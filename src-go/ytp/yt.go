package main

// Innertube player requests, format extraction, client fallback. Port of ytp.py (see MAP.md).

import (
	"bytes"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	origin    = "https://www.youtube.com"
	playerAPI = origin + "/youtubei/v1/player?prettyPrint=false"
	playerTTL = 6 * time.Hour
)

type client struct {
	id      int
	ctx     map[string]any
	ua      string
	cookies bool // sends cookies (logged-in path)
	js      bool // URLs need n/sig solving
}

var clients = map[string]client{
	"ios": {5, map[string]any{"clientName": "IOS", "clientVersion": "20.45.1", "deviceMake": "Apple", "deviceModel": "iPhone16,2",
		"osName": "iPhone", "osVersion": "18.6.2.22G100"},
		"com.google.ios.youtube/20.45.1 (iPhone16,2; U; CPU iOS 18_6_2 like Mac OS X;)", false, false},
	"tv": {7, map[string]any{"clientName": "TVHTML5", "clientVersion": "5.20260707", "deviceMake": "Samsung", "deviceModel": "UKS9800",
		"osName": "Tizen", "osVersion": "2.4.0"},
		"Mozilla/5.0 (SMART-TV; Linux; Tizen 2.4.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/2.4.0 TV Safari/538.1", true, true},
	"android_vr": {28, map[string]any{"clientName": "ANDROID_VR", "clientVersion": "1.65.10", "deviceMake": "Oculus", "deviceModel": "Quest 3",
		"androidSdkVersion": 32, "osName": "Android", "osVersion": "12L"},
		"com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip", false, false},
}

var httpc = &http.Client{}

type httpError struct{ code int }

func (e *httpError) Error() string { return fmt.Sprintf("HTTP Error %d", e.code) }

func fetch(method, u string, body []byte, h map[string]string, timeout time.Duration) ([]byte, error) {
	resp, err := open(method, u, body, h, timeout)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return io.ReadAll(resp.Body)
}

