package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type Progress struct {
	Phase      string    `json:"phase"`
	Crawled    int       `json:"crawled"`
	Queued     int       `json:"queued"`
	Discovered int       `json:"discovered"`
	Errors     int       `json:"errors"`
	Resources  int       `json:"resourcesChecked"`
	ResTotal   int       `json:"resourcesTotal"`
	Current    string    `json:"current,omitempty"`
	StartedAt  time.Time `json:"startedAt"`
	ElapsedMs  int64     `json:"elapsedMs"`
	PagesPerS  float64   `json:"pagesPerSec"`
	Log        []string  `json:"log,omitempty"`
}

type DupGroup struct {
	Value string   `json:"value"`
	URLs  []string `json:"urls"`
}

type NearDup struct {
	A          string  `json:"a"`
	B          string  `json:"b"`
	Similarity float64 `json:"similarity"`
}

type RedirectHop struct {
	URL    string `json:"url"`
	Status int    `json:"status"`
}

type RedirectChain struct {
	Start       string        `json:"start"`
	Hops        []RedirectHop `json:"hops"`
	Final       string        `json:"final"`
	FinalStatus int           `json:"finalStatus"`
	Loop        bool          `json:"loop"`
}

type Summary struct {
	PagesCrawled  int            `json:"pagesCrawled"`
	HTMLPages     int            `json:"htmlPages"`
	Indexable     int            `json:"indexable"`
	NonIndexable  int            `json:"nonIndexable"`
	Redirects     int            `json:"redirects"`
	ClientErrors  int            `json:"clientErrors"`
	ServerErrors  int            `json:"serverErrors"`
	Blocked       int            `json:"blocked"`
	Failed        int            `json:"failed"`
	InternalLinks int            `json:"internalLinks"`
	ExternalLinks int            `json:"externalLinks"`
	BrokenLinks   int            `json:"brokenLinks"`
	Images        int            `json:"images"`
	AvgTTFBMs     int            `json:"avgTtfbMs"`
	AvgLoadMs     int            `json:"avgLoadMs"`
	AvgWords      int            `json:"avgWords"`
	AvgSizeKB     int            `json:"avgSizeKb"`
	TotalBytes    int64          `json:"totalBytes"`
	MaxDepth      int            `json:"maxDepth"`
	Orphans       int            `json:"orphans"`
	StatusCodes   map[string]int `json:"statusCodes"`
	DepthHist     map[string]int `json:"depthHist"`
	ContentTypes  map[string]int `json:"contentTypes"`
	Errors        int            `json:"errors"`
	Warnings      int            `json:"warnings"`
	Notices       int            `json:"notices"`
	TTFBHist      map[string]int `json:"ttfbHist"`
	WordHist      map[string]int `json:"wordHist"`
	SchemaTypes   map[string]int `json:"schemaTypes"`
}

type Report struct {
	ID             string          `json:"id"`
	Status         string          `json:"status"` // queued | running | done | failed | cancelled
	Error          string          `json:"error,omitempty"`
	Options        Options         `json:"options"`
	StartURL       string          `json:"startUrl"`
	Host           string          `json:"host"`
	CreatedAt      time.Time       `json:"createdAt"`
	StartedAt      time.Time       `json:"startedAt"`
	FinishedAt     time.Time       `json:"finishedAt"`
	DurationMs     int64           `json:"durationMs"`
	Score          int             `json:"score"`
	Grade          string          `json:"grade"`
	CategoryScores map[string]int  `json:"categoryScores"`
	Summary        Summary         `json:"summary"`
	Issues         []IssueResult   `json:"issues"`
	Site           SiteInfo        `json:"site"`
	Pages          []*Page         `json:"pages"`
	Resources      []*Resource     `json:"resources"`
	Edges          []LinkEdge      `json:"edges"`
	DupTitles      []DupGroup      `json:"dupTitles"`
	DupDescs       []DupGroup      `json:"dupDescriptions"`
	DupH1          []DupGroup      `json:"dupH1"`
	DupContent     []DupGroup      `json:"dupContent"`
	NearDups       []NearDup       `json:"nearDuplicates"`
	Chains         []RedirectChain `json:"redirectChains"`
	Truncated      bool            `json:"truncated"` // stopped at maxPages with URLs left
	Progress       Progress        `json:"progress"`
}

