package main

import (
	"sort"
	"time"
)

type AuditRef struct {
	ID        string    `json:"id"`
	CreatedAt time.Time `json:"createdAt"`
	Score     int       `json:"score"`
	Grade     string    `json:"grade"`
	Pages     int       `json:"pages"`
	Errors    int       `json:"errors"`
	Warnings  int       `json:"warnings"`
	Notices   int       `json:"notices"`
}

type IssueDiff struct {
	ID         string   `json:"id"`
	Title      string   `json:"title"`
	Severity   string   `json:"severity"`
	Category   string   `json:"category"`
	Site       bool     `json:"site,omitempty"`
	Before     int      `json:"before"`
	After      int      `json:"after"`
	NewCount   int      `json:"newCount"`
	FixedCount int      `json:"fixedCount"`
	New        []string `json:"new"`
	Fixed      []string `json:"fixed"`
}

type StatusChange struct {
	URL  string `json:"url"`
	From int    `json:"from"`
	To   int    `json:"to"`
}

type Comparison struct {
	Base          AuditRef          `json:"base"`
	Current       AuditRef          `json:"current"`
	ScoreDelta    int               `json:"scoreDelta"`
	Categories    map[string][2]int `json:"categories"` // id -> [before, after]
	Issues        []IssueDiff       `json:"issues"`     // only issues whose URL set changed
	AddedCount    int               `json:"addedCount"`
	RemovedCount  int               `json:"removedCount"`
	Added         []string          `json:"added"`
	Removed       []string          `json:"removed"`
	StatusChanges []StatusChange    `json:"statusChanges"`
	NewIssues     int               `json:"newIssues"`   // issue types that appeared
	FixedIssues   int               `json:"fixedIssues"` // issue types that disappeared
	NotCompared   []string          `json:"notCompared"` // checks that only ran in one of the two audits
}

// notRun lists checks that a report did not evaluate (disabled, list/sitemap mode, or a
// third-party verifier that was off or failed), so a diff doesn't call them new or fixed.
func notRun(r *Report) map[string]bool {
	off := r.Options.disabledSet()
	if r.Options.Mode != "" && r.Options.Mode != "crawl" {
		for _, id := range []string{"orphan-page", "single-inlink", "deep-page", "no-outlinks", "redirect-internal", "not-in-sitemap"} {
			off[id] = true
		}
	}
	tp := r.Site.ThirdParty
	if tp == nil {
		tp = &ThirdParty{}
	}
	ok := func(c *Check) bool { return c != nil && c.Status == "ok" }
	deps := map[string]bool{
		"w3c-html-errors":         tp.W3C != nil && ok(&tp.W3C.Check),
		"observatory-low-grade":   tp.Observatory != nil && ok(&tp.Observatory.Check),
		"safe-browsing-flagged":   tp.SafeBrowsing != nil && ok(&tp.SafeBrowsing.Check),
		"links-to-unsafe":         tp.SafeBrowsing != nil && ok(&tp.SafeBrowsing.Check),
		"domain-expiring":         tp.RDAP != nil && ok(&tp.RDAP.Check),
		"domain-no-transfer-lock": tp.RDAP != nil && ok(&tp.RDAP.Check),
		"ssllabs-low-grade":       tp.SSLLabs != nil && ok(&tp.SSLLabs.Check),
	}
	for id, ran := range deps {
		if !ran {
			off[id] = true
		}
	}
	return off
}

func auditRef(r *Report) AuditRef {
	return AuditRef{ID: r.ID, CreatedAt: r.CreatedAt, Score: r.Score, Grade: r.Grade, Pages: len(r.Pages),
		Errors: r.Summary.Errors, Warnings: r.Summary.Warnings, Notices: r.Summary.Notices}
}

const diffCap = 300

// compareReports diffs two audits of a site: score, per-issue new/fixed URLs, page set and status codes.
func compareReports(base, cur *Report) Comparison {
	c := Comparison{Base: auditRef(base), Current: auditRef(cur), ScoreDelta: cur.Score - base.Score,
		Categories: map[string][2]int{}, Issues: []IssueDiff{}, Added: []string{}, Removed: []string{}, StatusChanges: []StatusChange{}}
	for _, cat := range Categories {
		c.Categories[cat.ID] = [2]int{base.CategoryScores[cat.ID], cur.CategoryScores[cat.ID]}
	}

	bi := map[string]IssueResult{}
	for _, is := range base.Issues {
		bi[is.ID] = is
	}
	ci := map[string]IssueResult{}
	for _, is := range cur.Issues {
		ci[is.ID] = is
	}
	ids := map[string]bool{}
	for id := range bi {
		ids[id] = true
	}
	for id := range ci {
		ids[id] = true
	}
	skipB, skipA := notRun(base), notRun(cur)
	c.NotCompared = []string{}
	for id := range ids {
		if skipB[id] != skipA[id] {
			if d, ok := issueIndex[id]; ok {
				c.NotCompared = append(c.NotCompared, d.Title)
			}
			continue
		}
		b, inB := bi[id]
		a, inA := ci[id]
		def := a.IssueDef
		if !inA {
			def = b.IssueDef
		}
		d := IssueDiff{ID: id, Title: def.Title, Severity: def.Severity, Category: def.Category, Site: def.Site,
			Before: b.Count, After: a.Count, New: []string{}, Fixed: []string{}}
		bs := toSet(b.URLs)
		as := toSet(a.URLs)
		for _, u := range a.URLs {
			if !bs[u] {
				d.NewCount++
				if len(d.New) < diffCap {
					d.New = append(d.New, u)
				}
			}
		}
		for _, u := range b.URLs {
			if !as[u] {
				d.FixedCount++
				if len(d.Fixed) < diffCap {
					d.Fixed = append(d.Fixed, u)
				}
			}
		}
		if d.NewCount == 0 && d.FixedCount == 0 && d.Before == d.After {
			continue
		}
		if !inB && inA {
			c.NewIssues++
		}
		if inB && !inA {
			c.FixedIssues++
		}
		c.Issues = append(c.Issues, d)
	}
	sort.Strings(c.NotCompared)
	order := map[string]int{"error": 0, "warning": 1, "notice": 2}
	sort.Slice(c.Issues, func(i, j int) bool {
		x, y := c.Issues[i], c.Issues[j]
		if order[x.Severity] != order[y.Severity] {
			return order[x.Severity] < order[y.Severity]
		}
		dx, dy := abs(x.After-x.Before), abs(y.After-y.Before)
		if dx != dy {
			return dx > dy
		}
		return x.ID < y.ID
	})

	bp := map[string]*Page{}
	for _, p := range base.Pages {
		bp[p.URL] = p
	}
	cp := map[string]bool{}
	for _, p := range cur.Pages {
		cp[p.URL] = true
		old := bp[p.URL]
		if old == nil {
			c.AddedCount++
			if len(c.Added) < diffCap {
				c.Added = append(c.Added, p.URL)
			}
			continue
		}
		if old.Status != p.Status && len(c.StatusChanges) < 500 {
			c.StatusChanges = append(c.StatusChanges, StatusChange{URL: p.URL, From: old.Status, To: p.Status})
		}
	}
	for _, p := range base.Pages {
		if !cp[p.URL] {
			c.RemovedCount++
			if len(c.Removed) < diffCap {
				c.Removed = append(c.Removed, p.URL)
			}
		}
	}
	return c
}

func toSet(s []string) map[string]bool {
	m := make(map[string]bool, len(s))
	for _, v := range s {
		m[v] = true
	}
	return m
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}
