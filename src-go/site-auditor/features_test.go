package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func runAudit(t *testing.T, opts Options) *Report {
	t.Helper()
	t.Setenv("TOOLS_ALLOW_PRIVATE_TARGETS", "1")
	if opts.Concurrency == 0 {
		opts.Concurrency = 4
	}
	if opts.TimeoutSec == 0 {
		opts.TimeoutSec = 5
	}
	a, err := newAudit("test", opts)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan *Report)
	go func() { done <- a.Run() }()
	select {
	case r := <-done:
		if r.Status != "done" {
			t.Fatalf("status %s: %s", r.Status, r.Error)
		}
		return r
	case <-time.After(90 * time.Second):
		t.Fatal("audit timed out")
	}
	return nil
}

func pagePaths(r *Report) map[string]*Page {
	out := map[string]*Page{}
	for _, p := range r.Pages {
		i := strings.Index(p.URL[8:], "/")
		out[p.URL[8+i:]] = p
	}
	return out
}

func TestListMode(t *testing.T) {
	srv, ext := fixtureSite(t)
	defer srv.Close()
	defer ext.Close()
	r := runAudit(t, Options{Mode: "list", URLs: []string{srv.URL + "/about", srv.URL + "/dup1", "https://other.example/x"}})
	got := pagePaths(r)
	if got["/about"] == nil || got["/dup1"] == nil {
		t.Fatalf("listed pages missing: %v", got)
	}
	// The home page is linked from both but must not be crawled in list mode.
	if got["/"] != nil || got["/broken"] != nil {
		t.Errorf("list mode followed links: %v", got)
	}
	if issueURLs(r, "orphan-page") != nil || issueURLs(r, "no-outlinks") != nil {
		t.Errorf("link-graph checks must be off in list mode")
	}
	if issueURLs(r, "thin-content") == nil {
		t.Errorf("page checks should still run")
	}
}

func TestSitemapMode(t *testing.T) {
	srv, ext := fixtureSite(t)
	defer srv.Close()
	defer ext.Close()
	r := runAudit(t, Options{URL: srv.URL, Mode: "sitemap"})
	got := pagePaths(r)
	for _, p := range []string{"/", "/about", "/orphan", "/noindex", "/old"} {
		if got[p] == nil {
			t.Errorf("sitemap URL %s not audited", p)
		}
	}
	if got["/dup1"] != nil || got["/broken"] != nil {
		t.Errorf("sitemap mode crawled linked-only URLs")
	}
}

func TestSubfolderIgnoreParamsAndSearch(t *testing.T) {
	var hits atomic.Int64
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		switch r.URL.Path {
		case "/blog/", "/blog":
			hits.Add(1)
			w.Write([]byte(page("Blog index page with a long enough title", "desc", `<h1>Blog</h1><p>`+longText+`</p><a href="/blog/a?utm_source=x&id=1">A</a><a href="/blog/a?id=1&utm_medium=y">A2</a><a href="/shop/">Shop</a><span class="price">$19.99</span>`, `<!-- gtm-ABC -->`)))
		case "/blog/a":
			w.Write([]byte(page("Blog post A for the subfolder test", "desc", `<h1>A</h1><p>`+longText+`</p><a href="/blog/">Back</a><span class="price">$5</span>`, "")))
		default:
			w.Write([]byte(page("Elsewhere", "desc", `<h1>x</h1>`, "")))
		}
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	f := false
	r := runAudit(t, Options{URL: srv.URL + "/blog/", SubfolderOnly: true, IgnoreParams: []string{"tracking"}, UseSitemaps: &f,
		CustomSearch: []SearchRule{{Name: "gtm", Pattern: "GTM-"}, {Name: "no-price", Pattern: `class="price"`, Absent: true}, {Name: "re", Pattern: `\$\d+`, Regex: true, InText: true}},
		Extract:      []ExtractRule{{Name: "price", Regex: `class="price">([^<]+)<`}},
	})
	got := pagePaths(r)
	if got["/shop/"] != nil {
		t.Errorf("subfolderOnly crawled /shop/")
	}
	if got["/blog/a?id=1"] == nil {
		t.Errorf("tracking params not stripped / deduped: %v", got)
	}
	n := 0
	for u := range got {
		if strings.HasPrefix(u, "/blog/a") {
			n++
		}
	}
	if n != 1 {
		t.Errorf("expected one /blog/a variant, got %d", n)
	}
	if len(r.CustomSearch) != 3 {
		t.Fatalf("custom search results = %d", len(r.CustomSearch))
	}
	if cs := r.CustomSearch[0]; cs.Matched != 1 || !strings.HasSuffix(cs.URLs[0], "/blog/") {
		t.Errorf("gtm rule (case-insensitive) = %+v", cs)
	}
	if cs := r.CustomSearch[1]; cs.Matched != 0 {
		t.Errorf("absent rule should match nothing: %+v", cs)
	}
	if cs := r.CustomSearch[2]; cs.Matched != 2 {
		t.Errorf("regex text rule = %+v", cs)
	}
	if p := got["/blog/a?id=1"]; p == nil || len(p.Extracted["price"]) != 1 || p.Extracted["price"][0] != "$5" {
		t.Errorf("extraction = %+v", p)
	}
}

