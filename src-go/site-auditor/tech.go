package main

import (
	"net/http"
	"regexp"
	"sort"
	"strings"
)

type Tech struct {
	Name     string `json:"name"`
	Category string `json:"category"`
	Version  string `json:"version,omitempty"`
	Evidence string `json:"evidence,omitempty"`
}

// techSig matches a technology by response header, cookie name, or a substring/regex found in the
// HTML, script/style URLs and meta generator. The first capture group of a regex is the version.
type techSig struct {
	name, cat string
	headers   map[string]string // header -> regex ("" = presence)
	cookies   []string          // cookie name prefixes
	html      []string          // plain substrings (lowercase) in HTML or resource URLs
	re        []string          // regexes over HTML/hints
}

var techSigs = []techSig{
	// CMS / site builders
	{name: "WordPress", cat: "CMS", html: []string{"/wp-content/", "/wp-includes/"}, re: []string{`(?i)generator:wordpress ?([\d.]+)?`}},
	{name: "WooCommerce", cat: "E-commerce", html: []string{"woocommerce"}},
	{name: "Shopify", cat: "E-commerce", headers: map[string]string{"x-shopid": "", "x-shopify-stage": ""}, html: []string{"cdn.shopify.com", "shopify.theme"}},
	{name: "Wix", cat: "CMS", headers: map[string]string{"x-wix-request-id": ""}, html: []string{"static.wixstatic.com", "wix.com"}},
	{name: "Squarespace", cat: "CMS", html: []string{"static1.squarespace.com", "squarespace.com"}},
	{name: "Webflow", cat: "CMS", html: []string{"webflow.js", "assets.website-files.com", "data-wf-page"}, re: []string{`(?i)generator:webflow`}},
	{name: "Drupal", cat: "CMS", headers: map[string]string{"x-drupal-cache": "", "x-generator": "(?i)drupal ?([\\d.]+)?"}, html: []string{"/sites/default/files/", "drupal-settings-json"}, re: []string{`(?i)generator:drupal ?([\d.]+)?`}},
	{name: "Joomla", cat: "CMS", html: []string{"/media/jui/", "/components/com_"}, re: []string{`(?i)generator:joomla!? ?([\d.]+)?`}},
	{name: "Ghost", cat: "CMS", re: []string{`(?i)generator:ghost ?([\d.]+)?`}},
	{name: "Magento", cat: "E-commerce", html: []string{"mage/cookies", "/static/version", "magento"}, cookies: []string{"mage-"}},
	{name: "PrestaShop", cat: "E-commerce", html: []string{"prestashop"}, cookies: []string{"PrestaShop-"}},
	{name: "BigCommerce", cat: "E-commerce", html: []string{"cdn11.bigcommerce.com", "bigcommerce"}},
	{name: "HubSpot CMS", cat: "CMS", headers: map[string]string{"x-hs-hub-id": ""}, html: []string{"hs-scripts.com", "hubspot"}},
	{name: "Framer", cat: "CMS", html: []string{"framerusercontent.com", "framer.com/m/"}},
	{name: "Hugo", cat: "Static site generator", re: []string{`(?i)generator:hugo ?([\d.]+)?`}},
	{name: "Jekyll", cat: "Static site generator", re: []string{`(?i)generator:jekyll v?([\d.]+)?`}},
	{name: "Docusaurus", cat: "Static site generator", re: []string{`(?i)generator:docusaurus v?([\d.]+)?`}},
	// JS frameworks
	{name: "Next.js", cat: "JavaScript framework", headers: map[string]string{"x-powered-by": "(?i)next\\.js ?([\\d.]+)?"}, html: []string{"/_next/static/", "__next_data__"}},
	{name: "Nuxt", cat: "JavaScript framework", html: []string{"/_nuxt/", "__nuxt"}},
	{name: "Gatsby", cat: "Static site generator", html: []string{"___gatsby", "/page-data/"}, re: []string{`(?i)generator:gatsby ?([\d.]+)?`}},
	{name: "Astro", cat: "JavaScript framework", html: []string{"astro-island", "/_astro/"}, re: []string{`(?i)generator:astro v?([\d.]+)?`}},
	{name: "SvelteKit", cat: "JavaScript framework", html: []string{"/_app/immutable/", "__sveltekit"}},
	{name: "Remix", cat: "JavaScript framework", html: []string{"__remixcontext", "/build/_shared/"}},
	{name: "Angular", cat: "JavaScript framework", html: []string{"ng-version=", "ng-app"}, re: []string{`ng-version="([\d.]+)"`}},
	{name: "Vue.js", cat: "JavaScript framework", html: []string{"vue.min.js", "vue.global", "data-v-", "__vue__"}},
	{name: "React", cat: "JavaScript library", html: []string{"react-dom", "data-reactroot", "react.production"}},
	{name: "Ember.js", cat: "JavaScript framework", html: []string{"ember.js", "ember-application"}},
	{name: "Preact", cat: "JavaScript library", html: []string{"preact.min.js", "preact.module.js", "/preact@"}},
	{name: "jQuery", cat: "JavaScript library", re: []string{`jquery[.-]?([\d]+\.[\d.]+)?(?:\.min)?\.js`}},
	{name: "Alpine.js", cat: "JavaScript library", html: []string{"alpinejs", "x-data="}},
	{name: "htmx", cat: "JavaScript library", html: []string{"htmx.org", "htmx.min.js", "hx-get="}},
	{name: "Lodash", cat: "JavaScript library", html: []string{"lodash.min.js", "lodash.js"}},
	{name: "GSAP", cat: "JavaScript library", html: []string{"gsap.min.js", "/gsap/"}},
	{name: "Three.js", cat: "JavaScript library", html: []string{"three.min.js", "three.module.js"}},
	// Backend
	{name: "PHP", cat: "Programming language", headers: map[string]string{"x-powered-by": "(?i)php/?([\\d.]+)?"}, cookies: []string{"PHPSESSID"}},
	{name: "ASP.NET", cat: "Web framework", headers: map[string]string{"x-aspnet-version": "([\\d.]+)", "x-powered-by": "(?i)asp\\.net"}, cookies: []string{"ASP.NET_SessionId", ".AspNetCore."}, html: []string{"__viewstate"}},
	{name: "Express", cat: "Web framework", headers: map[string]string{"x-powered-by": "(?i)^express"}},
	{name: "Laravel", cat: "Web framework", cookies: []string{"laravel_session", "XSRF-TOKEN"}},
	{name: "Django", cat: "Web framework", cookies: []string{"csrftoken", "django_language"}, html: []string{"csrfmiddlewaretoken"}},
	{name: "Ruby on Rails", cat: "Web framework", headers: map[string]string{"x-runtime": ""}, html: []string{"csrf-param\" content=\"authenticity_token"}},
	{name: "Java", cat: "Programming language", cookies: []string{"JSESSIONID"}},
	// Servers & CDNs
	{name: "Nginx", cat: "Web server", headers: map[string]string{"server": "(?i)nginx/?([\\d.]+)?"}},
	{name: "Apache", cat: "Web server", headers: map[string]string{"server": "(?i)apache/?([\\d.]+)?"}},
	{name: "Microsoft IIS", cat: "Web server", headers: map[string]string{"server": "(?i)microsoft-iis/?([\\d.]+)?"}},
	{name: "LiteSpeed", cat: "Web server", headers: map[string]string{"server": "(?i)litespeed"}},
	{name: "Caddy", cat: "Web server", headers: map[string]string{"server": "(?i)caddy"}},
	{name: "OpenResty", cat: "Web server", headers: map[string]string{"server": "(?i)openresty/?([\\d.]+)?"}},
	{name: "Cloudflare", cat: "CDN", headers: map[string]string{"cf-ray": "", "server": "(?i)cloudflare"}},
	{name: "Fastly", cat: "CDN", headers: map[string]string{"x-fastly-request-id": "", "x-served-by": "(?i)cache-"}},
	{name: "Akamai", cat: "CDN", headers: map[string]string{"x-akamai-transformed": "", "server": "(?i)akamai"}},
	{name: "Amazon CloudFront", cat: "CDN", headers: map[string]string{"x-amz-cf-id": "", "via": "(?i)cloudfront"}},
	{name: "Amazon S3", cat: "Hosting", headers: map[string]string{"server": "(?i)amazons3"}},
	{name: "Vercel", cat: "Hosting", headers: map[string]string{"x-vercel-id": "", "server": "(?i)vercel"}},
	{name: "Netlify", cat: "Hosting", headers: map[string]string{"x-nf-request-id": "", "server": "(?i)netlify"}},
	{name: "GitHub Pages", cat: "Hosting", headers: map[string]string{"x-github-request-id": "", "server": "(?i)github\\.com"}},
	{name: "Firebase Hosting", cat: "Hosting", headers: map[string]string{"x-firebase-hosting": ""}},
	{name: "Google Cloud", cat: "Hosting", headers: map[string]string{"server": "(?i)^(gws|google frontend|gse)", "via": "(?i)google"}},
	{name: "Heroku", cat: "Hosting", headers: map[string]string{"via": "(?i)vegur"}},
	{name: "Fly.io", cat: "Hosting", headers: map[string]string{"fly-request-id": ""}},
	{name: "Render", cat: "Hosting", headers: map[string]string{"rndr-id": ""}},
	{name: "Varnish", cat: "Cache", headers: map[string]string{"x-varnish": "", "via": "(?i)varnish"}},
	{name: "jsDelivr", cat: "CDN", html: []string{"cdn.jsdelivr.net"}},
	{name: "cdnjs", cat: "CDN", html: []string{"cdnjs.cloudflare.com"}},
	{name: "unpkg", cat: "CDN", html: []string{"unpkg.com"}},
	// UI
	{name: "Bootstrap", cat: "UI framework", re: []string{`bootstrap(?:\.bundle)?[.-]?([\d]+\.[\d.]+)?(?:\.min)?\.(?:css|js)`}},
	{name: "Tailwind CSS", cat: "UI framework", html: []string{"tailwindcss", "cdn.tailwindcss.com"}},
	{name: "Font Awesome", cat: "Font", html: []string{"font-awesome", "fontawesome"}},
	{name: "Google Fonts", cat: "Font", html: []string{"fonts.googleapis.com", "fonts.gstatic.com"}},
	{name: "Adobe Fonts", cat: "Font", html: []string{"use.typekit.net"}},
	// Analytics & marketing
	{name: "Google Analytics", cat: "Analytics", html: []string{"google-analytics.com", "gtag/js?id=g-", "gtag('config'"}},
	{name: "Google Tag Manager", cat: "Tag manager", html: []string{"googletagmanager.com/gtm.js", "googletagmanager.com/ns.html"}},
	{name: "Google Ads", cat: "Advertising", html: []string{"googleadservices.com", "gtag/js?id=aw-"}},
	{name: "Google AdSense", cat: "Advertising", html: []string{"pagead2.googlesyndication.com", "adsbygoogle"}},
	{name: "Plausible", cat: "Analytics", html: []string{"plausible.io/js"}},
	{name: "Fathom", cat: "Analytics", html: []string{"cdn.usefathom.com"}},
	{name: "Matomo", cat: "Analytics", html: []string{"matomo.js", "piwik.js", "_paq.push"}},
	{name: "Umami", cat: "Analytics", html: []string{"umami.js", "data-website-id"}},
	{name: "Hotjar", cat: "Analytics", html: []string{"static.hotjar.com", "hotjar"}},
	{name: "Microsoft Clarity", cat: "Analytics", html: []string{"clarity.ms"}},
	{name: "Segment", cat: "Analytics", html: []string{"cdn.segment.com"}},
	{name: "Mixpanel", cat: "Analytics", html: []string{"cdn.mxpnl.com", "mixpanel"}},
	{name: "Amplitude", cat: "Analytics", html: []string{"cdn.amplitude.com", "amplitude.com/libs"}},
	{name: "PostHog", cat: "Analytics", html: []string{"posthog"}},
	{name: "Vercel Analytics", cat: "Analytics", html: []string{"/_vercel/insights", "va.vercel-scripts.com"}},
	{name: "Cloudflare Web Analytics", cat: "Analytics", html: []string{"static.cloudflareinsights.com"}},
	{name: "Meta Pixel", cat: "Advertising", html: []string{"connect.facebook.net", "fbq('init'"}},
	{name: "LinkedIn Insight", cat: "Advertising", html: []string{"snap.licdn.com"}},
	{name: "TikTok Pixel", cat: "Advertising", html: []string{"analytics.tiktok.com"}},
	{name: "Twitter/X Pixel", cat: "Advertising", html: []string{"static.ads-twitter.com"}},
	{name: "HubSpot", cat: "Marketing automation", html: []string{"js.hs-scripts.com", "js.hsforms.net"}},
	{name: "Mailchimp", cat: "Marketing automation", html: []string{"chimpstatic.com", "list-manage.com"}},
	{name: "Klaviyo", cat: "Marketing automation", html: []string{"klaviyo.com"}},
	// Support / chat
	{name: "Intercom", cat: "Live chat", html: []string{"widget.intercom.io", "intercomsettings"}},
	{name: "Crisp", cat: "Live chat", html: []string{"client.crisp.chat"}},
	{name: "Drift", cat: "Live chat", html: []string{"js.driftt.com"}},
	{name: "Zendesk", cat: "Live chat", html: []string{"static.zdassets.com", "zopim"}},
	{name: "Tawk.to", cat: "Live chat", html: []string{"embed.tawk.to"}},
	{name: "tidio", cat: "Live chat", html: []string{"code.tidio.co"}},
	// Payments / security / consent
	{name: "Stripe", cat: "Payments", html: []string{"js.stripe.com"}},
	{name: "PayPal", cat: "Payments", html: []string{"paypal.com/sdk", "paypalobjects.com"}},
	{name: "reCAPTCHA", cat: "Security", html: []string{"google.com/recaptcha", "recaptcha/api.js"}},
	{name: "hCaptcha", cat: "Security", html: []string{"hcaptcha.com"}},
	{name: "Cloudflare Turnstile", cat: "Security", html: []string{"challenges.cloudflare.com/turnstile"}},
	{name: "Cookiebot", cat: "Cookie consent", html: []string{"consent.cookiebot.com"}},
	{name: "OneTrust", cat: "Cookie consent", html: []string{"cdn.cookielaw.org", "onetrust"}},
	{name: "Osano", cat: "Cookie consent", html: []string{"cmp.osano.com"}},
	// Media / maps / embeds
	{name: "YouTube", cat: "Video", html: []string{"youtube.com/embed", "youtube-nocookie.com"}},
	{name: "Vimeo", cat: "Video", html: []string{"player.vimeo.com"}},
	{name: "Google Maps", cat: "Maps", html: []string{"maps.googleapis.com", "google.com/maps/embed"}},
	{name: "Mapbox", cat: "Maps", html: []string{"api.mapbox.com"}},
	{name: "Cloudinary", cat: "Image CDN", html: []string{"res.cloudinary.com"}},
	{name: "imgix", cat: "Image CDN", html: []string{".imgix.net"}},
	{name: "Sentry", cat: "Error tracking", html: []string{"browser.sentry-cdn.com", "sentry.io"}},
	{name: "PWA (Web App Manifest)", cat: "Feature", html: []string{"rel=\"manifest\"", "manifest.webmanifest"}},
	{name: "Service Worker", cat: "Feature", html: []string{"serviceworker.register"}},
	{name: "AMP", cat: "Feature", html: []string{"cdn.ampproject.org"}},
}