// Audit is a running crawl; the Report is filled as it goes and finalised in analyze().
type Audit struct {
	report *Report
	opts   Options
	ctx    context.Context
	cancel context.CancelFunc

	mu       sync.Mutex
	progress Progress
	fetcher  *Fetcher
	robots   *Robots
	robotsUA string
	scope    scope
	start    *url.URL
	include  []*regexp.Regexp
	exclude  []*regexp.Regexp
	crawlGap time.Duration
	lastReq  time.Time
	gapMu    sync.Mutex

	seen      map[string]bool
	queue     []crawlJob
	inflight  int
	cond      *sync.Cond
	pages     map[string]*Page
	pageOrder []string
	edges     []LinkEdge
	resources map[string]*Resource
	sitemap   map[string]bool
	homeHints []string
	homeBody  []byte
	homeHdr   http.Header
	crawled   atomic.Int64
}

type crawlJob struct {
	url   string
	depth int
	from  string
}

func (o *Options) normalize() error {
	if o.MaxPages <= 0 {
		o.MaxPages = 500
	}
	if o.MaxPages > 10000 {
		o.MaxPages = 10000
	}
	if o.MaxDepth <= 0 {
		o.MaxDepth = 10
	}
	if o.MaxDepth > 50 {
		o.MaxDepth = 50
	}
	if o.Concurrency <= 0 {
		o.Concurrency = 8
	}
	if o.Concurrency > 32 {
		o.Concurrency = 32
	}
	if o.TimeoutSec <= 0 {
		o.TimeoutSec = 20
	}
	if o.TimeoutSec > 60 {
		o.TimeoutSec = 60
	}
	if o.CrawlDelayMs < 0 {
		o.CrawlDelayMs = 0
	}
	if o.CrawlDelayMs > 10000 {
		o.CrawlDelayMs = 10000
	}
	if o.UserAgent == "" {
		o.UserAgent = "default"
	}
	if len(o.UserAgent) > 400 {
		return errors.New("userAgent too long")
	}
	o.Keyword = strings.TrimSpace(strings.ToLower(o.Keyword))
	if len(o.Keyword) > 100 {
		o.Keyword = o.Keyword[:100]
	}
	for _, p := range append(append([]string{}, o.Include...), o.Exclude...) {
		if _, err := regexp.Compile(p); err != nil {
			return fmt.Errorf("invalid pattern %q: %v", p, err)
		}
	}
	return nil
}

func newAudit(id string, opts Options) (*Audit, error) {
	if err := opts.normalize(); err != nil {
		return nil, err
	}
	start, err := normalizeStartURL(opts.URL)
	if err != nil {
		return nil, err
	}
	if err := checkHostAllowed(start.Hostname()); err != nil {
		return nil, err
	}
	opts.URL = start.String()
	ua := userAgents[opts.UserAgent]
	if ua == "" {
		ua = opts.UserAgent
	}
	// Custom user agents fall back to the "*" robots.txt group.
	robotsUA := robotsTokens[opts.UserAgent]
	if robotsUA == "" {
		robotsUA = "*"
	}
	ctx, cancel := context.WithCancel(context.Background())
	a := &Audit{
		opts:      opts,
		ctx:       ctx,
		cancel:    cancel,
		fetcher:   NewFetcher(ua, time.Duration(opts.TimeoutSec)*time.Second),
		robotsUA:  robotsUA,
		start:     start,
		seen:      map[string]bool{},
		pages:     map[string]*Page{},
		resources: map[string]*Resource{},
		sitemap:   map[string]bool{},
		crawlGap:  time.Duration(opts.CrawlDelayMs) * time.Millisecond,
	}
	a.cond = sync.NewCond(&a.mu)
	for _, p := range opts.Include {
		a.include = append(a.include, regexp.MustCompile(p))
	}
	for _, p := range opts.Exclude {
		a.exclude = append(a.exclude, regexp.MustCompile(p))
	}
	a.report = &Report{ID: id, Status: "queued", Options: opts, StartURL: start.String(), Host: start.Hostname(), CreatedAt: time.Now()}
	a.progress.Phase = "queued"
	return a, nil
}

func (a *Audit) logf(format string, args ...any) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.logLocked(fmt.Sprintf(format, args...))
}

