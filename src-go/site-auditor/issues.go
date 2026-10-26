package main

import "sort"

type IssueDef struct {
	ID       string `json:"id"`
	Category string `json:"category"`
	Severity string `json:"severity"` // error | warning | notice
	Title    string `json:"title"`
	Why      string `json:"why"`
	Fix      string `json:"fix"`
	Site     bool   `json:"site,omitempty"`  // site-wide check (no per-URL list)
	Asset    bool   `json:"asset,omitempty"` // URLs are resources (JS/CSS/images), not pages
}

type IssueResult struct {
	IssueDef
	Count   int               `json:"count"`
	URLs    []string          `json:"urls,omitempty"`
	Details map[string]string `json:"details,omitempty"` // url (or "site") -> extra context
	Ratio   float64           `json:"ratio"`             // share of applicable pages affected
}

var Categories = []struct {
	ID, Label string
	Weight    float64
}{
	{"crawl", "Crawlability", 1.3},
	{"indexability", "Indexability", 1.3},
	{"content", "On-page content", 1.2},
	{"links", "Links", 1.0},
	{"performance", "Performance", 1.0},
	{"security", "Security & HTTPS", 1.0},
	{"images", "Images", 0.7},
	{"structured-data", "Structured data", 0.6},
	{"mobile", "Mobile", 0.8},
	{"international", "International", 0.5},
	{"social", "Social sharing", 0.4},
	{"accessibility", "Accessibility", 0.6},
	{"url", "URL structure", 0.4},
	{"ai", "AI search readiness", 0.5},
}

func def(id, cat, sev, title, why, fix string) IssueDef {
	return IssueDef{ID: id, Category: cat, Severity: sev, Title: title, Why: why, Fix: fix}
}

func assetDef(id, cat, sev, title, why, fix string) IssueDef {
	d := def(id, cat, sev, title, why, fix)
	d.Asset = true
	return d
}

func siteDef(id, cat, sev, title, why, fix string) IssueDef {
	d := def(id, cat, sev, title, why, fix)
	d.Site = true
	return d
}

