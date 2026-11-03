package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func mustURL(s string) *url.URL {
	u, err := url.Parse(s)
	if err != nil {
		panic(err)
	}
	return u
}

// fakeThirdParty imitates every external verification API with realistic payloads.
func fakeThirdParty() (*httptest.Server, *atomic.Int64) {
	var w3cCalls atomic.Int64
	var sslPolls atomic.Int64
	mux := http.NewServeMux()
	mux.HandleFunc("/w3c", func(w http.ResponseWriter, r *http.Request) {
		w3cCalls.Add(1)
		b, _ := io.ReadAll(r.Body)
		if r.Method != http.MethodPost || !strings.Contains(r.Header.Get("Content-Type"), "text/html") || len(b) == 0 {
			http.Error(w, "bad request", 400)
			return
		}
		w.Write([]byte(`{"messages":[{"type":"error","lastLine":3,"message":"Stray end tag div.","extract":"</div>"},{"type":"info","subType":"warning","message":"Consider adding lang"},{"type":"info","message":"just info"}]}`))
	})
	mux.HandleFunc("/observatory", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Query().Get("host") == "" {
			http.Error(w, "bad", 400)
			return
		}
		w.Write([]byte(`{"id":1,"details_url":"https://developer.mozilla.org/en-US/observatory/analyze?host=x","grade":"D","score":25,"tests_failed":6,"tests_passed":4,"tests_quantity":10,"error":null}`))
	})
	mux.HandleFunc("/sb", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("key") != "k123" {
			w.WriteHeader(403)
			w.Write([]byte(`{"error":{"code":403,"message":"API key not valid"}}`))
			return
		}
		var body struct {
			ThreatInfo struct {
				ThreatEntries []struct {
					URL string `json:"url"`
				} `json:"threatEntries"`
			} `json:"threatInfo"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		matches := []map[string]any{}
		for _, e := range body.ThreatInfo.ThreatEntries {
			if strings.Contains(e.URL, "/dead") {
				matches = append(matches, map[string]any{"threatType": "MALWARE", "platformType": "ANY_PLATFORM", "threat": map[string]string{"url": e.URL}})
			}
		}
		json.NewEncoder(w).Encode(map[string]any{"matches": matches})
	})
	mux.HandleFunc("/rdap/", func(w http.ResponseWriter, r *http.Request) {
		exp := time.Now().Add(10 * 24 * time.Hour).UTC().Format(time.RFC3339)
		w.Header().Set("Content-Type", "application/rdap+json")
		w.Write([]byte(`{"objectClassName":"domain","ldhName":"EXAMPLE.TEST","status":["active"],
"events":[{"eventAction":"registration","eventDate":"2010-05-01T00:00:00Z"},{"eventAction":"expiration","eventDate":"` + exp + `"},{"eventAction":"last changed","eventDate":"2024-01-01T00:00:00Z"}],
"entities":[{"roles":["registrar"],"vcardArray":["vcard",[["version",{},"text","4.0"],["fn",{},"text","Example Registrar, Inc."]]]}],
"nameservers":[{"ldhName":"NS1.EXAMPLE.TEST"}],"secureDNS":{"delegationSigned":true}}`))
	})
	mux.HandleFunc("/cdx", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("limit") == "-1" {
			w.Write([]byte(`[["timestamp","original"],["20240101000000","https://example.test/"]]`))
			return
		}
		w.Write([]byte(`[["timestamp","original"],["20050102030405","http://example.test/"]]`))
	})
	mux.HandleFunc("/tranco/", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"domain":"example.test","ranks":[{"date":"2024-01-01","rank":5000},{"date":"2024-02-01","rank":4200}]}`))
	})
	mux.HandleFunc("/green/", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"url":"x","green":true,"hosted_by":"Green Host","hosted_by_website":"green.example"}`))
	})
	mux.HandleFunc("/ssl", func(w http.ResponseWriter, r *http.Request) {
		if sslPolls.Add(1) < 2 {
			w.Write([]byte(`{"status":"IN_PROGRESS"}`))
			return
		}
		w.Write([]byte(`{"status":"READY","endpoints":[{"ipAddress":"1.2.3.4","grade":"A"},{"ipAddress":"::1","grade":"B","hasWarnings":true}]}`))
	})
	return httptest.NewServer(mux), &w3cCalls
}

func TestThirdPartyVerification(t *testing.T) {
	fake, w3cCalls := fakeThirdParty()
	defer fake.Close()
	saved := []string{w3cEndpoint, observatoryEndpoint, safeBrowsingEndpoint, rdapEndpoint, waybackCDXEndpoint, trancoEndpoint, greenWebEndpoint, sslLabsEndpoint}
	savedPoll, savedGap := sslLabsPoll, w3cGap
	defer func() {
		w3cEndpoint, observatoryEndpoint, safeBrowsingEndpoint, rdapEndpoint, waybackCDXEndpoint, trancoEndpoint, greenWebEndpoint, sslLabsEndpoint =
			saved[0], saved[1], saved[2], saved[3], saved[4], saved[5], saved[6], saved[7]
		sslLabsPoll, w3cGap = savedPoll, savedGap
		verifyLocalHosts = false
	}()
	w3cEndpoint = fake.URL + "/w3c"
	observatoryEndpoint = fake.URL + "/observatory"
	safeBrowsingEndpoint = fake.URL + "/sb"
	rdapEndpoint = fake.URL + "/rdap/"
	waybackCDXEndpoint = fake.URL + "/cdx"
	trancoEndpoint = fake.URL + "/tranco/"
	greenWebEndpoint = fake.URL + "/green/"
	sslLabsEndpoint = fake.URL + "/ssl"
	sslLabsPoll, w3cGap = 50*time.Millisecond, 0
	verifyLocalHosts = true
	t.Setenv("SAFE_BROWSING_API_KEY", "k123")

	r := runFixtureAudit(t, func(o *Options) {
		o.Verify = &VerifyOptions{W3CPages: 3, SSLLabs: true}
	})
	tp := r.Site.ThirdParty
	if tp == nil {
		t.Fatal("no third-party results")
	}
	if tp.W3C == nil || tp.W3C.Status != "ok" || len(tp.W3C.Pages) != 3 || w3cCalls.Load() != 3 {
		t.Fatalf("w3c = %+v calls=%d", tp.W3C, w3cCalls.Load())
	}
	if p := tp.W3C.Pages[0]; !strings.HasSuffix(p.URL, "/") || p.Errors != 1 || p.Warnings != 1 || len(p.Messages) != 2 {
		t.Errorf("w3c home page = %+v", p)
	}
	if o := tp.Observatory; o == nil || o.Grade != "D" || o.Score != 25 || o.TestsTotal != 10 {
		t.Errorf("observatory = %+v", o)
	}
	if s := tp.SafeBrowsing; s == nil || s.Status != "ok" || len(s.Matches) != 1 || s.Matches[0].Own {
		t.Errorf("safe browsing = %+v", s)
	}
	if d := tp.RDAP; d == nil || d.Registrar != "Example Registrar, Inc." || d.DaysLeft > 10 || d.AgeYears < 10 || !d.DNSSEC || len(d.Nameservers) != 1 {
		t.Errorf("rdap = %+v", d)
	}
	if w := tp.Wayback; w == nil || w.FirstCapture.Year() != 2005 || w.LastCapture.Year() != 2024 {
		t.Errorf("wayback = %+v", w)
	}
	if tr := tp.Tranco; tr == nil || tr.Rank != 4200 || tr.Best != 4200 {
		t.Errorf("tranco = %+v", tr)
	}
	if g := tp.GreenWeb; g == nil || !g.Green || g.HostedBy != "Green Host" {
		t.Errorf("green = %+v", g)
	}
	if s := tp.SSLLabs; s != nil {
		t.Errorf("ssl labs must not run for http:// sites: %+v", s)
	}
	for _, id := range []string{"observatory-low-grade", "domain-expiring", "domain-no-transfer-lock"} {
		if issueURLs(r, id) == nil {
			t.Errorf("expected site issue %s", id)
		}
	}
	if !hasIssueFor(r, "links-to-unsafe", "/") {
		t.Errorf("links-to-unsafe not attached to home: %v", issueURLs(r, "links-to-unsafe"))
	}
	if !hasIssueFor(r, "w3c-html-errors", "/") {
		t.Errorf("w3c-html-errors missing")
	}

	// SSL Labs polling and grade selection, called directly (the fixture is plain HTTP).
	s := sslLabs(t.Context(), "example.test")
	if s.Status != "ok" || s.Grade != "B" || len(s.Endpoints) != 2 {
		t.Errorf("ssl labs = %+v", s)
	}
}

func TestThirdPartyFailuresAreSoft(t *testing.T) {
	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
		w.Write([]byte("<html>oops</html>"))
	}))
	defer down.Close()
	saved, savedRDAP := observatoryEndpoint, rdapEndpoint
	defer func() { observatoryEndpoint, rdapEndpoint = saved, savedRDAP }()
	observatoryEndpoint = down.URL
	if o := observatoryScan(t.Context(), "example.test"); o.Status != "error" || o.Error == "" {
		t.Errorf("observatory failure = %+v", o)
	}
	nf := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(404)
		w.Write([]byte(`{"errorCode":404,"title":"Not Found"}`))
	}))
	defer nf.Close()
	rdapEndpoint = nf.URL + "/"
	if d := rdapLookup(t.Context(), "example.zz"); d.Status != "skipped" {
		t.Errorf("rdap 404 should be skipped: %+v", d)
	}
	// Without a key Safe Browsing is skipped, not failed.
	t.Setenv("SAFE_BROWSING_API_KEY", "")
	t.Setenv("PAGESPEED_API_KEY", "")
	a := &Audit{opts: Options{}, report: &Report{}, resources: map[string]*Resource{}}
	if s := a.safeBrowsing(t.Context()); s.Status != "skipped" {
		t.Errorf("safe browsing without key = %+v", s)
	}
	if !isLocalHost("127.0.0.1") || !isLocalHost("localhost") || isLocalHost("example.com") {
		t.Errorf("isLocalHost wrong")
	}
}

func stringsReader(s string) *strings.Reader { return strings.NewReader(s) }
