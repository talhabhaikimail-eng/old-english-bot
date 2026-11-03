package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/publicsuffix"
)

// Third-party endpoints (package vars so tests can point them at local fakes).
var (
	w3cEndpoint          = "https://validator.w3.org/nu/?out=json"
	observatoryEndpoint  = "https://observatory-api.mdn.mozilla.net/api/v2/scan"
	safeBrowsingEndpoint = "https://safebrowsing.googleapis.com/v4/threatMatches:find"
	rdapEndpoint         = "https://rdap.org/domain/"
	waybackCDXEndpoint   = "https://web.archive.org/cdx/search/cdx"
	trancoEndpoint       = "https://tranco-list.eu/api/ranks/domain/"
	greenWebEndpoint     = "https://api.thegreenwebfoundation.org/api/v3/greencheck/"
	sslLabsEndpoint      = "https://api.ssllabs.com/api/v3/analyze"
	sslLabsPoll          = 10 * time.Second
	sslLabsMaxWait       = 5 * time.Minute
	w3cGap               = 1200 * time.Millisecond
	// verifyLocalHosts lets tests verify 127.0.0.1 fixtures; real audits skip IP/localhost targets.
	verifyLocalHosts = false
)

var verifyClient = &http.Client{Timeout: 45 * time.Second}

const verifyUA = "DataNodesSiteAuditor/1.0 (+https://talhacodes.site)"

// ThirdParty holds independent verification from external services.
type ThirdParty struct {
	W3C          *W3CResult          `json:"w3c,omitempty"`
	Observatory  *ObservatoryResult  `json:"observatory,omitempty"`
	SafeBrowsing *SafeBrowsingResult `json:"safeBrowsing,omitempty"`
	RDAP         *RDAPResult         `json:"rdap,omitempty"`
	Wayback      *WaybackResult      `json:"wayback,omitempty"`
	Tranco       *TrancoResult       `json:"tranco,omitempty"`
	GreenWeb     *GreenWebResult     `json:"greenWeb,omitempty"`
	SSLLabs      *SSLLabsResult      `json:"sslLabs,omitempty"`
}

// Check is the common envelope: status is ok | error | skipped.
type Check struct {
	Status    string `json:"status"`
	Error     string `json:"error,omitempty"`
	ReportURL string `json:"reportUrl,omitempty"` // human-readable result on the provider's site
	Ms        int    `json:"ms"`
}

type W3CMessage struct {
	Type    string `json:"type"` // error | warning | info
	Message string `json:"message"`
	Line    int    `json:"line,omitempty"`
	Extract string `json:"extract,omitempty"`
}

type W3CPage struct {
	URL      string       `json:"url"`
	Errors   int          `json:"errors"`
	Warnings int          `json:"warnings"`
	Error    string       `json:"error,omitempty"`
	Messages []W3CMessage `json:"messages,omitempty"`
}

type W3CResult struct {
	Check
	Pages []W3CPage `json:"pages"`
}

type ObservatoryResult struct {
	Check
	Grade       string `json:"grade,omitempty"`
	Score       int    `json:"score"`
	TestsPassed int    `json:"testsPassed"`
	TestsFailed int    `json:"testsFailed"`
	TestsTotal  int    `json:"testsTotal"`
}

type SafeBrowsingMatch struct {
	URL        string `json:"url"`
	ThreatType string `json:"threatType"`
	Own        bool   `json:"own"` // URL belongs to the audited site
}

type SafeBrowsingResult struct {
	Check
	Checked int                 `json:"checked"`
	Matches []SafeBrowsingMatch `json:"matches"`
}

type RDAPResult struct {
	Check
	Domain      string    `json:"domain"`
	Registrar   string    `json:"registrar,omitempty"`
	Registered  time.Time `json:"registered,omitempty"`
	Expires     time.Time `json:"expires,omitempty"`
	Updated     time.Time `json:"updated,omitempty"`
	AgeYears    float64   `json:"ageYears"`
	DaysLeft    int       `json:"daysLeft"`
	Statuses    []string  `json:"statuses,omitempty"`
	Nameservers []string  `json:"nameservers,omitempty"`
	DNSSEC      bool      `json:"dnssec"`
}

type WaybackResult struct {
	Check
	FirstCapture time.Time `json:"firstCapture,omitempty"`
	LastCapture  time.Time `json:"lastCapture,omitempty"`
	LastURL      string    `json:"lastUrl,omitempty"`
}

