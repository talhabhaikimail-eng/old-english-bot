package main

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

const redacted = "[redacted]"

// Request headers a user may not override: they would break the crawler or smuggle requests.
var forbiddenHeaders = map[string]bool{
	"host": true, "content-length": true, "transfer-encoding": true, "connection": true, "upgrade": true,
	"te": true, "trailer": true, "keep-alive": true, "proxy-authorization": true, "proxy-connection": true,
	"accept-encoding": true,
}

var trackingParams = []string{"utm_*", "gclid", "fbclid", "msclkid", "mc_cid", "mc_eid", "_ga", "_gl", "yclid", "dclid"}

// normalizeExtra validates the scope, auth, rule and threshold options.
func (o *Options) normalizeExtra() error {
	switch o.Mode {
	case "", "crawl":
		o.Mode = "crawl"
	case "sitemap", "list":
	default:
		return fmt.Errorf("unknown mode %q (use crawl, sitemap or list)", o.Mode)
	}
	var urls []string
	for _, u := range o.URLs {
		if u = strings.TrimSpace(u); u != "" {
			urls = append(urls, u)
		}
	}
	o.URLs = uniqueStrings(urls)
	if len(o.URLs) > 10000 {
		return errors.New("URL list is limited to 10,000 URLs")
	}
	if o.Mode == "list" {
		if len(o.URLs) == 0 {
			return errors.New("list mode needs at least one URL")
		}
		if strings.TrimSpace(o.URL) == "" {
			o.URL = o.URLs[0]
		}
		if o.MaxPages < len(o.URLs) {
			o.MaxPages = min(len(o.URLs)+50, 10000)
		}
	}

	var params []string
	for _, p := range o.IgnoreParams {
		if p = strings.ToLower(strings.TrimSpace(p)); p != "" {
			if p == "tracking" {
				params = append(params, trackingParams...)
				continue
			}
			params = append(params, p)
		}
	}
	o.IgnoreParams = uniqueStrings(params)

	clean := map[string]string{}
	for k, v := range o.Headers {
		k = http.CanonicalHeaderKey(strings.TrimSpace(k))
		if k == "" || v == redacted {
			continue // redacted values come back when re-running a stored audit
		}
		if forbiddenHeaders[strings.ToLower(k)] || strings.ContainsAny(k+v, "\r\n") {
			return fmt.Errorf("header %q is not allowed", k)
		}
		if len(clean) >= 20 || len(k)+len(v) > 4096 {
			return errors.New("too many or too large custom headers")
		}
		clean[k] = v
	}
	o.Headers = clean
	o.AuthUser = strings.TrimSpace(o.AuthUser)
	if o.AuthPass == redacted || o.AuthUser == "" {
		// A re-run of a stored audit no longer has the password; don't send half a credential.
		o.AuthUser, o.AuthPass = "", ""
	}

	if len(o.CustomSearch) > 20 || len(o.Extract) > 20 {
		return errors.New("at most 20 custom search and 20 extraction rules")
	}
	for i, r := range o.CustomSearch {
		r.Name = strings.TrimSpace(r.Name)
		if r.Pattern == "" {
			return fmt.Errorf("custom search rule %d has no pattern", i+1)
		}
		if r.Name == "" {
			r.Name = firstN(r.Pattern, 40)
		}
		if r.Regex {
			if _, err := regexp.Compile(r.Pattern); err != nil {
				return fmt.Errorf("custom search %q: invalid regex: %v", r.Name, err)
			}
		}
		o.CustomSearch[i] = r
	}
	for i, r := range o.Extract {
		r.Name = strings.TrimSpace(r.Name)
		if r.Name == "" {
			r.Name = fmt.Sprintf("extract %d", i+1)
		}
		if _, err := regexp.Compile(r.Regex); err != nil || r.Regex == "" {
			return fmt.Errorf("extraction %q: invalid regex", r.Name)
		}
		o.Extract[i] = r
	}
	if o.Verify != nil && (o.Verify.W3CPages < 0 || o.Verify.W3CPages > 20) {
		o.Verify.W3CPages = min(max(o.Verify.W3CPages, 0), 20)
	}
	return nil
}

