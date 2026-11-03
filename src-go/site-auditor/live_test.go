package main

import (
	"context"
	"os"
	"testing"
	"time"
)

// TestLiveThirdParty hits the real verification APIs to catch format changes.
// Opt-in: LIVE_VERIFY=1 go test -run TestLiveThirdParty -v
func TestLiveThirdParty(t *testing.T) {
	if os.Getenv("LIVE_VERIFY") != "1" {
		t.Skip("set LIVE_VERIFY=1 to call the real third-party services")
	}
	host := os.Getenv("LIVE_VERIFY_HOST")
	if host == "" {
		host = "wikipedia.org"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()

	if o := observatoryScan(ctx, host); o.Status != "ok" || o.Grade == "" {
		t.Errorf("observatory: %+v", o)
	} else {
		t.Logf("observatory: grade %s score %d (%d/%d)", o.Grade, o.Score, o.TestsPassed, o.TestsTotal)
	}
	if d := rdapLookup(ctx, host); d.Status != "ok" || d.Registered.IsZero() || d.Expires.IsZero() {
		t.Errorf("rdap: %+v", d)
	} else {
		t.Logf("rdap: registrar %q registered %s expires %s statuses %v", d.Registrar, d.Registered.Format("2006-01-02"), d.Expires.Format("2006-01-02"), d.Statuses)
	}
	if w := waybackLookup(ctx, host); w.Status != "ok" || w.FirstCapture.IsZero() {
		t.Errorf("wayback: %+v", w)
	} else {
		t.Logf("wayback: first %s last %s", w.FirstCapture.Format("2006-01-02"), w.LastCapture.Format("2006-01-02"))
	}
	if tr := trancoRank(ctx, host); tr.Status != "ok" || tr.Rank == 0 {
		t.Errorf("tranco: %+v", tr)
	} else {
		t.Logf("tranco: #%d on %s", tr.Rank, tr.Date)
	}
	if g := greenWeb(ctx, "www."+host); g.Status != "ok" {
		t.Errorf("green web: %+v", g)
	} else {
		t.Logf("green web: green=%v hosted by %q", g.Green, g.HostedBy)
	}
	a := &Audit{opts: Options{}, report: &Report{}, resources: map[string]*Resource{}, ctx: ctx}
	a.report.Site.Origin = "https://" + host
	a.start = mustURL("https://" + host + "/")
	if s := a.safeBrowsing(ctx); s.Status == "error" {
		t.Errorf("safe browsing: %+v", s)
	} else {
		t.Logf("safe browsing: %s %s", s.Status, s.Error)
	}
	// W3C: validate a tiny document directly (verifyW3C needs a crawl).
	var out struct {
		Messages []struct {
			Type string `json:"type"`
		} `json:"messages"`
	}
	if _, err := getJSON(ctx, "POST", w3cEndpoint, stringsReader("<!DOCTYPE html><html lang=en><head><title>x</title></head><body><div></span></body></html>"),
		map[string]string{"Content-Type": "text/html; charset=utf-8"}, &out); err != nil || len(out.Messages) == 0 {
		t.Errorf("w3c: %v %+v", err, out)
	} else {
		t.Logf("w3c: %d messages", len(out.Messages))
	}
	if os.Getenv("LIVE_SSLLABS") == "1" {
		s := sslLabs(ctx, host)
		t.Logf("ssl labs: %+v", s)
	}
}