func (a *Audit) logLocked(s string) {
	line := time.Now().Format("15:04:05") + "  " + s
	a.progress.Log = append(a.progress.Log, line)
	if len(a.progress.Log) > 60 {
		a.progress.Log = a.progress.Log[len(a.progress.Log)-60:]
	}
}

func (a *Audit) setPhase(p string) {
	a.mu.Lock()
	a.progress.Phase = p
	a.logLocked(phaseLabel(p))
	a.mu.Unlock()
}

func phaseLabel(p string) string {
	switch p {
	case "site":
		return "Checking robots.txt, sitemaps, TLS, DNS and security headers"
	case "crawl":
		return "Crawling pages"
	case "resources":
		return "Checking images, scripts, stylesheets and external links"
	case "pagespeed":
		return "Running Lighthouse via PageSpeed Insights"
	case "analyze":
		return "Analysing duplicates, link graph and issues"
	}
	return p
}

func (a *Audit) Progress() Progress {
	a.mu.Lock()
	defer a.mu.Unlock()
	p := a.progress
	p.Log = append([]string(nil), a.progress.Log...)
	p.Crawled = int(a.crawled.Load())
	p.Queued = len(a.queue) + a.inflight
	p.Discovered = len(a.seen)
	if !p.StartedAt.IsZero() {
		p.ElapsedMs = time.Since(p.StartedAt).Milliseconds()
		if s := time.Since(p.StartedAt).Seconds(); s > 0 {
			p.PagesPerS = float64(int(float64(p.Crawled)/s*10)) / 10
		}
	}
	return p
}

// Run executes every phase; it always returns a report (possibly failed or partial).
func (a *Audit) Run() *Report {
	r := a.report
	r.Status = "running"
	r.StartedAt = time.Now()
	a.mu.Lock()
	a.progress.StartedAt = r.StartedAt
	a.mu.Unlock()

	defer func() {
		if rec := recover(); rec != nil {
			r.Status = "failed"
			r.Error = fmt.Sprintf("internal error: %v", rec)
		}
		r.FinishedAt = time.Now()
		r.DurationMs = r.FinishedAt.Sub(r.StartedAt).Milliseconds()
		a.mu.Lock()
		a.progress.Phase = r.Status
		a.mu.Unlock()
		r.Progress = a.Progress()
	}()

	if err := a.siteChecks(); err != nil {
		r.Status = "failed"
		r.Error = err.Error()
		return r
	}
	a.setPhase("crawl")
	a.crawl()
	cancelled := a.ctx.Err() != nil

	if !cancelled && (boolOr(a.opts.CheckResources, true) || boolOr(a.opts.CheckExternal, true)) {
		a.setPhase("resources")
		a.checkResources()
	}
	if !cancelled && a.ctx.Err() == nil && boolOr(a.opts.PageSpeed, false) {
		a.setPhase("pagespeed")
		a.pageSpeed()
	}
	a.setPhase("analyze")
	a.analyze()
	if a.ctx.Err() != nil {
		r.Status = "cancelled"
		if r.Error == "" {
			r.Error = "audit cancelled — partial results"
		}
	} else {
		r.Status = "done"
	}
	return r
}

