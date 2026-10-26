// site-auditor is a self-hosted website SEO/technical audit service: it crawls a site, runs
// 130+ checks (crawlability, indexability, content, links, performance, security, structured data,
// accessibility, international, AI readiness…) and serves the reports over a small JSON API that
// the dashboard proxies through /api/site-audit/*.
package main

import (
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8083"
	}
	dir := os.Getenv("AUDITOR_DATA_DIR")
	if dir == "" {
		dir = "data/site-audits"
	}
	maxStored, _ := strconv.Atoi(os.Getenv("AUDITOR_MAX_STORED"))
	if maxStored <= 0 {
		maxStored = 40
	}
	maxRunning, _ := strconv.Atoi(os.Getenv("AUDITOR_MAX_RUNNING"))
	if maxRunning <= 0 {
		maxRunning = 2
	}
	store := NewStore(dir, maxStored, maxRunning)
	srv := &http.Server{
		Addr:              "127.0.0.1:" + port,
		Handler:           newMux(store),
		ReadHeaderTimeout: 10 * time.Second,
	}
	if os.Getenv("AUDITOR_LISTEN_ALL") == "1" {
		srv.Addr = ":" + port
	}
	log.Printf("site-auditor listening on %s", srv.Addr)
	log.Fatal(srv.ListenAndServe())
}

