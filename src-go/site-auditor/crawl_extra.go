package main

import (
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

type compiledSearch struct {
	rule   SearchRule
	re     interface{ FindAllStringIndex(string, int) [][]int }
	needle string
}

// customRules evaluates the custom search and extraction rules for one HTML page.
func (a *Audit) customRules(p *Page, body []byte, text string) {
	if len(a.search) == 0 && len(a.extract) == 0 {
		return
	}
	html := string(body)
	lowerHTML, lowerText := "", ""
	for _, s := range a.search {
		hay := html
		if s.rule.InText {
			hay = text
		}
		n := 0
		if s.re != nil {
			n = len(s.re.FindAllStringIndex(hay, 1000))
		} else {
			if s.rule.InText {
				if lowerText == "" {
					lowerText = strings.ToLower(text)
				}
				n = strings.Count(lowerText, s.needle)
			} else {
				if lowerHTML == "" {
					lowerHTML = strings.ToLower(html)
				}
				n = strings.Count(lowerHTML, s.needle)
			}
		}
		if p.Custom == nil {
			p.Custom = map[string]int{}
		}
		p.Custom[s.rule.Name] = n
	}
	for i, re := range a.extract {
		name := a.opts.Extract[i].Name
		var vals []string
		for _, m := range re.FindAllStringSubmatch(html, 5) {
			v := m[0]
			if len(m) > 1 {
				v = m[1]
			}
			if v = strings.TrimSpace(cleanText(v)); v != "" {
				vals = appendUnique(vals, firstN(v, 300))
			}
		}
		if p.Extracted == nil {
			p.Extracted = map[string][]string{}
		}
		p.Extracted[name] = vals
	}
}

// SearchResult summarises one custom search rule across the crawl.
type SearchResult struct {
	Rule    SearchRule     `json:"rule"`
	Matched int            `json:"matched"` // pages reported by the rule (contains, or absent when Absent)
	Checked int            `json:"checked"`
	URLs    []string       `json:"urls"`
	Counts  map[string]int `json:"counts,omitempty"` // url -> occurrences (contains rules)
}

func (a *Audit) searchResults(pages []*Page) []SearchResult {
	var out []SearchResult
	for _, s := range a.search {
		res := SearchResult{Rule: s.rule, URLs: []string{}}
		if !s.rule.Absent {
			res.Counts = map[string]int{}
		}
		for _, p := range pages {
			if !p.IsHTML || p.Custom == nil {
				continue
			}
			res.Checked++
			n := p.Custom[s.rule.Name]
			if (n > 0) != s.rule.Absent {
				res.Matched++
				if len(res.URLs) < 5000 {
					res.URLs = append(res.URLs, p.URL)
					if !s.rule.Absent {
						res.Counts[p.URL] = n
					}
				}
			}
		}
		out = append(out, res)
	}
	return out
}

// retryable reports transient failures worth a second attempt.
func retryable(res *FetchResult) bool {
	if res.Err != nil {
		msg := res.Err.Error()
		return res.Err != errBlockedTarget && !strings.Contains(msg, "DNS lookup failed") && !strings.Contains(msg, "TLS certificate")
	}
	switch res.Status {
	case 429, 502, 503, 504:
		return true
	}
	return false
}

func retryDelay(res *FetchResult) time.Duration {
	if res.Header != nil {
		var secs int
		if _, err := fmt.Sscanf(res.Header.Get("Retry-After"), "%d", &secs); err == nil && secs > 0 {
			return time.Duration(min(secs, 10)) * time.Second
		}
	}
	return 1500 * time.Millisecond
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func resourceBroken(r *Resource) bool {
	if r.Kind == "external" {
		return (r.Status != 0 || r.Error != "") && externalBroken(r)
	}
	return r.Status >= 400 || r.Error != ""
}

// reverifyBroken re-checks every broken link/asset with a real-browser user agent and a GET, a
// second opinion that removes false positives from bot-blocking servers and flaky hosts.
func (a *Audit) reverifyBroken() {
	a.mu.Lock()
	var list []*Resource
	for _, r := range a.resources {
		if resourceBroken(r) && r.Error != errBlockedTarget.Error() && len(list) < 500 {
			list = append(list, r)
		}
	}
	a.progress.ResTotal = len(list)
	a.progress.Resources = 0
	a.mu.Unlock()
	if len(list) == 0 {
		return
	}
	rf := *a.fetcher
	rf.userAgent = userAgents["chrome"]
	rf.timeout = a.fetcher.timeout * 3 / 2
	var wg sync.WaitGroup
	sem := make(chan struct{}, 8)
	fixed := 0
	var fmu sync.Mutex
	for _, r := range list {
		if a.ctx.Err() != nil {
			break
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(r *Resource) {
			defer wg.Done()
			defer func() { <-sem }()
			time.Sleep(300 * time.Millisecond)
			probe := &Resource{URL: r.URL, Kind: r.Kind}
			a.checkResourceWithGET(&rf, probe)
			first := statusLabel(r.Status, r.Error)
			a.mu.Lock()
			if resourceBroken(probe) {
				r.Reverified = "confirmed broken on re-check (" + statusLabel(probe.Status, probe.Error) + ")"
			} else {
				r.Reverified = fmt.Sprintf("first check %s, re-check with a browser user agent returned %s", first, statusLabel(probe.Status, probe.Error))
				r.Status, r.Error = probe.Status, ""
				if probe.RedirectTo != "" {
					r.RedirectTo = probe.RedirectTo
				}
				if probe.ContentType != "" {
					r.ContentType = probe.ContentType
				}
				if r.Size == 0 {
					r.Size = probe.Size
				}
				fmu.Lock()
				fixed++
				fmu.Unlock()
			}
			a.progress.Resources++
			a.mu.Unlock()
		}(r)
	}
	wg.Wait()
	a.logf("Re-checked %d broken links/assets: %d were false positives", len(list), fixed)
}

// checkResourceWithGET always uses GET (some servers answer HEAD with errors).
func (a *Audit) checkResourceWithGET(f *Fetcher, r *Resource) {
	cur := r.URL
	var res *FetchResult
	for hop := 0; hop < 6; hop++ {
		res = f.Do(a.ctx, cur, fetchOpts{method: http.MethodGet, headers: map[string]string{
			"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"}})
		if res.Err == nil && res.Status >= 300 && res.Status < 400 {
			if loc := res.Header.Get("Location"); loc != "" {
				if nu, err := res.reqURL().Parse(loc); err == nil {
					if hop == 0 {
						r.RedirectTo = nu.String()
					}
					cur = nu.String()
					continue
				}
			}
		}
		break
	}
	r.Status = res.Status
	if res.Err != nil {
		r.Error = res.Err.Error()
		return
	}
	r.ContentType = res.Header.Get("Content-Type")
	if res.TransferSize > 0 {
		r.Size = res.TransferSize
	}
}

func statusLabel(status int, err string) string {
	if err != "" {
		return err
	}
	if status == 0 {
		return "no response"
	}
	return fmt.Sprintf("HTTP %d", status)
}
