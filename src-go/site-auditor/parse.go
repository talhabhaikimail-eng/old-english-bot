package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/url"
	"regexp"
	"strings"
	"unicode"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
	"golang.org/x/net/html/charset"
)

// parsed holds raw extraction output that the crawler turns into a Page and new crawl targets.
type parsed struct {
	links     []LinkRef
	images    []ImageRef
	scripts   []string
	styles    []string
	text      string
	headText  string // title + headings, for keyword relevance
	baseURL   *url.URL
	techHints []string // script/link URLs + meta generator for tech detection
}

var spaceRe = regexp.MustCompile(`\s+`)

func cleanText(s string) string {
	return strings.TrimSpace(spaceRe.ReplaceAllString(s, " "))
}

func attr(n *html.Node, key string) (string, bool) {
	for _, a := range n.Attr {
		if strings.EqualFold(a.Key, key) {
			return a.Val, true
		}
	}
	return "", false
}

func attrv(n *html.Node, key string) string {
	v, _ := attr(n, key)
	return strings.TrimSpace(v)
}

// textOf returns the visible text below n (skipping script/style/template).
func textOf(n *html.Node) string {
	var b strings.Builder
	var walk func(*html.Node)
	walk = func(c *html.Node) {
		if c.Type == html.TextNode {
			b.WriteString(c.Data)
			b.WriteByte(' ')
			return
		}
		if c.Type == html.ElementNode {
			switch c.DataAtom {
			case atom.Script, atom.Style, atom.Template, atom.Noscript:
				return
			case atom.Img:
				if alt := attrv(c, "alt"); alt != "" {
					b.WriteString(alt)
					b.WriteByte(' ')
				}
			}
		}
		for ch := c.FirstChild; ch != nil; ch = ch.NextSibling {
			walk(ch)
		}
	}
	walk(n)
	return cleanText(b.String())
}

var genericAnchors = map[string]bool{
	"click here": true, "here": true, "read more": true, "more": true, "learn more": true, "this": true,
	"link": true, "this link": true, "click": true, "go": true, "continue": true, "details": true,
}