var techImplies = map[string][]Tech{
	"Next.js":       {{Name: "React", Category: "JavaScript library"}, {Name: "Node.js", Category: "Programming language"}},
	"Gatsby":        {{Name: "React", Category: "JavaScript library"}},
	"Remix":         {{Name: "React", Category: "JavaScript library"}},
	"Nuxt":          {{Name: "Vue.js", Category: "JavaScript framework"}, {Name: "Node.js", Category: "Programming language"}},
	"SvelteKit":     {{Name: "Svelte", Category: "JavaScript framework"}},
	"WooCommerce":   {{Name: "WordPress", Category: "CMS"}},
	"WordPress":     {{Name: "PHP", Category: "Programming language"}, {Name: "MySQL", Category: "Database"}},
	"Laravel":       {{Name: "PHP", Category: "Programming language"}},
	"Drupal":        {{Name: "PHP", Category: "Programming language"}},
	"Joomla":        {{Name: "PHP", Category: "Programming language"}},
	"Magento":       {{Name: "PHP", Category: "Programming language"}},
	"Django":        {{Name: "Python", Category: "Programming language"}},
	"Ruby on Rails": {{Name: "Ruby", Category: "Programming language"}},
	"Express":       {{Name: "Node.js", Category: "Programming language"}},
}

