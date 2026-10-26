package main

import (
	"errors"
	"net/url"
	"path"
	"strings"
)

// normalizeStartURL turns user input ("example.com", "https://Example.com/a#x") into an absolute URL.
func normalizeStartURL(raw string) (*url.URL, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return nil, errors.New("url is required")
	}
	if !strings.Contains(s, "://") {
		s = "https://" + s
	}
	u, err := url.Parse(s)
	if err != nil {
		return nil, errors.New("invalid url")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, errors.New("only http and https URLs can be audited")
	}
	if u.Hostname() == "" || len(s) > 2048 {
		return nil, errors.New("invalid url")
	}
	if u.Path == "" {
		u.Path = "/"
	}
	return canonicalURL(u, false), nil
}

// canonicalURL lowercases scheme/host, drops default ports and fragments, and optionally the query.
func canonicalURL(u *url.URL, stripQuery bool) *url.URL {
	c := *u
	c.Scheme = strings.ToLower(c.Scheme)
	host := strings.ToLower(c.Hostname())
	port := c.Port()
	if (c.Scheme == "http" && port == "80") || (c.Scheme == "https" && port == "443") {
		port = ""
	}
	if port != "" {
		if strings.Contains(host, ":") {
			c.Host = "[" + host + "]:" + port
		} else {
			c.Host = host + ":" + port
		}
	} else if strings.Contains(host, ":") {
		c.Host = "[" + host + "]"
	} else {
		c.Host = host
	}
	c.Fragment = ""
	c.RawFragment = ""
	c.User = nil
	if c.Path == "" {
		c.Path = "/"
	}
	if stripQuery {
		c.RawQuery = ""
	}
	c.ForceQuery = false
	return &c
}

// resolveLink resolves href against base and returns a normalized absolute http(s) URL, or "".
func resolveLink(base *url.URL, href string, stripQuery bool) string {
	h := strings.TrimSpace(href)
	if h == "" || strings.HasPrefix(h, "#") {
		return ""
	}
	lower := strings.ToLower(h)
	for _, p := range []string{"javascript:", "mailto:", "tel:", "data:", "sms:", "about:", "blob:", "ftp:", "file:", "whatsapp:", "skype:", "callto:"} {
		if strings.HasPrefix(lower, p) {
			return ""
		}
	}
	ref, err := url.Parse(h)
	if err != nil {
		return ""
	}
	abs := base.ResolveReference(ref)
	if abs.Scheme != "http" && abs.Scheme != "https" {
		return ""
	}
	if abs.Hostname() == "" {
		return ""
	}
	return canonicalURL(abs, stripQuery).String()
}

// siteHost strips a leading "www." so example.com and www.example.com count as one site.
func siteHost(host string) string {
	return strings.TrimPrefix(strings.ToLower(host), "www.")
}

// scope decides which URLs belong to the audited site.
type scope struct {
	root              string // host without www.
	includeSubdomains bool
}

func (s scope) internal(u *url.URL) bool {
	h := siteHost(u.Hostname())
	if h == s.root {
		return true
	}
	return s.includeSubdomains && strings.HasSuffix(h, "."+s.root)
}

// urlIssues lists URL hygiene problems (used by the url-* checks).
func urlIssues(raw string) (upper, underscore, spaces, nonASCII, tooLong, manyParams, doubleSlash bool) {
	u, err := url.Parse(raw)
	if err != nil {
		return
	}
	p := u.EscapedPath()
	upper = strings.ToLower(p) != p
	underscore = strings.Contains(p, "_")
	spaces = strings.Contains(p, "%20") || strings.Contains(p, "+")
	for _, r := range u.Path {
		if r > 127 {
			nonASCII = true
			break
		}
	}
	tooLong = len(raw) > 115
	manyParams = len(u.Query()) > 2
	doubleSlash = strings.Contains(p, "//")
	return
}

// fileExt returns the lowercase extension of a URL path ("" when none).
func fileExt(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return strings.ToLower(path.Ext(u.Path))
}

var nonPageExts = map[string]bool{
	".jpg": true, ".jpeg": true, ".png": true, ".gif": true, ".webp": true, ".avif": true, ".svg": true, ".ico": true, ".bmp": true, ".tif": true, ".tiff": true,
	".css": true, ".js": true, ".mjs": true, ".json": true, ".woff": true, ".woff2": true, ".ttf": true, ".otf": true, ".eot": true,
	".mp4": true, ".webm": true, ".mp3": true, ".wav": true, ".ogg": true, ".mov": true, ".avi": true,
	".zip": true, ".gz": true, ".rar": true, ".7z": true, ".tar": true, ".exe": true, ".dmg": true, ".apk": true, ".msi": true,
}