// siteChecks resolves the real homepage and gathers site-wide data before crawling.
func (a *Audit) siteChecks() error {
	a.setPhase("site")
	ctx := a.ctx
	site := &a.report.Site

	// Follow the start URL's redirects to find the canonical homepage/host.
	cur := a.start.String()
	var home *FetchResult
	for i := 0; i < 10; i++ {
		p, res := probe(ctx, a.fetcher, cur, true)
		site.StartRedirects = append(site.StartRedirects, *p)
		if res.Err != nil {
			return fmt.Errorf("could not reach %s: %v", cur, res.Err)
		}
		if res.Status >= 300 && res.Status < 400 && p.Location != "" {
			cur = p.Location
			continue
		}
		home = res
		break
	}
	if home == nil {
		return errors.New("start URL redirects too many times")
	}
	final, _ := url.Parse(cur)
	final = canonicalURL(final, false)
	if len(site.StartRedirects) == 1 {
		site.StartRedirects = nil
	}
	a.start = final
	a.scope = scope{root: siteHost(final.Hostname()), includeSubdomains: a.opts.IncludeSubdomains}
	a.report.Host = final.Hostname()
	site.FinalURL = final.String()
	site.Origin = final.Scheme + "://" + final.Host
	site.Protocol = home.Proto
	site.HTTP2 = strings.HasPrefix(home.Proto, "HTTP/2")
	site.Server = home.Header.Get("Server")
	a.homeHdr = home.Header
	a.homeBody = home.Body
	site.SecurityHeaders, site.SecurityGrade = securityHeaders(home.Header, final.Scheme == "https")

	var wg sync.WaitGroup
	var mu sync.Mutex
	run := func(f func()) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() { recover() }()
			f()
		}()
	}
	host := final.Hostname()
	run(func() {
		d := lookupDNS(ctx, host)
		mu.Lock()
		site.DNS = d
		site.IP = append(append([]string{}, d.A...), d.AAAA...)
		mu.Unlock()
	})
	// Probed even for http:// sites so the report can say whether HTTPS is available at all.
	run(func() {
		t := inspectTLS(ctx, host)
		mu.Lock()
		site.TLS = t
		if t.ALPN == "h2" && final.Scheme == "https" {
			site.HTTP2 = true
		}
		mu.Unlock()
	})
	// http:// should 301 to https://
	run(func() {
		u := *final
		u.Scheme = "http"
		p, _ := probe(ctx, a.fetcher, u.String(), false)
		p.Ok = p.Status >= 300 && p.Status < 400 && strings.HasPrefix(p.Location, "https://")
		if !p.Ok && p.Error == "" && final.Scheme == "http" {
			p.Note = "site is served over plain HTTP"
		}
		mu.Lock()
		site.HTTPSRedirect = p
		mu.Unlock()
	})
	// www vs apex consolidation
	run(func() {
		u := *final
		h := final.Hostname()
		if strings.HasPrefix(h, "www.") {
			u.Host = strings.TrimPrefix(h, "www.")
		} else {
			u.Host = "www." + h
		}
		if final.Port() != "" {
			u.Host += ":" + final.Port()
		}
		p, _ := probe(ctx, a.fetcher, u.String(), false)
		switch {
		case p.Error != "":
			p.Ok, p.Note = true, "alternate host does not resolve"
		case p.Status >= 300 && p.Status < 400:
			lu, _ := url.Parse(p.Location)
			p.Ok = lu != nil && lu.Hostname() == final.Hostname()
			if !p.Ok {
				p.Note = "redirects somewhere other than " + final.Hostname()
			}
		case p.Status == 200:
			p.Ok, p.Note = false, "both hosts serve content"
		default:
			p.Ok = true
		}
		mu.Lock()
		site.WWWCheck = p
		mu.Unlock()
	})
	// Soft-404 probe with a URL that cannot exist.
	run(func() {
		u := site.Origin + "/this-page-should-not-exist-" + randomToken()
		p, _ := probe(ctx, a.fetcher, u, false)
		p.Ok = p.Status == 404 || p.Status == 410
		mu.Lock()
		site.Soft404 = p
		mu.Unlock()
	})
	wellKnown := func(path string, set func(*ProbeResult)) {
		run(func() {
			p, res := probe(ctx, a.fetcher, site.Origin+path, true)
			ct := ""
			if res.Header != nil {
				ct = strings.ToLower(res.Header.Get("Content-Type"))
			}
			p.Ok = p.Status == 200 && !strings.Contains(ct, "text/html")
			if p.Status == 200 && strings.Contains(ct, "text/html") {
				p.Note = "returns an HTML page instead of a text file"
			}
			mu.Lock()
			set(p)
			mu.Unlock()
		})
	}
	wellKnown("/llms.txt", func(p *ProbeResult) { site.LlmsTxt = p })
	wellKnown("/.well-known/security.txt", func(p *ProbeResult) { site.SecurityTxt = p })

	// robots.txt
	robotsURL := site.Origin + "/robots.txt"
	rp, rres := probe(ctx, a.fetcher, robotsURL, true)
	ri := &RobotsInfo{URL: robotsURL, Status: rp.Status}
	if rres.Status == 200 && rres.Err == nil {
		ri.Found = true
		ri.Size = len(rres.Body)
		ri.Content = firstN(string(rres.Body), 20000)
		a.robots = ParseRobots(string(rres.Body))
		ri.Sitemaps = a.robots.Sitemaps
		ri.Agents = a.robots.Agents()
		ri.CrawlDelay = a.robots.CrawlDelay(a.robotsUA)
		ri.AIBots = a.robots.BotAccessList(final, aiCrawlers)
		ri.SearchBots = a.robots.BotAccessList(final, searchCrawlers)
	} else {
		a.robots = &Robots{}
		ri.AIBots = a.robots.BotAccessList(final, aiCrawlers)
		ri.SearchBots = a.robots.BotAccessList(final, searchCrawlers)
	}
	site.Robots = ri
	if boolOr(a.opts.RespectRobots, true) && ri.CrawlDelay > 0 && a.crawlGap == 0 {
		a.crawlGap = time.Duration(min(ri.CrawlDelay, 5) * float64(time.Second))
		a.logf("robots.txt asks for crawl-delay %.1fs", ri.CrawlDelay)
	}

	// Sitemaps: robots.txt entries plus the conventional locations.
	seeds := append([]string{}, ri.Sitemaps...)
	if len(seeds) == 0 {
		seeds = append(seeds, site.Origin+"/sitemap.xml", site.Origin+"/sitemap_index.xml")
	}
	infos, entries := collectSitemaps(ctx, a.fetcher, uniqueStrings(seeds), max(a.opts.MaxPages*3, 5000))
	// The conventional fallbacks that 404 aren't errors; keep them only if nothing else was found.
	var kept []SitemapInfo
	for _, in := range infos {
		if len(ri.Sitemaps) == 0 && in.Status == 404 {
			continue
		}
		kept = append(kept, in)
	}
	site.Sitemaps = kept
	if site.Sitemaps == nil {
		site.Sitemaps = []SitemapInfo{}
	}
	for _, e := range entries {
		if u, err := url.Parse(e.Loc); err == nil {
			a.sitemap[canonicalURL(u, a.opts.StripQuery).String()] = true
		}
	}
	site.SitemapURLs = len(a.sitemap)
	wg.Wait()
	a.logf("Homepage %s (%s), %d sitemap URLs, robots.txt %s", final.String(), home.Proto, len(a.sitemap), map[bool]string{true: "found", false: "missing"}[ri.Found])
	return nil
}

