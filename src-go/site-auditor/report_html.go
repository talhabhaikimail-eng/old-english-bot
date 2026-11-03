package main

import (
	"fmt"
	"html/template"
	"io"
	"strings"
	"time"
)

// writeHTMLReport renders a standalone, printable client report (no external assets).
func writeHTMLReport(w io.Writer, r *Report) error {
	type issueView struct {
		IssueResult
		Samples []string
		More    int
	}
	type catView struct {
		Label string
		Score int
	}
	var cats []catView
	for _, c := range Categories {
		if s, ok := r.CategoryScores[c.ID]; ok {
			cats = append(cats, catView{c.Label, s})
		}
	}
	var issues []issueView
	for _, is := range r.Issues {
		v := issueView{IssueResult: is}
		if !is.Site {
			for _, u := range is.URLs {
				if len(v.Samples) >= 8 {
					break
				}
				if d := is.Details[u]; d != "" {
					u += " — " + firstN(d, 160)
				}
				v.Samples = append(v.Samples, u)
			}
			v.More = is.Count - len(v.Samples)
		} else if d := is.Details["site"]; d != "" {
			v.Samples = []string{firstN(d, 400)}
		}
		issues = append(issues, v)
	}
	data := map[string]any{
		"R": r, "Cats": cats, "Issues": issues, "Generated": time.Now().UTC().Format("2006-01-02 15:04 UTC"),
		"Duration": (time.Duration(r.DurationMs) * time.Millisecond).Round(time.Second).String(),
		"TP":       r.Site.ThirdParty,
	}
	return reportTmpl.Execute(w, data)
}

func scoreClass(s int) string {
	switch {
	case s >= 90:
		return "good"
	case s >= 70:
		return "ok"
	}
	return "bad"
}

