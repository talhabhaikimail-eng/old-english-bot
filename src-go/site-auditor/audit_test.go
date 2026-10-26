package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

const longText = `Search engine optimisation is the practice of improving a website so that it earns more organic traffic from search engines. Good pages answer a clear question, load quickly and are easy to navigate. Internal links help visitors and crawlers discover related content, while descriptive titles and meta descriptions encourage people to click. Structured data describes the entities on a page so search engines can show rich results. Accessibility matters too: images need alternative text and forms need labels. Fast servers, compressed assets and careful caching keep pages responsive on mobile networks. `

func page(title, desc, body string, extraHead string) string {
	return fmt.Sprintf(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>%s</title><meta name="description" content="%s">%s</head><body>%s</body></html>`, title, desc, extraHead, body)
}

// fixtureSite is a small site with known problems; external links point at a second server
// reached through "localhost" so it counts as another host.
func fixtureSite(t *testing.T) (*httptest.Server, *httptest.Server) {
	ext := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/dead" {
			http.NotFound(w, r)
			return
		}
		w.Write([]byte("ok"))
	}))
	extURL := strings.Replace(ext.URL, "127.0.0.1", "localhost", 1)

	mux := http.NewServeMux()
	var base string
	mux.HandleFunc("/robots.txt", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "User-agent: *\nDisallow: /private/\n\nUser-agent: GPTBot\nDisallow: /\n\nSitemap: %s/sitemap.xml\n", base)
	})
	mux.HandleFunc("/sitemap.xml", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/xml")
		fmt.Fprintf(w, `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>%[1]s/</loc></url><url><loc>%[1]s/about</loc></url><url><loc>%[1]s/orphan</loc></url><url><loc>%[1]s/noindex</loc></url><url><loc>%[1]s/old</loc></url></urlset>`, base)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		body := `<h1>Welcome to the fixture site</h1><h2>Intro</h2><p>` + longText + longText + `</p>
<a href="/about">About us</a> <a href="/broken">Broken page</a> <a href="/old">Old page</a> <a href="/noindex">Hidden</a>
<a href="/dup1">Dup one</a> <a href="/dup2">Dup two</a> <a href="/Upper_Case">Odd URL</a> <a href="/private/secret">Private</a>
<a href="/temp">Temp</a> <a href="` + extURL + `/ok">External ok</a> <a href="` + extURL + `/dead">External dead</a>
<a href="/about" rel="nofollow">click here</a> <a href="/fr/about" rel="nofollow">French</a> <a href="/about"><img src="/logo.png" alt="Logo"></a>
<img src="/missing.png"> <img src="/logo.png" alt="">`
		schema := `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Fixture","url":"/","logo":"/logo.png"}</script>`
		w.Write([]byte(page("Fixture Site – Home of the example audit test pages", "A fixture website used to verify that the site auditor finds the problems it is supposed to find.", body, `<link rel="canonical" href="/">`+schema)))
	})
	mux.HandleFunc("/about", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		head := `<link rel="canonical" href="` + base + `/about"><link rel="alternate" hreflang="en" href="` + base + `/about"><link rel="alternate" hreflang="fr" href="` + base + `/fr/about"><link rel="alternate" hreflang="english" href="` + base + `/about">` +
			`<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","description":"x"}</script>`
		w.Write([]byte(page("About", "", `<h1>About</h1><p>Short page.</p><a href="/">Home</a><form><input type="text" name="q"></form><button></button>`, head)))
	})
	mux.HandleFunc("/fr/about", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte(page("À propos de notre site d'exemple pour les tests", "Une page en français utilisée pour vérifier les liens hreflang réciproques dans l'audit.", `<h1>À propos</h1><a href="/">Accueil</a>`, `<link rel="canonical" href="`+base+`/fr/about">`)))
	})
	mux.HandleFunc("/orphan", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte(page("An orphan page only listed in the XML sitemap", "This page has no internal links pointing to it, so it should be reported as an orphan.", `<h1>Orphan</h1><p>`+longText+`</p><a href="/">Home</a>`, `<link rel="canonical" href="`+base+`/orphan">`)))
	})
	mux.HandleFunc("/noindex", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte(page("Hidden page that should not be indexed by search", "noindex test", `<h1>Hidden</h1><a href="/">Home</a>`, `<meta name="robots" content="noindex, follow">`)))
	})
	dup := func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte(page("Duplicate title shared by two different pages", "Same description on both duplicate pages of the fixture website for testing.", `<h1>Duplicate</h1><p>`+longText+`</p><a href="/">Home</a>`, "")))
	}
	mux.HandleFunc("/dup1", dup)
	mux.HandleFunc("/dup2", dup)
	mux.HandleFunc("/Upper_Case", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte(`<html><head><title>x</title></head><body><font>old</font><a href="/">home</a></body></html>`))
	})
	mux.HandleFunc("/old", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/older", http.StatusMovedPermanently)
	})
	mux.HandleFunc("/older", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/about", http.StatusMovedPermanently)
	})
	mux.HandleFunc("/temp", func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "/about", http.StatusFound) })
	mux.HandleFunc("/broken", func(w http.ResponseWriter, r *http.Request) { http.Error(w, "gone", http.StatusGone) })
	mux.HandleFunc("/logo.png", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		w.Write(make([]byte, 300*1024))
	})
	srv := httptest.NewServer(mux)
	base = srv.URL
	return srv, ext
}