type TrancoResult struct {
	Check
	Domain string `json:"domain"`
	Rank   int    `json:"rank"` // 0 = not in the top 1M
	Date   string `json:"date,omitempty"`
	Best   int    `json:"best,omitempty"`
}

type GreenWebResult struct {
	Check
	Green    bool   `json:"green"`
	HostedBy string `json:"hostedBy,omitempty"`
	HostURL  string `json:"hostUrl,omitempty"`
}

type SSLLabsEndpoint struct {
	IP      string `json:"ip"`
	Grade   string `json:"grade,omitempty"`
	Warning bool   `json:"hasWarnings"`
	Message string `json:"message,omitempty"`
}

type SSLLabsResult struct {
	Check
	Grade     string            `json:"grade,omitempty"` // worst endpoint grade
	Endpoints []SSLLabsEndpoint `json:"endpoints,omitempty"`
}

func isLocalHost(host string) bool {
	return net.ParseIP(host) != nil || host == "localhost" || strings.HasSuffix(host, ".localhost") || !strings.Contains(host, ".")
}

func (a *Audit) verifyEnabled() bool {
	v := a.opts.Verify
	if v == nil {
		return true
	}
	return v.on(func(x *VerifyOptions) *bool { return x.W3C }) || v.on(func(x *VerifyOptions) *bool { return x.Observatory }) ||
		v.on(func(x *VerifyOptions) *bool { return x.SafeBrowsing }) || v.on(func(x *VerifyOptions) *bool { return x.RDAP }) ||
		v.on(func(x *VerifyOptions) *bool { return x.Wayback }) || v.on(func(x *VerifyOptions) *bool { return x.Tranco }) ||
		v.on(func(x *VerifyOptions) *bool { return x.GreenWeb }) || v.SSLLabs
}

// thirdParty runs every enabled external verification in parallel; failures never fail the audit.
func (a *Audit) thirdParty() {
	host := a.start.Hostname()
	tp := &ThirdParty{}
	a.report.Site.ThirdParty = tp
	if isLocalHost(host) && !verifyLocalHosts {
		a.logf("Third-party verification skipped: %s is not a public host name", host)
		return
	}
	apex, err := publicsuffix.EffectiveTLDPlusOne(host)
	if err != nil {
		apex = host
	}
	v := a.opts.Verify
	on := func(p func(*VerifyOptions) *bool) bool { return v.on(p) }
	limit := 3 * time.Minute
	if v != nil && v.SSLLabs {
		limit = sslLabsMaxWait + time.Minute
	}
	ctx, cancel := context.WithTimeout(a.ctx, limit)
	defer cancel()

	var wg sync.WaitGroup
	run := func(name string, f func()) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() {
				if r := recover(); r != nil {
					a.logf("%s check crashed: %v", name, r)
				}
			}()
			start := time.Now()
			f()
			a.logf("%s check finished (%s)", name, time.Since(start).Round(100*time.Millisecond))
		}()
	}
	if on(func(x *VerifyOptions) *bool { return x.W3C }) {
		n := 5
		if v != nil && v.W3CPages > 0 {
			n = v.W3CPages
		}
		run("W3C HTML validator", func() { tp.W3C = a.verifyW3C(ctx, n) })
	}
	if on(func(x *VerifyOptions) *bool { return x.Observatory }) {
		run("Mozilla Observatory", func() { tp.Observatory = observatoryScan(ctx, host) })
	}
	if on(func(x *VerifyOptions) *bool { return x.SafeBrowsing }) {
		run("Safe Browsing", func() { tp.SafeBrowsing = a.safeBrowsing(ctx) })
	}
	if on(func(x *VerifyOptions) *bool { return x.RDAP }) {
		run("RDAP", func() { tp.RDAP = rdapLookup(ctx, apex) })
	}
	if on(func(x *VerifyOptions) *bool { return x.Wayback }) {
		run("Wayback Machine", func() { tp.Wayback = waybackLookup(ctx, host) })
	}
	if on(func(x *VerifyOptions) *bool { return x.Tranco }) {
		run("Tranco rank", func() { tp.Tranco = trancoRank(ctx, apex) })
	}
	if on(func(x *VerifyOptions) *bool { return x.GreenWeb }) {
		run("Green Web", func() { tp.GreenWeb = greenWeb(ctx, host) })
	}
	if v != nil && v.SSLLabs && a.start.Scheme == "https" {
		run("SSL Labs", func() { tp.SSLLabs = sslLabs(ctx, host) })
	}
	wg.Wait()
}

