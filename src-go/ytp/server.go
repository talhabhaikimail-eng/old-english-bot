package main

// Local test player: port of server.py. ui.html is embedded in the binary.
//
//	GET /                     UI
//	GET /api/resolve?url=...  resolve() with cookies -> formats + timing
//	GET /s/<key>?range=a-b    byte-range proxy to googlevideo (mirror fallback, same IP as resolver)

import (
	"crypto/rand"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed ui.html
var uiHTML []byte

type stream struct {
	mu   sync.Mutex
	urls []string
	ua   string
	size int64
}

var (
	streamsMu sync.Mutex
	streams   = map[string]*stream{}
)

type cookieFile struct {
	mu    sync.Mutex
	path  string
	mtime time.Time
	value string
}

// get re-reads the file whenever it changes, so sessions can be swapped without restarting.
func (c *cookieFile) get() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	st, err := os.Stat(c.path)
	if err != nil {
		return ""
	}
	if !st.ModTime().Equal(c.mtime) {
		c.mtime, c.value = st.ModTime(), loadCookies(c.path)
	}
	return c.value
}

// serve runs the CLI test server (blocks).
func serve(port, cookiePath string) {
	ck := &cookieFile{path: cookiePath}
	state := "none"
	if ck.get() != "" {
		state = "loaded"
	}
	fmt.Printf("cookies: %s (%s)   open http://127.0.0.1:%s\n", state, cookiePath, port)
	go func() {
		if err := warmup(); err != nil {
			fmt.Println(err)
		}
	}()
	srv := &http.Server{Addr: "127.0.0.1:" + port, Handler: newMux(ck.get)}
	if err := srv.ListenAndServe(); err != nil {
		die("%v", err)
	}
}

// warmup fetches the player and builds the solver so the first resolve is fast.
func warmup() error {
	p, err := playerInfo()
	if err != nil {
		return fmt.Errorf("player warmup failed: %w", err)
	}
	if _, err := solve(p.ID, []string{probeN}, nil); err != nil {
		return fmt.Errorf("solver warmup failed: %w", err)
	}
	return nil
}

// newMux builds the server's routes; cookies() is asked for the current cookie header on every resolve.
func newMux(cookies func() string) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			sendJSON(w, 404, jmap{"error": "not found"})
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Write(uiHTML)
	})
	mux.HandleFunc("/api/resolve", func(w http.ResponseWriter, r *http.Request) {
		t0 := time.Now()
		q := r.URL.Query()
		vid, err := videoID(q.Get("url"))
		if err != nil {
			sendJSON(w, 400, jmap{"error": err.Error()})
			return
		}
		order := []string{"ios", "tv"}
		if q.Get("cookie_first") == "1" {
			order = []string{"tv", "ios"}
		}
		info := resolve(vid, cookies(), order)
		fmt.Fprintf(os.Stderr, "resolve %s via %q in %s | %s\n", vid, info.Client, time.Since(t0).Round(time.Millisecond), strings.Join(info.Tried, "; "))
		if info.Error != "" {
			sendJSON(w, 200, info)
			return
		}
		var fmts []jmap
		for _, f := range info.Formats {
			key := token()
			size := sizeOf(f)
			streamsMu.Lock()
			streams[key] = &stream{urls: mirrors(f.URL), ua: clients[f.Client].ua, size: size}
			streamsMu.Unlock()
			fmts = append(fmts, jmap{"itag": f.Itag, "kind": f.Kind, "ext": f.Ext, "codecs": f.Codecs, "res": f.Res,
				"height": f.Height, "fps": f.FPS, "bitrate": f.Bitrate, "drc": f.DRC, "lang": f.Lang,
				"size": size, "src": "/s/" + key, "direct": f.URL})
		}
		b, _ := json.Marshal(info)
		var out jmap
		json.Unmarshal(b, &out)
		out["formats"] = fmts
		tm, _ := out["timing"].(jmap)
		if tm == nil {
			tm = jmap{}
		}
		tm["server_total"] = float64(time.Since(t0).Milliseconds()) / 1000
		out["timing"] = tm
		sendJSON(w, 200, out)
	})
	mux.HandleFunc("/s/", func(w http.ResponseWriter, r *http.Request) {
		streamsMu.Lock()
		s := streams[strings.TrimPrefix(r.URL.Path, "/s/")]
		streamsMu.Unlock()
		if s == nil {
			sendJSON(w, 404, jmap{"error": "unknown stream"})
			return
		}
		proxy(w, r, s)
	})
	registerAPI(mux, cookies)
	return mux
}

func proxy(w http.ResponseWriter, r *http.Request, s *stream) {
	rng := r.URL.Query().Get("range")
	if rng == "" {
		rng = "0-"
	}
	a, b, _ := strings.Cut(rng, "-")
	if b == "" {
		b = strconv.FormatInt(s.size-1, 10)
	}
	s.mu.Lock()
	n := len(s.urls)
	s.mu.Unlock()
	var resp *http.Response
	var last error
	for i := 0; i < n; i++ {
		s.mu.Lock()
		u := s.urls[0]
		s.mu.Unlock()
		var err error
		resp, err = open("GET", u+"&range="+a+"-"+b, nil, map[string]string{"User-Agent": s.ua}, 6*time.Second)
		if err == nil {
			break
		}
		last = err
		var he *httpError
		if errors.As(err, &he) && he.code == 403 {
			break // URL itself rejected; mirrors won't help
		}
		s.mu.Lock() // node unreachable -> rotate to next mirror
		s.urls = append(s.urls[1:], s.urls[0])
		s.mu.Unlock()
	}
	if resp == nil {
		sendJSON(w, 502, jmap{"error": fmt.Sprint(last)})
		return
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		sendJSON(w, 502, jmap{"error": err.Error()})
		return
	}
	ct := resp.Header.Get("Content-Type")
	if ct == "" {
		ct = "application/octet-stream"
	}
	h := w.Header()
	h.Set("Content-Type", ct)
	h.Set("Content-Length", strconv.Itoa(len(data)))
	h.Set("Cache-Control", "no-store")
	h.Set("X-Total-Size", strconv.FormatInt(s.size, 10))
	if pu, err := url.Parse(resp.Request.URL.String()); err == nil {
		h.Set("X-Upstream", pu.Host)
	}
	w.WriteHeader(200)
	w.Write(data)
}

func sendJSON(w http.ResponseWriter, code int, v any) {
	b, _ := json.Marshal(v)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Length", strconv.Itoa(len(b)))
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	w.Write(b)
}

func token() string {
	b := make([]byte, 9)
	rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}