func runFixtureAudit(t *testing.T, mutate func(*Options)) *Report {
	t.Setenv("TOOLS_ALLOW_PRIVATE_TARGETS", "1")
	srv, ext := fixtureSite(t)
	defer srv.Close()
	defer ext.Close()
	opts := Options{URL: srv.URL, MaxPages: 100, Concurrency: 4, TimeoutSec: 5}
	if mutate != nil {
		mutate(&opts)
	}
	a, err := newAudit("test", opts)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan *Report)
	go func() { done <- a.Run() }()
	select {
	case r := <-done:
		return r
	case <-time.After(90 * time.Second):
		t.Fatal("audit timed out")
	}
	return nil
}

func issueURLs(r *Report, id string) []string {
	for _, is := range r.Issues {
		if is.ID == id {
			return is.URLs
		}
	}
	return nil
}

func hasIssueFor(r *Report, id, suffix string) bool {
	for _, u := range issueURLs(r, id) {
		if strings.HasSuffix(u, suffix) {
			return true
		}
	}
	return false
}

func TestFixtureAudit(t *testing.T) {
	r := runFixtureAudit(t, nil)
	if r.Status != "done" {
		t.Fatalf("status %s: %s", r.Status, r.Error)
	}
	byPath := map[string]*Page{}
	for _, p := range r.Pages {
		u, _ := url.Parse(p.URL)
		byPath[u.Path] = p
	}
	for _, path := range []string{"/", "/about", "/broken", "/old", "/older", "/noindex", "/dup1", "/dup2", "/Upper_Case", "/private/secret", "/temp", "/orphan", "/fr/about"} {
		if byPath[path] == nil {
			t.Errorf("page %s not crawled", path)
		}
	}
	if p := byPath["/orphan"]; p != nil && p.Depth != -1 {
		t.Errorf("orphan depth = %d, want -1", p.Depth)
	}
	if p := byPath["/about"]; p != nil && (p.Depth != 1 || p.Inlinks < 3) {
		t.Errorf("/about depth=%d inlinks=%d", p.Depth, p.Inlinks)
	}
	if p := byPath["/private/secret"]; p != nil && !p.BlockedRobots {
		t.Errorf("/private/secret should be blocked by robots.txt")
	}
	if p := byPath["/"]; p == nil || p.LinkScore <= 0 || !p.Indexable {
		t.Errorf("home should be indexable with a link score: %+v", p)
	}

	want := map[string]string{
		"http-4xx":              "/broken",
		"redirect-chain":        "/old",
		"redirect-temporary":    "/temp",
		"blocked-robots":        "/private/secret",
		"orphan-page":           "/orphan",
		"noindex":               "/noindex",
		"sitemap-non-indexable": "/noindex",
		"title-duplicate":       "/dup1",
		"desc-duplicate":        "/dup2",
		"duplicate-content":     "/dup1",
		"desc-missing":          "/about",
		"title-too-short":       "/about",
		"thin-content":          "/about",
		"canonical-missing":     "/dup1",
		"broken-internal-links": "/",
		"broken-external-links": "/",
		"links-to-redirects":    "/",
		"nofollow-internal":     "/",
		"generic-anchors":       "/",
		"img-missing-alt":       "/",
		"img-broken":            "/",
		"img-large":             "/",
		"schema-invalid":        "/about",
		"hreflang-invalid":      "/about",
		"hreflang-no-return":    "/about",
		"hreflang-no-xdefault":  "/about",
		"a11y-inputs":           "/about",
		"a11y-buttons":          "/about",
		"url-uppercase":         "/Upper_Case",
		"url-underscore":        "/Upper_Case",
		"deprecated-html":       "/Upper_Case",
		"viewport-missing":      "/Upper_Case",
		"lang-missing":          "/Upper_Case",
		"doctype-missing":       "/Upper_Case",
		"no-compression":        "/",
	}
	for id, suffix := range want {
		if !hasIssueFor(r, id, suffix) {
			t.Errorf("expected issue %s for %s, got %v", id, suffix, issueURLs(r, id))
		}
	}
	if hasIssueFor(r, "orphan-page", "/about") {
		t.Errorf("/about is linked and must not be an orphan")
	}
	if hasIssueFor(r, "broken-external-links", "/about") {
		t.Errorf("/about has no external links")
	}
	for _, id := range []string{"ai-bots-blocked", "llms-txt-missing", "soft-404"} {
		if issueURLs(r, id) == nil && id != "soft-404" {
			t.Errorf("expected site issue %s", id)
		}
	}
	if issueURLs(r, "soft-404") != nil {
		t.Errorf("fixture returns real 404s, soft-404 should not fire")
	}
	if issueURLs(r, "sitemap-missing") != nil || issueURLs(r, "robots-missing") != nil {
		t.Errorf("robots.txt and sitemap exist")
	}
	if len(r.Chains) == 0 || len(r.Chains[0].Hops) < 2 {
		t.Errorf("redirect chain not recorded: %+v", r.Chains)
	}
	if len(r.DupTitles) != 1 || len(r.DupTitles[0].URLs) != 2 {
		t.Errorf("dup titles = %+v", r.DupTitles)
	}
	if r.Score <= 0 || r.Score >= 100 || r.Grade == "" {
		t.Errorf("score %d grade %q", r.Score, r.Grade)
	}
	if r.Summary.HTMLPages < 8 || r.Summary.Blocked != 1 || r.Summary.Orphans != 1 {
		t.Errorf("summary %+v", r.Summary)
	}
	if r.Site.Robots == nil || !r.Site.Robots.Found {
		t.Fatalf("robots not found")
	}
	gpt := false
	for _, b := range r.Site.Robots.AIBots {
		if b.Token == "GPTBot" && !b.Allowed {
			gpt = true
		}
	}
	if !gpt {
		t.Errorf("GPTBot should be reported as blocked")
	}
	if r.Site.SitemapURLs != 5 {
		t.Errorf("sitemap URLs = %d", r.Site.SitemapURLs)
	}
	// Every page-level issue URL must be a crawled URL.
	known := map[string]bool{"site": true}
	for _, p := range r.Pages {
		known[p.URL] = true
	}
	for _, is := range r.Issues {
		if is.Asset {
			continue
		}
		for _, u := range is.URLs {
			if !known[u] {
				t.Errorf("issue %s references unknown URL %s", is.ID, u)
			}
		}
	}
}