func TestDisabledChecksAndThresholds(t *testing.T) {
	r := runFixtureAudit(t, func(o *Options) {
		o.DisabledChecks = []string{"thin-content", "category:accessibility"}
		o.Thresholds = &Thresholds{TitleMin: 2}
	})
	for _, is := range r.Issues {
		if is.ID == "thin-content" || is.Category == "accessibility" {
			t.Errorf("disabled issue reported: %s", is.ID)
		}
	}
	for _, p := range r.Pages {
		for _, id := range p.Issues {
			if id == "thin-content" || strings.HasPrefix(id, "a11y-") {
				t.Errorf("disabled issue %s attached to %s", id, p.URL)
			}
		}
	}
	if hasIssueFor(r, "title-too-short", "/about") {
		t.Errorf("custom title minimum ignored")
	}
}

func TestHeadersOnlySentToSite(t *testing.T) {
	var leaked atomic.Bool
	ext := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" || r.Header.Get("X-Staging") != "" {
			leaked.Store(true)
		}
		w.Write([]byte("ok"))
	}))
	defer ext.Close()
	extURL := strings.Replace(ext.URL, "127.0.0.1", "localhost", 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u, p, ok := r.BasicAuth()
		if !ok || u != "user" || p != "secret" || r.Header.Get("X-Staging") != "1" {
			w.Header().Set("WWW-Authenticate", `Basic realm="staging"`)
			http.Error(w, "auth", 401)
			return
		}
		w.Header().Set("Content-Type", "text/html")
		w.Write([]byte(page("Staging home page behind basic auth", "d", `<h1>Hi</h1><a href="`+extURL+`/x">ext</a><img src="`+extURL+`/i.png" alt="i">`, "")))
	}))
	defer srv.Close()
	r := runAudit(t, Options{URL: srv.URL, AuthUser: "user", AuthPass: "secret", Headers: map[string]string{"X-Staging": "1"}})
	if p := pagePaths(r)["/"]; p == nil || p.Status != 200 {
		t.Fatalf("authenticated home not fetched: %+v", p)
	}
	if leaked.Load() {
		t.Errorf("credentials were sent to an external host")
	}
	if r.Options.AuthPass != redacted || r.Options.Headers["X-Staging"] != redacted {
		t.Errorf("secrets not redacted in stored options: %+v", r.Options)
	}
	b, _ := json.Marshal(r)
	if bytes.Contains(b, []byte("secret")) {
		t.Errorf("password present in serialized report")
	}
	// Re-running with redacted options must not send the placeholder.
	o := r.Options
	if err := o.normalize(); err != nil || o.AuthUser != "" || len(o.Headers) != 0 {
		t.Errorf("redacted options should normalise to no credentials: %+v %v", o, err)
	}
	if _, err := newAudit("x", Options{URL: srv.URL, Headers: map[string]string{"Host": "evil"}}); err == nil {
		t.Errorf("Host header override must be rejected")
	}
}