var compiledTech = func() map[string][]*regexp.Regexp {
	m := map[string][]*regexp.Regexp{}
	for _, s := range techSigs {
		for _, r := range s.re {
			m[s.name] = append(m[s.name], regexp.MustCompile(r))
		}
	}
	return m
}()

var compiledHeaderRes = map[string]*regexp.Regexp{}

func headerRe(expr string) *regexp.Regexp {
	if r, ok := compiledHeaderRes[expr]; ok {
		return r
	}
	r := regexp.MustCompile(expr)
	compiledHeaderRes[expr] = r
	return r
}

func init() {
	// Pre-compile header regexes so detectTech never writes to the shared map concurrently.
	for _, s := range techSigs {
		for _, e := range s.headers {
			if e != "" {
				headerRe(e)
			}
		}
	}
}

// detectTech runs every signature against the homepage response.
func detectTech(h http.Header, body []byte, hints []string) []Tech {
	lowerBody := strings.ToLower(string(body[:min(len(body), 1_500_000)]))
	hintBlob := strings.ToLower(strings.Join(hints, "\n"))
	blob := lowerBody + "\n" + hintBlob
	rawBlob := string(body[:min(len(body), 1_500_000)]) + "\n" + strings.Join(hints, "\n")
	var cookieNames []string
	for _, c := range h.Values("Set-Cookie") {
		if name, _, ok := strings.Cut(c, "="); ok {
			cookieNames = append(cookieNames, strings.TrimSpace(name))
		}
	}
	var out []Tech
	for _, s := range techSigs {
		t := Tech{Name: s.name, Category: s.cat}
		found := false
		for hk, expr := range s.headers {
			v := h.Get(hk)
			if v == "" {
				continue
			}
			if expr == "" {
				found, t.Evidence = true, "header "+hk
				break
			}
			if m := headerRe(expr).FindStringSubmatch(v); m != nil {
				found, t.Evidence = true, hk+": "+firstN(v, 80)
				if len(m) > 1 && m[1] != "" {
					t.Version = m[1]
				}
				break
			}
		}
		if !found {
			for _, cp := range s.cookies {
				for _, cn := range cookieNames {
					if strings.HasPrefix(cn, cp) {
						found, t.Evidence = true, "cookie "+cn
						break
					}
				}
				if found {
					break
				}
			}
		}
		if !found {
			for _, sub := range s.html {
				if strings.Contains(blob, sub) {
					found, t.Evidence = true, "matched \""+sub+"\""
					break
				}
			}
		}
		for _, re := range compiledTech[s.name] {
			if m := re.FindStringSubmatch(rawBlob); m != nil {
				if !found {
					found, t.Evidence = true, "matched "+firstN(m[0], 60)
				}
				if len(m) > 1 && m[1] != "" && t.Version == "" {
					t.Version = strings.Trim(m[1], ".")
				}
			}
		}
		if found {
			out = append(out, t)
		}
	}
	have := map[string]bool{}
	for _, t := range out {
		have[t.Name] = true
	}
	for name, implied := range techImplies {
		if !have[name] {
			continue
		}
		for _, im := range implied {
			if !have[im.Name] {
				have[im.Name] = true
				out = append(out, Tech{Name: im.Name, Category: im.Category, Evidence: "implied by " + name})
			}
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Category != out[j].Category {
			return out[i].Category < out[j].Category
		}
		return out[i].Name < out[j].Name
	})
	return out
}
