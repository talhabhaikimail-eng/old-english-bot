package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"strings"
)

type SitemapInfo struct {
	URL       string   `json:"url"`
	Status    int      `json:"status"`
	Kind      string   `json:"kind"` // urlset | sitemapindex | text | invalid
	URLCount  int      `json:"urlCount"`
	Children  int      `json:"children,omitempty"`
	Error     string   `json:"error,omitempty"`
	Warnings  []string `json:"warnings,omitempty"`
	SizeBytes int      `json:"sizeBytes"`
}

type sitemapDoc struct {
	XMLName  xml.Name
	URLs     []sitemapURL `xml:"url"`
	Sitemaps []struct {
		Loc string `xml:"loc"`
	} `xml:"sitemap"`
}

type sitemapURL struct {
	Loc        string `xml:"loc"`
	Lastmod    string `xml:"lastmod"`
	Changefreq string `xml:"changefreq"`
	Priority   string `xml:"priority"`
}

// SitemapEntry is a URL listed in a sitemap.
type SitemapEntry struct {
	Loc     string
	Lastmod string
	Source  string
}

// collectSitemaps fetches sitemap files breadth-first (following sitemap indexes) up to a URL budget.
func collectSitemaps(ctx context.Context, f *Fetcher, seeds []string, maxURLs int) ([]SitemapInfo, []SitemapEntry) {
	var infos []SitemapInfo
	var entries []SitemapEntry
	seen := map[string]bool{}
	queue := append([]string(nil), seeds...)
	for len(queue) > 0 && len(infos) < 60 && len(entries) < maxURLs {
		sm := queue[0]
		queue = queue[1:]
		if seen[sm] {
			continue
		}
		seen[sm] = true
		if ctx.Err() != nil {
			break
		}
		res := f.Do(ctx, sm, fetchOpts{readBody: true})
		info := SitemapInfo{URL: sm, Status: res.Status, SizeBytes: len(res.Body)}
		if res.Err != nil {
			info.Kind = "invalid"
			info.Error = res.Err.Error()
			infos = append(infos, info)
			continue
		}
		if res.Status != 200 {
			info.Kind = "invalid"
			info.Error = fmt.Sprintf("HTTP %d", res.Status)
			infos = append(infos, info)
			continue
		}
		body := res.Body
		if len(body) > 2 && body[0] == 0x1f && body[1] == 0x8b {
			if gz, err := gzip.NewReader(bytes.NewReader(body)); err == nil {
				if b, err := io.ReadAll(io.LimitReader(gz, 60<<20)); err == nil {
					body = b
				}
			}
		}
		trim := bytes.TrimSpace(body)
		if len(trim) > 0 && trim[0] != '<' {
			// Plain-text sitemap: one URL per line.
			info.Kind = "text"
			for _, line := range strings.Split(string(trim), "\n") {
				line = strings.TrimSpace(line)
				if strings.HasPrefix(line, "http://") || strings.HasPrefix(line, "https://") {
					entries = append(entries, SitemapEntry{Loc: line, Source: sm})
					info.URLCount++
				}
			}
			infos = append(infos, info)
			continue
		}
		var doc sitemapDoc
		dec := xml.NewDecoder(bytes.NewReader(body))
		dec.Strict = false
		if err := dec.Decode(&doc); err != nil {
			info.Kind = "invalid"
			info.Error = "XML parse error: " + err.Error()
			infos = append(infos, info)
			continue
		}
		switch strings.ToLower(doc.XMLName.Local) {
		case "sitemapindex":
			info.Kind = "sitemapindex"
			for _, s := range doc.Sitemaps {
				loc := strings.TrimSpace(s.Loc)
				if loc != "" {
					info.Children++
					queue = append(queue, loc)
				}
			}
		case "urlset":
			info.Kind = "urlset"
			for _, u := range doc.URLs {
				loc := strings.TrimSpace(u.Loc)
				if loc == "" {
					continue
				}
				info.URLCount++
				entries = append(entries, SitemapEntry{Loc: loc, Lastmod: strings.TrimSpace(u.Lastmod), Source: sm})
			}
			if info.URLCount > 50000 {
				info.Warnings = append(info.Warnings, "more than 50,000 URLs (protocol limit)")
			}
		default:
			info.Kind = "invalid"
			info.Error = "root element is <" + doc.XMLName.Local + ">, expected <urlset> or <sitemapindex>"
		}
		if len(body) > 50<<20 {
			info.Warnings = append(info.Warnings, "larger than 50 MB uncompressed (protocol limit)")
		}
		infos = append(infos, info)
	}
	if len(entries) > maxURLs {
		entries = entries[:maxURLs]
	}
	return infos, entries
}