func (a *Audit) allowedByPatterns(u string) bool {
	for _, re := range a.exclude {
		if re.MatchString(u) {
			return false
		}
	}
	if len(a.include) == 0 {
		return true
	}
	for _, re := range a.include {
		if re.MatchString(u) {
			return true
		}
	}
	return false
}

// enqueue adds an internal URL to the frontier (caller holds a.mu).
func (a *Audit) enqueueLocked(u string, depth int, from string, force bool) {
	if a.seen[u] {
		return
	}
	if len(a.seen) >= a.opts.MaxPages {
		a.report.Truncated = true
		return
	}
	if !force && !a.allowedByPatterns(u) {
		return
	}
	if nonPageExts[fileExt(u)] {
		return
	}
	a.seen[u] = true
	a.queue = append(a.queue, crawlJob{url: u, depth: depth, from: from})
	a.cond.Signal()
}

func (a *Audit) crawl() {
	a.mu.Lock()
	a.enqueueLocked(a.start.String(), 0, "", true)
	a.mu.Unlock()

	sitemapSeeded := false
	var wg sync.WaitGroup
	for i := 0; i < a.opts.Concurrency; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				a.mu.Lock()
				for len(a.queue) == 0 && a.inflight > 0 && a.ctx.Err() == nil {
					a.cond.Wait()
				}
				if len(a.queue) == 0 && a.inflight == 0 && !sitemapSeeded && a.ctx.Err() == nil && boolOr(a.opts.UseSitemaps, true) {
					// Link graph exhausted: crawl sitemap URLs nobody linked to (orphan candidates).
					sitemapSeeded = true
					added := 0
					for u := range a.sitemap {
						pu, err := url.Parse(u)
						if err != nil || !a.scope.internal(pu) {
							continue
						}
						before := len(a.queue)
						a.enqueueLocked(u, 0, "sitemap", false)
						if len(a.queue) > before {
							added++
						}
					}
					if added > 0 {
						a.logLocked(fmt.Sprintf("Link graph exhausted — crawling %d URLs found only in sitemaps", added))
						a.cond.Broadcast()
					}
				}
				if len(a.queue) == 0 || a.ctx.Err() != nil {
					a.cond.Broadcast()
					a.mu.Unlock()
					return
				}
				job := a.queue[0]
				a.queue = a.queue[1:]
				a.inflight++
				a.progress.Current = job.url
				a.mu.Unlock()

				a.processPage(job)

				a.mu.Lock()
				a.inflight--
				a.cond.Broadcast()
				a.mu.Unlock()
			}
		}()
	}
	// Wake waiting workers on cancellation.
	done := make(chan struct{})
	go func() {
		select {
		case <-a.ctx.Done():
			a.mu.Lock()
			a.cond.Broadcast()
			a.mu.Unlock()
		case <-done:
		}
	}()
	wg.Wait()
	close(done)
}