func TestRetryAndReverify(t *testing.T) {
	var flaky atomic.Int64
	ext := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Bot-hostile: 404 for non-browser user agents, 200 for Chrome.
		if !strings.Contains(r.UserAgent(), "Chrome") {
			http.NotFound(w, r)
			return
		}
		w.Write([]byte("ok"))
	}))
	defer ext.Close()
	extURL := strings.Replace(ext.URL, "127.0.0.1", "localhost", 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		switch r.URL.Path {
		case "/flaky":
			if flaky.Add(1) == 1 {
				http.Error(w, "busy", 503)
				return
			}
			w.Write([]byte(page("Flaky page that works the second time", "d", `<h1>f</h1><a href="/">h</a>`, "")))
		default:
			w.Write([]byte(page("Home page for the retry test suite", "d", `<h1>h</h1><a href="/flaky">f</a><a href="`+extURL+`/article">ext</a>`, "")))
		}
	}))
	defer srv.Close()
	r := runAudit(t, Options{URL: srv.URL})
	if p := pagePaths(r)["/flaky"]; p == nil || p.Status != 200 || !p.Retried {
		t.Errorf("flaky page not retried: %+v", p)
	}
	if !hasIssueFor(r, "intermittent-errors", "/flaky") {
		t.Errorf("intermittent-errors not reported")
	}
	if issueURLs(r, "broken-external-links") != nil {
		t.Errorf("bot-blocked external link should be cleared by re-verification")
	}
	for _, res := range r.Resources {
		if res.Kind == "external" && res.Reverified == "" {
			t.Errorf("external resource not re-verified: %+v", res)
		}
	}
}

func TestCompareAndHTMLReport(t *testing.T) {
	base := runFixtureAudit(t, nil)
	cur := runFixtureAudit(t, func(o *Options) { o.Exclude = []string{"/dup"} })
	// Different test servers get different ports: rewrite base URLs onto cur's origin.
	from, to := base.Site.Origin, cur.Site.Origin
	for _, p := range base.Pages {
		p.URL = strings.Replace(p.URL, from, to, 1)
	}
	for i := range base.Issues {
		for j, u := range base.Issues[i].URLs {
			base.Issues[i].URLs[j] = strings.Replace(u, from, to, 1)
		}
	}
	c := compareReports(base, cur)
	if c.RemovedCount != 2 {
		t.Errorf("removed = %d %v", c.RemovedCount, c.Removed)
	}
	found := false
	for _, d := range c.Issues {
		if d.ID == "title-duplicate" && d.After == 0 && d.FixedCount == 2 {
			found = true
		}
	}
	if !found {
		t.Errorf("title-duplicate should be fixed: %+v", c.Issues)
	}
	if c.FixedIssues == 0 {
		t.Errorf("no fixed issue types counted")
	}
	// A verifier that only ran in one audit must not show up as new.
	cur.Site.ThirdParty = &ThirdParty{Observatory: &ObservatoryResult{Check: Check{Status: "ok"}, Grade: "F"}}
	cur.Issues = append(cur.Issues, IssueResult{IssueDef: issueIndex["observatory-low-grade"], Count: 1, URLs: []string{"site"}})
	c = compareReports(base, cur)
	for _, d := range c.Issues {
		if d.ID == "observatory-low-grade" {
			t.Errorf("observatory issue compared although the baseline never ran it")
		}
	}
	if len(c.NotCompared) != 1 {
		t.Errorf("notCompared = %v", c.NotCompared)
	}
	var buf bytes.Buffer
	if err := writeHTMLReport(&buf, cur); err != nil {
		t.Fatal(err)
	}
	html := buf.String()
	for _, want := range []string{"<!DOCTYPE html>", cur.Host, "Category scores", "How to fix"} {
		if !strings.Contains(html, want) {
			t.Errorf("HTML report missing %q", want)
		}
	}
}