// parseHTML fills the HTML-derived fields of p and returns links/resources for the crawler.
func parseHTML(p *Page, body []byte, contentType string, pageURL *url.URL, stripQuery bool) *parsed {
	out := &parsed{baseURL: pageURL}
	r, err := charset.NewReader(bytes.NewReader(body), contentType)
	if err != nil {
		r = bytes.NewReader(body)
	}
	doc, err := html.Parse(r)
	if err != nil {
		return out
	}
	p.Doctype = bytes.Contains(bytes.ToLower(body[:min(len(body), 1024)]), []byte("<!doctype"))
	p.OpenGraph = map[string]string{}
	p.Twitter = map[string]string{}
	p.Headers = nonNilMap(p.Headers)

	// First pass: <base href> changes how every relative URL resolves, and <label for> targets
	// are needed before inputs are checked for labels.
	labelled := map[string]bool{}
	baseSeen := false
	var prepass func(*html.Node)
	prepass = func(n *html.Node) {
		if n.Type == html.ElementNode {
			switch n.DataAtom {
			case atom.Base:
				if h := attrv(n, "href"); h != "" && !baseSeen {
					baseSeen = true
					if bu, err := pageURL.Parse(h); err == nil {
						out.baseURL = bu
					}
				}
			case atom.Label:
				if f := attrv(n, "for"); f != "" {
					labelled[f] = true
				}
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			prepass(c)
		}
	}
	prepass(doc)
	base := out.baseURL
	https := pageURL.Scheme == "https"

	ids := map[string]int{}
	var bodyText strings.Builder
	inHead := false
	lastHeading := 0
	seenImg := map[string]bool{}
	imgIndex := 0

	var walk func(n *html.Node, depth int, inLink bool, inBody bool)
	walk = func(n *html.Node, depth int, inLink bool, inBody bool) {
		if n.Type == html.TextNode {
			if inBody {
				bodyText.WriteString(n.Data)
				bodyText.WriteByte(' ')
			}
			return
		}
		if n.Type != html.ElementNode {
			for c := n.FirstChild; c != nil; c = c.NextSibling {
				walk(c, depth, inLink, inBody)
			}
			return
		}
		p.DOMNodes++
		if depth > p.DOMDepth {
			p.DOMDepth = depth
		}
		if id := attrv(n, "id"); id != "" {
			ids[id]++
		}
		if ti, ok := attr(n, "tabindex"); ok {
			if v := strings.TrimSpace(ti); v != "" && v != "0" && !strings.HasPrefix(v, "-") {
				p.A11y.PositiveTabindex++
			}
		}

		switch n.DataAtom {
		case atom.Html:
			p.Lang = attrv(n, "lang")
		case atom.Head:
			inHead = true
			defer func() { inHead = false }()
		case atom.Body:
			inBody = true
		case atom.Script:
			src := attrv(n, "src")
			typ := strings.ToLower(attrv(n, "type"))
			if typ == "application/ld+json" {
				p.Schema = append(p.Schema, parseJSONLD(textContentRaw(n)))
				return
			}
			if src != "" {
				if abs := resolveLink(base, src, false); abs != "" {
					out.scripts = append(out.scripts, abs)
					out.techHints = append(out.techHints, abs)
					if https && strings.HasPrefix(abs, "http://") {
						p.MixedContent = append(p.MixedContent, abs)
					}
				}
				_, async := attr(n, "async")
				_, deferA := attr(n, "defer")
				if inHead && !async && !deferA && typ != "module" {
					p.RenderBlocking++
				}
			} else if typ == "" || strings.Contains(typ, "javascript") || typ == "module" {
				raw := textContentRaw(n)
				p.InlineScriptKB += len(raw)
				out.techHints = append(out.techHints, firstN(raw, 4000))
			}
			return
		case atom.Style:
			p.InlineStyleKB += len(textContentRaw(n))
			return
		case atom.Noscript, atom.Template:
			return
		case atom.Title:
			if !inSVG(n) {
				p.TitleCount++
				if p.TitleCount == 1 {
					p.Title = cleanText(textContentRaw(n))
				}
			}
			return
		case atom.Meta:
			name := strings.ToLower(attrv(n, "name"))
			prop := strings.ToLower(attrv(n, "property"))
			content := strings.TrimSpace(attrv(n, "content"))
			if cs := attrv(n, "charset"); cs != "" {
				p.Charset = cs
			}
			if he := strings.ToLower(attrv(n, "http-equiv")); he == "content-type" && p.Charset == "" {
				if i := strings.Index(strings.ToLower(content), "charset="); i >= 0 {
					p.Charset = strings.TrimSpace(content[i+8:])
				}
			}
			switch {
			case name == "description":
				p.DescCount++
				if p.DescCount == 1 {
					p.Description = cleanText(content)
				}
			case name == "robots" || name == "googlebot":
				// Merge both tags into one de-duplicated directive list.
				for _, d := range strings.Split(strings.ToLower(content), ",") {
					if d = strings.TrimSpace(d); d != "" && !containsDirective(p.MetaRobots, d) {
						if p.MetaRobots != "" {
							p.MetaRobots += ", "
						}
						p.MetaRobots += d
					}
				}
			case name == "viewport":
				p.Viewport = content
			case name == "generator":
				p.Generator = content
				out.techHints = append(out.techHints, "generator:"+content)
			case strings.HasPrefix(prop, "og:"):
				if _, ok := p.OpenGraph[prop]; !ok {
					p.OpenGraph[prop] = content
				}
			case strings.HasPrefix(name, "twitter:") || strings.HasPrefix(prop, "twitter:"):
				k := name
				if k == "" {
					k = prop
				}
				if _, ok := p.Twitter[k]; !ok {
					p.Twitter[k] = content
				}
			}
		case atom.Link:
			rel := strings.ToLower(attrv(n, "rel"))
			href := attrv(n, "href")
			rels := strings.Fields(rel)
			has := func(r string) bool {
				for _, x := range rels {
					if x == r {
						return true
					}
				}
				return false
			}
			switch {
			case has("canonical"):
				p.CanonicalCount++
				if p.CanonicalCount == 1 {
					p.CanonicalRaw = href
					p.Canonical = resolveLink(base, href, false)
				}
			case has("alternate") && attrv(n, "hreflang") != "":
				p.Hreflang = append(p.Hreflang, Hreflang{Lang: strings.ToLower(attrv(n, "hreflang")), URL: resolveLink(base, href, false)})
			case has("amphtml"):
				p.AMP = resolveLink(base, href, false)
			case has("prev"):
				p.PrevURL = resolveLink(base, href, false)
			case has("next"):
				p.NextURL = resolveLink(base, href, false)
			case has("icon") || has("shortcut") || has("apple-touch-icon"):
				if p.Favicon == "" {
					p.Favicon = resolveLink(base, href, false)
				}
			case has("stylesheet"):
				if abs := resolveLink(base, href, false); abs != "" {
					out.styles = append(out.styles, abs)
					out.techHints = append(out.techHints, abs)
					media := strings.ToLower(attrv(n, "media"))
					if inHead && (media == "" || media == "all" || media == "screen") {
						p.RenderBlocking++
					}
					if https && strings.HasPrefix(abs, "http://") {
						p.MixedContent = append(p.MixedContent, abs)
					}
				}
			case has("preconnect") || has("dns-prefetch") || has("preload"):
				out.techHints = append(out.techHints, href)
			}
		case atom.H1, atom.H2, atom.H3, atom.H4, atom.H5, atom.H6:
			level := int(n.Data[1] - '0')
			t := textOf(n)
			if level == 1 {
				p.H1 = append(p.H1, t)
			}
			if len(p.Headings) < 200 {
				p.Headings = append(p.Headings, Heading{Level: level, Text: firstN(t, 200)})
			}
			if lastHeading > 0 && level > lastHeading+1 {
				p.A11y.SkippedHeadings++
			}
			lastHeading = level
			out.headText += " " + t
		case atom.A:
			href, hasHref := attr(n, "href")
			if hasHref {
				anchor := textOf(n)
				label := anchor
				if label == "" {
					label = attrv(n, "aria-label")
				}
				if label == "" {
					label = attrv(n, "title")
				}
				imgLink := hasChild(n, atom.Img)
				if label == "" && !imgLink {
					p.A11y.EmptyLinks++
				}
				if genericAnchors[strings.ToLower(strings.Trim(anchor, " .!>»→"))] {
					p.A11y.GenericLinkTexts++
				}
				if abs := resolveLink(base, href, stripQuery); abs != "" {
					rel := strings.ToLower(attrv(n, "rel"))
					nofollow := strings.Contains(rel, "nofollow") || strings.Contains(rel, "ugc") || strings.Contains(rel, "sponsored")
					if label == "" && imgLink {
						label = "[image] " + imgAlt(n)
					}
					out.links = append(out.links, LinkRef{URL: abs, Anchor: firstN(label, 160), Rel: rel, Nofollow: nofollow, ImgLink: imgLink})
				}
			}
			for c := n.FirstChild; c != nil; c = c.NextSibling {
				walk(c, depth+1, true, inBody)
			}
			return
		case atom.Img:
			src := attrv(n, "src")
			if src == "" {
				src = attrv(n, "data-src")
			}
			if src == "" || strings.HasPrefix(src, "data:") {
				break
			}
			alt, hasAlt := attr(n, "alt")
			abs := resolveLink(base, src, false)
			if abs == "" {
				break
			}
			imgIndex++
			if !hasAlt {
				p.A11y.ImagesNoAlt++
			}
			if seenImg[abs] {
				break
			}
			seenImg[abs] = true
			_, hasSrcset := attr(n, "srcset")
			lazy := strings.EqualFold(attrv(n, "loading"), "lazy") || attrv(n, "data-src") != ""
			img := ImageRef{Src: abs, Alt: firstN(strings.TrimSpace(alt), 200), HasAlt: hasAlt, Width: attrv(n, "width"), Height: attrv(n, "height"), Lazy: lazy, Srcset: hasSrcset, InLink: inLink, Format: imageFormat(abs)}
			out.images = append(out.images, img)
			if https && strings.HasPrefix(abs, "http://") {
				p.MixedContent = append(p.MixedContent, abs)
			}
		case atom.Iframe:
			p.Iframes++
			if attrv(n, "title") == "" && attrv(n, "aria-label") == "" {
				p.A11y.IframesNoTitle++
			}
			if src := resolveLink(base, attrv(n, "src"), false); src != "" {
				out.techHints = append(out.techHints, src)
				if https && strings.HasPrefix(src, "http://") {
					p.MixedContent = append(p.MixedContent, src)
				}
			}
		case atom.Form:
			p.Forms++
		case atom.Input, atom.Select, atom.Textarea:
			typ := strings.ToLower(attrv(n, "type"))
			if typ != "hidden" && typ != "submit" && typ != "button" && typ != "reset" && typ != "image" {
				id := attrv(n, "id")
				if attrv(n, "aria-label") == "" && attrv(n, "aria-labelledby") == "" && attrv(n, "title") == "" &&
					!hasAncestor(n, atom.Label) && (id == "" || !labelled[id]) {
					p.A11y.InputsNoLabel++
				}
			}
		case atom.Button:
			if textOf(n) == "" && attrv(n, "aria-label") == "" && attrv(n, "title") == "" && attrv(n, "aria-labelledby") == "" {
				p.A11y.ButtonsNoName++
			}
		case atom.Font, atom.Center, atom.Marquee, atom.Blink, atom.Frameset, atom.Frame, atom.Strike, atom.Big, atom.Tt:
			p.Deprecated = appendUnique(p.Deprecated, n.Data)
		}
		if _, ok := attr(n, "itemtype"); ok && len(p.Schema) < 50 {
			p.Schema = append(p.Schema, SchemaItem{Format: "microdata", Types: []string{shortType(attrv(n, "itemtype"))}})
		}
		if t := attrv(n, "typeof"); t != "" && len(p.Schema) < 50 {
			p.Schema = append(p.Schema, SchemaItem{Format: "rdfa", Types: strings.Fields(t)})
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c, depth+1, inLink, inBody)
		}
	}
	walk(doc, 0, false, false)

	for _, c := range ids {
		if c > 1 {
			p.A11y.DuplicateIDs++
		}
	}
	out.links = dedupeLinks(out.links)
	out.text = cleanText(bodyText.String())
	out.headText = p.Title + " " + out.headText
	out.scripts = uniqueStrings(out.scripts)
	out.styles = uniqueStrings(out.styles)
	p.MixedContent = uniqueStrings(p.MixedContent)
	p.InlineScriptKB /= 1024
	p.InlineStyleKB /= 1024
	if p.Generator != "" {
		out.techHints = append(out.techHints, p.Generator)
	}
	return out
}