func (a *Audit) throttle() {
	if a.crawlGap <= 0 {
		return
	}
	a.gapMu.Lock()
	defer a.gapMu.Unlock()
	if wait := a.crawlGap - time.Since(a.lastReq); wait > 0 {
		select {
		case <-time.After(wait):
		case <-a.ctx.Done():
		}
	}
	a.lastReq = time.Now()
}

func (a *Audit) processPage(job crawlJob) {
	pu, _ := url.Parse(job.url)
	p := &Page{URL: job.url, Depth: job.depth, FoundFrom: job.from, CrawledAt: time.Now(), H1: []string{}}
	defer func() {
		a.crawled.Add(1)
		a.mu.Lock()
		a.pages[p.URL] = p
		a.pageOrder = append(a.pageOrder, p.URL)
		if p.Error != "" || p.Status >= 400 {
			a.progress.Errors++
		}
		a.mu.Unlock()
	}()

	if boolOr(a.opts.RespectRobots, true) {
		if ok, rule := a.robots.Allowed(a.robotsUA, pu); !ok {
			p.BlockedRobots = true
			p.RobotsRule = rule
			p.IndexReason = "Blocked by robots.txt"
			return
		}
	}
	a.throttle()
	res := a.fetcher.Do(a.ctx, job.url, fetchOpts{readBody: true, readIf: func(h http.Header) bool {
		return isHTMLContentType(h.Get("Content-Type"))
	}})
	p.Status = res.Status
	p.Proto = res.Proto
	p.Timing = Timing{DNSMs: ms(res.DNS), ConnectMs: ms(res.Connect), TLSMs: ms(res.TLS), TTFBMs: ms(res.TTFB), TotalMs: ms(res.Total)}
	if res.Err != nil {
		p.Error = res.Err.Error()
		return
	}
	h := res.Header
	p.ContentType = h.Get("Content-Type")
	p.Compression = strings.ToLower(h.Get("Content-Encoding"))
	p.TransferSize = res.TransferSize
	p.Size = len(res.Body)
	p.XRobots = strings.ToLower(strings.Join(h.Values("X-Robots-Tag"), ", "))
	p.Headers = map[string]string{}
	for _, k := range []string{"Server", "Cache-Control", "Content-Encoding", "Last-Modified", "ETag", "Expires", "Age", "Vary", "X-Cache", "CF-Cache-Status", "Content-Language", "Link", "Strict-Transport-Security", "Content-Security-Policy"} {
		if v := h.Get(k); v != "" {
			p.Headers[k] = firstN(v, 400)
		}
	}

	if res.Status >= 300 && res.Status < 400 {
		if loc := h.Get("Location"); loc != "" {
			target := resolveLink(pu, loc, a.opts.StripQuery)
			p.RedirectTo = target
			if tu, err := url.Parse(target); err == nil && target != "" && a.scope.internal(tu) {
				a.mu.Lock()
				a.edges = append(a.edges, LinkEdge{From: job.url, To: target, Anchor: fmt.Sprintf("[%d redirect]", res.Status)})
				a.enqueueLocked(target, job.depth, job.url, true)
				a.mu.Unlock()
			}
		}
		return
	}
	if res.Status != 200 || !isHTMLContentType(p.ContentType) || len(res.Body) == 0 {
		return
	}
	p.IsHTML = true
	if p.Compression == "" && p.TransferSize > 0 && int64(p.Size) > p.TransferSize+64 {
		p.Compression = "unknown"
	}
	ps := parseHTML(p, res.Body, p.ContentType, pu, a.opts.StripQuery)
	ws := words(ps.text)
	p.WordCount = len(ws)
	if p.Size > 0 {
		p.TextRatio = float64(int(float64(len(ps.text))/float64(p.Size)*1000)) / 10
	}
	p.Sentences = countSentences(ps.text)
	p.Readability, p.ReadingLevel = fleschReadingEase(ws, p.Sentences)
	p.Keywords = topKeywords(ws, 12)
	if len(ws) > 0 {
		p.ContentHash = contentHash(ws)
		p.Simhash = simhash(ws)
	}
	p.TextSample = firstN(ps.text, 600)
	p.TitlePx = pixelWidth(p.Title, 20)
	p.DescPx = pixelWidth(p.Description, 14)
	if kw := a.opts.Keyword; kw != "" {
		lowerText := strings.ToLower(ps.text)
		first100 := strings.Join(ws[:min(100, len(ws))], " ")
		kc := &KeywordCheck{Keyword: kw,
			InTitle:     strings.Contains(strings.ToLower(p.Title), kw),
			InDesc:      strings.Contains(strings.ToLower(p.Description), kw),
			InH1:        strings.Contains(strings.ToLower(strings.Join(p.H1, " ")), kw),
			InURL:       strings.Contains(strings.ToLower(job.url), strings.ReplaceAll(kw, " ", "-")),
			InFirst100:  strings.Contains(first100, kw),
			Occurrences: strings.Count(lowerText, kw)}
		p.KeywordCheck = kc
	}

	// Links → edges, frontier, external resources.
	nextDepth := job.depth + 1
	var internal, external, nofollow int
	links := make([]LinkRef, 0, len(ps.links))
	a.mu.Lock()
	for _, l := range ps.links {
		lu, err := url.Parse(l.URL)
		// Cloudflare's /cdn-cgi/ endpoints (email obfuscation, challenges) aren't real pages.
		if err != nil || strings.HasPrefix(lu.Path, "/cdn-cgi/") {
			continue
		}
		l.Internal = a.scope.internal(lu)
		if l.Nofollow {
			nofollow++
		}
		if l.Internal {
			internal++
			if l.URL != job.url {
				a.edges = append(a.edges, LinkEdge{From: job.url, To: l.URL, Anchor: l.Anchor, Nofollow: l.Nofollow})
			}
			if nextDepth <= a.opts.MaxDepth && !strings.Contains(p.MetaRobots+p.XRobots, "nofollow") {
				a.enqueueLocked(l.URL, nextDepth, job.url, false)
			}
		} else {
			external++
			if boolOr(a.opts.CheckExternal, true) {
				a.addResourceLocked(l.URL, "external", job.url, false)
			}
		}
		if len(links) < 1500 {
			links = append(links, l)
		}
	}
	// Canonical, hreflang and pagination targets are crawled so their status can be verified.
	for _, extra := range append([]string{p.Canonical, p.PrevURL, p.NextURL}, hreflangURLs(p.Hreflang)...) {
		if extra == "" {
			continue
		}
		if eu, err := url.Parse(extra); err == nil && a.scope.internal(eu) {
			a.enqueueLocked(canonicalURL(eu, a.opts.StripQuery).String(), nextDepth, job.url, true)
		}
	}
	if boolOr(a.opts.CheckResources, true) {
		for _, img := range ps.images {
			iu, _ := url.Parse(img.Src)
			a.addResourceLocked(img.Src, "image", job.url, iu != nil && a.scope.internal(iu))
		}
		for _, s := range ps.scripts {
			su, _ := url.Parse(s)
			a.addResourceLocked(s, "script", job.url, su != nil && a.scope.internal(su))
		}
		for _, s := range ps.styles {
			su, _ := url.Parse(s)
			a.addResourceLocked(s, "style", job.url, su != nil && a.scope.internal(su))
		}
	}
	if job.url == a.start.String() {
		a.homeHints = ps.techHints
		a.homeBody = res.Body
	}
	a.mu.Unlock()
	p.Links = links
	p.InternalLinks = internal
	p.ExternalLinks = external
	p.NofollowLinks = nofollow
	p.Images = ps.images
	if len(p.Images) > 300 {
		p.Images = p.Images[:300]
	}
	p.Scripts = ps.scripts
	p.Styles = ps.styles
}