func TestCompareAndExportHTTP(t *testing.T) {
	t.Setenv("TOOLS_ALLOW_PRIVATE_TARGETS", "1")
	srv, ext := fixtureSite(t)
	defer srv.Close()
	defer ext.Close()
	s := NewStore(t.TempDir(), 5, 1)
	api := httptest.NewServer(newMux(s))
	defer api.Close()
	start := func(body string) string {
		res, err := http.Post(api.URL+"/api/audits", "application/json", strings.NewReader(body))
		if err != nil || res.StatusCode != 202 {
			t.Fatalf("start: %v %v", err, res.Status)
		}
		var sum AuditSummary
		json.NewDecoder(res.Body).Decode(&sum)
		res.Body.Close()
		deadline := time.Now().Add(60 * time.Second)
		for {
			r, _ := http.Get(api.URL + "/api/audits/" + sum.ID + "/progress")
			var p struct{ Status string }
			json.NewDecoder(r.Body).Decode(&p)
			r.Body.Close()
			if p.Status == "done" {
				return sum.ID
			}
			if time.Now().After(deadline) {
				t.Fatalf("audit %s not done: %s", sum.ID, p.Status)
			}
			time.Sleep(200 * time.Millisecond)
		}
	}
	first := start(fmt.Sprintf(`{"url":%q,"maxPages":30,"pageSpeedKey":"AIzaSECRET"}`, srv.URL))
	time.Sleep(10 * time.Millisecond)
	second := start(fmt.Sprintf(`{"url":%q,"maxPages":30,"exclude":["/dup"]}`, srv.URL))
	res, _ := http.Get(api.URL + "/api/audits/" + second + "/compare")
	var c Comparison
	json.NewDecoder(res.Body).Decode(&c)
	res.Body.Close()
	if res.StatusCode != 200 || c.Base.ID != first || c.RemovedCount != 2 {
		t.Errorf("compare: %d base=%s removed=%d", res.StatusCode, c.Base.ID, c.RemovedCount)
	}
	res, _ = http.Get(api.URL + "/api/audits/" + second + "/export?type=report&format=html")
	b, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if !strings.Contains(res.Header.Get("Content-Type"), "text/html") || !bytes.Contains(b, []byte("SEO site audit")) {
		t.Errorf("html export: %s", res.Header.Get("Content-Type"))
	}
	res, _ = http.Get(api.URL + "/api/audits/" + first)
	b, _ = io.ReadAll(res.Body)
	res.Body.Close()
	if bytes.Contains(b, []byte("AIzaSECRET")) {
		t.Errorf("API key leaked in overview")
	}
	raw, _ := readReport(s.path(first))
	if raw == nil || raw.Options.PageSpeedKey != "" {
		t.Errorf("API key persisted to disk")
	}
}

func TestOptionValidation(t *testing.T) {
	bad := []Options{
		{URL: "example.com", Mode: "spider"},
		{Mode: "list"},
		{URL: "example.com", CustomSearch: []SearchRule{{Pattern: "(", Regex: true}}},
		{URL: "example.com", Extract: []ExtractRule{{Name: "x", Regex: "["}}},
		{URL: "example.com", Headers: map[string]string{"X-A": "b\r\nInjected: 1"}},
	}
	for i, o := range bad {
		if err := o.normalize(); err == nil {
			t.Errorf("case %d should fail: %+v", i, o)
		}
	}
	if got := cleanURL("https://a.com/p?utm_source=x&id=2&gclid=9#f", append([]string{}, trackingParams...)); got != "https://a.com/p?id=2#f" {
		t.Errorf("cleanURL = %s", got)
	}
	for in, want := range map[string]string{"/": "/", "/blog": "/blog/", "/blog/": "/blog/", "/blog/post.html": "/blog/", "/a/b": "/a/b/"} {
		u := mustURL(in)
		if got := folderPrefix(u); got != want {
			t.Errorf("folderPrefix(%s) = %s, want %s", in, got, want)
		}
	}
}
