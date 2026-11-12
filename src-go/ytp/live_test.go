//go:build live

package main

// Real-world sweep against YouTube (network + a logged-in cookies.txt):
//
//	go test -tags live -run TestLive -v -timeout 60m                 # search-driven sweep
//	YTP_IDS="id1,id2" go test -tags live -run TestLive -v            # just these
//	YTP_PER_QUERY=8 YTP_PAR=4 YTP_COOKIES=cookies.txt ...
//
// For each video: resolve with the default order (ios,tv) and the cookie client alone (tv), then fetch the
// first, middle and last KiB of the picked video and audio streams (a preview/ad-gate/n-sig bug shows up
// as a 403 there), or the HLS manifest + first segment for live streams.

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

var searches = []struct{ q, sp string }{
	{"official music video", ""},
	{"vevo", ""},
	{"age restricted video", ""},
	{"horror movie trailer red band", ""},
	{"music", "EgJAAQ%3D%3D"},       // live now
	{"news", "EgJAAQ%3D%3D"},        // live now
	{"nature", "EgJwAQ%3D%3D"},      // 4K
	{"hdr", "EgPIAQE%3D"},           // HDR
	{"360 video", "EgJ4AQ%3D%3D"},   // 360
	{"documentary", "EgIYAg%3D%3D"}, // > 20 min
	{"podcast full episode", "EgIYAg%3D%3D"},
	{"funny", "EgIYAQ%3D%3D"}, // < 4 min
	{"#shorts", ""},
	{"nursery rhymes", ""}, // made for kids
	{"mrbeast", ""},        // multi-language audio tracks
	{"lofi hip hop", ""},
	{"gaming walkthrough", ""},
	{"premiere", ""},
}

var fixedIDs = []string{
	"dQw4w9WgXcQ", "jNQXAC9IVRw", "kJQP7kiw5Fk", "aqz-KE-bpKQ", "BaW_jenozKc", "nfWlot6h_JM", "IB3lcPjvWLA",
	"a9LDPn-MO4I", "07FYdnEawAQ", "6SJNVb0GnPI", "HtVdAasjOgU", "Tq92D6wQ1mg", "jfKfPfyJRdk", "XqZsoesa55w",
	"0e3GPea1Tyg", "aaaaaaaaaaa",
}

var idInPage = regexp.MustCompile(`"videoId":"([\w-]{11})"`)

func searchIDs(t *testing.T, cookie string, per int) []string {
	var out []string
	seen := map[string]bool{}
	for _, s := range searches {
		u := "https://www.youtube.com/results?search_query=" + url.QueryEscape(s.q)
		if s.sp != "" {
			u += "&sp=" + s.sp
		}
		b, err := fetch("GET", u, nil, map[string]string{"Cookie": cookie, "Accept-Language": "en-US,en;q=0.9",
			"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36"}, 15*time.Second)
		if err != nil {
			t.Logf("search %q: %v", s.q, err)
			continue
		}
		n := 0
		for _, m := range idInPage.FindAllSubmatch(b, -1) {
			if id := string(m[1]); !seen[id] && n < per {
				seen[id] = true
				out = append(out, id)
				n++
			}
		}
	}
	return out
}

type probeRes struct{ start, mid, end string }

func rangeStatus(u, ua string, a, b int64) string {
	_, err := fetch("GET", fmt.Sprintf("%s&range=%d-%d", u, a, b), nil, map[string]string{"User-Agent": ua}, 10*time.Second)
	if err == nil {
		return "ok"
	}
	var he *httpError
	if errors.As(err, &he) {
		return strconv.Itoa(he.code)
	}
	return "neterr"
}

func probeFormat(f Format) probeRes {
	s := sizeOf(f)
	if s <= 2048 {
		return probeRes{"nosize", "", ""}
	}
	return probeRes{rangeStatus(f.URL, f.UA, 0, 1023), rangeStatus(f.URL, f.UA, s/2, s/2+1023), rangeStatus(f.URL, f.UA, s-1024, s-1)}
}

func (p probeRes) ok() bool { return p.start == "ok" && p.mid == "ok" && p.end == "ok" }

type row struct {
	id, mode, title, client, status, detail string
	dur                                     time.Duration
	ok                                      bool
}