func containsDirective(list, d string) bool {
	for _, x := range strings.Split(list, ",") {
		if strings.TrimSpace(x) == d {
			return true
		}
	}
	return false
}

func nonNilMap(m map[string]string) map[string]string {
	if m == nil {
		return map[string]string{}
	}
	return m
}

func textContentRaw(n *html.Node) string {
	var b strings.Builder
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if c.Type == html.TextNode {
			b.WriteString(c.Data)
		}
	}
	return b.String()
}

func inSVG(n *html.Node) bool {
	for p := n.Parent; p != nil; p = p.Parent {
		if p.Type == html.ElementNode && (p.DataAtom == atom.Svg || p.Data == "svg") {
			return true
		}
	}
	return false
}

func hasChild(n *html.Node, a atom.Atom) bool {
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if c.Type == html.ElementNode && c.DataAtom == a {
			return true
		}
		if hasChild(c, a) {
			return true
		}
	}
	return false
}

func imgAlt(n *html.Node) string {
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if c.Type == html.ElementNode && c.DataAtom == atom.Img {
			return attrv(c, "alt")
		}
		if s := imgAlt(c); s != "" {
			return s
		}
	}
	return ""
}

func hasAncestor(n *html.Node, a atom.Atom) bool {
	for p := n.Parent; p != nil; p = p.Parent {
		if p.Type == html.ElementNode && p.DataAtom == a {
			return true
		}
	}
	return false
}