// getJSON performs a request against a third-party API and decodes JSON into out.
func getJSON(ctx context.Context, method, u string, body io.Reader, hdr map[string]string, out any) (int, error) {
	req, err := http.NewRequestWithContext(ctx, method, u, body)
	if err != nil {
		return 0, err
	}
	req.Header.Set("User-Agent", verifyUA)
	req.Header.Set("Accept", "application/json")
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := verifyClient.Do(req)
	if err != nil {
		return 0, simplifyNetErr(err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return resp.StatusCode, err
	}
	if resp.StatusCode == 429 {
		return resp.StatusCode, fmt.Errorf("rate limited by the service (HTTP 429) — try again later")
	}
	if out != nil && len(bytes.TrimSpace(data)) > 0 {
		if err := json.Unmarshal(data, out); err != nil {
			if resp.StatusCode >= 400 {
				return resp.StatusCode, fmt.Errorf("HTTP %d", resp.StatusCode)
			}
			return resp.StatusCode, fmt.Errorf("unexpected response: %v", err)
		}
	}
	return resp.StatusCode, nil
}

func finish(c *Check, start time.Time, err error) {
	c.Ms = int(time.Since(start).Milliseconds())
	if err != nil {
		c.Status, c.Error = "error", err.Error()
	} else if c.Status == "" {
		c.Status = "ok"
	}
}

// ── W3C Nu HTML Checker ──

func (a *Audit) verifyW3C(ctx context.Context, n int) *W3CResult {
	res := &W3CResult{Pages: []W3CPage{}}
	start := time.Now()
	a.mu.Lock()
	inlinks := map[string]int{}
	for _, e := range a.edges {
		inlinks[e.To]++
	}
	var cand []*Page
	for _, p := range a.pages {
		if p.IsHTML && p.Status == 200 {
			cand = append(cand, p)
		}
	}
	a.mu.Unlock()
	home := a.start.String()
	// Homepage first, then the most-linked pages.
	sort.Slice(cand, func(i, j int) bool {
		if (cand[i].URL == home) != (cand[j].URL == home) {
			return cand[i].URL == home
		}
		if inlinks[cand[i].URL] != inlinks[cand[j].URL] {
			return inlinks[cand[i].URL] > inlinks[cand[j].URL]
		}
		return cand[i].URL < cand[j].URL
	})
	if len(cand) > n {
		cand = cand[:n]
	}
	if len(cand) == 0 {
		res.Status, res.Error = "skipped", "no HTML pages to validate"
		return res
	}
	var lastErr error
	for i, p := range cand {
		if ctx.Err() != nil {
			break
		}
		if i > 0 {
			select { // the public validator asks clients to be gentle
			case <-time.After(w3cGap):
			case <-ctx.Done():
			}
		}
		pg := W3CPage{URL: p.URL}
		body := a.fetcher.Do(ctx, p.URL, fetchOpts{readBody: true})
		if body.Err != nil || len(body.Body) == 0 {
			pg.Error = "could not re-fetch page"
			res.Pages = append(res.Pages, pg)
			continue
		}
		var out struct {
			Messages []struct {
				Type     string `json:"type"`
				SubType  string `json:"subType"`
				Message  string `json:"message"`
				LastLine int    `json:"lastLine"`
				Extract  string `json:"extract"`
			} `json:"messages"`
		}
		_, err := getJSON(ctx, http.MethodPost, w3cEndpoint, bytes.NewReader(body.Body), map[string]string{"Content-Type": "text/html; charset=utf-8"}, &out)
		if err != nil {
			pg.Error = err.Error()
			lastErr = err
			res.Pages = append(res.Pages, pg)
			continue
		}
		for _, m := range out.Messages {
			typ := m.Type
			switch {
			case m.Type == "error" || m.Type == "non-document-error":
				pg.Errors++
				typ = "error"
			case m.SubType == "warning":
				pg.Warnings++
				typ = "warning"
			default:
				continue
			}
			if len(pg.Messages) < 60 {
				pg.Messages = append(pg.Messages, W3CMessage{Type: typ, Message: firstN(m.Message, 400), Line: m.LastLine, Extract: firstN(m.Extract, 200)})
			}
		}
		res.Pages = append(res.Pages, pg)
	}
	res.ReportURL = "https://validator.w3.org/nu/?doc=" + url.QueryEscape(home)
	ok := 0
	for _, p := range res.Pages {
		if p.Error == "" {
			ok++
		}
	}
	if ok == 0 && lastErr != nil {
		finish(&res.Check, start, lastErr)
		return res
	}
	finish(&res.Check, start, nil)
	return res
}

// ── Mozilla HTTP Observatory ──

func observatoryScan(ctx context.Context, host string) *ObservatoryResult {
	res := &ObservatoryResult{}
	start := time.Now()
	var out struct {
		Grade         *string `json:"grade"`
		Score         *int    `json:"score"`
		TestsFailed   int     `json:"tests_failed"`
		TestsPassed   int     `json:"tests_passed"`
		TestsQuantity int     `json:"tests_quantity"`
		DetailsURL    string  `json:"details_url"`
		Error         *string `json:"error"`
		Message       string  `json:"message"`
	}
	_, err := getJSON(ctx, http.MethodPost, observatoryEndpoint+"?host="+url.QueryEscape(host), nil, nil, &out)
	if err == nil {
		switch {
		case out.Error != nil && *out.Error != "":
			err = fmt.Errorf("%s", *out.Error)
		case out.Grade == nil:
			err = fmt.Errorf("no grade returned%s", map[bool]string{true: ": " + out.Message, false: ""}[out.Message != ""])
		}
	}
	if err == nil {
		res.Grade = *out.Grade
		if out.Score != nil {
			res.Score = *out.Score
		}
		res.TestsPassed, res.TestsFailed, res.TestsTotal = out.TestsPassed, out.TestsFailed, out.TestsQuantity
	}
	res.ReportURL = out.DetailsURL
	if res.ReportURL == "" {
		res.ReportURL = "https://developer.mozilla.org/en-US/observatory/analyze?host=" + url.QueryEscape(host)
	}
	finish(&res.Check, start, err)
	return res
}

// ── Google Safe Browsing ──

func (a *Audit) safeBrowsingKey() string {
	for _, k := range []string{os.Getenv("SAFE_BROWSING_API_KEY"), a.opts.PageSpeedKey, os.Getenv("PAGESPEED_API_KEY")} {
		if k = strings.TrimSpace(k); k != "" {
			return k
		}
	}
	return ""
}

func (a *Audit) safeBrowsing(ctx context.Context) *SafeBrowsingResult {
	res := &SafeBrowsingResult{Matches: []SafeBrowsingMatch{}}
	start := time.Now()
	key := a.safeBrowsingKey()
	if key == "" {
		res.Status, res.Error = "skipped", "needs a Google API key with the Safe Browsing API enabled (SAFE_BROWSING_API_KEY or the PageSpeed key)"
		return res
	}
	a.mu.Lock()
	own := map[string]bool{a.report.Site.Origin + "/": true}
	urls := []string{a.report.Site.Origin + "/"}
	for _, u := range a.pageOrder {
		if len(urls) >= 250 {
			break
		}
		if !own[u] {
			own[u] = true
			urls = append(urls, u)
		}
	}
	ext := 0
	for _, u := range sortedKeys(a.resources) {
		if r := a.resources[u]; r.Kind == "external" && ext < 250 {
			urls = append(urls, u)
			ext++
		}
	}
	a.mu.Unlock()
	res.Checked = len(urls)
	type entry struct {
		URL string `json:"url"`
	}
	entries := make([]entry, len(urls))
	for i, u := range urls {
		entries[i] = entry{u}
	}
	reqBody, _ := json.Marshal(map[string]any{
		"client": map[string]string{"clientId": "datanodes-site-auditor", "clientVersion": "1.0"},
		"threatInfo": map[string]any{
			"threatTypes":      []string{"MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE", "POTENTIALLY_HARMFUL_APPLICATION"},
			"platformTypes":    []string{"ANY_PLATFORM"},
			"threatEntryTypes": []string{"URL"},
			"threatEntries":    entries,
		},
	})
	var out struct {
		Matches []struct {
			ThreatType string `json:"threatType"`
			Threat     struct {
				URL string `json:"url"`
			} `json:"threat"`
		} `json:"matches"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	_, err := getJSON(ctx, http.MethodPost, safeBrowsingEndpoint+"?key="+url.QueryEscape(key), bytes.NewReader(reqBody), map[string]string{"Content-Type": "application/json"}, &out)
	if err == nil && out.Error != nil {
		err = fmt.Errorf("%s", out.Error.Message)
	}
	seen := map[string]bool{}
	for _, m := range out.Matches {
		if seen[m.Threat.URL+m.ThreatType] {
			continue
		}
		seen[m.Threat.URL+m.ThreatType] = true
		res.Matches = append(res.Matches, SafeBrowsingMatch{URL: m.Threat.URL, ThreatType: m.ThreatType, Own: own[m.Threat.URL]})
	}
	res.ReportURL = "https://transparencyreport.google.com/safe-browsing/search?url=" + url.QueryEscape(a.start.Hostname())
	finish(&res.Check, start, err)
	return res
}

// ── RDAP (domain registration) ──

func rdapLookup(ctx context.Context, domain string) *RDAPResult {
	res := &RDAPResult{Domain: domain}
	start := time.Now()
	var out struct {
		Events []struct {
			Action string `json:"eventAction"`
			Date   string `json:"eventDate"`
		} `json:"events"`
		Status   []string `json:"status"`
		Entities []struct {
			Roles []string `json:"roles"`
			Vcard []any    `json:"vcardArray"`
		} `json:"entities"`
		Nameservers []struct {
			Name string `json:"ldhName"`
		} `json:"nameservers"`
		SecureDNS struct {
			DelegationSigned bool `json:"delegationSigned"`
		} `json:"secureDNS"`
		ErrorCode int    `json:"errorCode"`
		Title     string `json:"title"`
	}
	code, err := getJSON(ctx, http.MethodGet, rdapEndpoint+url.PathEscape(domain), nil, map[string]string{"Accept": "application/rdap+json, application/json"}, &out)
	if err == nil && (code == 404 || out.ErrorCode == 404) {
		res.Status, res.Error = "skipped", "the registry for this TLD doesn't publish RDAP data"
		res.Ms = int(time.Since(start).Milliseconds())
		return res
	}
	if err == nil && code >= 400 {
		err = fmt.Errorf("HTTP %d %s", code, out.Title)
	}
	if err == nil {
		for _, e := range out.Events {
			t, perr := time.Parse(time.RFC3339, e.Date)
			if perr != nil {
				continue
			}
			switch strings.ToLower(e.Action) {
			case "registration":
				res.Registered = t
			case "expiration":
				res.Expires = t
			case "last changed", "last update of rdap database":
				if strings.ToLower(e.Action) == "last changed" {
					res.Updated = t
				}
			}
		}
		res.Statuses = out.Status
		for _, ns := range out.Nameservers {
			res.Nameservers = append(res.Nameservers, strings.ToLower(ns.Name))
		}
		res.DNSSEC = out.SecureDNS.DelegationSigned
		for _, e := range out.Entities {
			for _, role := range e.Roles {
				if role == "registrar" {
					res.Registrar = vcardFN(e.Vcard)
				}
			}
		}
		if !res.Registered.IsZero() {
			res.AgeYears = float64(int(time.Since(res.Registered).Hours()/24/365.25*10)) / 10
		}
		if !res.Expires.IsZero() {
			res.DaysLeft = int(time.Until(res.Expires).Hours() / 24)
		}
	}
	res.ReportURL = "https://client.rdap.org/?type=domain&object=" + url.QueryEscape(domain)
	finish(&res.Check, start, err)
	return res
}

// vcardFN pulls the formatted name out of a jCard array: ["vcard", [["fn", {}, "text", "Name"], …]].
func vcardFN(v []any) string {
	if len(v) < 2 {
		return ""
	}
	props, _ := v[1].([]any)
	for _, p := range props {
		arr, _ := p.([]any)
		if len(arr) >= 4 {
			if name, _ := arr[0].(string); name == "fn" {
				s, _ := arr[3].(string)
				return s
			}
		}
	}
	return ""
}

// ── Wayback Machine ──

func waybackLookup(ctx context.Context, host string) *WaybackResult {
	res := &WaybackResult{}
	start := time.Now()
	var first [][]string
	_, err := getJSON(ctx, http.MethodGet, waybackCDXEndpoint+"?url="+url.QueryEscape(host)+"&output=json&limit=1&fl=timestamp,original", nil, nil, &first)
	if err == nil && len(first) > 1 && len(first[1]) > 0 {
		res.FirstCapture, _ = time.Parse("20060102150405", first[1][0])
	}
	var last [][]string
	_, err2 := getJSON(ctx, http.MethodGet, waybackCDXEndpoint+"?url="+url.QueryEscape(host)+"&output=json&limit=-1&fastLatest=true&fl=timestamp,original", nil, nil, &last)
	if err2 == nil && len(last) > 1 && len(last[len(last)-1]) > 1 {
		row := last[len(last)-1]
		res.LastCapture, _ = time.Parse("20060102150405", row[0])
		res.LastURL = "https://web.archive.org/web/" + row[0] + "/" + row[1]
	}
	if err != nil && err2 != nil {
		finish(&res.Check, start, err)
		return res
	}
	res.ReportURL = "https://web.archive.org/web/*/" + host
	finish(&res.Check, start, nil)
	return res
}

// ── Tranco top-sites rank ──

func trancoRank(ctx context.Context, domain string) *TrancoResult {
	res := &TrancoResult{Domain: domain}
	start := time.Now()
	var out struct {
		Ranks []struct {
			Date string `json:"date"`
			Rank int    `json:"rank"`
		} `json:"ranks"`
	}
	_, err := getJSON(ctx, http.MethodGet, trancoEndpoint+url.PathEscape(domain), nil, nil, &out)
	if err == nil && len(out.Ranks) > 0 {
		sort.Slice(out.Ranks, func(i, j int) bool { return out.Ranks[i].Date > out.Ranks[j].Date })
		res.Rank, res.Date = out.Ranks[0].Rank, out.Ranks[0].Date
		for _, r := range out.Ranks {
			if r.Rank > 0 && (res.Best == 0 || r.Rank < res.Best) {
				res.Best = r.Rank
			}
		}
	}
	res.ReportURL = "https://tranco-list.eu/query"
	finish(&res.Check, start, err)
	return res
}

// ── Green Web Foundation ──

func greenWeb(ctx context.Context, host string) *GreenWebResult {
	res := &GreenWebResult{}
	start := time.Now()
	var out struct {
		Green           bool   `json:"green"`
		HostedBy        string `json:"hosted_by"`
		HostedByWebsite string `json:"hosted_by_website"`
	}
	_, err := getJSON(ctx, http.MethodGet, greenWebEndpoint+url.PathEscape(host), nil, nil, &out)
	res.Green, res.HostedBy, res.HostURL = out.Green, out.HostedBy, out.HostedByWebsite
	res.ReportURL = "https://www.thegreenwebfoundation.org/green-web-check/?url=" + url.QueryEscape(host)
	finish(&res.Check, start, err)
	return res
}

// ── Qualys SSL Labs ──

func sslLabs(ctx context.Context, host string) *SSLLabsResult {
	res := &SSLLabsResult{}
	start := time.Now()
	endpoint := sslLabsEndpoint
	hdr := map[string]string{}
	if email := os.Getenv("SSLLABS_EMAIL"); email != "" {
		// API v4 requires a registered e-mail address.
		endpoint = strings.Replace(endpoint, "/api/v3/", "/api/v4/", 1)
		hdr["email"] = email
	}
	res.ReportURL = "https://www.ssllabs.com/ssltest/analyze.html?d=" + url.QueryEscape(host) + "&hideResults=on"
	q := "?host=" + url.QueryEscape(host) + "&fromCache=on&maxAge=24&all=done"
	deadline := time.Now().Add(sslLabsMaxWait)
	for {
		var out struct {
			Status        string `json:"status"`
			StatusMessage string `json:"statusMessage"`
			Errors        []struct {
				Message string `json:"message"`
			} `json:"errors"`
			Endpoints []struct {
				IP            string `json:"ipAddress"`
				Grade         string `json:"grade"`
				HasWarnings   bool   `json:"hasWarnings"`
				StatusMessage string `json:"statusMessage"`
			} `json:"endpoints"`
		}
		code, err := getJSON(ctx, http.MethodGet, endpoint+q, nil, hdr, &out)
		if err == nil && len(out.Errors) > 0 {
			err = fmt.Errorf("%s", out.Errors[0].Message)
		} else if err == nil && code >= 400 {
			err = fmt.Errorf("HTTP %d", code)
		}
		if err != nil {
			finish(&res.Check, start, err)
			return res
		}
		switch out.Status {
		case "READY":
			order := map[string]int{"A+": 0, "A": 1, "A-": 2, "B": 3, "C": 4, "D": 5, "E": 6, "F": 7, "T": 8, "M": 9}
			worst := -1
			for _, e := range out.Endpoints {
				res.Endpoints = append(res.Endpoints, SSLLabsEndpoint{IP: e.IP, Grade: e.Grade, Warning: e.HasWarnings, Message: e.StatusMessage})
				if o, ok := order[e.Grade]; ok && o > worst {
					worst, res.Grade = o, e.Grade
				}
			}
			finish(&res.Check, start, nil)
			return res
		case "ERROR":
			finish(&res.Check, start, fmt.Errorf("%s", nonEmpty(out.StatusMessage, "SSL Labs assessment failed")))
			return res
		}
		q = "?host=" + url.QueryEscape(host) + "&all=done" // poll without restarting the scan
		if time.Now().After(deadline) {
			finish(&res.Check, start, fmt.Errorf("SSL Labs assessment still running after %s — open the report link", sslLabsMaxWait))
			return res
		}
		select {
		case <-time.After(sslLabsPoll):
		case <-ctx.Done():
			finish(&res.Check, start, fmt.Errorf("SSL Labs assessment timed out — open the report link"))
			return res
		}
	}
}

// thirdPartyIssues turns verification results into catalog issues.
func (a *Audit) thirdPartyIssues(c *issueCollector) {
	tp := a.report.Site.ThirdParty
	if tp == nil {
		return
	}
	if w := tp.W3C; w != nil {
		for _, p := range w.Pages {
			if p.Error == "" && p.Errors > 0 {
				c.add("w3c-html-errors", p.URL, fmt.Sprintf("%d errors, %d warnings", p.Errors, p.Warnings))
				if pg := a.pages[p.URL]; pg != nil {
					pg.Issues = appendUnique(pg.Issues, "w3c-html-errors")
				}
			}
		}
	}
	if o := tp.Observatory; o != nil && o.Status == "ok" {
		if g := strings.TrimRight(o.Grade, "+-"); g != "A" && g != "B" {
			c.site("observatory-low-grade", fmt.Sprintf("grade %s, score %d/100, %d of %d tests failed", o.Grade, o.Score, o.TestsFailed, o.TestsTotal))
		}
	}
	if s := tp.SafeBrowsing; s != nil && s.Status == "ok" {
		var own []string
		flagged := map[string]string{}
		for _, m := range s.Matches {
			if m.Own {
				own = append(own, m.URL+" ("+m.ThreatType+")")
			} else {
				flagged[m.URL] = m.ThreatType
			}
		}
		if len(own) > 0 {
			c.site("safe-browsing-flagged", strings.Join(own, "\n"))
		}
		if len(flagged) > 0 {
			for _, p := range a.pages {
				var hits []string
				for _, l := range p.Links {
					if t, ok := flagged[l.URL]; ok {
						hits = append(hits, l.URL+" ("+t+")")
					}
				}
				if len(hits) > 0 {
					c.add("links-to-unsafe", p.URL, strings.Join(hits, "\n"))
					p.Issues = appendUnique(p.Issues, "links-to-unsafe")
				}
			}
		}
	}
	if r := tp.RDAP; r != nil && r.Status == "ok" {
		if !r.Expires.IsZero() && r.DaysLeft < 30 {
			c.site("domain-expiring", fmt.Sprintf("%s expires %s (%d days)", r.Domain, r.Expires.Format("2006-01-02"), r.DaysLeft))
		}
		locked := false
		for _, s := range r.Statuses {
			if strings.Contains(strings.ToLower(s), "transfer prohibited") {
				locked = true
			}
		}
		if len(r.Statuses) > 0 && !locked {
			c.site("domain-no-transfer-lock", strings.Join(r.Statuses, ", "))
		}
	}
	if s := tp.SSLLabs; s != nil && s.Status == "ok" && s.Grade != "" {
		if g := s.Grade; g != "A+" && g != "A" && g != "A-" {
			c.site("ssllabs-low-grade", "SSL Labs grade "+g)
		}
	}
}