func checkOne(vid, cookie string, order []string, mode string) row {
	t0 := time.Now()
	info := resolve(vid, cookie, order)
	r := row{id: vid, mode: mode, dur: time.Since(t0), client: info.Client}
	if info.Title != nil {
		r.title = *info.Title
		if len(r.title) > 38 {
			r.title = r.title[:38]
		}
	}
	if info.Error != "" {
		r.status, r.detail = "NOSTREAM", strings.Join(info.Tried, " | ")
		return r
	}
	if info.Live { // live: no HLS any more; adaptive URLs serve the newest segment (or &sq=N)
		var parts []string
		r.ok = true
		for _, sel := range []string{"bv", "ba"} {
			f, err := pick(info.Formats, sel)
			if err != nil {
				parts, r.ok = append(parts, sel+":none"), false
				continue
			}
			st := "ok"
			if _, err := fetch("GET", f.URL, nil, map[string]string{"User-Agent": f.UA}, 10*time.Second); err != nil {
				st, r.ok = err.Error(), false
			}
			parts = append(parts, fmt.Sprintf("%s:%d[%s]", sel, f.Itag, st))
		}
		r.status = map[bool]string{true: "LIVE-OK", false: "LIVE-FAIL"}[r.ok]
		r.detail = strings.Join(parts, " ") + "  " + strings.Join(info.Tried, " | ")
		return r
	}
	var parts []string
	r.ok = true
	for _, sel := range []string{"bv", "ba"} {
		f, err := pick(info.Formats, sel)
		if err != nil {
			parts = append(parts, sel+":none")
			if sel == "ba" { // every non-live video has audio
				r.ok = false
			}
			continue
		}
		p := probeFormat(f)
		parts = append(parts, fmt.Sprintf("%s:%d[%s/%s/%s]", sel, f.Itag, p.start, p.mid, p.end))
		if !p.ok() && p.start != "nosize" {
			r.ok = false
		}
	}
	tj, _ := json.Marshal(info.Timing)
	r.detail = strings.Join(parts, " ") + "  " + strings.Join(info.Tried, " | ") + "  " + string(tj)
	if r.status == "" {
		r.status = map[bool]string{true: "OK", false: "BROKEN"}[r.ok]
	}
	return r
}

func TestLive(t *testing.T) {
	cacheDir = os.Getenv("YTP_CACHE")
	if cacheDir == "" {
		d, _ := os.UserCacheDir()
		cacheDir = d + string(os.PathSeparator) + "ytp"
	}
	os.MkdirAll(cacheDir, 0o755)
	cp := os.Getenv("YTP_COOKIES")
	if cp == "" {
		cp = "cookies.txt"
	}
	cookie := loadCookies(cp)
	if cookie == "" {
		t.Fatal("no cookies in " + cp)
	}
	t0 := time.Now()
	if err := warmup(); err != nil {
		t.Fatal(err)
	}
	t.Logf("warmup %.2fs", time.Since(t0).Seconds())

	var ids []string
	if s := os.Getenv("YTP_IDS"); s != "" {
		ids = strings.Split(s, ",")
	} else {
		per, _ := strconv.Atoi(os.Getenv("YTP_PER_QUERY"))
		if per == 0 {
			per = 5
		}
		ids = append(append(ids, fixedIDs...), searchIDs(t, cookie, per)...)
	}
	par, _ := strconv.Atoi(os.Getenv("YTP_PAR"))
	if par == 0 {
		par = 4
	}
	t.Logf("%d videos, %d at a time", len(ids), par)

	var mu sync.Mutex
	var rows []row
	sem := make(chan struct{}, par)
	var wg sync.WaitGroup
	for _, id := range ids {
		wg.Add(1)
		sem <- struct{}{}
		go func(id string) {
			defer func() { <-sem; wg.Done() }()
			a := checkOne(id, cookie, []string{"ios", "tv"}, "default")
			b := checkOne(id, cookie, []string{"tv"}, "tv")
			mu.Lock()
			rows = append(rows, a, b)
			t.Logf("%-11s %-7s %-10s %-4s %5.2fs %-38s %s", a.id, a.mode, a.status, a.client, a.dur.Seconds(), a.title, a.detail)
			t.Logf("%-11s %-7s %-10s %-4s %5.2fs %-38s %s", b.id, b.mode, b.status, b.client, b.dur.Seconds(), "", b.detail)
			mu.Unlock()
		}(id)
	}
	wg.Wait()

	sort.Slice(rows, func(i, j int) bool { return rows[i].dur < rows[j].dur })
	cnt := map[string]int{}
	var durs []float64
	for _, r := range rows {
		cnt[r.mode+":"+r.status]++
		if r.ok {
			durs = append(durs, r.dur.Seconds())
		}
	}
	t.Logf("summary %v", cnt)
	if n := len(durs); n > 0 {
		t.Logf("resolve time (ok rows): p50 %.2fs p90 %.2fs max %.2fs", durs[n/2], durs[n*9/10], durs[n-1])
	}
}