func dedupeLinks(in []LinkRef) []LinkRef {
	seen := map[string]int{}
	out := in[:0]
	for _, l := range in {
		if i, ok := seen[l.URL]; ok {
			// Keep the first anchor but remember a followed link wins over nofollow.
			if !l.Nofollow {
				out[i].Nofollow = false
			}
			continue
		}
		seen[l.URL] = len(out)
		out = append(out, l)
	}
	return out
}

func uniqueStrings(in []string) []string {
	seen := map[string]bool{}
	out := in[:0]
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

func appendUnique(s []string, v string) []string {
	for _, x := range s {
		if x == v {
			return s
		}
	}
	return append(s, v)
}

func firstN(s string, n int) string {
	if len(s) <= n {
		return s
	}
	// Cut on a rune boundary.
	for n > 0 && !isRuneStart(s[n]) {
		n--
	}
	return s[:n]
}

func isRuneStart(b byte) bool { return b&0xC0 != 0x80 }

func imageFormat(u string) string {
	switch fileExt(u) {
	case ".jpg", ".jpeg":
		return "jpeg"
	case ".png":
		return "png"
	case ".gif":
		return "gif"
	case ".webp":
		return "webp"
	case ".avif":
		return "avif"
	case ".svg":
		return "svg"
	case ".ico":
		return "ico"
	case ".bmp":
		return "bmp"
	}
	return ""
}

func shortType(t string) string {
	t = strings.TrimSpace(t)
	if i := strings.LastIndexAny(t, "/#"); i >= 0 {
		return t[i+1:]
	}
	return t
}

// ── JSON-LD ─────────────────────────────────────────────────────────────────

// Required properties per type for Google rich results (subset of the most common types).
var schemaRequired = map[string][]string{
	"Article":             {"headline"},
	"NewsArticle":         {"headline"},
	"BlogPosting":         {"headline"},
	"Product":             {"name"},
	"Offer":               {"price", "priceCurrency"},
	"AggregateRating":     {"ratingValue"},
	"Review":              {"reviewRating", "author"},
	"Organization":        {"name"},
	"LocalBusiness":       {"name", "address"},
	"Person":              {"name"},
	"BreadcrumbList":      {"itemListElement"},
	"FAQPage":             {"mainEntity"},
	"Question":            {"name", "acceptedAnswer"},
	"HowTo":               {"name", "step"},
	"Recipe":              {"name", "image"},
	"Event":               {"name", "startDate", "location"},
	"JobPosting":          {"title", "description", "datePosted", "hiringOrganization"},
	"VideoObject":         {"name", "thumbnailUrl", "uploadDate"},
	"WebSite":             {"name"},
	"SoftwareApplication": {"name"},
	"Course":              {"name", "description"},
	"ImageObject":         {"contentUrl"},
}

// Recommended properties that commonly earn warnings in Google's Rich Results Test.
var schemaRecommended = map[string][]string{
	"Article":       {"image", "datePublished", "author"},
	"BlogPosting":   {"image", "datePublished", "author"},
	"NewsArticle":   {"image", "datePublished", "author"},
	"Product":       {"image", "offers", "description"},
	"Organization":  {"url", "logo"},
	"LocalBusiness": {"telephone", "openingHoursSpecification", "geo"},
	"Event":         {"image", "description", "offers"},
	"WebSite":       {"url"},
	"Recipe":        {"recipeIngredient", "recipeInstructions"},
}

func parseJSONLD(raw string) SchemaItem {
	item := SchemaItem{Format: "json-ld", Raw: firstN(strings.TrimSpace(raw), 6000)}
	var v any
	dec := json.NewDecoder(strings.NewReader(strings.TrimSpace(raw)))
	if err := dec.Decode(&v); err != nil && err != io.EOF {
		item.Errors = append(item.Errors, "invalid JSON: "+err.Error())
		return item
	}
	var visit func(x any, top bool)
	visit = func(x any, top bool) {
		switch t := x.(type) {
		case []any:
			for _, e := range t {
				visit(e, top)
			}
		case map[string]any:
			if g, ok := t["@graph"]; ok {
				visit(g, true)
			}
			types := schemaTypes(t["@type"])
			if top && len(types) > 0 {
				if _, ok := t["@context"]; !ok && len(item.Types) == 0 {
					item.Errors = append(item.Errors, "missing @context")
				}
			}
			for _, ty := range types {
				item.Types = appendUnique(item.Types, ty)
				for _, req := range schemaRequired[ty] {
					if isEmptyJSON(t[req]) {
						item.Errors = append(item.Errors, ty+": missing required property \""+req+"\"")
					}
				}
				for _, rec := range schemaRecommended[ty] {
					if isEmptyJSON(t[rec]) {
						item.Errors = append(item.Errors, ty+": missing recommended property \""+rec+"\" (warning)")
					}
				}
			}
			for k, e := range t {
				if k == "@graph" || k == "@context" {
					continue
				}
				visit(e, false)
			}
		}
	}
	visit(v, true)
	if len(item.Errors) > 30 {
		item.Errors = item.Errors[:30]
	}
	return item
}

func schemaTypes(v any) []string {
	switch t := v.(type) {
	case string:
		return []string{shortType(t)}
	case []any:
		var out []string
		for _, e := range t {
			if s, ok := e.(string); ok {
				out = append(out, shortType(s))
			}
		}
		return out
	}
	return nil
}

func isEmptyJSON(v any) bool {
	switch t := v.(type) {
	case nil:
		return true
	case string:
		return strings.TrimSpace(t) == ""
	case []any:
		return len(t) == 0
	}
	return false
}

// hasLetter reports whether s contains at least one letter (used for word counting).
func hasLetter(s string) bool {
	for _, r := range s {
		if unicode.IsLetter(r) {
			return true
		}
	}
	return false
}