var reportTmpl = template.Must(template.New("report").Funcs(template.FuncMap{
	"scoreClass": scoreClass,
	"date": func(t time.Time) string {
		if t.IsZero() {
			return "—"
		}
		return t.Format("2 Jan 2006")
	},
	"upper": strings.ToUpper,
	"pct":   func(f float64) string { return fmt.Sprintf("%.0f%%", f*100) },
}).Parse(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>SEO audit — {{.R.Host}}</title>
<style>
:root{--fg:#0f172a;--muted:#64748b;--line:#e2e8f0;--good:#059669;--ok:#d97706;--bad:#dc2626;--chip:#f1f5f9}
*{box-sizing:border-box}body{font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--fg);margin:0;padding:32px;max-width:1000px;margin:auto}
h1{font-size:24px;margin:0}h2{font-size:17px;margin:32px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--line)}
.muted{color:var(--muted)}.row{display:flex;gap:24px;align-items:center;flex-wrap:wrap}
.score{width:110px;height:110px;border-radius:50%;display:flex;flex-direction:column;align-items:center;justify-content:center;border:8px solid}
.score b{font-size:32px;line-height:1}.good{color:var(--good);border-color:var(--good)}.ok{color:var(--ok);border-color:var(--ok)}.bad{color:var(--bad);border-color:var(--bad)}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;flex:1}.stat{border:1px solid var(--line);border-radius:8px;padding:8px 10px}.stat b{display:block;font-size:18px}
.cats{display:grid;grid-template-columns:repeat(2,1fr);gap:6px 24px}.cat{display:flex;align-items:center;gap:8px}.cat span{flex:1}
.bar{height:6px;border-radius:3px;background:var(--line);flex:1;overflow:hidden}.bar i{display:block;height:100%}
.bar .good{background:var(--good)}.bar .ok{background:var(--ok)}.bar .bad{background:var(--bad)}
.issue{border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:10px 0;break-inside:avoid}
.sev{display:inline-block;font-size:11px;font-weight:600;padding:1px 8px;border-radius:10px;margin-right:6px;text-transform:uppercase}
.sev.error{background:#fee2e2;color:var(--bad)}.sev.warning{background:#fef3c7;color:var(--ok)}.sev.notice{background:#e0f2fe;color:#0369a1}
.issue h3{font-size:14px;margin:0 0 6px}.issue p{margin:4px 0}.urls{font:12px ui-monospace,monospace;color:var(--muted);margin:6px 0 0;padding-left:18px;word-break:break-all}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:500}
a{color:#2563eb}@media print{body{padding:0}.issue{page-break-inside:avoid}a{color:inherit}}
</style></head><body>
<div class="row" style="justify-content:space-between">
 <div><h1>SEO site audit — {{.R.Host}}</h1>
 <p class="muted">{{.R.StartURL}} · audited {{date .R.CreatedAt}} · {{.R.Summary.PagesCrawled}} URLs in {{.Duration}} · generated {{.Generated}}</p></div>
</div>
{{if .R.Truncated}}<p class="muted"><b>Note:</b> the crawl stopped at the {{.R.Options.MaxPages}}-page limit; more URLs exist.</p>{{end}}
<div class="row" style="margin-top:16px">
 <div class="score {{scoreClass .R.Score}}"><b>{{.R.Score}}</b><small>Grade {{.R.Grade}}</small></div>
 <div class="stats">
  <div class="stat"><b>{{.R.Summary.HTMLPages}}</b><span class="muted">HTML pages</span></div>
  <div class="stat"><b>{{.R.Summary.Indexable}}</b><span class="muted">Indexable</span></div>
  <div class="stat"><b style="color:var(--bad)">{{.R.Summary.Errors}}</b><span class="muted">Errors</span></div>
  <div class="stat"><b style="color:var(--ok)">{{.R.Summary.Warnings}}</b><span class="muted">Warnings</span></div>
  <div class="stat"><b>{{.R.Summary.BrokenLinks}}</b><span class="muted">Broken link targets</span></div>
  <div class="stat"><b>{{.R.Summary.Redirects}}</b><span class="muted">Redirects</span></div>
  <div class="stat"><b>{{.R.Summary.AvgTTFBMs}} ms</b><span class="muted">Avg. TTFB</span></div>
  <div class="stat"><b>{{.R.Summary.AvgWords}}</b><span class="muted">Avg. words</span></div>
 </div>
</div>

<h2>Category scores</h2>
<div class="cats">{{range .Cats}}<div class="cat"><span>{{.Label}}</span><div class="bar"><i class="{{scoreClass .Score}}" style="width:{{.Score}}%"></i></div><b>{{.Score}}</b></div>{{end}}</div>

{{with .TP}}<h2>Independent verification</h2><table>
<tr><th>Service</th><th>Result</th></tr>
{{with .Observatory}}<tr><td>Mozilla HTTP Observatory</td><td>{{if eq .Status "ok"}}Grade <b>{{.Grade}}</b> ({{.Score}}/100, {{.TestsPassed}}/{{.TestsTotal}} tests passed){{else}}{{.Status}}: {{.Error}}{{end}} {{if .ReportURL}}<a href="{{.ReportURL}}">report</a>{{end}}</td></tr>{{end}}
{{with .SSLLabs}}<tr><td>Qualys SSL Labs</td><td>{{if eq .Status "ok"}}Grade <b>{{.Grade}}</b>{{else}}{{.Status}}: {{.Error}}{{end}} <a href="{{.ReportURL}}">report</a></td></tr>{{end}}
{{with .SafeBrowsing}}<tr><td>Google Safe Browsing</td><td>{{if eq .Status "ok"}}{{if .Matches}}<b style="color:var(--bad)">{{len .Matches}} flagged URL(s)</b>{{else}}No threats found ({{.Checked}} URLs checked){{end}}{{else}}{{.Status}}: {{.Error}}{{end}}</td></tr>{{end}}
{{with .W3C}}<tr><td>W3C HTML validator</td><td>{{if eq .Status "ok"}}{{range .Pages}}<div>{{.URL}} — {{if .Error}}{{.Error}}{{else}}{{.Errors}} errors, {{.Warnings}} warnings{{end}}</div>{{end}}{{else}}{{.Status}}: {{.Error}}{{end}}</td></tr>{{end}}
{{with .RDAP}}<tr><td>Domain (RDAP)</td><td>{{if eq .Status "ok"}}{{.Domain}} · registrar {{.Registrar}} · registered {{date .Registered}} · expires {{date .Expires}} ({{.DaysLeft}} days){{else}}{{.Status}}: {{.Error}}{{end}}</td></tr>{{end}}
{{with .Wayback}}<tr><td>Internet Archive</td><td>{{if eq .Status "ok"}}{{if .FirstCapture.IsZero}}not archived yet{{else}}first capture {{date .FirstCapture}}, latest {{date .LastCapture}}{{end}}{{else}}{{.Status}}: {{.Error}}{{end}}</td></tr>{{end}}
{{with .Tranco}}<tr><td>Tranco rank</td><td>{{if eq .Status "ok"}}{{if .Rank}}#{{.Rank}} ({{.Date}}){{else}}not in the top 1M{{end}}{{else}}{{.Status}}: {{.Error}}{{end}}</td></tr>{{end}}
{{with .GreenWeb}}<tr><td>Green Web Foundation</td><td>{{if eq .Status "ok"}}{{if .Green}}Green hosting{{if .HostedBy}} ({{.HostedBy}}){{end}}{{else}}Not verified as green hosting{{end}}{{else}}{{.Status}}: {{.Error}}{{end}}</td></tr>{{end}}
</table>{{end}}

{{with .R.Site.PageSpeed}}<h2>Lighthouse (PageSpeed Insights)</h2><table><tr><th>Strategy</th><th>Performance</th><th>Accessibility</th><th>Best practices</th><th>SEO</th></tr>
{{range .}}<tr><td>{{.Strategy}}</td>{{if .Error}}<td colspan="4">{{.Error}}</td>{{else}}<td>{{index .Scores "performance"}}</td><td>{{index .Scores "accessibility"}}</td><td>{{index .Scores "best-practices"}}</td><td>{{index .Scores "seo"}}</td>{{end}}</tr>{{end}}</table>{{end}}

<h2>Issues ({{len .Issues}})</h2>
{{range .Issues}}<div class="issue"><h3><span class="sev {{.Severity}}">{{.Severity}}</span>{{.Title}}{{if not .Site}} <span class="muted">— {{.Count}} {{if .Asset}}assets{{else}}URLs ({{pct .Ratio}} of pages){{end}}</span>{{end}}</h3>
<p><b>Why it matters:</b> {{.Why}}</p><p><b>How to fix:</b> {{.Fix}}</p>
{{if .Samples}}<ul class="urls">{{range .Samples}}<li>{{.}}</li>{{end}}{{if gt .More 0}}<li>…and {{.More}} more</li>{{end}}</ul>{{end}}</div>
{{else}}<p>No issues found.</p>{{end}}

<h2>Site</h2><table>
<tr><td>Final URL</td><td>{{.R.Site.FinalURL}}</td></tr>
<tr><td>Server / protocol</td><td>{{.R.Site.Server}} {{.R.Site.Protocol}}{{if .R.Site.HTTP2}} (HTTP/2){{end}}</td></tr>
{{with .R.Site.TLS}}<tr><td>TLS certificate</td><td>{{if .Valid}}valid, {{.Issuer}}, expires {{date .NotAfter}} ({{.DaysLeft}} days), {{.Version}}{{else}}invalid: {{.Error}}{{end}}</td></tr>{{end}}
<tr><td>Security headers grade</td><td>{{.R.Site.SecurityGrade}}</td></tr>
{{with .R.Site.Robots}}<tr><td>robots.txt</td><td>{{if .Found}}found, {{len .Sitemaps}} sitemap reference(s){{else}}missing (HTTP {{.Status}}){{end}}</td></tr>{{end}}
<tr><td>Sitemap URLs</td><td>{{.R.Site.SitemapURLs}}</td></tr>
{{if .R.Site.Tech}}<tr><td>Technologies</td><td>{{range $i, $t := .R.Site.Tech}}{{if $i}}, {{end}}{{$t.Name}}{{end}}</td></tr>{{end}}
</table>
<p class="muted" style="margin-top:32px">Generated by the DataNodes SEO Site Auditor.</p>
</body></html>`))