func hreflangURLs(h []Hreflang) []string {
	out := make([]string, 0, len(h))
	for _, x := range h {
		out = append(out, x.URL)
	}
	return out
}

func (a *Audit) addResourceLocked(u, kind, foundOn string, internal bool) {
	r := a.resources[u]
	if r == nil {
		if len(a.resources) >= 8000 {
			return
		}
		r = &Resource{URL: u, Kind: kind, Internal: internal}
		a.resources[u] = r
	}
	r.FoundOnCount++
	if len(r.FoundOn) < 50 && (len(r.FoundOn) == 0 || r.FoundOn[len(r.FoundOn)-1] != foundOn) {
		r.FoundOn = append(r.FoundOn, foundOn)
	}
}

func ms(d time.Duration) int { return int(d.Milliseconds()) }

// checkResources HEADs (falling back to GET) every unique image/script/style/external URL.
func (a *Audit) checkResources() {
	a.mu.Lock()
	list := make([]*Resource, 0, len(a.resources))
	for _, r := range a.resources {
		// Pages already crawled cover internal link targets; skip them as resources.
		if r.Kind == "external" || a.pages[r.URL] == nil {
			list = append(list, r)
		}
	}
	a.progress.ResTotal = len(list)
	a.mu.Unlock()

	jobs := make(chan *Resource)
	var wg sync.WaitGroup
	var done atomic.Int64
	workers := min(max(a.opts.Concurrency*2, 8), 48)
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for r := range jobs {
				a.checkResource(r)
				n := done.Add(1)
				a.mu.Lock()
				a.progress.Resources = int(n)
				a.progress.Current = r.URL
				a.mu.Unlock()
			}
		}()
	}
	for _, r := range list {
		if a.ctx.Err() != nil {
			break
		}
		jobs <- r
	}
	close(jobs)
	wg.Wait()
}

