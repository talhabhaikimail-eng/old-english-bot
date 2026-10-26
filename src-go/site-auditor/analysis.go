package main

import (
	"fmt"
	"math"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

var hreflangRe = regexp.MustCompile(`^(x-default|[a-z]{2,3}(-([a-z]{4}))?(-([a-z]{2}|\d{3}))?)$`)
var loremRe = regexp.MustCompile(`(?i)lorem ipsum|dolor sit amet`)
var fixedWidthRe = regexp.MustCompile(`width=\d`)

func isBrokenStatus(s int) bool { return s >= 400 }

// externalBroken treats only definitive failures as broken: many sites answer bots with 403/429/999.
func externalBroken(r *Resource) bool {
	if r.Error != "" {
		return !strings.Contains(r.Error, "timed out") && r.Error != errBlockedTarget.Error()
	}
	return r.Status == 404 || r.Status == 410 || (r.Status >= 500 && r.Status <= 599)
}

func (a *Audit) analyze() {
	r := a.report
	a.mu.Lock()
	defer a.mu.Unlock()

	pages := make([]*Page, 0, len(a.pageOrder))
	for _, u := range a.pageOrder {
		pages = append(pages, a.pages[u])
	}
	byURL := a.pages
	start := a.start.String()

	// ── Link graph: inlinks, click depth, PageRank ──
	inlinks := map[string]int{}
	uniqueFrom := map[string]map[string]bool{}
	out := map[string][]string{}
	for _, e := range a.edges {
		inlinks[e.To]++
		if uniqueFrom[e.To] == nil {
			uniqueFrom[e.To] = map[string]bool{}
		}
		uniqueFrom[e.To][e.From] = true
		if !e.Nofollow {
			out[e.From] = append(out[e.From], e.To)
		}
	}
	depth := map[string]int{start: 0}
	queue := []string{start}
	for len(queue) > 0 {
		u := queue[0]
		queue = queue[1:]
		for _, v := range out[u] {
			if _, ok := depth[v]; !ok {
				depth[v] = depth[u] + 1
				queue = append(queue, v)
			}
		}
	}
	pr := pageRank(pages, out)
	for _, p := range pages {
		p.Inlinks = inlinks[p.URL]
		p.UniqueInlinks = len(uniqueFrom[p.URL])
		if d, ok := depth[p.URL]; ok {
			p.Depth = d
		} else {
			p.Depth = -1 // not reachable by following links from the homepage
		}
		p.LinkScore = pr[p.URL]
		p.InSitemap = a.sitemap[p.URL]
	}

	// ── Indexability ──
	for _, p := range pages {
		p.Indexable, p.IndexReason = indexability(p)
	}

	c := newCollector()
	sum := &r.Summary
	sum.StatusCodes = map[string]int{}
	sum.DepthHist = map[string]int{}
	sum.ContentTypes = map[string]int{}
	sum.TTFBHist = map[string]int{}
	sum.WordHist = map[string]int{}
	sum.SchemaTypes = map[string]int{}

	// ── Redirect chains ──
	for _, p := range pages {
		if p.RedirectTo == "" {
			continue
		}
		ch := RedirectChain{Start: p.URL, Hops: []RedirectHop{{URL: p.URL, Status: p.Status}}}
		visited := map[string]bool{p.URL: true}
		cur := p.RedirectTo
		for i := 0; i < 15; i++ {
			if visited[cur] {
				ch.Loop = true
				break
			}
			visited[cur] = true
			np := byURL[cur]
			if np == nil {
				ch.Final = cur
				if res := a.resources[cur]; res != nil {
					ch.FinalStatus = res.Status
				}
				break
			}
			if np.RedirectTo == "" {
				ch.Final = cur
				ch.FinalStatus = np.Status
				break
			}
			ch.Hops = append(ch.Hops, RedirectHop{URL: cur, Status: np.Status})
			cur = np.RedirectTo
		}
		if ch.Loop || len(ch.Hops) > 1 {
			r.Chains = append(r.Chains, ch)
		}
		if ch.Loop {
			c.add("redirect-loop", p.URL, "")
		} else if len(ch.Hops) > 1 {
			c.add("redirect-chain", p.URL, fmt.Sprintf("%d hops → %s", len(ch.Hops), ch.Final))
		}
		if !ch.Loop && ch.FinalStatus >= 400 {
			c.add("redirect-broken", p.URL, fmt.Sprintf("ends at %s (%d)", ch.Final, ch.FinalStatus))
		}
		if p.Status == 302 || p.Status == 307 || p.Status == 303 {
			c.add("redirect-temporary", p.URL, fmt.Sprintf("%d → %s", p.Status, p.RedirectTo))
		}
		if inlinks[p.URL] > 0 {
			c.add("redirect-internal", p.URL, "→ "+p.RedirectTo)
		}
	}

	// ── Duplicate groups (indexable HTML pages only) ──
	group := func(key func(*Page) string) []DupGroup {
		m := map[string][]string{}
		for _, p := range pages {
			if !p.IsHTML || !p.Indexable {
				continue
			}
			if k := key(p); k != "" {
				m[k] = append(m[k], p.URL)
			}
		}
		var g []DupGroup
		for k, urls := range m {
			if len(urls) > 1 {
				g = append(g, DupGroup{Value: k, URLs: urls})
			}
		}
		sort.Slice(g, func(i, j int) bool { return len(g[i].URLs) > len(g[j].URLs) })
		return g
	}
	r.DupTitles = group(func(p *Page) string { return strings.ToLower(p.Title) })
	r.DupDescs = group(func(p *Page) string { return strings.ToLower(p.Description) })
	r.DupH1 = group(func(p *Page) string {
		if len(p.H1) == 0 {
			return ""
		}
		return strings.ToLower(p.H1[0])
	})
	r.DupContent = group(func(p *Page) string {
		if p.WordCount < 30 {
			return ""
		}
		return p.ContentHash
	})
	for i := range r.DupContent {
		r.DupContent[i].Value = byURL[r.DupContent[i].URLs[0]].Title
	}
	inGroup := func(gs []DupGroup) map[string]int {
		m := map[string]int{}
		for _, g := range gs {
			for _, u := range g.URLs {
				m[u] = len(g.URLs)
			}
		}
		return m
	}
	dupTitle, dupDesc, dupH1, dupContent := inGroup(r.DupTitles), inGroup(r.DupDescs), inGroup(r.DupH1), inGroup(r.DupContent)

	// Near duplicates: pairwise simhash on indexable pages with real content (bounded for large crawls).
	var cand []*Page
	for _, p := range pages {
		if p.IsHTML && p.Indexable && p.WordCount >= 100 && p.Simhash != 0 {
			cand = append(cand, p)
		}
	}
	if len(cand) > 3000 {
		cand = cand[:3000]
	}
	nearSet := map[string]string{}
	for i := 0; i < len(cand); i++ {
		for j := i + 1; j < len(cand); j++ {
			if cand[i].ContentHash == cand[j].ContentHash {
				continue
			}
			if d := hamming(cand[i].Simhash, cand[j].Simhash); d <= 3 {
				sim := math.Round((1-float64(d)/64)*1000) / 10
				if len(r.NearDups) < 2000 {
					r.NearDups = append(r.NearDups, NearDup{A: cand[i].URL, B: cand[j].URL, Similarity: sim})
				}
				nearSet[cand[i].URL] = cand[j].URL
				nearSet[cand[j].URL] = cand[i].URL
			}
		}
	}

	// ── Hreflang map for return-link checks ──
	hreflangOf := map[string]map[string]bool{}
	for _, p := range pages {
		if len(p.Hreflang) > 0 {
			set := map[string]bool{}
			for _, h := range p.Hreflang {
				set[h.URL] = true
			}
			hreflangOf[p.URL] = set
		}
	}

	httpsSite := a.start.Scheme == "https"
	var ttfbSum, loadSum, wordSum, sizeSum, htmlN int
	brokenLinkTargets := 0

	for _, p := range pages {
		sum.PagesCrawled++
		switch {
		case p.BlockedRobots:
			sum.StatusCodes["blocked"]++
			sum.Blocked++
		case p.Error != "":
			sum.StatusCodes["error"]++
			sum.Failed++
		default:
			sum.StatusCodes[strconv.Itoa(p.Status)]++
		}
		if p.Status >= 300 && p.Status < 400 {
			sum.Redirects++
		}
		if p.Status >= 400 && p.Status < 500 {
			sum.ClientErrors++
		}
		if p.Status >= 500 {
			sum.ServerErrors++
		}
		if p.Depth >= 0 {
			sum.DepthHist[strconv.Itoa(min(p.Depth, 10))]++
			sum.MaxDepth = max(sum.MaxDepth, p.Depth)
		} else {
			sum.DepthHist["orphan"]++
		}
		if ct := strings.TrimSpace(strings.Split(p.ContentType, ";")[0]); ct != "" {
			sum.ContentTypes[ct]++
		}
		sum.TotalBytes += p.TransferSize
		if p.Indexable {
			sum.Indexable++
		} else if p.Status != 0 || p.BlockedRobots {
			sum.NonIndexable++
		}

		// Crawl status issues (every internal URL).
		switch {
		case p.BlockedRobots:
			if p.Inlinks > 0 {
				c.add("blocked-robots", p.URL, p.RobotsRule)
			}
		case p.Error != "":
			c.add("fetch-failed", p.URL, p.Error)
		case p.Status >= 500:
			c.add("http-5xx", p.URL, strconv.Itoa(p.Status))
		case p.Status >= 400:
			c.add("http-4xx", p.URL, strconv.Itoa(p.Status))
		}
		if p.InSitemap && !p.Indexable {
			c.add("sitemap-non-indexable", p.URL, p.IndexReason)
		}
		if strings.HasPrefix(p.URL, "http://") && httpsSite && p.Status == 200 {
			c.add("http-page", p.URL, "")
		}
		if !p.IsHTML {
			continue
		}

		// ── HTML pages ──
		htmlN++
		sum.HTMLPages++
		ttfbSum += p.Timing.TTFBMs
		loadSum += p.Timing.TotalMs
		wordSum += p.WordCount
		sizeSum += p.Size
		sum.InternalLinks += p.InternalLinks
		sum.ExternalLinks += p.ExternalLinks
		sum.Images += len(p.Images)
		sum.TTFBHist[bucket(p.Timing.TTFBMs, []int{200, 500, 800, 1500, 3000}, "ms")]++
		sum.WordHist[bucket(p.WordCount, []int{100, 300, 600, 1000, 2000}, "")]++
		for _, s := range p.Schema {
			for _, t := range s.Types {
				sum.SchemaTypes[t]++
			}
		}

		u := p.URL
		var issues []string
		add := func(id, detail string) {
			c.add(id, u, detail)
			issues = append(issues, id)
		}
		indexable := p.Indexable

		if p.Depth > 4 {
			add("deep-page", fmt.Sprintf("%d clicks", p.Depth))
		}
		if p.InSitemap && p.UniqueInlinks == 0 && u != start {
			add("orphan-page", "")
			sum.Orphans++
		} else if p.UniqueInlinks == 1 && indexable && u != start {
			add("single-inlink", "")
		}

		// Indexability
		robots := p.MetaRobots + " " + p.XRobots
		if strings.Contains(robots, "noindex") || strings.Contains(robots, "none") {
			add("noindex", strings.TrimSpace(robots))
		}
		if strings.Contains(robots, "nofollow") {
			add("nofollow-page", "")
		}
		switch {
		case p.CanonicalCount > 1:
			add("canonical-multiple", fmt.Sprintf("%d canonical tags", p.CanonicalCount))
		case p.CanonicalCount == 0:
			add("canonical-missing", "")
		}
		if p.Canonical != "" && p.Canonical != u {
			cu, _ := url.Parse(p.Canonical)
			if cu != nil && !a.scope.internal(cu) {
				add("canonical-cross-domain", p.Canonical)
			} else {
				add("canonicalised", "→ "+p.Canonical)
				if tp := byURL[p.Canonical]; tp != nil {
					switch {
					case tp.BlockedRobots || tp.Error != "" || tp.Status >= 400:
						add("canonical-broken", fmt.Sprintf("%s (%s)", p.Canonical, statusText(tp)))
					case tp.RedirectTo != "":
						add("canonical-redirect", p.Canonical+" → "+tp.RedirectTo)
					case strings.Contains(tp.MetaRobots+tp.XRobots, "noindex"):
						add("canonical-noindex", p.Canonical)
					}
				}
			}
		}
		if p.CanonicalRaw != "" && !strings.HasPrefix(p.CanonicalRaw, "http") {
			add("canonical-relative", p.CanonicalRaw)
		}
		if indexable && len(a.sitemap) > 0 && !p.InSitemap {
			add("not-in-sitemap", "")
		}

		// Content
		switch {
		case p.Title == "":
			add("title-missing", "")
		case len([]rune(p.Title)) > 60 || p.TitlePx > 580:
			add("title-too-long", fmt.Sprintf("%d chars, ~%dpx", len([]rune(p.Title)), p.TitlePx))
		case len([]rune(p.Title)) < 30:
			add("title-too-short", fmt.Sprintf("%d chars", len([]rune(p.Title))))
		}
		if p.TitleCount > 1 {
			add("title-multiple", fmt.Sprintf("%d tags", p.TitleCount))
		}
		if n := dupTitle[u]; n > 0 {
			add("title-duplicate", fmt.Sprintf("shared by %d pages", n))
		}
		if p.Title != "" && len(p.H1) > 0 && strings.EqualFold(strings.TrimSpace(p.Title), strings.TrimSpace(p.H1[0])) {
			add("title-equals-h1", "")
		}
		switch {
		case p.Description == "":
			add("desc-missing", "")
		case len([]rune(p.Description)) > 160:
			add("desc-too-long", fmt.Sprintf("%d chars", len([]rune(p.Description))))
		case len([]rune(p.Description)) < 70:
			add("desc-too-short", fmt.Sprintf("%d chars", len([]rune(p.Description))))
		}
		if p.DescCount > 1 {
			add("desc-multiple", fmt.Sprintf("%d tags", p.DescCount))
		}
		if n := dupDesc[u]; n > 0 {
			add("desc-duplicate", fmt.Sprintf("shared by %d pages", n))
		}
		nonEmptyH1 := 0
		for _, h := range p.H1 {
			if h != "" {
				nonEmptyH1++
			}
		}
		switch {
		case nonEmptyH1 == 0:
			add("h1-missing", "")
		case len(p.H1) > 1:
			add("h1-multiple", fmt.Sprintf("%d H1s", len(p.H1)))
		}
		if n := dupH1[u]; n > 0 {
			add("h1-duplicate", fmt.Sprintf("shared by %d pages", n))
		}
		if len(p.H1) > 0 && len([]rune(p.H1[0])) > 70 {
			add("h1-too-long", fmt.Sprintf("%d chars", len([]rune(p.H1[0]))))
		}
		hasH2 := false
		for _, h := range p.Headings {
			if h.Level == 2 {
				hasH2 = true
				break
			}
		}
		if !hasH2 && p.WordCount > 300 {
			add("h2-missing", "")
		}
		if indexable && p.WordCount < 200 {
			add("thin-content", fmt.Sprintf("%d words", p.WordCount))
		}
		if p.TextRatio < 10 && p.Size > 5000 {
			add("low-text-ratio", fmt.Sprintf("%.1f%%", p.TextRatio))
		}
		if n := dupContent[u]; n > 0 {
			add("duplicate-content", fmt.Sprintf("identical to %d other page(s)", n-1))
		} else if other, ok := nearSet[u]; ok {
			add("near-duplicate", "similar to "+other)
		}
		if p.Readability > 0 && p.Readability < 30 && strings.HasPrefix(strings.ToLower(p.Lang+"en"), "en") {
			add("low-readability", fmt.Sprintf("Flesch %.0f", p.Readability))
		}
		if loremRe.MatchString(p.TextSample) || loremRe.MatchString(p.Title) {
			add("lorem-ipsum", "")
		}
		if !p.Doctype {
			add("doctype-missing", "")
		}
		if p.Charset == "" && !strings.Contains(strings.ToLower(p.ContentType), "charset") {
			add("charset-missing", "")
		}
		if len(p.Deprecated) > 0 {
			add("deprecated-html", strings.Join(p.Deprecated, ", "))
		}
		if kc := p.KeywordCheck; kc != nil && indexable {
			if !kc.InTitle {
				add("keyword-missing-title", "")
			}
			if !kc.InH1 {
				add("keyword-missing-h1", "")
			}
			if !kc.InDesc {
				add("keyword-missing-desc", "")
			}
		}

		// Links
		var brokenInt, brokenExt, toRedirect, nofollowInt, httpLinks []string
		for _, l := range p.Links {
			if l.Internal {
				tp := byURL[l.URL]
				if tp != nil {
					if tp.Error != "" || isBrokenStatus(tp.Status) {
						brokenInt = append(brokenInt, l.URL)
					} else if tp.RedirectTo != "" {
						toRedirect = append(toRedirect, l.URL)
					}
				}
				if l.Nofollow {
					nofollowInt = append(nofollowInt, l.URL)
				}
				if httpsSite && strings.HasPrefix(l.URL, "http://") {
					httpLinks = append(httpLinks, l.URL)
				}
			} else if res := a.resources[l.URL]; res != nil && (res.Status != 0 || res.Error != "") && externalBroken(res) {
				brokenExt = append(brokenExt, l.URL)
			}
		}
		if len(brokenInt) > 0 {
			add("broken-internal-links", listDetail(brokenInt))
			brokenLinkTargets += len(brokenInt)
		}
		if len(brokenExt) > 0 {
			add("broken-external-links", listDetail(brokenExt))
			brokenLinkTargets += len(brokenExt)
		}
		if len(toRedirect) > 0 {
			add("links-to-redirects", listDetail(toRedirect))
		}
		if len(nofollowInt) > 0 {
			add("nofollow-internal", listDetail(nofollowInt))
		}
		if len(httpLinks) > 0 {
			add("http-links", listDetail(httpLinks))
		}
		if p.InternalLinks == 0 {
			add("no-outlinks", "")
		}
		if p.InternalLinks+p.ExternalLinks > 300 {
			add("too-many-links", fmt.Sprintf("%d links", p.InternalLinks+p.ExternalLinks))
		}
		if p.A11y.GenericLinkTexts > 0 {
			add("generic-anchors", fmt.Sprintf("%d links", p.A11y.GenericLinkTexts))
		}

		// Performance
		if p.Timing.TTFBMs > 800 {
			add("slow-ttfb", fmt.Sprintf("%d ms", p.Timing.TTFBMs))
		}
		if p.Timing.TotalMs > 3000 {
			add("slow-page", fmt.Sprintf("%.1f s", float64(p.Timing.TotalMs)/1000))
		}
		if p.Size > 500*1024 {
			add("large-html", fmt.Sprintf("%d KB", p.Size/1024))
		}
		if p.DOMNodes > 1500 {
			add("excessive-dom", fmt.Sprintf("%d elements, depth %d", p.DOMNodes, p.DOMDepth))
		}
		if p.Compression == "" && p.Size > 2048 {
			add("no-compression", fmt.Sprintf("%d KB uncompressed", p.Size/1024))
		}
		if p.RenderBlocking > 2 {
			add("render-blocking", fmt.Sprintf("%d resources", p.RenderBlocking))
		}
		if len(p.Scripts) > 25 {
			add("too-many-scripts", fmt.Sprintf("%d scripts", len(p.Scripts)))
		}
		if len(p.Styles) > 10 {
			add("too-many-css", fmt.Sprintf("%d stylesheets", len(p.Styles)))
		}
		if p.InlineScriptKB+p.InlineStyleKB > 100 {
			add("large-inline-code", fmt.Sprintf("%d KB JS, %d KB CSS", p.InlineScriptKB, p.InlineStyleKB))
		}
		var brokenAssets []string
		for _, s := range append(append([]string{}, p.Scripts...), p.Styles...) {
			if res := a.resources[s]; res != nil && (res.Status >= 400 || (res.Error != "" && res.Internal)) {
				brokenAssets = append(brokenAssets, s)
			}
		}
		if len(brokenAssets) > 0 {
			add("broken-assets", listDetail(brokenAssets))
		}

		// Images
		var noAlt, brokenImg, largeImg, noDim, legacy []string
		noLazy := 0
		for i := range p.Images {
			img := &p.Images[i]
			if res := a.resources[img.Src]; res != nil {
				img.Status = res.Status
				img.Size = res.Size
			}
			if !img.HasAlt {
				noAlt = append(noAlt, img.Src)
			}
			if img.Status >= 400 {
				brokenImg = append(brokenImg, img.Src)
			}
			if img.Size > 200*1024 && img.Format != "svg" {
				largeImg = append(largeImg, fmt.Sprintf("%s (%d KB)", img.Src, img.Size/1024))
			}
			if (img.Width == "" || img.Height == "") && img.Format != "svg" {
				noDim = append(noDim, img.Src)
			}
			if img.Format == "jpeg" || img.Format == "png" || img.Format == "gif" || img.Format == "bmp" {
				legacy = append(legacy, img.Src)
			}
			if i >= 3 && !img.Lazy {
				noLazy++
			}
		}
		if len(noAlt) > 0 {
			add("img-missing-alt", listDetail(noAlt))
		}
		if len(brokenImg) > 0 {
			add("img-broken", listDetail(brokenImg))
		}
		if len(largeImg) > 0 {
			add("img-large", listDetail(largeImg))
		}
		if len(noDim) > 0 {
			add("img-no-dimensions", listDetail(noDim))
		}
		if len(legacy) > 0 {
			add("img-legacy-format", fmt.Sprintf("%d of %d images", len(legacy), len(p.Images)))
		}
		if noLazy >= 3 {
			add("img-no-lazy", fmt.Sprintf("%d images", noLazy))
		}

		// Security
		if len(p.MixedContent) > 0 {
			add("mixed-content", listDetail(p.MixedContent))
		}

		// Structured data
		hasSchema := len(p.Schema) > 0
		var schemaErr, schemaWarn []string
		for _, s := range p.Schema {
			for _, e := range s.Errors {
				if strings.HasSuffix(e, "(warning)") {
					schemaWarn = append(schemaWarn, strings.TrimSuffix(e, " (warning)"))
				} else {
					schemaErr = append(schemaErr, e)
				}
			}
		}
		if !hasSchema && indexable {
			add("schema-missing", "")
		}
		if len(schemaErr) > 0 {
			add("schema-invalid", strings.Join(uniqueStrings(schemaErr), "; "))
		}
		if len(schemaWarn) > 0 {
			add("schema-warnings", strings.Join(uniqueStrings(schemaWarn), "; "))
		}

		// Mobile
		vp := strings.ToLower(strings.ReplaceAll(p.Viewport, " ", ""))
		switch {
		case p.Viewport == "":
			add("viewport-missing", "")
		default:
			if strings.Contains(vp, "user-scalable=no") || strings.Contains(vp, "user-scalable=0") || maxScaleBelow2(vp) {
				add("viewport-no-zoom", p.Viewport)
			}
			if !strings.Contains(vp, "device-width") && fixedWidthRe.MatchString(vp) {
				add("viewport-fixed", p.Viewport)
			}
		}

		// International
		if p.Lang == "" {
			add("lang-missing", "")
		}
		if len(p.Hreflang) > 0 {
			self, xdef := false, false
			var invalid, broken, noReturn []string
			for _, h := range p.Hreflang {
				if !hreflangRe.MatchString(h.Lang) {
					invalid = append(invalid, h.Lang)
				}
				if h.Lang == "x-default" {
					xdef = true
				}
				if h.URL == u {
					self = true
					continue
				}
				if tp := byURL[h.URL]; tp != nil {
					if tp.Status != 200 || tp.RedirectTo != "" {
						broken = append(broken, h.URL)
					} else if tp.IsHTML && !hreflangOf[h.URL][u] {
						noReturn = append(noReturn, h.URL)
					}
				}
			}
			if len(invalid) > 0 {
				add("hreflang-invalid", strings.Join(invalid, ", "))
			}
			if !self {
				add("hreflang-no-self", "")
			}
			if len(broken) > 0 {
				add("hreflang-broken", listDetail(broken))
			}
			if len(noReturn) > 0 {
				add("hreflang-no-return", listDetail(noReturn))
			}
			if !xdef {
				add("hreflang-no-xdefault", "")
			}
		}

		// Social
		if indexable {
			var missing []string
			for _, k := range []string{"og:title", "og:description", "og:image"} {
				if p.OpenGraph[k] == "" {
					missing = append(missing, k)
				}
			}
			if len(missing) > 0 {
				add("og-missing", strings.Join(missing, ", "))
			}
			if p.Twitter["twitter:card"] == "" {
				add("twitter-missing", "")
			}
		}

		// Accessibility
		if p.A11y.EmptyLinks > 0 {
			add("a11y-empty-links", fmt.Sprintf("%d links", p.A11y.EmptyLinks))
		}
		if p.A11y.ButtonsNoName > 0 {
			add("a11y-buttons", fmt.Sprintf("%d buttons", p.A11y.ButtonsNoName))
		}
		if p.A11y.InputsNoLabel > 0 {
			add("a11y-inputs", fmt.Sprintf("%d fields", p.A11y.InputsNoLabel))
		}
		if p.A11y.SkippedHeadings > 0 {
			add("a11y-headings", fmt.Sprintf("%d jumps", p.A11y.SkippedHeadings))
		}
		if p.A11y.DuplicateIDs > 0 {
			add("a11y-duplicate-ids", fmt.Sprintf("%d ids", p.A11y.DuplicateIDs))
		}
		if p.A11y.IframesNoTitle > 0 {
			add("a11y-iframe-title", fmt.Sprintf("%d iframes", p.A11y.IframesNoTitle))
		}
		if p.A11y.PositiveTabindex > 0 {
			add("a11y-tabindex", fmt.Sprintf("%d elements", p.A11y.PositiveTabindex))
		}

		// URL hygiene
		upper, underscore, spaces, nonASCII, tooLong, manyParams, doubleSlash := urlIssues(u)
		if upper {
			add("url-uppercase", "")
		}
		if underscore {
			add("url-underscore", "")
		}
		if spaces {
			add("url-spaces", "")
		}
		if nonASCII {
			add("url-non-ascii", "")
		}
		if tooLong {
			add("url-too-long", fmt.Sprintf("%d chars", len(u)))
		}
		if manyParams {
			add("url-params", "")
		}
		if doubleSlash {
			add("url-double-slash", "")
		}

		// AI readiness: almost no server-rendered text but plenty of JS.
		if p.WordCount < 50 && len(p.Scripts) >= 3 && p.Status == 200 {
			add("js-rendered", fmt.Sprintf("%d words in HTML, %d scripts", p.WordCount, len(p.Scripts)))
		}
		p.Issues = issues
	}

	// Attach crawl-level issues (computed before the HTML loop) to their pages too.
	for id, res := range c.byID {
		if res.Site {
			continue
		}
		for _, u := range res.URLs {
			if p := byURL[u]; p != nil && !p.IsHTML {
				p.Issues = appendUnique(p.Issues, id)
			}
		}
	}

	if htmlN > 0 {
		sum.AvgTTFBMs = ttfbSum / htmlN
		sum.AvgLoadMs = loadSum / htmlN
		sum.AvgWords = wordSum / htmlN
		sum.AvgSizeKB = sizeSum / htmlN / 1024
	}
	sum.BrokenLinks = brokenLinkTargets

	a.assetIssues(c)
	a.siteIssues(c)

	// ── Finalise ──
	r.Issues = c.results(max(htmlN, 1))
	for _, is := range r.Issues {
		switch is.Severity {
		case "error":
			sum.Errors += is.Count
		case "warning":
			sum.Warnings += is.Count
		default:
			sum.Notices += is.Count
		}
	}
	r.Score, r.CategoryScores = score(r.Issues)
	r.Grade = grade(r.Score)
	r.Pages = pages
	r.Edges = a.edges
	r.Resources = make([]*Resource, 0, len(a.resources))
	for _, res := range a.resources {
		res.FoundOnCount = max(res.FoundOnCount, len(res.FoundOn))
		r.Resources = append(r.Resources, res)
	}
	sort.Slice(r.Resources, func(i, j int) bool { return r.Resources[i].FoundOnCount > r.Resources[j].FoundOnCount })
	if a.report.Site.Tech == nil {
		a.report.Site.Tech = []Tech{}
	}
}

// assetIssues reports problems with JS/CSS files once per asset rather than per page.
func (a *Audit) assetIssues(c *issueCollector) {
	for _, res := range a.resources {
		if res.Kind != "script" && res.Kind != "style" && res.Kind != "image" {
			continue
		}
		if res.Status != 200 {
			continue
		}
		if !hasMaxAge(res.CacheControl) && res.Internal {
			c.add("uncached-assets", res.URL, nonEmpty(res.CacheControl, "no Cache-Control"))
		}
		if res.Kind == "image" {
			continue
		}
		if res.Compression == "" && res.Size > 2048 {
			c.add("uncompressed-assets", res.URL, fmt.Sprintf("%d KB", res.Size/1024))
		}
		if res.Size > 500*1024 {
			c.add("large-assets", res.URL, fmt.Sprintf("%d KB", res.Size/1024))
		}
	}
}

func (a *Audit) siteIssues(c *issueCollector) {
	site := &a.report.Site
	home := a.start
	// Tech stack + homepage schema
	site.Tech = detectTech(a.homeHdr, a.homeBody, a.homeHints)
	if hp := a.pages[home.String()]; hp != nil {
		for _, s := range hp.Schema {
			site.HomeSchema = append(site.HomeSchema, s.Types...)
		}
		if hp.Favicon != "" {
			p, _ := probe(a.ctx, a.fetcher, hp.Favicon, false)
			p.Ok = p.Status == 200
			site.Favicon = p
		}
	}
	site.HomeSchema = uniqueStrings(site.HomeSchema)
	if site.Favicon == nil {
		p, _ := probe(a.ctx, a.fetcher, site.Origin+"/favicon.ico", false)
		p.Ok = p.Status == 200
		site.Favicon = p
	}
	if !site.Favicon.Ok {
		c.site("favicon-missing", "")
	}
	hasOrg := false
	for _, t := range site.HomeSchema {
		if t == "Organization" || t == "WebSite" || t == "LocalBusiness" || t == "Corporation" || t == "Person" || strings.HasSuffix(t, "Business") {
			hasOrg = true
		}
	}
	if !hasOrg {
		c.site("no-org-schema", "")
	}

	// HTTPS / TLS
	if home.Scheme != "https" {
		if site.TLS != nil && site.TLS.Valid {
			c.site("no-https-redirect", "site has a valid certificate but the crawl start redirects to http://")
		} else {
			c.site("no-https", "")
		}
	} else if site.HTTPSRedirect != nil && !site.HTTPSRedirect.Ok {
		d := fmt.Sprintf("http:// returned %d", site.HTTPSRedirect.Status)
		if site.HTTPSRedirect.Error != "" {
			d = "http:// " + site.HTTPSRedirect.Error
		}
		// An unreachable port 80 is acceptable; only flag when HTTP serves content or redirects elsewhere.
		if site.HTTPSRedirect.Error == "" {
			c.site("no-https-redirect", d)
		}
	}
	if t := site.TLS; t != nil && home.Scheme == "https" {
		switch {
		case !t.Valid:
			c.site("ssl-expired", nonEmpty(t.Error, "certificate invalid"))
		case t.DaysLeft < 30:
			c.site("ssl-expiring", fmt.Sprintf("expires in %d days (%s)", t.DaysLeft, t.NotAfter.Format("2006-01-02")))
		}
		if t.Version == "TLS 1.0" || t.Version == "TLS 1.1" {
			c.site("old-tls", t.Version)
		}
	}
	if !site.HTTP2 {
		c.site("http2-missing", site.Protocol)
	}
	for _, h := range site.SecurityHeaders {
		if h.Good {
			continue
		}
		switch h.Name {
		case "Strict-Transport-Security":
			if home.Scheme == "https" {
				c.site("no-hsts", h.Note)
			}
		case "Content-Security-Policy":
			c.site("no-csp", h.Note)
		case "X-Frame-Options":
			c.site("no-xfo", "")
		case "X-Content-Type-Options":
			c.site("no-xcto", "")
		case "Referrer-Policy":
			c.site("no-referrer-policy", "")
		case "Permissions-Policy":
			c.site("no-permissions-policy", "")
		case "Server banner":
			c.site("server-leak", h.Value)
		}
	}
	if d := site.DNS; d != nil && d.Error == "" {
		if d.SPF == "" {
			c.site("dns-no-spf", "")
		}
		if d.DMARC == "" {
			c.site("dns-no-dmarc", "")
		}
		if !d.CAA {
			c.site("dns-no-caa", "")
		}
	}
	if site.SecurityTxt != nil && !site.SecurityTxt.Ok {
		c.site("security-txt-missing", "")
	}

	// robots / sitemaps
	if ri := site.Robots; ri != nil {
		if !ri.Found {
			c.site("robots-missing", fmt.Sprintf("HTTP %d", ri.Status))
		} else {
			if a.robots.DisallowsEverything("*") {
				c.site("robots-blocks-all", "User-agent: * / Disallow: /")
			}
			if len(ri.Sitemaps) == 0 {
				c.site("robots-no-sitemap", "")
			}
		}
		var blockedAI, blockedSearch []string
		for _, b := range ri.AIBots {
			if !b.Allowed {
				blockedAI = append(blockedAI, b.Token)
			}
		}
		for _, b := range ri.SearchBots {
			if !b.Allowed && (b.Token == "Googlebot" || b.Token == "Bingbot") {
				blockedSearch = append(blockedSearch, b.Token)
			}
		}
		if len(blockedAI) > 0 {
			c.site("ai-bots-blocked", strings.Join(blockedAI, ", "))
		}
		if len(blockedSearch) > 0 {
			c.site("search-bots-blocked", strings.Join(blockedSearch, ", "))
		}
	}
	validSitemap := false
	var smErrs []string
	for _, s := range site.Sitemaps {
		if s.Error != "" {
			smErrs = append(smErrs, s.URL+": "+s.Error)
		} else {
			validSitemap = true
		}
	}
	if len(smErrs) > 0 {
		c.site("sitemap-invalid", strings.Join(smErrs, "; "))
	}
	if !validSitemap && len(smErrs) == 0 {
		c.site("sitemap-missing", "")
	}
	if s := site.Soft404; s != nil && s.Error == "" && s.Status == 200 {
		c.site("soft-404", s.URL+" returned 200")
	}
	if w := site.WWWCheck; w != nil && !w.Ok {
		c.site("www-duplicate", w.URL+": "+w.Note)
	}
	if l := site.LlmsTxt; l != nil && !l.Ok {
		c.site("llms-txt-missing", "")
	}
}

func indexability(p *Page) (bool, string) {
	switch {
	case p.BlockedRobots:
		return false, "Blocked by robots.txt"
	case p.Error != "":
		return false, "Fetch failed"
	case p.Status >= 300 && p.Status < 400:
		return false, "Redirect"
	case p.Status >= 400:
		return false, fmt.Sprintf("HTTP %d", p.Status)
	case p.Status != 200:
		return false, fmt.Sprintf("HTTP %d", p.Status)
	case !p.IsHTML:
		return false, "Not HTML"
	}
	robots := p.MetaRobots + " " + p.XRobots
	if strings.Contains(robots, "noindex") || strings.Contains(robots, "none") {
		return false, "Noindex"
	}
	if p.Canonical != "" && p.Canonical != p.URL {
		return false, "Canonicalised"
	}
	return true, ""
}

// pageRank computes internal PageRank over followed links, scaled to 0–100 logarithmically.
func pageRank(pages []*Page, out map[string][]string) map[string]float64 {
	nodes := map[string]bool{}
	for _, p := range pages {
		if p.Status == 200 && p.IsHTML {
			nodes[p.URL] = true
		}
	}
	n := float64(len(nodes))
	if n == 0 {
		return map[string]float64{}
	}
	rank := map[string]float64{}
	for u := range nodes {
		rank[u] = 1 / n
	}
	const d = 0.85
	for iter := 0; iter < 30; iter++ {
		next := map[string]float64{}
		dangling := 0.0
		for u := range nodes {
			var targets []string
			for _, v := range out[u] {
				if nodes[v] && v != u {
					targets = append(targets, v)
				}
			}
			if len(targets) == 0 {
				dangling += rank[u]
				continue
			}
			share := rank[u] / float64(len(targets))
			for _, v := range targets {
				next[v] += share
			}
		}
		for u := range nodes {
			next[u] = (1-d)/n + d*(next[u]+dangling/n)
		}
		rank = next
	}
	maxR := 0.0
	for _, v := range rank {
		maxR = math.Max(maxR, v)
	}
	minR := 1 / n * (1 - d)
	scaled := map[string]float64{}
	for u, v := range rank {
		s := 0.0
		if maxR > minR {
			s = math.Log(v/minR) / math.Log(maxR/minR) * 100
		}
		scaled[u] = math.Round(math.Max(1, math.Min(100, s))*10) / 10
	}
	return scaled
}

func statusText(p *Page) string {
	switch {
	case p.BlockedRobots:
		return "blocked by robots.txt"
	case p.Error != "":
		return p.Error
	}
	return strconv.Itoa(p.Status)
}

func listDetail(urls []string) string {
	urls = uniqueStrings(urls)
	if len(urls) <= 5 {
		return strings.Join(urls, "\n")
	}
	return strings.Join(urls[:5], "\n") + fmt.Sprintf("\n…and %d more", len(urls)-5)
}

func bucket(v int, edges []int, unit string) string {
	prev := 0
	for _, e := range edges {
		if v < e {
			return fmt.Sprintf("%d–%d%s", prev, e, unit)
		}
		prev = e
	}
	return fmt.Sprintf("%d+%s", prev, unit)
}

func hasMaxAge(cc string) bool {
	cc = strings.ToLower(cc)
	if strings.Contains(cc, "no-store") || strings.Contains(cc, "no-cache") {
		return false
	}
	i := strings.Index(cc, "max-age=")
	if i < 0 {
		return strings.Contains(cc, "immutable")
	}
	n, _ := strconv.Atoi(strings.TrimFunc(strings.Split(cc[i+8:], ",")[0], func(r rune) bool { return r < '0' || r > '9' }))
	return n >= 3600
}

func maxScaleBelow2(vp string) bool {
	i := strings.Index(vp, "maximum-scale=")
	if i < 0 {
		return false
	}
	v, err := strconv.ParseFloat(strings.Split(vp[i+14:], ",")[0], 64)
	return err == nil && v < 2
}

func nonEmpty(s, def string) string {
	if s == "" {
		return def
	}
	return s
}