// thresholds merges user overrides over the defaults.
func (o *Options) thresholds() Thresholds {
	t := defaultThresholds
	if o.Thresholds == nil {
		return t
	}
	u := *o.Thresholds
	pick := func(dst *int, v, lo, hi int) {
		if v > 0 {
			*dst = min(max(v, lo), hi)
		}
	}
	pick(&t.TitleMin, u.TitleMin, 1, 200)
	pick(&t.TitleMax, u.TitleMax, 10, 300)
	pick(&t.DescMin, u.DescMin, 1, 500)
	pick(&t.DescMax, u.DescMax, 20, 1000)
	pick(&t.ThinWords, u.ThinWords, 1, 10000)
	pick(&t.SlowTTFBMs, u.SlowTTFBMs, 50, 30000)
	pick(&t.SlowLoadMs, u.SlowLoadMs, 100, 60000)
	pick(&t.LargeHTMLKB, u.LargeHTMLKB, 10, 10000)
	pick(&t.LargeImgKB, u.LargeImgKB, 10, 20000)
	pick(&t.MaxDOM, u.MaxDOM, 100, 100000)
	pick(&t.DeepClicks, u.DeepClicks, 1, 50)
	return t
}

// redactedCopy is what gets stored and returned: secrets never leave the running audit.
func (o Options) redactedCopy() Options {
	c := o
	c.PageSpeedKey = ""
	if len(o.Headers) > 0 {
		c.Headers = map[string]string{}
		for k := range o.Headers {
			c.Headers[k] = redacted
		}
	}
	if c.AuthPass != "" {
		c.AuthPass = redacted
	}
	return c
}

// requestHeaders are added to every request sent to the audited site (never to third parties).
func (o *Options) requestHeaders() map[string]string {
	if len(o.Headers) == 0 && o.AuthUser == "" {
		return nil
	}
	h := map[string]string{}
	for k, v := range o.Headers {
		h[k] = v
	}
	if o.AuthUser != "" {
		h["Authorization"] = "Basic " + base64.StdEncoding.EncodeToString([]byte(o.AuthUser+":"+o.AuthPass))
	}
	return h
}

// disabledSet expands DisabledChecks (ids and "category:x") into issue ids.
func (o *Options) disabledSet() map[string]bool {
	out := map[string]bool{}
	for _, d := range o.DisabledChecks {
		d = strings.TrimSpace(d)
		if cat, ok := strings.CutPrefix(d, "category:"); ok {
			for _, def := range issueCatalog {
				if def.Category == cat {
					out[def.ID] = true
				}
			}
			continue
		}
		out[d] = true
	}
	return out
}

// paramIgnored reports whether a query parameter name matches the ignore list (prefix* wildcards).
func paramIgnored(name string, list []string) bool {
	name = strings.ToLower(name)
	for _, p := range list {
		if pre, ok := strings.CutSuffix(p, "*"); ok {
			if strings.HasPrefix(name, pre) {
				return true
			}
		} else if name == p {
			return true
		}
	}
	return false
}

// cleanURL drops ignored query parameters from an absolute URL.
func cleanURL(raw string, ignore []string) string {
	if len(ignore) == 0 || !strings.Contains(raw, "?") {
		return raw
	}
	u, err := url.Parse(raw)
	if err != nil || u.RawQuery == "" {
		return raw
	}
	var kept []string
	for _, part := range strings.Split(u.RawQuery, "&") {
		name, _, _ := strings.Cut(part, "=")
		if n, err := url.QueryUnescape(name); err == nil {
			name = n
		}
		if part != "" && !paramIgnored(name, ignore) {
			kept = append(kept, part)
		}
	}
	u.RawQuery = strings.Join(kept, "&")
	return u.String()
}

// folderPrefix is the directory of the start URL ("/blog/" for /blog/ or /blog/post).
func folderPrefix(u *url.URL) string {
	p := u.Path
	if p == "" {
		return "/"
	}
	if !strings.HasSuffix(p, "/") {
		if i := strings.LastIndex(p, "/"); i >= 0 {
			// "/blog" is treated as the folder "/blog/" so /blog and everything below it is in scope.
			if !strings.Contains(p[i:], ".") {
				return p + "/"
			}
			p = p[:i+1]
		}
	}
	return p
}