func (a *Audit) checkResource(r *Resource) {
	cur := r.URL
	var res *FetchResult
	for hop := 0; hop < 5; hop++ {
		method := http.MethodHead
		res = a.fetcher.Do(a.ctx, cur, fetchOpts{method: method})
		// Plenty of servers mishandle HEAD; retry with GET before calling the resource broken.
		if res.Err != nil || res.Status == 405 || res.Status == 403 || res.Status == 404 || res.Status == 501 || res.Status == 400 || (r.Kind == "image" && res.Header != nil && res.Header.Get("Content-Length") == "" && res.Status == 200) {
			res = a.fetcher.Do(a.ctx, cur, fetchOpts{method: http.MethodGet, readBody: r.Kind == "image", headers: map[string]string{"Accept": "*/*"}})
		}
		if res.Err == nil && res.Status >= 300 && res.Status < 400 {
			if loc := res.Header.Get("Location"); loc != "" {
				base, _ := url.Parse(cur)
				if nu, err := base.Parse(loc); err == nil {
					if hop == 0 {
						r.RedirectTo = nu.String()
					}
					cur = nu.String()
					continue
				}
			}
		}
		break
	}
	r.Status = res.Status
	r.TimeMs = ms(res.Total)
	if res.Err != nil {
		r.Error = res.Err.Error()
		return
	}
	r.ContentType = res.Header.Get("Content-Type")
	r.CacheControl = res.Header.Get("Cache-Control")
	r.Compression = strings.ToLower(res.Header.Get("Content-Encoding"))
	if len(res.Body) > 0 {
		r.Size = int64(len(res.Body))
		if r.Compression != "" {
			r.Size = res.TransferSize
		}
	} else if cl := res.Header.Get("Content-Length"); cl != "" {
		fmt.Sscanf(cl, "%d", &r.Size)
	}
}

func (a *Audit) pageSpeed() {
	target := a.start.String()
	var wg sync.WaitGroup
	runs := make([]PageSpeedRun, 2)
	for i, s := range []string{"mobile", "desktop"} {
		wg.Add(1)
		go func(i int, s string) {
			defer wg.Done()
			runs[i] = runPageSpeed(a.ctx, target, s, a.opts.PageSpeedKey)
		}(i, s)
	}
	wg.Wait()
	a.report.Site.PageSpeed = runs
	for _, r := range runs {
		if r.Error != "" {
			a.logf("PageSpeed (%s): %s", r.Strategy, r.Error)
		}
	}
}