// open returns the response with a 2xx status, or *httpError.
func open(method, u string, body []byte, h map[string]string, timeout time.Duration) (*http.Response, error) {
	req, err := http.NewRequest(method, u, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	for k, v := range h {
		req.Header.Set(k, v)
	}
	c := *httpc
	c.Timeout = timeout
	resp, err := c.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 300 {
		resp.Body.Close()
		return nil, &httpError{resp.StatusCode}
	}
	return resp, nil
}

var vidRe = regexp.MustCompile(`(?:v=|/shorts/|/live/|/embed/|youtu\.be/|/v/)([\w-]{11})`)
var bareVidRe = regexp.MustCompile(`^[\w-]{11}$`)

func videoID(s string) (string, error) {
	if m := vidRe.FindStringSubmatch(s); m != nil {
		return m[1], nil
	}
	if bareVidRe.MatchString(s) {
		return s, nil
	}
	return "", fmt.Errorf("bad url/id: %s", s)
}

// loadCookies reads a raw `a=b; c=d` header or a Netscape cookies.txt.
func loadCookies(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return parseCookies(string(b))
}

// parseCookies turns a raw `a=b; c=d` header or Netscape cookies.txt content into a Cookie header.
func parseCookies(content string) string {
	raw := strings.TrimSpace(content)
	if !strings.Contains(raw, "\t") {
		return raw
	}
	var parts []string
	for _, l := range strings.Split(raw, "\n") {
		l = strings.TrimRight(l, "\r")
		if l == "" || strings.HasPrefix(l, "#") && !strings.HasPrefix(l, "#HttpOnly_") {
			continue
		}
		r := strings.Split(l, "\t")
		if len(r) >= 7 && strings.Contains(r[0], "youtube") {
			parts = append(parts, r[5]+"="+r[6])
		}
	}
	return strings.Join(parts, "; ")
}

func sapisidAuth(cookie string) string {
	c := map[string]string{}
	for _, p := range strings.Split(cookie, ";") {
		if k, v, ok := strings.Cut(strings.TrimSpace(p), "="); ok {
			c[k] = v
		}
	}
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	var out []string
	for _, nk := range [][2]string{{"SAPISIDHASH", "SAPISID"}, {"SAPISID1PHASH", "__Secure-1PAPISID"}, {"SAPISID3PHASH", "__Secure-3PAPISID"}} {
		if v, ok := c[nk[1]]; ok {
			h := sha1.Sum([]byte(ts + " " + v + " " + origin))
			out = append(out, nk[0]+" "+ts+"_"+hex.EncodeToString(h[:]))
		}
	}
	return strings.Join(out, " ")
}

// ---------------------------------------------------------------- player version (cached)

type playerMeta struct {
	ID  string  `json:"id"`
	STS int     `json:"sts"`
	TS  float64 `json:"ts"`
}

var (
	playerMu   sync.Mutex
	playerIDRe = regexp.MustCompile(`player\\?/([0-9a-f]{8})\\?/`)
	stsRe      = regexp.MustCompile(`(?:signatureTimestamp|sts)\s*:\s*(\d{5})`)
)

// playerInfo returns {id, sts}: id from the tiny iframe_api script, sts from the TV player JS. Cached 6 h.
func playerInfo() (playerMeta, error) {
	playerMu.Lock()
	defer playerMu.Unlock()
	meta := filepath.Join(cacheDir, "player.json")
	var p playerMeta
	if b, err := os.ReadFile(meta); err == nil && json.Unmarshal(b, &p) == nil &&
		time.Since(time.Unix(int64(p.TS), 0)) < playerTTL && p.ID != "" {
		return p, nil
	}
	b, err := fetch("GET", origin+"/iframe_api", nil, nil, 15*time.Second)
	if err != nil {
		return p, err
	}
	m := playerIDRe.FindSubmatch(b)
	if m == nil {
		return p, errors.New("player id not found in iframe_api")
	}
	pid := string(m[1])
	jsPath := filepath.Join(cacheDir, pid+".tv.js")
	js, err := os.ReadFile(jsPath)
	if err != nil {
		if js, err = fetch("GET", origin+"/s/player/"+pid+"/tv-player-ias.vflset/tv-player-ias.js", nil, nil, 30*time.Second); err != nil {
			return p, err
		}
		if err := os.WriteFile(jsPath, js, 0o644); err != nil {
			return p, err
		}
	}
	sm := stsRe.FindSubmatch(js)
	if sm == nil {
		return p, errors.New("sts not found in player")
	}
	sts, _ := strconv.Atoi(string(sm[1]))
	p = playerMeta{pid, sts, float64(time.Now().Unix())}
	b, _ = json.Marshal(p)
	_ = os.WriteFile(meta, b, 0o644)
	return p, nil
}

// ---------------------------------------------------------------- innertube

type jmap = map[string]any

func player(vid, cl, cookie string, sts int, pyv bool) jmap {
	c := clients[cl]
	ctx := jmap{"hl": "en", "gl": "US"}
	for k, v := range c.ctx {
		ctx[k] = v
	}
	body := jmap{"context": jmap{"client": ctx}, "videoId": vid, "contentCheckOk": true, "racyCheckOk": true}
	if sts != 0 {
		pc := jmap{"contentPlaybackContext": jmap{"html5Preference": "HTML5_PREF_WANTS", "signatureTimestamp": sts}}
		if pyv {
			// Without this, logged-in non-Premium sessions get a pre-roll ad and the content URLs return 403 for
			// ~3 s (ad gate). BUT on age-restricted videos pyv yields preview-only URLs -> see extract().
			pc["adPlaybackContext"] = jmap{"pyv": true}
		}
		body["playbackContext"] = pc
	}
	h := map[string]string{"Content-Type": "application/json", "User-Agent": c.ua, "Origin": origin,
		"X-YouTube-Client-Name": strconv.Itoa(c.id), "X-YouTube-Client-Version": c.ctx["clientVersion"].(string)}
	if cookie != "" && c.cookies {
		h["Cookie"] = cookie
		h["Authorization"] = sapisidAuth(cookie)
		h["X-Origin"] = origin
		h["X-Goog-AuthUser"] = "0"
	}
	b, _ := json.Marshal(body)
	out, err := fetch("POST", playerAPI, b, h, 15*time.Second)
	if err != nil {
		var he *httpError
		if errors.As(err, &he) {
			return jmap{"playabilityStatus": jmap{"status": fmt.Sprintf("HTTP_%d", he.code)}}
		}
		return jmap{"playabilityStatus": jmap{"status": "ERROR", "reason": err.Error()}}
	}
	var p jmap
	if json.Unmarshal(out, &p) != nil {
		return jmap{"playabilityStatus": jmap{"status": "BAD_JSON"}}
	}
	return p
}

type Format struct {
	Itag         int     `json:"itag"`
	Kind         string  `json:"kind"`
	Ext          string  `json:"ext"`
	Codecs       string  `json:"codecs"`
	Res          string  `json:"res"`
	Height       int     `json:"height"`
	FPS          *int    `json:"fps"`
	Bitrate      int     `json:"bitrate"`
	Size         int64   `json:"size"`
	AbrKbps      int     `json:"abr_kbps"`
	Lang         *string `json:"lang"`
	AudioDefault bool    `json:"audio_default,omitempty"` // the original track on videos with dubbed audio
	DRC          bool    `json:"drc"`
	DRM          bool    `json:"drm"`
	URL          string  `json:"url"`
	Client       string  `json:"client"`
	UA           string  `json:"ua"` // fetch the URL with this User-Agent (and &range=a-b)
}

type Info struct {
	ID        string   `json:"id"`
	Title     *string  `json:"title"`
	Author    *string  `json:"author"`
	Duration  int      `json:"duration"`
	Live      bool     `json:"live"`
	Client    string   `json:"client"`
	Player    *string  `json:"player"`
	HLS       *string  `json:"hls"`
	ExpiresIn int      `json:"expires_in"`
	Formats   []Format `json:"formats"`
	// What the player answer says about the video itself (description, views, channel, …).
	Details   jmap     `json:"details,omitempty"`
	Tried     []string `json:"tried,omitempty"`
	Timing    jmap     `json:"timing,omitempty"`
	Error     string   `json:"error,omitempty"`
}

// timing is shared by the parallel client goroutines.
type timing struct {
	mu            sync.Mutex
	m             jmap
	title, author string // from whichever client's response has them
}

func (t *timing) setMeta(title, author string) {
	t.mu.Lock()
	if t.title == "" {
		t.title, t.author = title, author
	}
	t.mu.Unlock()
}

func (t *timing) meta() (string, string) { t.mu.Lock(); defer t.mu.Unlock(); return t.title, t.author }

func (t *timing) set(k string, v any) { t.mu.Lock(); t.m[k] = v; t.mu.Unlock() }
func (t *timing) since(k string, t0 time.Time) {
	t.set(k, float64(time.Since(t0).Milliseconds())/1000)
}
func (t *timing) copy() jmap {
	t.mu.Lock()
	defer t.mu.Unlock()
	c := jmap{}
	for k, v := range t.m {
		c[k] = v
	}
	return c
}

type rawFmt struct {
	f      jmap
	url    string
	s, sp  string // signature challenge and its param name
	nParam string
}

var codecsRe = regexp.MustCompile(`codecs="([^"]+)"`)

func str(m jmap, k string) string { s, _ := m[k].(string); return s }
func num(m jmap, k string) int {
	switch v := m[k].(type) {
	case float64:
		return int(v)
	case string:
		n, _ := strconv.Atoi(v)
		return n
	}
	return 0
}
func obj(m jmap, k string) jmap  { o, _ := m[k].(jmap); return o }
func arr(m jmap, k string) []any { a, _ := m[k].([]any); return a }
func ptr[T any](v T) *T          { return &v }

func norm(f jmap, cl, u string) Format {
	mime := str(f, "mimeType")
	codecs := ""
	if m := codecsRe.FindStringSubmatch(mime); m != nil {
		codecs = m[1]
	}
	kind := "video"
	if strings.Contains(codecs, ",") {
		kind = "av"
	} else if strings.HasPrefix(mime, "audio") {
		kind = "audio"
	}
	ext := strings.Split(mime, ";")[0]
	ext = ext[strings.LastIndex(ext, "/")+1:]
	abr := num(f, "bitrate")
	if _, ok := f["averageBitrate"]; ok {
		abr = num(f, "averageBitrate")
	}
	out := Format{Itag: num(f, "itag"), Kind: kind, Ext: ext, Codecs: codecs, Res: str(f, "qualityLabel"),
		Height: num(f, "height"), Bitrate: num(f, "bitrate"), Size: int64(num(f, "contentLength")),
		AbrKbps: (abr + 500) / 1000, DRC: f["isDrc"] == true, DRM: f["drmFamilies"] != nil, URL: u, Client: cl,
		UA: clients[cl].ua}
	if _, ok := f["fps"]; ok {
		out.FPS = ptr(num(f, "fps"))
	}
	if at := obj(f, "audioTrack"); at != nil && str(at, "displayName") != "" {
		out.Lang = ptr(str(at, "displayName"))
		out.AudioDefault = at["audioIsDefault"] == true
	}
	return out
}

func queryParam(u, k string) string {
	_, q, _ := strings.Cut(u, "?")
	v, _ := url.ParseQuery(q)
	return v.Get(k)
}

var nParamRe = regexp.MustCompile(`([?&])n=[^&]+`)

// probe=false skips the preview check (see previewOnly): the caller gets the URLs at once and is expected
// to resolve again with the check in the background.
func extract(vid, cl, cookie string, tm *timing, pyv, probe bool) (*Info, string) {
	c := clients[cl]
	var pm playerMeta
	if c.js {
		t0 := time.Now()
		var err error
		if pm, err = playerInfo(); err != nil {
			return nil, "player info: " + err.Error()
		}
		tm.since("player_info", t0)
	}
	key := "player_" + cl
	if !pyv {
		key += "_nopyv"
	}
	t0 := time.Now()
	p := player(vid, cl, cookie, pm.STS, pyv)
	tm.since(key, t0)
	ps, sd := obj(p, "playabilityStatus"), obj(p, "streamingData")
	if d := obj(p, "videoDetails"); str(d, "title") != "" { // the tv client sends none: share across clients
		tm.setMeta(str(d, "title"), str(d, "author"))
	}
	status := str(ps, "status")
	if r := str(ps, "reason"); r != "" {
		status += " (" + r + ")"
	}
	if c.cookies { // cookie client: report whether YouTube accepted the session
		li := false
		for _, x := range arr(obj(p, "responseContext"), "serviceTrackingParams") {
			for _, y := range arr(x.(jmap), "params") {
				if y := y.(jmap); str(y, "key") == "logged_in" {
					li = str(y, "value") == "1"
				}
			}
		}
		tm.set("logged_in", li)
		if !li {
			status += " [cookies NOT logged in - re-export cookies.txt]"
		}
	}
	var raw []rawFmt
	for _, a := range append(arr(sd, "formats"), arr(sd, "adaptiveFormats")...) {
		f := a.(jmap)
		if f["drmFamilies"] != nil {
			continue
		}
		r := rawFmt{f: f, url: str(f, "url")}
		if r.url == "" {
			q, _ := url.ParseQuery(str(f, "signatureCipher"))
			r.url, r.s, r.sp = q.Get("url"), q.Get("s"), q.Get("sp")
			if r.sp == "" {
				r.sp = "signature"
			}
		}
		if r.url != "" {
			r.nParam = queryParam(r.url, "n")
			raw = append(raw, r)
		}
	}
	if str(ps, "status") != "OK" || len(raw) == 0 {
		return nil, status
	}

	var fmts []Format
	if c.js { // solve every distinct n and s at once
		nset, sset := map[string]bool{}, map[string]bool{}
		for _, r := range raw {
			if r.nParam != "" {
				nset[r.nParam] = true
			}
			if r.s != "" {
				sset[r.s] = true
			}
		}
		t0 := time.Now()
		ans, err := solve(pm.ID, keys(nset), keys(sset))
		if err != nil {
			return nil, "solver: " + err.Error()
		}
		tm.since("solve", t0)
		for _, r := range raw {
			u := r.url
			if r.nParam != "" {
				u = nParamRe.ReplaceAllString(u, "${1}n="+url.QueryEscape(ans[r.nParam]))
			}
			if r.s != "" {
				u += "&" + r.sp + "=" + url.QueryEscape(ans[r.s])
			}
			fmts = append(fmts, norm(r.f, cl, u))
		}
	} else {
		for _, r := range raw {
			fmts = append(fmts, norm(r.f, cl, r.url))
		}
	}
	if c.js && pyv && obj(p, "videoDetails")["isLive"] == true {
		// Live on tv: with pyv every segment is 403 for good; without it they serve at once (no ad gate).
		return extract(vid, cl, cookie, tm, false, probe)
	}
	if probe {
		// Preview-only URLs (~60 s of media, then 403) come from: tv + pyv on age-restricted and some public
		// videos, and ios on videos where YouTube wants a PO token. tv without pyv is full but may sit behind
		// the pre-roll ad gate (all 403 for ~3-5 s), so wait that out instead of handing back dead URLs.
		wait := 1200 * time.Millisecond
		if c.js && !pyv {
			wait = 9 * time.Second
		} else if !c.js {
			wait = 0
		}
		t0 := time.Now()
		st := streamState(fmts, c.ua, wait)
		tm.since(key+"_probe", t0)
		switch {
		case st == "preview" && c.js && pyv:
			return extract(vid, cl, cookie, tm, false, probe)
		case st == "preview":
			return nil, status + " [preview-only URLs: 403 after ~60 s]"
		case st == "gated" && (!c.js || !pyv):
			return nil, status + " [stream URLs refused (403)]"
		}
	}
	d := obj(p, "videoDetails")
	info := &Info{ID: vid, Duration: num(d, "lengthSeconds"), Live: d["isLive"] == true, Client: cl,
		ExpiresIn: num(sd, "expiresInSeconds"), Formats: fmts}
	if v := str(d, "title"); v != "" {
		info.Title = ptr(v)
	}
	if v := str(d, "author"); v != "" {
		info.Author = ptr(v)
	}
	info.Details = videoFacts(p)
	if pm.ID != "" {
		info.Player = ptr(pm.ID)
	}
	if v := str(sd, "hlsManifestUrl"); v != "" {
		info.HLS = ptr(v)
	}
	return info, status
}

func keys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func sizeOf(f Format) int64 {
	if f.Size > 0 {
		return f.Size
	}
	n, _ := strconv.ParseInt(queryParam(f.URL, "clen"), 10, 64)
	return n
}

// streamState checks the streams a player would pick: the best video and the best audio (previews can be
// per format: ios has served full SD with every >=720p stream cut at ~60 s). For each it fetches the first
// and last KiB: "full" (every end served), "preview" (a start served, its end 403: the URLs stop after
// ~60 s), "gated" (all 403 for `wait`: ad gate / refused). Nothing in the player response tells these apart.
func streamState(fmts []Format, ua string, wait time.Duration) string {
	var targets []Format
	for _, sel := range []string{"bv", "ba"} {
		if f, err := pick(fmts, sel); err == nil && sizeOf(f) > 1024 {
			targets = append(targets, f)
		}
	}
	if len(targets) == 0 {
		return "full"
	}
	// 1 = served, 0 = refused (403), -1 = no answer (timeout / network)
	get := func(f Format, a int64) int {
		_, err := fetch("GET", fmt.Sprintf("%s&range=%d-%d", f.URL, a, a+1023), nil, map[string]string{"User-Agent": ua}, 4*time.Second)
		var he *httpError
		switch {
		case err == nil:
			return 1
		case errors.As(err, &he) && he.code == 403:
			return 0
		}
		return -1
	}
	deadline := time.Now().Add(wait)
	gated, recheck := false, false
	for try := 0; ; try++ {
		res := make([]int, 2*len(targets))
		var wg sync.WaitGroup
		for i, f := range targets {
			wg.Add(2)
			go func() { defer wg.Done(); res[2*i] = get(f, 0) }()
			go func() { defer wg.Done(); res[2*i+1] = get(f, sizeOf(f)-1024) }()
		}
		wg.Wait()
		full, preview, unknown := true, false, false
		for i := range targets {
			start, end := res[2*i], res[2*i+1]
			full = full && end == 1
			preview = preview || start == 1 && end == 0
			unknown = unknown || start == -1 || end == -1
		}
		switch {
		case full:
			return "full"
		case preview && gated && !recheck:
			// the ad gate lifts per request: right as it opens, a start can pass while its end still
			// gets 403. Look once more before calling it a preview.
			recheck = true
			time.Sleep(300 * time.Millisecond)
			continue
		case preview:
			return "preview"
		case unknown && try < 2:
			continue // slow/unreachable node: ask again rather than guess
		case unknown:
			return "full" // can't tell; don't throw away URLs that may well work
		case time.Now().After(deadline):
			return "gated"
		}
		gated = true
		time.Sleep(300 * time.Millisecond)
	}
}

// resolve runs all clients in parallel; the first OK one in `order` wins.
func resolve(vid, cookie string, order []string) *Info { return resolveOpt(vid, cookie, order, true) }

// resolveOpt is resolve with the preview check switchable (see extract).
func resolveOpt(vid, cookie string, order []string, probe bool) *Info {
	var use []string
	for _, cl := range order {
		if cookie != "" || !clients[cl].cookies {
			use = append(use, cl)
		}
	}
	tm := &timing{m: jmap{}}
	var oembed chan [2]string
	for _, cl := range use {
		if clients[cl].js { // tv responses carry no title/author; fetch them alongside in case no other client does
			oembed = make(chan [2]string, 1)
			go func() {
				var o struct {
					Title      string `json:"title"`
					AuthorName string `json:"author_name"`
				}
				b, err := fetch("GET", origin+"/oembed?format=json&url="+url.QueryEscape("https://www.youtube.com/watch?v="+vid), nil, nil, 3*time.Second)
				if err == nil {
					json.Unmarshal(b, &o)
				}
				oembed <- [2]string{o.Title, o.AuthorName}
			}()
			break
		}
	}
	type res struct {
		info   *Info
		status string
	}
	chans := map[string]chan res{}
	for _, cl := range use {
		ch := make(chan res, 1)
		chans[cl] = ch
		go func(cl string) {
			defer func() {
				if r := recover(); r != nil {
					ch <- res{nil, fmt.Sprint("panic: ", r)}
				}
			}()
			i, s := extract(vid, cl, cookie, tm, true, probe)
			ch <- res{i, s}
		}(cl)
	}
	var tried []string
	for _, cl := range use { // preference order; stop waiting as soon as a preferred client succeeds
		var r res
		select {
		case r = <-chans[cl]:
		case <-time.After(60 * time.Second):
			r = res{nil, "timeout"}
		}
		tried = append(tried, cl+": "+r.status)
		if r.info != nil {
			r.info.Tried, r.info.Timing = tried, tm.copy()
			if r.info.Title == nil {
				title, author := tm.meta()
				if title == "" && oembed != nil {
					select {
					case o := <-oembed:
						title, author = o[0], o[1]
					case <-time.After(3 * time.Second):
					}
				}
				if title != "" {
					r.info.Title = ptr(title)
				}
				if author != "" {
					r.info.Author = ptr(author)
				}
			}
			return r.info
		}
	}
	return &Info{ID: vid, Error: "no playable streams", Tried: tried, Timing: tm.copy(), Formats: []Format{}}
}

// ---------------------------------------------------------------- selection / download

func pick(fmts []Format, sel string) (Format, error) {
	var r []Format
	filter := func(ok func(Format) bool) {
		r = r[:0]
		for _, f := range fmts {
			if ok(f) {
				r = append(r, f)
			}
		}
	}
	fps := func(f Format) int {
		if f.FPS == nil {
			return 0
		}
		return *f.FPS
	}
	if n, err := strconv.Atoi(sel); err == nil {
		filter(func(f Format) bool { return f.Itag == n })
	} else if sel == "ba" {
		filter(func(f Format) bool { return f.Kind == "audio" && !f.DRC })
		for _, f := range r {
			if f.AudioDefault { // dubbed video: keep the original-language track
				filter(func(f Format) bool { return f.Kind == "audio" && !f.DRC && f.AudioDefault })
				break
			}
		}
		sort.SliceStable(r, func(i, j int) bool { return r[i].Bitrate < r[j].Bitrate })
	} else if sel == "bv" {
		filter(func(f Format) bool { return f.Kind == "video" })
		sort.SliceStable(r, func(i, j int) bool {
			a, b := r[i], r[j]
			if a.Height != b.Height {
				return a.Height < b.Height
			}
			if fps(a) != fps(b) {
				return fps(a) < fps(b)
			}
			return a.Bitrate < b.Bitrate
		})
	} else { // best muxed, else best video-only
		byHB := func() {
			sort.SliceStable(r, func(i, j int) bool {
				if r[i].Height != r[j].Height {
					return r[i].Height < r[j].Height
				}
				return r[i].Bitrate < r[j].Bitrate
			})
		}
		filter(func(f Format) bool { return f.Kind == "av" })
		if len(r) == 0 {
			filter(func(f Format) bool { return f.Kind == "video" })
		}
		byHB()
	}
	if len(r) == 0 {
		return Format{}, fmt.Errorf("no format matches %s", sel)
	}
	return r[len(r)-1], nil
}

var hostRe = regexp.MustCompile(`^(https://rr\d+---)([\w-]+)(\.googlevideo\.com/.*)$`)

// mirrors: the same URL on each cache node listed in mn= (what the official player does on failure).
func mirrors(u string) []string {
	m := hostRe.FindStringSubmatch(u)
	mn := strings.Split(queryParam(u, "mn"), ",")
	if m == nil || mn[0] == "" {
		return []string{u}
	}
	out := []string{u}
	for i, node := range mn {
		if node != m[2] {
			out = append(out, fmt.Sprintf("%s%s%s&fallback_count=%d", m[1], node, m[3], i+1))
		}
	}
	return out
}

// download fetches &range=a-b chunks (no per-connection throttling, resumable), failing over to mirror nodes.
func download(f Format, out string) error {
	const chunk = 10 << 20
	ua := clients[f.Client].ua
	urls := mirrors(f.URL)
	size := sizeOf(f)
	if size == 0 {
		resp, err := open("HEAD", f.URL, nil, map[string]string{"User-Agent": ua}, 15*time.Second)
		if err != nil {
			return err
		}
		resp.Body.Close()
		size = resp.ContentLength
	}
	var pos int64
	if st, err := os.Stat(out); err == nil {
		pos = st.Size()
	}
	fh, err := os.OpenFile(out, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer fh.Close()
	t0 := time.Now()
	for pos < size {
		end := min(pos+chunk, size) - 1
		var data []byte
		for attempt := 0; ; attempt++ {
			data, err = fetch("GET", fmt.Sprintf("%s&range=%d-%d", urls[0], pos, end), nil, map[string]string{"User-Agent": ua}, 20*time.Second)
			if err == nil {
				break
			}
			var he *httpError
			if errors.As(err, &he) && he.code == 403 || attempt == 2*len(urls)-1 {
				return err
			}
			urls = append(urls[1:], urls[0]) // node unreachable/timeout (VPNs!) -> rotate to next mirror
		}
		if _, err := fh.Write(data); err != nil {
			return err
		}
		pos += int64(len(data))
		el := max(time.Since(t0).Seconds(), 1e-3)
		fmt.Fprintf(os.Stderr, "\r%3d%%  %d/%d MiB  %.1f MB/s", pos*100/size, pos>>20, size>>20, float64(pos)/el/1e6)
	}
	fmt.Fprintln(os.Stderr)
	return nil
}