var issueCatalog = []IssueDef{
	// ── Crawlability ──
	def("http-4xx", "crawl", "error", "Internal pages return 4xx errors", "Visitors and crawlers hit dead ends; link equity pointing at these URLs is wasted.", "Restore the page, 301-redirect it to the closest live page, or remove links pointing to it."),
	def("http-5xx", "crawl", "error", "Internal pages return 5xx errors", "Server errors stop Google from crawling and can lead to de-indexing if they persist.", "Check server logs for the failing URLs and fix the application or hosting errors."),
	def("fetch-failed", "crawl", "error", "Pages could not be fetched", "Timeouts, DNS or connection failures mean neither users nor crawlers can load the page.", "Check hosting uptime, firewall/WAF rules and response time for these URLs."),
	def("redirect-chain", "crawl", "warning", "Redirect chains", "Each extra hop adds latency and Google stops following after ~10 hops; equity can leak along the way.", "Point the first URL (and every internal link to it) straight at the final destination."),
	def("redirect-loop", "crawl", "error", "Redirect loops", "The URL never resolves to a page, so it cannot be crawled or indexed.", "Fix the redirect rules so the chain ends on a 200 page."),
	def("redirect-temporary", "crawl", "warning", "Temporary redirects (302/307)", "Temporary redirects tell search engines to keep the old URL indexed instead of consolidating signals.", "Use 301/308 for permanent moves."),
	def("redirect-broken", "crawl", "error", "Redirects to broken pages", "The redirect sends users and crawlers to an error page.", "Update the redirect target to a live page."),
	def("redirect-internal", "crawl", "notice", "Internal URLs that redirect", "Linking to redirecting URLs wastes crawl budget and adds latency.", "Update internal links to point at the final URL directly."),
	def("blocked-robots", "crawl", "warning", "Internal URLs blocked by robots.txt", "Blocked URLs cannot be crawled; if they are linked they may still be indexed without content.", "Remove the Disallow rule if the page should rank, or stop linking to it."),
	def("deep-page", "crawl", "notice", "Pages more than 4 clicks from the homepage", "Deep pages get crawled less often and receive less internal link equity.", "Link to important deep pages from hubs, navigation or the homepage."),
	def("orphan-page", "crawl", "warning", "Orphan pages (in sitemap, not linked internally)", "Pages with no internal links are hard for users and crawlers to discover and rank poorly.", "Add contextual internal links to these pages or remove them from the sitemap if obsolete."),
	def("single-inlink", "crawl", "notice", "Pages with only one internal inlink", "Weakly linked pages receive little internal PageRank.", "Add more internal links from relevant pages."),

	// ── Indexability ──
	def("noindex", "indexability", "notice", "Pages blocked by noindex", "These pages will not appear in search results.", "Remove the noindex directive (meta robots or X-Robots-Tag) if the page should rank."),
	def("nofollow-page", "indexability", "notice", "Pages with nofollow meta robots", "Crawlers will not follow any links on these pages.", "Remove nofollow from meta robots unless it is intentional."),
	def("canonicalised", "indexability", "notice", "Canonicalised pages", "The canonical points to another URL, so this URL will not be indexed itself.", "Make sure this is intentional and that internal links point to the canonical version."),
	def("canonical-missing", "indexability", "warning", "Missing canonical tag", "Without a canonical, parameter or duplicate variants can compete with the main URL.", "Add <link rel=\"canonical\" href=\"…\"> pointing at the preferred URL (self-referencing is fine)."),
	def("canonical-multiple", "indexability", "error", "Multiple canonical tags", "Conflicting canonicals cause search engines to ignore all of them.", "Keep exactly one canonical tag per page."),
	def("canonical-broken", "indexability", "error", "Canonical points to a broken or blocked URL", "An invalid canonical target confuses indexing and can drop the page from search.", "Point the canonical at a live, indexable 200 URL."),
	def("canonical-redirect", "indexability", "warning", "Canonical points to a redirect", "Canonicals should reference the final URL, not a redirecting one.", "Update the canonical to the redirect destination."),
	def("canonical-noindex", "indexability", "error", "Canonical points to a noindex page", "Mixed signals: the canonical says 'index that one' but the target says 'don't index me'.", "Canonicalise to an indexable page or remove noindex from the target."),
	def("canonical-relative", "indexability", "notice", "Relative canonical URL", "Relative canonicals are easy to break and are discouraged by Google.", "Use an absolute URL including the protocol and host."),
	def("canonical-cross-domain", "indexability", "notice", "Canonical points to another domain", "The page hands its ranking signals to a different site.", "Confirm the cross-domain canonical is intentional (syndicated content)."),
	def("sitemap-non-indexable", "indexability", "error", "Non-indexable URLs in the sitemap", "Sitemaps should list only canonical, 200, indexable URLs; anything else wastes crawl budget and erodes trust in the sitemap.", "Remove redirects, errors, noindex and canonicalised URLs from the sitemap."),
	def("not-in-sitemap", "indexability", "notice", "Indexable pages missing from the sitemap", "Pages absent from the sitemap may be discovered and recrawled more slowly.", "Add every indexable page to your XML sitemap (most CMSs do this automatically)."),

	// ── Content ──
	def("title-missing", "content", "error", "Missing or empty <title>", "The title is the main headline in search results and a strong ranking signal.", "Write a unique, descriptive title of 30–60 characters for every page."),
	def("title-too-long", "content", "warning", "Title too long (> 60 chars / 580px)", "Google truncates long titles in results, hiding key words.", "Shorten the title to about 50–60 characters with the main keyword near the start."),
	def("title-too-short", "content", "notice", "Title too short (< 30 chars)", "Short titles miss the chance to describe the page and target keywords.", "Expand the title to 30–60 characters."),
	def("title-duplicate", "content", "warning", "Duplicate titles", "Identical titles make pages compete with each other and confuse searchers.", "Give each page a unique title that reflects its specific content."),
	def("title-multiple", "content", "warning", "Multiple <title> tags", "Browsers and search engines may pick the wrong one.", "Keep a single <title> in the <head>."),
	def("title-equals-h1", "content", "notice", "Title identical to H1", "Using the same text twice misses an opportunity to target keyword variations.", "Vary the H1 and title slightly while keeping them consistent."),
	def("desc-missing", "content", "warning", "Missing meta description", "Google will improvise a snippet, often less compelling, lowering click-through rate.", "Write a unique meta description of 70–160 characters that sells the click."),
	def("desc-too-long", "content", "notice", "Meta description too long (> 160 chars)", "Long descriptions are truncated in results.", "Keep descriptions under about 155–160 characters (≈ 920px)."),
	def("desc-too-short", "content", "notice", "Meta description too short (< 70 chars)", "Short descriptions waste valuable SERP space.", "Expand to 70–160 characters with a clear value proposition."),
	def("desc-duplicate", "content", "warning", "Duplicate meta descriptions", "Repeated descriptions make results look identical and lower CTR.", "Write unique descriptions per page."),
	def("desc-multiple", "content", "warning", "Multiple meta descriptions", "Search engines may ignore all of them.", "Keep a single meta description tag."),
	def("h1-missing", "content", "warning", "Missing H1 heading", "The H1 tells users and search engines what the page is about.", "Add one descriptive H1 per page."),
	def("h1-multiple", "content", "notice", "Multiple H1 headings", "Several H1s dilute the main topic signal.", "Use one H1 and structure sub-sections with H2–H6."),
	def("h1-duplicate", "content", "notice", "Duplicate H1 headings across pages", "Pages with the same H1 look like duplicates.", "Make each H1 unique to its page."),
	def("h1-too-long", "content", "notice", "H1 too long (> 70 chars)", "Long headings are hard to scan.", "Keep the H1 concise."),
	def("h2-missing", "content", "notice", "No H2 subheadings", "Subheadings improve scannability and help search engines understand structure.", "Break longer content into sections with H2s."),
	def("thin-content", "content", "warning", "Low word count (< 200 words)", "Thin pages rarely rank and can drag down perceived site quality.", "Expand with genuinely useful content, merge with related pages, or noindex utility pages."),
	def("low-text-ratio", "content", "notice", "Low text-to-HTML ratio (< 10%)", "Heavy markup with little text can signal thin or bloated pages.", "Trim unnecessary markup/inline code and add meaningful content."),
	def("duplicate-content", "content", "error", "Duplicate content (identical pages)", "Exact duplicates split ranking signals and waste crawl budget.", "Consolidate duplicates with 301 redirects or canonical tags."),
	def("near-duplicate", "content", "warning", "Near-duplicate content", "Pages that are ≥ 90% similar compete with each other.", "Differentiate the content or canonicalise to one version."),
	def("low-readability", "content", "notice", "Hard-to-read content (Flesch < 30)", "Complex text loses readers; clear writing tends to perform better.", "Use shorter sentences and simpler words."),
	def("lorem-ipsum", "content", "warning", "Placeholder text (lorem ipsum)", "Placeholder copy looks unfinished to users and search engines.", "Replace placeholder text with real content."),
	def("doctype-missing", "content", "notice", "Missing <!DOCTYPE html>", "Without a doctype, browsers render in quirks mode.", "Start every HTML document with <!DOCTYPE html>."),
	def("charset-missing", "content", "notice", "Character encoding not declared", "Browsers may misrender text without a declared charset.", "Add <meta charset=\"utf-8\"> as the first element in <head>."),
	def("deprecated-html", "content", "notice", "Deprecated HTML elements", "Tags like <font> and <center> are obsolete and signal outdated markup.", "Replace them with CSS."),
	def("keyword-missing-title", "content", "notice", "Focus keyword missing from title", "Pages targeting a keyword should mention it in the title.", "Work the focus keyword naturally into the title."),
	def("keyword-missing-h1", "content", "notice", "Focus keyword missing from H1", "The main heading should reflect the target query.", "Include the focus keyword in the H1."),
	def("keyword-missing-desc", "content", "notice", "Focus keyword missing from meta description", "Google bolds matching words in snippets, improving CTR.", "Mention the keyword in the meta description."),

	// ── Links ──
	def("broken-internal-links", "links", "error", "Pages with broken internal links", "Broken links frustrate users and waste crawl budget and link equity.", "Fix or remove links that point to 4xx/5xx URLs."),
	def("broken-external-links", "links", "warning", "Pages with broken external links", "Linking to dead pages hurts user experience and perceived quality.", "Update or remove external links that return 404/410/5xx."),
	def("links-to-redirects", "links", "notice", "Pages linking to redirected URLs", "Every internal redirect is a wasted hop for users and crawlers.", "Update links to the final destination URL."),
	def("nofollow-internal", "links", "notice", "Nofollow on internal links", "Nofollowed internal links stop PageRank flowing within your own site.", "Remove rel=nofollow from internal links."),
	def("no-outlinks", "links", "warning", "Pages with no internal outlinks", "Dead-end pages trap users and crawlers and don't pass link equity.", "Add navigation and contextual links to related pages."),
	def("too-many-links", "links", "notice", "Too many links on a page (> 300)", "Huge link counts dilute equity and can look spammy.", "Trim boilerplate links and keep only useful navigation."),
	def("http-links", "links", "warning", "HTTPS pages linking to HTTP internal URLs", "Links to http:// trigger redirects and may expose users to insecure pages.", "Update internal links to use https://."),
	def("generic-anchors", "links", "notice", "Non-descriptive anchor text", "Anchors like 'click here' tell users and search engines nothing about the target.", "Use descriptive anchor text that names the destination."),

	// ── Performance ──
	def("slow-ttfb", "performance", "warning", "Slow server response (TTFB > 800ms)", "A slow time-to-first-byte delays everything else and hurts Core Web Vitals.", "Add caching (CDN/page cache), optimise database queries or upgrade hosting."),
	def("slow-page", "performance", "warning", "Slow HTML download (> 3s)", "Slow pages raise bounce rates and are crawled less.", "Reduce HTML size, enable compression and caching."),
	def("large-html", "performance", "warning", "Large HTML document (> 500 KB)", "Big documents take longer to download and parse, especially on mobile.", "Remove inline data/scripts, paginate long lists, lazy-load components."),
	def("excessive-dom", "performance", "warning", "Excessive DOM size (> 1,500 elements)", "Large DOMs slow down rendering and interaction (INP).", "Simplify markup and virtualise long lists."),
	def("no-compression", "performance", "warning", "HTML not compressed", "gzip/brotli typically shrinks HTML by 70–90%.", "Enable gzip or brotli compression on the server/CDN."),
	def("render-blocking", "performance", "notice", "Render-blocking resources in <head>", "Synchronous scripts and stylesheets delay first paint (FCP/LCP).", "Add defer/async to scripts, inline critical CSS and load the rest asynchronously."),
	def("too-many-scripts", "performance", "notice", "Too many JavaScript files (> 25)", "Each request adds overhead; lots of JS slows interactivity.", "Bundle scripts and remove unused third-party tags."),
	def("too-many-css", "performance", "notice", "Too many CSS files (> 10)", "Many stylesheets delay rendering.", "Combine stylesheets and remove unused CSS."),
	def("large-inline-code", "performance", "notice", "Large inline scripts/styles (> 100 KB)", "Inline code can't be cached between pages.", "Move large inline code into cached external files."),
	def("broken-assets", "performance", "error", "Broken JavaScript/CSS files", "Missing scripts or styles break page layout and functionality.", "Fix the asset URLs or restore the files."),
	assetDef("uncached-assets", "performance", "notice", "Static assets without browser caching", "Without long cache lifetimes, repeat visits re-download everything.", "Serve JS/CSS/images with Cache-Control: max-age (ideally a year with hashed filenames)."),
	assetDef("uncompressed-assets", "performance", "notice", "Uncompressed JavaScript/CSS", "Text assets compress very well; serving them raw wastes bandwidth.", "Enable gzip/brotli for text/css and application/javascript."),
	assetDef("large-assets", "performance", "notice", "Large JavaScript/CSS files (> 500 KB)", "Heavy bundles slow down parsing and execution.", "Code-split, tree-shake and minify."),

	// ── Images ──
	def("img-missing-alt", "images", "warning", "Images missing alt text", "Alt text is needed for accessibility and image search.", "Add descriptive alt attributes (alt=\"\" for purely decorative images)."),
	def("img-broken", "images", "error", "Broken images", "Missing images look broken to users.", "Fix image URLs or restore the files."),
	def("img-large", "images", "warning", "Large images (> 200 KB)", "Oversized images are the most common cause of slow LCP.", "Resize and compress images; serve WebP/AVIF."),
	def("img-no-dimensions", "images", "notice", "Images without width/height", "Missing dimensions cause layout shifts (CLS) while images load.", "Set width and height attributes (or CSS aspect-ratio)."),
	def("img-legacy-format", "images", "notice", "Images in legacy formats (JPEG/PNG/GIF)", "WebP/AVIF are typically 25–50% smaller at the same quality.", "Serve modern formats, e.g. with <picture> fallbacks."),
	def("img-no-lazy", "images", "notice", "Offscreen images not lazy-loaded", "Loading every image up front competes with critical resources.", "Add loading=\"lazy\" to images below the fold."),

	// ── Security ──
	def("mixed-content", "security", "error", "Mixed content (HTTP resources on HTTPS pages)", "Browsers block or warn about insecure resources, breaking pages and trust.", "Load every resource over HTTPS."),
	def("http-page", "security", "error", "Pages served over plain HTTP", "Chrome marks HTTP pages 'Not secure' and HTTPS is a ranking signal.", "Serve every page over HTTPS and 301-redirect HTTP to HTTPS."),
	siteDef("no-https", "security", "error", "Site not available over HTTPS", "HTTPS is a ranking signal and required for modern browser features.", "Install a TLS certificate (e.g. Let's Encrypt) and serve the site over HTTPS."),
	siteDef("no-https-redirect", "security", "error", "HTTP does not redirect to HTTPS", "Visitors on http:// stay on an insecure, duplicate version of the site.", "Add a site-wide 301 redirect from http:// to https://."),
	siteDef("ssl-expired", "security", "error", "TLS certificate expired or invalid", "Browsers show a full-page security warning.", "Renew/replace the certificate and make sure the full chain is served."),
	siteDef("ssl-expiring", "security", "warning", "TLS certificate expires within 30 days", "An expired certificate will take the site offline for most visitors.", "Renew the certificate or enable auto-renewal."),
	siteDef("old-tls", "security", "warning", "Outdated TLS version negotiated", "TLS 1.0/1.1 are deprecated and insecure.", "Enable TLS 1.2 and 1.3 only."),
	siteDef("no-hsts", "security", "warning", "Missing HSTS header", "Without HSTS, the first request can be downgraded to HTTP by an attacker.", "Send Strict-Transport-Security: max-age=31536000; includeSubDomains."),
	siteDef("no-csp", "security", "notice", "Missing Content-Security-Policy", "CSP is the strongest defence against XSS and data injection.", "Define a Content-Security-Policy header (start with Report-Only)."),
	siteDef("no-xfo", "security", "notice", "Clickjacking protection missing", "Without X-Frame-Options or frame-ancestors your pages can be framed by other sites.", "Send X-Frame-Options: SAMEORIGIN or CSP frame-ancestors 'self'."),
	siteDef("no-xcto", "security", "notice", "Missing X-Content-Type-Options", "Browsers may MIME-sniff responses into executable types.", "Send X-Content-Type-Options: nosniff."),
	siteDef("no-referrer-policy", "security", "notice", "Missing Referrer-Policy", "Full URLs (possibly with tokens) can leak to third parties.", "Send Referrer-Policy: strict-origin-when-cross-origin."),
	siteDef("no-permissions-policy", "security", "notice", "Missing Permissions-Policy", "Embedded content can request powerful browser features.", "Send a Permissions-Policy limiting camera, microphone, geolocation etc."),
	siteDef("server-leak", "security", "notice", "Server software version disclosed", "Version banners help attackers find known vulnerabilities.", "Hide versions in Server / X-Powered-By headers."),
	siteDef("dns-no-spf", "security", "notice", "No SPF record", "Without SPF anyone can spoof email from your domain.", "Publish a TXT record like v=spf1 include:<provider> -all."),
	siteDef("dns-no-dmarc", "security", "notice", "No DMARC record", "DMARC protects your domain against phishing and improves deliverability.", "Publish _dmarc TXT: v=DMARC1; p=quarantine; rua=mailto:…"),
	siteDef("dns-no-caa", "security", "notice", "No CAA record", "CAA restricts which certificate authorities may issue certificates for your domain.", "Add a CAA record for your CA (e.g. 0 issue \"letsencrypt.org\")."),
	siteDef("security-txt-missing", "security", "notice", "No security.txt", "Researchers have no standard way to report vulnerabilities to you.", "Publish /.well-known/security.txt (RFC 9116)."),

	// ── Structured data ──
	def("schema-missing", "structured-data", "notice", "No structured data", "Schema.org markup enables rich results and helps search/AI engines understand entities.", "Add JSON-LD for the page type (Article, Product, Organization, BreadcrumbList…)."),
	def("schema-invalid", "structured-data", "error", "Invalid structured data", "Errors make the markup ineligible for rich results.", "Fix JSON syntax and add the required properties listed in the details."),
	def("schema-warnings", "structured-data", "notice", "Structured data missing recommended properties", "Recommended fields improve rich-result eligibility and appearance.", "Add the recommended properties listed in the details."),
	siteDef("no-org-schema", "structured-data", "notice", "Homepage lacks Organization/WebSite schema", "Entity markup feeds knowledge panels, sitelinks search box and AI engines.", "Add Organization (name, url, logo, sameAs) and WebSite JSON-LD to the homepage."),

	// ── Mobile ──
	def("viewport-missing", "mobile", "error", "Missing viewport meta tag", "Without it, mobile browsers render the desktop layout zoomed out; Google indexes mobile-first.", "Add <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">."),
	def("viewport-no-zoom", "mobile", "warning", "Viewport disables zooming", "user-scalable=no or maximum-scale=1 blocks users who need to zoom.", "Remove user-scalable=no and maximum-scale restrictions."),
	def("viewport-fixed", "mobile", "warning", "Viewport uses a fixed width", "Fixed-width viewports don't adapt to screen size.", "Use width=device-width."),
	siteDef("favicon-missing", "mobile", "notice", "No favicon", "Google shows favicons next to mobile results; missing ones look unprofessional.", "Add a favicon (at least 48×48) and link it with <link rel=\"icon\">."),
	siteDef("http2-missing", "performance", "notice", "HTTP/2 not supported", "HTTP/2 multiplexing makes pages with many assets load faster.", "Enable HTTP/2 (or HTTP/3) on your server or CDN."),

	// ── International ──
	def("lang-missing", "international", "warning", "Missing <html lang> attribute", "Screen readers and search engines use it to determine the page language.", "Add lang=\"en\" (or the right language code) to the <html> element."),
	def("hreflang-invalid", "international", "error", "Invalid hreflang codes", "Invalid language/region codes are ignored by Google.", "Use ISO 639-1 language and ISO 3166-1 alpha-2 region codes (e.g. en-gb) or x-default."),
	def("hreflang-no-self", "international", "warning", "Hreflang without self-reference", "Each hreflang set should include the page itself.", "Add a hreflang entry pointing to the page's own URL."),
	def("hreflang-no-return", "international", "error", "Hreflang missing return links", "Alternates must link back to each other or Google ignores the annotation.", "Make every alternate page reference this page in its hreflang set."),
	def("hreflang-broken", "international", "error", "Hreflang points to broken or redirecting URLs", "Alternates must be indexable 200 pages.", "Update hreflang URLs to final, live pages."),
	def("hreflang-no-xdefault", "international", "notice", "Hreflang without x-default", "x-default tells search engines which page to show users of other languages.", "Add hreflang=\"x-default\" pointing at your language selector or default page."),

	// ── Social ──
	def("og-missing", "social", "notice", "Incomplete Open Graph tags", "Links shared on Facebook, LinkedIn, Slack and WhatsApp look bare without og:title/description/image.", "Add og:title, og:description, og:image and og:url."),
	def("twitter-missing", "social", "notice", "Missing Twitter/X card", "Without twitter:card, X shows a plain link.", "Add <meta name=\"twitter:card\" content=\"summary_large_image\">."),

	// ── Accessibility ──
	def("a11y-empty-links", "accessibility", "warning", "Links without accessible text", "Screen readers announce these as just 'link'.", "Give links text, aria-label, or an image with alt text."),
	def("a11y-buttons", "accessibility", "warning", "Buttons without an accessible name", "Icon-only buttons are unusable with screen readers.", "Add visible text or aria-label to buttons."),
	def("a11y-inputs", "accessibility", "warning", "Form fields without labels", "Unlabelled inputs can't be identified by assistive technology.", "Associate a <label for> or add aria-label."),
	def("a11y-headings", "accessibility", "notice", "Skipped heading levels", "Jumping from H2 to H4 breaks the document outline.", "Use heading levels in order."),
	def("a11y-duplicate-ids", "accessibility", "notice", "Duplicate element IDs", "Duplicate IDs break label associations and ARIA references.", "Make id attributes unique on each page."),
	def("a11y-iframe-title", "accessibility", "notice", "Iframes without a title", "Screen reader users can't tell what embedded content is.", "Add a descriptive title attribute to each iframe."),
	def("a11y-tabindex", "accessibility", "notice", "Positive tabindex values", "Positive tabindex breaks the natural keyboard order.", "Use tabindex=\"0\" or -1 and order elements in the DOM."),

	// ── URLs ──
	def("url-uppercase", "url", "notice", "URLs with uppercase characters", "URLs are case-sensitive; mixed case creates duplicate-URL risk.", "Use lowercase URLs and redirect uppercase variants."),
	def("url-underscore", "url", "notice", "URLs with underscores", "Google treats hyphens, not underscores, as word separators.", "Use hyphens in URL slugs."),
	def("url-too-long", "url", "notice", "Long URLs (> 115 characters)", "Long URLs are truncated in results and hard to share.", "Use short, descriptive slugs."),
	def("url-params", "url", "notice", "URLs with many query parameters", "Parameter-heavy URLs create crawl traps and duplicates.", "Use clean paths and canonicalise parameter variants."),
	def("url-non-ascii", "url", "notice", "URLs with non-ASCII characters", "Non-ASCII URLs get percent-encoded and can break when shared.", "Prefer ASCII slugs (transliterate)."),
	def("url-spaces", "url", "warning", "URLs containing spaces", "Spaces must be encoded and often break links.", "Replace spaces with hyphens."),
	def("url-double-slash", "url", "notice", "URLs with double slashes", "Double slashes create duplicate URL variants.", "Fix links that produce // in the path."),

	// ── Site-wide crawl / AI ──
	siteDef("robots-missing", "crawl", "warning", "robots.txt missing", "A robots.txt helps crawlers find sitemaps and avoid crawl traps.", "Publish /robots.txt with a Sitemap: line."),
	siteDef("robots-blocks-all", "crawl", "error", "robots.txt blocks the whole site", "Search engines are told not to crawl anything.", "Remove 'Disallow: /' for search engine user agents."),
	siteDef("robots-no-sitemap", "crawl", "notice", "robots.txt doesn't reference a sitemap", "Referencing the sitemap helps every crawler find it.", "Add 'Sitemap: https://example.com/sitemap.xml' to robots.txt."),
	siteDef("sitemap-missing", "crawl", "warning", "No XML sitemap found", "Sitemaps help search engines discover and prioritise pages.", "Generate /sitemap.xml and submit it in Search Console."),
	siteDef("sitemap-invalid", "crawl", "error", "Sitemap errors", "Unreadable sitemaps are ignored by search engines.", "Fix the HTTP errors / XML syntax listed in the details."),
	siteDef("soft-404", "crawl", "warning", "Missing pages return 200 (soft 404)", "Non-existent URLs that return 200 create infinite duplicate pages.", "Return a real 404 status for missing pages."),
	siteDef("www-duplicate", "crawl", "warning", "www and non-www both resolve", "Two versions of the site split ranking signals.", "301-redirect one host to the other."),
	siteDef("llms-txt-missing", "ai", "notice", "No llms.txt", "llms.txt gives AI assistants a curated map of your most important content.", "Publish /llms.txt with a short description and links to key pages."),
	siteDef("ai-bots-blocked", "ai", "notice", "AI crawlers blocked in robots.txt", "Blocked AI search crawlers (ChatGPT, Claude, Perplexity) can't cite your pages in answers.", "Allow the AI search/user agents you want visibility in (training bots can stay blocked)."),
	siteDef("search-bots-blocked", "ai", "error", "Major search crawlers blocked", "Googlebot or Bingbot are disallowed from the homepage; AI answers built on these indexes can't see you either.", "Allow Googlebot and Bingbot in robots.txt."),
	def("js-rendered", "ai", "warning", "Content appears to require JavaScript", "Very little text in the raw HTML; AI crawlers and some search bots don't execute JS.", "Server-side render or pre-render the main content."),
}

var issueIndex = func() map[string]IssueDef {
	m := map[string]IssueDef{}
	for _, d := range issueCatalog {
		m[d.ID] = d
	}
	return m
}()

var sevWeight = map[string]float64{"error": 0.10, "warning": 0.03, "notice": 0.004}

// issueCollector accumulates affected URLs per issue.
type issueCollector struct {
	byID map[string]*IssueResult
}

func newCollector() *issueCollector { return &issueCollector{byID: map[string]*IssueResult{}} }

func (c *issueCollector) add(id, u, detail string) {
	d, ok := issueIndex[id]
	if !ok {
		return
	}
	r := c.byID[id]
	if r == nil {
		r = &IssueResult{IssueDef: d}
		c.byID[id] = r
	}
	r.Count++
	if len(r.URLs) < 5000 {
		r.URLs = append(r.URLs, u)
	}
	if detail != "" {
		if r.Details == nil {
			r.Details = map[string]string{}
		}
		if len(r.Details) < 5000 {
			r.Details[u] = detail
		}
	}
}

func (c *issueCollector) site(id, detail string) {
	c.add(id, "site", detail)
}

// results sorts issues by severity then count, filling ratios against applicable page counts.
func (c *issueCollector) results(htmlPages int) []IssueResult {
	order := map[string]int{"error": 0, "warning": 1, "notice": 2}
	out := make([]IssueResult, 0, len(c.byID))
	for _, r := range c.byID {
		if r.Site {
			r.Ratio = 1
		} else if htmlPages > 0 {
			r.Ratio = float64(r.Count) / float64(htmlPages)
			if r.Ratio > 1 {
				r.Ratio = 1
			}
		}
		out = append(out, *r)
	}
	sort.Slice(out, func(i, j int) bool {
		if order[out[i].Severity] != order[out[j].Severity] {
			return order[out[i].Severity] < order[out[j].Severity]
		}
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].ID < out[j].ID
	})
	return out
}

// score combines issues multiplicatively: each issue removes a share of the remaining score,
// scaled by severity and by how much of the site it affects.
func score(issues []IssueResult) (int, map[string]int) {
	cat := map[string]float64{}
	for _, c := range Categories {
		cat[c.ID] = 1
	}
	overall := 1.0
	for _, is := range issues {
		ratio := is.Ratio
		penalty := sevWeight[is.Severity] * (0.15 + 0.85*ratio)
		overall *= 1 - penalty
		// Category scores are more sensitive so differences are visible per area.
		cat[is.Category] *= 1 - min(0.9, penalty*2.2)
	}
	out := map[string]int{}
	for k, v := range cat {
		out[k] = int(v*100 + 0.5)
	}
	return int(overall*100 + 0.5), out
}

func grade(s int) string {
	switch {
	case s >= 90:
		return "A"
	case s >= 80:
		return "B"
	case s >= 70:
		return "C"
	case s >= 55:
		return "D"
	}
	return "F"
}
