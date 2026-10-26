package main

import (
	"net/http"
	"net/url"
	"strings"
	"testing"
)

func TestRobots(t *testing.T) {
	r := ParseRobots(`# comment
User-agent: Googlebot
Disallow: /nogoogle
Allow: /nogoogle/ok$

User-agent: *
User-agent: Other
Disallow: /private
Allow: /private/public
Disallow: /*.pdf$
Crawl-delay: 2
Sitemap: https://example.com/sitemap.xml
`)
	cases := []struct {
		agent, path string
		want        bool
	}{
		{"Googlebot", "/private", true}, // Googlebot group wins and doesn't block /private
		{"Googlebot", "/nogoogle/x", false},
		{"Googlebot", "/nogoogle/ok", true},
		{"Googlebot-Image", "/nogoogle", false}, // prefix match on token
		{"*", "/private/x", false},
		{"*", "/private/public/x", true},
		{"*", "/files/a.pdf", false},
		{"*", "/files/a.pdf?x=1", true},
		{"bingbot", "/", true},
	}
	for _, c := range cases {
		u, _ := url.Parse("https://example.com" + c.path)
		if got, rule := r.Allowed(c.agent, u); got != c.want {
			t.Errorf("%s %s = %v (%s), want %v", c.agent, c.path, got, rule, c.want)
		}
	}
	if len(r.Sitemaps) != 1 || r.CrawlDelay("bingbot") != 2 {
		t.Errorf("sitemaps %v delay %v", r.Sitemaps, r.CrawlDelay("bingbot"))
	}
	if ParseRobots("User-agent: *\nDisallow:\n").DisallowsEverything("*") {
		t.Errorf("empty Disallow allows everything")
	}
	if !ParseRobots("User-agent: *\nDisallow: /\n").DisallowsEverything("*") {
		t.Errorf("Disallow: / blocks everything")
	}
}

func TestNormalizeAndResolve(t *testing.T) {
	u, err := normalizeStartURL("Example.COM:443/a#frag")
	if err != nil || u.String() != "https://example.com/a" {
		t.Fatalf("got %v %v", u, err)
	}
	if _, err := normalizeStartURL("ftp://x"); err == nil {
		t.Errorf("ftp should be rejected")
	}
	base, _ := url.Parse("https://example.com/dir/page")
	cases := map[string]string{
		"../x?b=1#y":            "https://example.com/x?b=1",
		"//cdn.example.com/a":   "https://cdn.example.com/a",
		"mailto:a@b.c":          "",
		"javascript:void(0)":    "",
		"#top":                  "",
		"HTTP://EXAMPLE.com:80": "http://example.com/",
	}
	for in, want := range cases {
		if got := resolveLink(base, in, false); got != want {
			t.Errorf("resolve %q = %q, want %q", in, got, want)
		}
	}
	if got := resolveLink(base, "/a?b=1", true); got != "https://example.com/a" {
		t.Errorf("strip query: %s", got)
	}
	sc := scope{root: "example.com"}
	for in, want := range map[string]bool{"https://www.example.com/": true, "https://example.com/": true, "https://blog.example.com/": false, "https://evil-example.com/": false} {
		pu, _ := url.Parse(in)
		if sc.internal(pu) != want {
			t.Errorf("internal(%s) != %v", in, want)
		}
	}
	sc.includeSubdomains = true
	pu, _ := url.Parse("https://blog.example.com/")
	if !sc.internal(pu) {
		t.Errorf("subdomain should be internal")
	}
}

func TestParseHTML(t *testing.T) {
	html := `<!doctype html><html lang="en"><head><base href="https://example.com/sub/">
<title>Hello  World</title><title>Second</title><meta name="description" content="Desc here">
<meta name="robots" content="NOINDEX"><link rel="canonical" href="/canon">
<meta property="og:title" content="OG"><meta name="twitter:card" content="summary">
<link rel="stylesheet" href="style.css"><script src="app.js"></script><script src="later.js" defer></script>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Article","headline":"x"},{"@type":"BreadcrumbList"}]}</script>
<script type="application/ld+json">{bad json</script>
</head><body><h1>Main</h1><h3>Skipped</h3>
<a href="page2">Page two</a><a href="page2" rel="nofollow">again</a><a href="https://other.com/">Other</a><a href="#x"></a><a href="/x"></a>
<img src="a.jpg"><img src="b.webp" alt="B" width="10" height="10" loading="lazy">
<label for="f1">Name</label><input id="f1"><input id="f2"><button><svg></svg></button>
<p>Some text here for counting words.</p><font>old</font><div id="d"></div><div id="d"></div>
</body></html>`
	p := &Page{}
	u, _ := url.Parse("https://example.com/sub/index.html")
	ps := parseHTML(p, []byte(html), "text/html", u, false)
	if p.Title != "Hello World" || p.TitleCount != 2 || p.Description != "Desc here" {
		t.Errorf("title/desc: %q %d %q", p.Title, p.TitleCount, p.Description)
	}
	if p.Canonical != "https://example.com/canon" || p.MetaRobots != "noindex" {
		t.Errorf("canonical/robots: %q %q", p.Canonical, p.MetaRobots)
	}
	if len(p.H1) != 1 || p.A11y.SkippedHeadings != 1 || p.Lang != "en" || !p.Doctype {
		t.Errorf("h1=%v skipped=%d lang=%q", p.H1, p.A11y.SkippedHeadings, p.Lang)
	}
	if len(ps.links) != 3 {
		t.Fatalf("links: %+v", ps.links)
	}
	if ps.links[0].URL != "https://example.com/sub/page2" || ps.links[0].Nofollow {
		t.Errorf("first link %+v (followed occurrence should win)", ps.links[0])
	}
	if p.A11y.EmptyLinks != 2 || p.A11y.InputsNoLabel != 1 || p.A11y.ButtonsNoName != 1 || p.A11y.DuplicateIDs != 1 || p.A11y.ImagesNoAlt != 1 {
		t.Errorf("a11y %+v", p.A11y)
	}
	if p.RenderBlocking != 2 || len(ps.scripts) != 2 || len(ps.styles) != 1 {
		t.Errorf("render-blocking %d scripts %v styles %v", p.RenderBlocking, ps.scripts, ps.styles)
	}
	if len(p.Schema) != 2 || len(p.Schema[0].Types) != 2 || len(p.Schema[1].Errors) == 0 {
		t.Errorf("schema %+v", p.Schema)
	}
	foundBreadcrumbErr := false
	for _, e := range p.Schema[0].Errors {
		if strings.Contains(e, "BreadcrumbList: missing required property \"itemListElement\"") {
			foundBreadcrumbErr = true
		}
	}
	if !foundBreadcrumbErr {
		t.Errorf("breadcrumb error missing: %v", p.Schema[0].Errors)
	}
	if p.OpenGraph["og:title"] != "OG" || p.Twitter["twitter:card"] != "summary" {
		t.Errorf("social %v %v", p.OpenGraph, p.Twitter)
	}
	if len(ps.images) != 2 || ps.images[0].HasAlt || !ps.images[1].Lazy || ps.images[1].Format != "webp" {
		t.Errorf("images %+v", ps.images)
	}
	if len(p.Deprecated) != 1 || !strings.Contains(ps.text, "Some text here") {
		t.Errorf("deprecated %v text %q", p.Deprecated, ps.text)
	}
}