func newMux(store *Store) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"status": "ok", "checks": len(issueCatalog)})
	})
	mux.HandleFunc("GET /api/checks", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"checks": issueCatalog, "categories": Categories})
	})
	mux.HandleFunc("GET /api/audits", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"audits": store.List()})
	})
	mux.HandleFunc("POST /api/audits", func(w http.ResponseWriter, r *http.Request) {
		var opts Options
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&opts); err != nil {
			writeErr(w, 400, "invalid JSON body")
			return
		}
		sum, err := store.Start(opts)
		if err != nil {
			code := 400
			if errors.Is(err, errBlockedTarget) {
				err = errors.New("that address is private or reserved and can't be audited")
			}
			writeErr(w, code, err.Error())
			return
		}
		writeJSON(w, 202, sum)
	})
	mux.HandleFunc("GET /api/audits/{id}", func(w http.ResponseWriter, r *http.Request) {
		a, rep, ok := lookup(store, w, r)
		if !ok {
			return
		}
		if a != nil {
			writeJSON(w, 200, map[string]any{"id": a.report.ID, "status": runningStatus(a), "progress": a.Progress(), "options": a.opts, "startUrl": a.report.StartURL})
			return
		}
		writeJSON(w, 200, overview(rep))
	})
	mux.HandleFunc("GET /api/audits/{id}/progress", func(w http.ResponseWriter, r *http.Request) {
		a, rep, ok := lookup(store, w, r)
		if !ok {
			return
		}
		if a != nil {
			writeJSON(w, 200, map[string]any{"status": runningStatus(a), "progress": a.Progress()})
			return
		}
		writeJSON(w, 200, map[string]any{"status": rep.Status, "progress": rep.Progress})
	})
	mux.HandleFunc("POST /api/audits/{id}/cancel", func(w http.ResponseWriter, r *http.Request) {
		if err := store.Cancel(r.PathValue("id")); err != nil {
			writeErr(w, 404, err.Error())
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
	})
	mux.HandleFunc("DELETE /api/audits/{id}", func(w http.ResponseWriter, r *http.Request) {
		if err := store.Delete(r.PathValue("id")); err != nil {
			code := 404
			if !errors.Is(err, errNotFound) {
				code = 409
			}
			writeErr(w, code, err.Error())
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
	})
	mux.HandleFunc("GET /api/audits/{id}/page", func(w http.ResponseWriter, r *http.Request) {
		rep := finished(store, w, r)
		if rep == nil {
			return
		}
		u := r.URL.Query().Get("url")
		for _, p := range rep.Pages {
			if p.URL == u {
				var in []LinkEdge
				for _, e := range rep.Edges {
					if e.To == u && len(in) < 1000 {
						in = append(in, e)
					}
				}
				var issues []IssueResult
				for _, is := range rep.Issues {
					for _, iu := range is.URLs {
						if iu == u {
							x := is
							x.URLs = nil
							x.Details = nil
							if d, ok := is.Details[u]; ok {
								x.Details = map[string]string{u: d}
							}
							issues = append(issues, x)
							break
						}
					}
				}
				var chain *RedirectChain
				for i := range rep.Chains {
					if rep.Chains[i].Start == u {
						chain = &rep.Chains[i]
					}
				}
				writeJSON(w, 200, map[string]any{"page": p, "inlinks": nonNil(in), "issues": nonNil(issues), "chain": chain})
				return
			}
		}
		writeErr(w, 404, "page not found in this audit")
	})
	mux.HandleFunc("GET /api/audits/{id}/links", func(w http.ResponseWriter, r *http.Request) {
		rep := finished(store, w, r)
		if rep == nil {
			return
		}
		rows := linkRows(rep, r.URL.Query().Get("type"), strings.ToLower(r.URL.Query().Get("q")))
		writePaged(w, r, rows)
	})
	mux.HandleFunc("GET /api/audits/{id}/resources", func(w http.ResponseWriter, r *http.Request) {
		rep := finished(store, w, r)
		if rep == nil {
			return
		}
		q := r.URL.Query()
		rows := resourceRows(rep, q.Get("kind"), q.Get("filter"), strings.ToLower(q.Get("q")))
		writePaged(w, r, rows)
	})
	mux.HandleFunc("GET /api/audits/{id}/export", func(w http.ResponseWriter, r *http.Request) {
		rep := finished(store, w, r)
		if rep == nil {
			return
		}
		exportReport(w, rep, r.URL.Query().Get("type"), r.URL.Query().Get("format"))
	})
	return logRequests(mux)
}

func runningStatus(a *Audit) string {
	if a.Progress().Phase == "queued" {
		return "queued"
	}
	return "running"
}

func lookup(store *Store, w http.ResponseWriter, r *http.Request) (*Audit, *Report, bool) {
	a, rep, err := store.Get(r.PathValue("id"))
	if err != nil {
		writeErr(w, 404, errNotFound.Error())
		return nil, nil, false
	}
	return a, rep, true
}

func finished(store *Store, w http.ResponseWriter, r *http.Request) *Report {
	a, rep, ok := lookup(store, w, r)
	if !ok {
		return nil
	}
	if a != nil {
		writeErr(w, 409, "audit is still running")
		return nil
	}
	return rep
}

// PageRow is the compact per-page record used by the pages table.
type PageRow struct {
	URL         string   `json:"url"`
	Status      int      `json:"status"`
	Error       string   `json:"error,omitempty"`
	Blocked     bool     `json:"blocked,omitempty"`
	ContentType string   `json:"contentType,omitempty"`
	Depth       int      `json:"depth"`
	Indexable   bool     `json:"indexable"`
	IndexReason string   `json:"indexReason,omitempty"`
	Title       string   `json:"title,omitempty"`
	TitleLen    int      `json:"titleLen"`
	Description string   `json:"description,omitempty"`
	DescLen     int      `json:"descLen"`
	H1          string   `json:"h1,omitempty"`
	H1Count     int      `json:"h1Count"`
	Words       int      `json:"words"`
	TTFBMs      int      `json:"ttfbMs"`
	LoadMs      int      `json:"loadMs"`
	SizeKB      float64  `json:"sizeKb"`
	Inlinks     int      `json:"inlinks"`
	Outlinks    int      `json:"outlinks"`
	External    int      `json:"external"`
	LinkScore   float64  `json:"linkScore"`
	InSitemap   bool     `json:"inSitemap"`
	Canonical   string   `json:"canonical,omitempty"`
	RedirectTo  string   `json:"redirectTo,omitempty"`
	Readability float64  `json:"readability"`
	Images      int      `json:"images"`
	Schema      []string `json:"schema,omitempty"`
	Issues      []string `json:"issues"`
	IsHTML      bool     `json:"isHtml"`
}

func pageRow(p *Page) PageRow {
	row := PageRow{URL: p.URL, Status: p.Status, Error: p.Error, Blocked: p.BlockedRobots, ContentType: strings.Split(p.ContentType, ";")[0],
		Depth: p.Depth, Indexable: p.Indexable, IndexReason: p.IndexReason, Title: p.Title, TitleLen: len([]rune(p.Title)),
		Description: firstN(p.Description, 320), DescLen: len([]rune(p.Description)), H1Count: len(p.H1), Words: p.WordCount,
		TTFBMs: p.Timing.TTFBMs, LoadMs: p.Timing.TotalMs, SizeKB: float64(p.Size*10/1024) / 10, Inlinks: p.Inlinks,
		Outlinks: p.InternalLinks, External: p.ExternalLinks, LinkScore: p.LinkScore, InSitemap: p.InSitemap, Canonical: p.Canonical,
		RedirectTo: p.RedirectTo, Readability: p.Readability, Images: len(p.Images), Issues: p.Issues, IsHTML: p.IsHTML}
	if len(p.H1) > 0 {
		row.H1 = p.H1[0]
	}
	for _, s := range p.Schema {
		row.Schema = append(row.Schema, s.Types...)
	}
	row.Schema = uniqueStrings(row.Schema)
	if row.Issues == nil {
		row.Issues = []string{}
	}
	return row
}

// overview is everything the dashboard needs for a finished audit except the heavy link and
// resource lists (served paged by /links and /resources).
func overview(r *Report) map[string]any {
	rows := make([]PageRow, 0, len(r.Pages))
	for _, p := range r.Pages {
		rows = append(rows, pageRow(p))
	}
	opts := r.Options
	opts.PageSpeedKey = ""
	resStats := map[string]map[string]int{}
	for _, res := range r.Resources {
		m := resStats[res.Kind]
		if m == nil {
			m = map[string]int{}
			resStats[res.Kind] = m
		}
		m["total"]++
		switch {
		case res.Kind == "external" && (res.Status != 0 || res.Error != "") && externalBroken(res):
			m["broken"]++
		case res.Kind != "external" && (res.Status >= 400 || res.Error != ""):
			m["broken"]++
		}
		if res.RedirectTo != "" {
			m["redirected"]++
		}
	}
	return map[string]any{
		"id": r.ID, "status": r.Status, "error": r.Error, "options": opts, "startUrl": r.StartURL, "host": r.Host,
		"createdAt": r.CreatedAt, "startedAt": r.StartedAt, "finishedAt": r.FinishedAt, "durationMs": r.DurationMs,
		"score": r.Score, "grade": r.Grade, "categoryScores": r.CategoryScores, "categories": Categories,
		"summary": r.Summary, "issues": nonNil(r.Issues), "site": r.Site, "pages": rows,
		"dupTitles": nonNil(r.DupTitles), "dupDescriptions": nonNil(r.DupDescs), "dupH1": nonNil(r.DupH1),
		"dupContent": nonNil(r.DupContent), "nearDuplicates": nonNil(r.NearDups), "redirectChains": nonNil(r.Chains),
		"truncated": r.Truncated, "progress": r.Progress, "resourceStats": resStats, "edgeCount": len(r.Edges),
	}
}

func nonNil[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}

type LinkRow struct {
	From     string `json:"from"`
	To       string `json:"to"`
	Anchor   string `json:"anchor"`
	Nofollow bool   `json:"nofollow"`
	Internal bool   `json:"internal"`
	Status   int    `json:"status"`
	Error    string `json:"error,omitempty"`
	Redirect string `json:"redirectTo,omitempty"`
}

func linkRows(r *Report, typ, q string) []LinkRow {
	pages := map[string]*Page{}
	for _, p := range r.Pages {
		pages[p.URL] = p
	}
	res := map[string]*Resource{}
	for _, x := range r.Resources {
		res[x.URL] = x
	}
	var rows []LinkRow
	for _, p := range r.Pages {
		for _, l := range p.Links {
			row := LinkRow{From: p.URL, To: l.URL, Anchor: l.Anchor, Nofollow: l.Nofollow, Internal: l.Internal}
			broken := false
			if l.Internal {
				if tp := pages[l.URL]; tp != nil {
					row.Status, row.Error, row.Redirect = tp.Status, tp.Error, tp.RedirectTo
					if tp.BlockedRobots {
						row.Error = "blocked by robots.txt"
					}
					broken = tp.Error != "" || tp.Status >= 400
				}
			} else if x := res[l.URL]; x != nil {
				row.Status, row.Error, row.Redirect = x.Status, x.Error, x.RedirectTo
				broken = (x.Status != 0 || x.Error != "") && externalBroken(x)
			}
			switch typ {
			case "internal":
				if !l.Internal {
					continue
				}
			case "external":
				if l.Internal {
					continue
				}
			case "broken":
				if !broken {
					continue
				}
			case "redirect":
				if row.Redirect == "" {
					continue
				}
			case "nofollow":
				if !l.Nofollow {
					continue
				}
			}
			if q != "" && !strings.Contains(strings.ToLower(row.From+" "+row.To+" "+row.Anchor), q) {
				continue
			}
			rows = append(rows, row)
		}
	}
	return rows
}

func resourceRows(r *Report, kind, filter, q string) []*Resource {
	var rows []*Resource
	for _, x := range r.Resources {
		if kind != "" && kind != "all" && x.Kind != kind {
			continue
		}
		switch filter {
		case "broken":
			if x.Kind == "external" {
				if !((x.Status != 0 || x.Error != "") && externalBroken(x)) {
					continue
				}
			} else if !(x.Status >= 400 || x.Error != "") {
				continue
			}
		case "large":
			if x.Size < 200*1024 {
				continue
			}
		case "uncached":
			if hasMaxAge(x.CacheControl) || x.Status != 200 {
				continue
			}
		case "redirect":
			if x.RedirectTo == "" {
				continue
			}
		}
		if q != "" && !strings.Contains(strings.ToLower(x.URL), q) {
			continue
		}
		rows = append(rows, x)
	}
	if filter == "large" {
		sort.Slice(rows, func(i, j int) bool { return rows[i].Size > rows[j].Size })
	}
	return rows
}

func writePaged[T any](w http.ResponseWriter, r *http.Request, rows []T) {
	offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	if offset < 0 {
		offset = 0
	}
	total := len(rows)
	end := min(offset+limit, total)
	page := []T{}
	if offset < total {
		page = rows[offset:end]
	}
	writeJSON(w, 200, map[string]any{"total": total, "offset": offset, "limit": limit, "rows": page})
}

func exportReport(w http.ResponseWriter, r *Report, typ, format string) {
	name := fmt.Sprintf("%s-%s-%s", sanitizeName(r.Host), typ, r.CreatedAt.Format("2006-01-02"))
	if format == "json" || typ == "full" {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Disposition", `attachment; filename="`+name+`.json"`)
		var v any = r
		switch typ {
		case "pages":
			v = r.Pages
		case "issues":
			v = r.Issues
		case "links":
			v = linkRows(r, "", "")
		case "resources":
			v = r.Resources
		}
		enc := json.NewEncoder(w)
		enc.SetIndent("", " ")
		_ = enc.Encode(v)
		return
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`.csv"`)
	w.Write([]byte("\xEF\xBB\xBF")) // BOM so Excel opens UTF-8 correctly
	cw := csv.NewWriter(w)
	defer cw.Flush()
	b := strconv.FormatBool
	itoa := strconv.Itoa
	switch typ {
	case "issues":
		cw.Write([]string{"Severity", "Category", "Issue", "Count", "URL", "Detail", "How to fix"})
		for _, is := range r.Issues {
			for _, u := range is.URLs {
				cw.Write([]string{is.Severity, is.Category, is.Title, itoa(is.Count), u, is.Details[u], is.Fix})
			}
		}
	case "links":
		cw.Write([]string{"From", "To", "Anchor", "Internal", "Nofollow", "Status", "Error", "Redirects to"})
		for _, l := range linkRows(r, "", "") {
			cw.Write([]string{l.From, l.To, l.Anchor, b(l.Internal), b(l.Nofollow), itoa(l.Status), l.Error, l.Redirect})
		}
	case "resources":
		cw.Write([]string{"URL", "Type", "Status", "Error", "Size (bytes)", "Content-Type", "Cache-Control", "Encoding", "Redirects to", "Internal", "Found on (count)", "Example page"})
		for _, x := range r.Resources {
			ex := ""
			if len(x.FoundOn) > 0 {
				ex = x.FoundOn[0]
			}
			cw.Write([]string{x.URL, x.Kind, itoa(x.Status), x.Error, strconv.FormatInt(x.Size, 10), x.ContentType, x.CacheControl, x.Compression, x.RedirectTo, b(x.Internal), itoa(x.FoundOnCount), ex})
		}
	case "images":
		cw.Write([]string{"Page", "Image", "Alt", "Has alt", "Width", "Height", "Lazy", "Format", "Status", "Size (bytes)"})
		for _, p := range r.Pages {
			for _, im := range p.Images {
				cw.Write([]string{p.URL, im.Src, im.Alt, b(im.HasAlt), im.Width, im.Height, b(im.Lazy), im.Format, itoa(im.Status), strconv.FormatInt(im.Size, 10)})
			}
		}
	default: // pages
		cw.Write([]string{"URL", "Status", "Indexable", "Indexability reason", "Depth", "Title", "Title length", "Title px", "Meta description", "Description length",
			"H1", "H1 count", "Words", "Readability", "Canonical", "Meta robots", "X-Robots-Tag", "Redirects to", "TTFB (ms)", "Load (ms)", "Size (bytes)",
			"Transfer (bytes)", "Compression", "Inlinks", "Unique inlinks", "Internal outlinks", "External outlinks", "Link score", "In sitemap", "Images",
			"Images missing alt", "Schema types", "Lang", "Content type", "Issues"})
		for _, p := range r.Pages {
			row := pageRow(p)
			cw.Write([]string{p.URL, itoa(p.Status) + map[bool]string{true: " " + p.Error, false: ""}[p.Error != ""], b(p.Indexable), p.IndexReason, itoa(p.Depth),
				p.Title, itoa(row.TitleLen), itoa(p.TitlePx), p.Description, itoa(row.DescLen), row.H1, itoa(len(p.H1)), itoa(p.WordCount),
				strconv.FormatFloat(p.Readability, 'f', 1, 64), p.Canonical, p.MetaRobots, p.XRobots, p.RedirectTo, itoa(p.Timing.TTFBMs),
				itoa(p.Timing.TotalMs), itoa(p.Size), strconv.FormatInt(p.TransferSize, 10), p.Compression, itoa(p.Inlinks), itoa(p.UniqueInlinks),
				itoa(p.InternalLinks), itoa(p.ExternalLinks), strconv.FormatFloat(p.LinkScore, 'f', 1, 64), b(p.InSitemap), itoa(len(p.Images)),
				itoa(p.A11y.ImagesNoAlt), strings.Join(row.Schema, " "), p.Lang, row.ContentType, strings.Join(p.Issues, " ")})
		}
	}
}

func sanitizeName(s string) string {
	return strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '.' {
			return r
		}
		return '-'
	}, s)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func logRequests(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		h.ServeHTTP(w, r)
		if r.Method != http.MethodGet || !strings.HasSuffix(r.URL.Path, "/progress") {
			log.Printf("%s %s (%s)", r.Method, r.URL.Path, time.Since(start).Round(time.Millisecond))
		}
	})
}