func TestMaxPagesAndPatterns(t *testing.T) {
	r := runFixtureAudit(t, func(o *Options) {
		o.MaxPages = 4
		o.Exclude = []string{"/dup"}
	})
	if len(r.Pages) > 4 {
		t.Errorf("crawled %d pages, limit 4", len(r.Pages))
	}
	for _, p := range r.Pages {
		if strings.Contains(p.URL, "/dup") {
			t.Errorf("excluded URL crawled: %s", p.URL)
		}
	}
	if !r.Truncated {
		t.Errorf("expected truncated flag")
	}
}

func TestRespectRobotsOff(t *testing.T) {
	f := false
	r := runFixtureAudit(t, func(o *Options) { o.RespectRobots = &f })
	for _, p := range r.Pages {
		if p.BlockedRobots {
			t.Errorf("%s blocked although respectRobots=false", p.URL)
		}
	}
}

func TestBlockedPrivateTarget(t *testing.T) {
	t.Setenv("TOOLS_ALLOW_PRIVATE_TARGETS", "")
	t.Setenv("AUDITOR_ALLOW_PRIVATE", "")
	for _, u := range []string{"http://127.0.0.1:8080", "http://localhost/", "http://10.0.0.5", "http://[::1]/", "http://169.254.169.254/latest"} {
		if _, err := newAudit("x", Options{URL: u}); err == nil {
			t.Errorf("%s should be rejected", u)
		}
	}
	f := NewFetcher("t", 3*time.Second)
	res := f.Do(t.Context(), "http://127.0.0.1.nip.io/", fetchOpts{})
	if res.Err == nil {
		t.Errorf("DNS name resolving to loopback must be blocked")
	}
}

func TestStoreLifecycle(t *testing.T) {
	t.Setenv("TOOLS_ALLOW_PRIVATE_TARGETS", "1")
	srv, ext := fixtureSite(t)
	defer srv.Close()
	defer ext.Close()
	dir := t.TempDir()
	s := NewStore(dir, 5, 1)
	sum, err := s.Start(Options{URL: srv.URL, MaxPages: 20, Concurrency: 4, TimeoutSec: 5})
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(60 * time.Second)
	for {
		list := s.List()
		if len(list) == 1 && list[0].Status == "done" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("audit didn't finish: %+v", list)
		}
		time.Sleep(200 * time.Millisecond)
	}
	// Reload from disk.
	s2 := NewStore(dir, 5, 1)
	_, rep, err := s2.Get(sum.ID)
	if err != nil || rep == nil || len(rep.Pages) == 0 {
		t.Fatalf("reload failed: %v", err)
	}
	if err := s2.Delete(sum.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s2.Get(sum.ID); err == nil {
		t.Errorf("deleted audit still readable")
	}
}