func TestTextMetrics(t *testing.T) {
	ws := words("The cat sat on the mat. The cat is happy! Is it? Yes, the cat's mat is red. " + strings.Repeat("Simple words make easy reading. ", 10))
	score, label := fleschReadingEase(ws, countSentences(strings.Repeat("a. ", 14)))
	if score < 60 || label == "" {
		t.Errorf("simple text should read easily: %v %q", score, label)
	}
	kw := topKeywords(words(strings.Repeat("site audit tool checks site audit issues. ", 5)), 5)
	if len(kw) == 0 || kw[0].Term != "site audit" {
		t.Errorf("keywords %+v", kw)
	}
	a := words(longText + longText)
	b := append(append([]string{}, a...), "one", "extra", "sentence")
	if d := hamming(simhash(a), simhash(b)); d > 3 {
		t.Errorf("near-identical texts differ by %d bits", d)
	}
	c := words(strings.Repeat("completely different content about cooking pasta recipes tonight ", 20))
	if d := hamming(simhash(a), simhash(c)); d < 10 {
		t.Errorf("different texts too similar: %d", d)
	}
	if w := pixelWidth(strings.Repeat("a", 60), 20); w < 500 || w > 700 {
		t.Errorf("pixel width %d", w)
	}
}

func TestSecurityHeadersAndTech(t *testing.T) {
	h := http.Header{}
	h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
	h.Set("Content-Security-Policy", "default-src 'self'; frame-ancestors 'self'")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
	h.Set("Permissions-Policy", "camera=()")
	h.Set("Server", "nginx/1.25.3")
	h.Add("Set-Cookie", "PHPSESSID=abc; path=/")
	checks, g := securityHeaders(h, true)
	if g != "A" && g != "A+" {
		t.Errorf("grade %s", g)
	}
	leak := false
	for _, c := range checks {
		if c.Name == "Server banner" && !c.Good {
			leak = true
		}
	}
	if !leak {
		t.Errorf("server version leak not flagged")
	}
	_, g2 := securityHeaders(http.Header{}, true)
	if g2 != "F" {
		t.Errorf("no headers grade = %s", g2)
	}
	body := []byte(`<html><head><meta name="generator" content="WordPress 6.4.2"><link href="/wp-content/themes/x/style.css"><script src="https://www.googletagmanager.com/gtm.js?id=GTM-1"></script><script src="/js/jquery-3.7.1.min.js"></script></head></html>`)
	tech := detectTech(h, body, []string{"generator:WordPress 6.4.2", "/js/jquery-3.7.1.min.js"})
	names := map[string]string{}
	for _, x := range tech {
		names[x.Name] = x.Version
	}
	for _, want := range []string{"WordPress", "Nginx", "PHP", "Google Tag Manager", "jQuery"} {
		if _, ok := names[want]; !ok {
			t.Errorf("tech %s not detected (got %v)", want, names)
		}
	}
	if names["WordPress"] != "6.4.2" || names["Nginx"] != "1.25.3" || names["jQuery"] != "3.7.1" {
		t.Errorf("versions %v", names)
	}
}

func TestScore(t *testing.T) {
	perfect, _ := score(nil)
	if perfect != 100 {
		t.Errorf("no issues = %d", perfect)
	}
	bad, cats := score([]IssueResult{
		{IssueDef: issueIndex["http-4xx"], Ratio: 0.5},
		{IssueDef: issueIndex["title-missing"], Ratio: 1},
		{IssueDef: issueIndex["no-hsts"], Ratio: 1},
	})
	if bad >= 85 || bad <= 40 || cats["crawl"] >= 100 || cats["social"] != 100 {
		t.Errorf("score %d cats %v", bad, cats)
	}
	for _, d := range issueCatalog {
		if d.Why == "" || d.Fix == "" || sevWeight[d.Severity] == 0 {
			t.Errorf("incomplete issue %s", d.ID)
		}
		found := false
		for _, c := range Categories {
			if c.ID == d.Category {
				found = true
			}
		}
		if !found {
			t.Errorf("issue %s has unknown category %s", d.ID, d.Category)
		}
	}
}
