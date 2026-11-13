package main

// Downloader API, served next to the test player by `ytp serve`.
//
//	GET /health                              {"ok":true,"cookies":bool}
//	GET /api/info?url=URL                    title, author, duration, live, and what can be downloaded:
//	                                         every video height (up to 4K and above) with its codec,
//	                                         container and size, and the audio choices
//	GET /api/download?url=URL&height=720     best video up to that height merged with the best
//	                                         audio (needs ffmpeg on PATH); mp4, or webm/mkv when the
//	                                         height only exists as VP9
//	GET /api/download?url=URL&audio=1        best audio only, as m4a when there is one (plays
//	                                         everywhere); ext=webm asks for Opus instead
//	GET /api/download?url=URL&f=b|bv|ba|ITAG one format, streamed as it is fetched
//	GET /api/record?url=URL&minutes=5&height=720   a live stream, recorded from now for that long
//	GET /api/progress?id=ID                  how far a download or recording that was started with
//	                                         &id=ID has got: {"stage","done","total"}
//
// Add cookie_first=1 to use the logged-in tv client first. Errors are JSON: {"error": "..."}.

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// progress of one download, for callers that passed &id=.
type progress struct {
	stage       atomic.Value // string
	done, total atomic.Int64
}

var (
	progressMu sync.Mutex
	progresses = map[string]*progress{}
)

// track registers a progress under id (none when id is empty) and returns it with its cleanup.
func track(id string) (*progress, func()) {
	p := &progress{}
	p.stage.Store("starting")
	if id == "" {
		return p, func() {}
	}
	progressMu.Lock()
	progresses[id] = p
	progressMu.Unlock()
	return p, func() {
		// Kept a little longer so the last poll still sees the end.
		time.AfterFunc(30*time.Second, func() {
			progressMu.Lock()
			if progresses[id] == p {
				delete(progresses, id)
			}
			progressMu.Unlock()
		})
	}
}

func registerAPI(mux *http.ServeMux, cookies func() string) {
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		sendJSON(w, 200, jmap{"ok": true, "cookies": cookies() != ""})
	})
	mux.HandleFunc("/api/progress", func(w http.ResponseWriter, r *http.Request) {
		progressMu.Lock()
		p := progresses[r.URL.Query().Get("id")]
		progressMu.Unlock()
		if p == nil {
			sendJSON(w, 404, jmap{"error": "unknown id"})
			return
		}
		sendJSON(w, 200, jmap{"stage": p.stage.Load(), "done": p.done.Load(), "total": p.total.Load()})
	})
	// resolved answers a request's video, or sends the error and returns nil.
	resolved := func(w http.ResponseWriter, r *http.Request) (*Info, string) {
		q := r.URL.Query()
		vid, err := videoID(q.Get("url"))
		if err != nil {
			sendJSON(w, 400, jmap{"error": err.Error()})
			return nil, ""
		}
		order := []string{"ios", "tv"}
		if q.Get("cookie_first") == "1" {
			order = []string{"tv", "ios"}
		}
		t0 := time.Now()
		info := resolve(vid, cookies(), order)
		fmt.Fprintf(os.Stderr, "%s %s via %q in %s | %s\n", strings.TrimPrefix(r.URL.Path, "/api/"), vid, info.Client,
			time.Since(t0).Round(time.Millisecond), strings.Join(info.Tried, "; "))
		if info.Error != "" {
			sendJSON(w, 502, info)
			return nil, ""
		}
		return info, vid
	}
	mux.HandleFunc("/api/info", func(w http.ResponseWriter, r *http.Request) {
		info, vid := resolved(w, r)
		if info == nil {
			return
		}
		sendJSON(w, 200, describe(info, vid))
	})
	mux.HandleFunc("/api/download", func(w http.ResponseWriter, r *http.Request) {
		info, vid := resolved(w, r)
		if info == nil {
			return
		}
		q := r.URL.Query()
		if info.Live {
			sendJSON(w, 409, jmap{"error": "this is a live stream: record it with /api/record?minutes=N"})
			return
		}
		p, done := track(q.Get("id"))
		defer done()
		name := safeName(deref(info.Title), vid)
		if h := q.Get("height"); h != "" {
			height, err := strconv.Atoi(h)
			if err != nil || height <= 0 {
				sendJSON(w, 400, jmap{"error": "height must be a number, for example 720"})
				return
			}
			sendMerged(w, r, info, height, name, p)
			return
		}
		sel := q.Get("f")
		if q.Get("audio") == "1" {
			sel = "ba"
		}
		if sel == "" {
			sel = "b"
		}
		f, err := pick(info.Formats, sel)
		if err != nil {
			sendJSON(w, 404, jmap{"error": err.Error()})
			return
		}
		if q.Get("audio") == "1" {
			want := "m4a"
			if q.Get("ext") == "webm" {
				want = "webm"
			}
			if best, ok := audioLike(info, f, want); ok {
				f = best
			}
		}
		sendFormat(w, r, f, name, p)
	})
	mux.HandleFunc("/api/record", func(w http.ResponseWriter, r *http.Request) {
		info, vid := resolved(w, r)
		if info == nil {
			return
		}
		q := r.URL.Query()
		if !info.Live {
			sendJSON(w, 409, jmap{"error": "this is not a live stream: use /api/download"})
			return
		}
		minutes, err := strconv.ParseFloat(q.Get("minutes"), 64)
		if q.Get("minutes") == "" {
			minutes, err = 5, nil
		}
		if err != nil || minutes <= 0 || minutes > 120 {
			sendJSON(w, 400, jmap{"error": "minutes must be between 0 and 120"})
			return
		}
		height, _ := strconv.Atoi(q.Get("height"))
		if height <= 0 {
			height = 720
		}
		p, done := track(q.Get("id"))
		defer done()
		sendRecording(w, r, info, height, time.Duration(minutes*float64(time.Minute)), safeName(deref(info.Title), vid), p)
	})
}

// audioLike finds the best audio in a container family ("m4a" or "webm") on the same track
// (language) as `like`.
func audioLike(info *Info, like Format, family string) (Format, bool) {
	want := map[string]bool{"m4a": true, "mp4": true}
	if family == "webm" {
		want = map[string]bool{"webm": true}
	}
	var best *Format
	for i, c := range info.Formats {
		if c.Kind == "audio" && !c.DRC && !c.DRM && want[c.Ext] && sameLang(c.Lang, like.Lang) && (best == nil || c.Bitrate > best.Bitrate) {
			best = &info.Formats[i]
		}
	}
	if best == nil {
		return Format{}, false
	}
	return *best, true
}

// chooseMerged picks what a merged download at up to `height` is made of: the tallest video, at
// the same height H.264 in mp4 (plays everywhere) and then the higher bitrate, with the best
// audio of the same container family so nothing has to be re-encoded.
func chooseMerged(info *Info, height int) (video, audio Format, ext string, err error) {
	var videos []Format
	for _, f := range info.Formats {
		if f.Kind == "video" && !f.DRM && f.Height <= height {
			videos = append(videos, f)
		}
	}
	if len(videos) == 0 {
		return video, audio, "", fmt.Errorf("no video at or below %dp", height)
	}
	sort.SliceStable(videos, func(i, j int) bool {
		a, b := videos[i], videos[j]
		if a.Height != b.Height {
			return a.Height > b.Height
		}
		am, bm := strings.HasPrefix(a.Codecs, "avc1"), strings.HasPrefix(b.Codecs, "avc1")
		if am != bm {
			return am
		}
		return a.Bitrate > b.Bitrate
	})
	video = videos[0]
	if audio, err = pick(info.Formats, "ba"); err != nil {
		return video, audio, "", err
	}
	ext = "mp4"
	if video.Ext == "webm" {
		ext = "webm"
	}
	family := map[string]string{"mp4": "m4a", "webm": "webm"}[ext]
	if best, ok := audioLike(info, audio, family); ok {
		audio = best
	} else if ext == "webm" {
		ext = "mkv" // VP9 with AAC only fits in Matroska
	}
	return video, audio, ext, nil
}

// describe lists what can be downloaded from a resolved video.
func describe(info *Info, vid string) jmap {
	heights := map[int]bool{}
	for _, f := range info.Formats {
		if f.Kind == "video" && !f.DRM && f.Height > 0 {
			heights[f.Height] = true
		}
	}
	var hs []int
	for h := range heights {
		hs = append(hs, h)
	}
	sort.Sort(sort.Reverse(sort.IntSlice(hs)))
	videos := []jmap{}
	for _, h := range hs {
		v, a, ext, err := chooseMerged(info, h)
		if err != nil {
			continue
		}
		size := int64(0)
		if vs, as := sizeOf(v), sizeOf(a); vs > 0 && as > 0 {
			size = vs + as
		}
		fps := 0
		if v.FPS != nil {
			fps = *v.FPS
		}
		videos = append(videos, jmap{"height": h, "fps": fps, "codec": v.Codecs, "ext": ext, "size": size, "bitrate": v.Bitrate})
	}
	audios := []jmap{}
	if ba, err := pick(info.Formats, "ba"); err == nil {
		for _, family := range []string{"m4a", "webm"} {
			if a, ok := audioLike(info, ba, family); ok {
				audios = append(audios, jmap{"ext": family, "codec": a.Codecs, "kbps": a.Bitrate / 1000, "size": sizeOf(a)})
			}
		}
	}
	title, author := deref(info.Title), deref(info.Author)
	if title == "None" {
		title = ""
	}
	if author == "None" {
		author = ""
	}
	return jmap{
		"id": vid, "title": title, "author": author, "duration": info.Duration, "live": info.Live, "client": info.Client,
		"thumbnail": "https://i.ytimg.com/vi/" + vid + "/hqdefault.jpg",
		"video":     videos, "audio": audios,
	}
}

// safeName makes a title usable as a file name.
func safeName(title, fallback string) string {
	if title == "" || title == "None" {
		return fallback
	}
	clean := strings.Map(func(c rune) rune {
		if c < 32 || strings.ContainsRune(`\/:*?"<>|`, c) {
			return ' '
		}
		return c
	}, title)
	clean = strings.Join(strings.Fields(clean), " ")
	if r := []rune(clean); len(r) > 120 {
		clean = string(r[:120])
	}
	if clean == "" {
		return fallback
	}
	return clean
}

func attachment(w http.ResponseWriter, name, ext, mime string) {
	file := name + "." + ext
	ascii := strings.Map(func(c rune) rune {
		if c > 126 || c == '"' || c == '\\' {
			return '_'
		}
		return c
	}, file)
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"; filename*=UTF-8''%s`, ascii, url.PathEscape(file)))
	w.Header().Set("Cache-Control", "no-store")
}

func mimeOf(f Format) string {
	kind := "video"
	if f.Kind == "audio" {
		kind = "audio"
	}
	ext := f.Ext
	if ext == "m4a" {
		ext = "mp4"
	}
	return kind + "/" + ext
}

// lengthOf is a format's size, asking the server when the resolver did not say.
func lengthOf(f Format) (int64, error) {
	if size := sizeOf(f); size > 0 {
		return size, nil
	}
	resp, err := open("HEAD", f.URL, nil, map[string]string{"User-Agent": clients[f.Client].ua}, 15*time.Second)
	if err != nil {
		return 0, err
	}
	resp.Body.Close()
	if resp.ContentLength <= 0 {
		return 0, errors.New("the stream's size is unknown")
	}
	return resp.ContentLength, nil
}

// pieces fetches a format in 10 MiB range requests, moving to a mirror node when one fails, and
// hands each piece to `use`. `alive` says whether anyone still wants it.
//
// Several pieces are fetched at once (YouTube limits the speed of one connection, not of the
// whole download) and handed over in order. YTP_PARALLEL sets how many, 8 by default; that many
// pieces are held in memory at most.
func pieces(f Format, size int64, alive func() bool, use func([]byte) error) error {
	const chunk = 10 << 20
	parallel := 8
	if n, err := strconv.Atoi(os.Getenv("YTP_PARALLEL")); err == nil && n >= 1 && n <= 32 {
		parallel = n
	}
	ua := clients[f.Client].ua
	all := mirrors(f.URL)
	var stopped atomic.Bool
	// One piece, complete: a short answer is continued from where it stopped.
	one := func(pos, end int64) ([]byte, error) {
		urls := append([]string(nil), all...)
		buf := make([]byte, 0, end-pos+1)
		for attempt := 0; pos <= end; {
			if stopped.Load() || !alive() {
				return nil, errors.New("cancelled")
			}
			data, err := fetch("GET", fmt.Sprintf("%s&range=%d-%d", urls[0], pos, end), nil, map[string]string{"User-Agent": ua}, 30*time.Second)
			if err == nil && len(data) > 0 {
				buf = append(buf, data...)
				pos += int64(len(data))
				continue
			}
			if err == nil {
				err = errors.New("the server sent nothing")
			}
			var he *httpError
			if errors.As(err, &he) && he.code == 403 || attempt >= 2*len(urls)+1 {
				return nil, err
			}
			attempt++
			urls = append(urls[1:], urls[0]) // node unreachable or timed out: the next mirror
		}
		return buf, nil
	}
	type result struct {
		data []byte
		err  error
	}
	// The queue keeps the pieces in order and its size is how many may be under way.
	queue := make(chan chan result, parallel)
	go func() {
		defer close(queue)
		for pos := int64(0); pos < size && !stopped.Load(); pos += chunk {
			ch := make(chan result, 1)
			queue <- ch
			go func(pos, end int64) {
				data, err := one(pos, end)
				ch <- result{data, err}
			}(pos, min(pos+chunk, size)-1)
		}
	}()
	var failed error
	for ch := range queue {
		r := <-ch
		if failed != nil {
			continue // let what was started finish and be dropped
		}
		if r.err == nil {
			r.err = use(r.data)
		}
		if r.err != nil {
			failed = r.err
			stopped.Store(true)
		}
	}
	return failed
}

// sendFormat streams one format as it is fetched.
func sendFormat(w http.ResponseWriter, r *http.Request, f Format, name string, p *progress) {
	size, err := lengthOf(f)
	if err != nil {
		sendJSON(w, 502, jmap{"error": err.Error()})
		return
	}
	p.total.Store(size)
	p.stage.Store("downloading")
	started := false
	err = pieces(f, size, func() bool { return r.Context().Err() == nil }, func(data []byte) error {
		if !started {
			attachment(w, name, f.Ext, mimeOf(f))
			w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
			w.WriteHeader(200)
			started = true
		}
		_, err := w.Write(data)
		p.done.Add(int64(len(data)))
		return err
	})
	if err != nil && !started {
		sendJSON(w, 502, jmap{"error": err.Error()})
	}
	// Mid-file: the short body tells the caller it is incomplete.
}

// toFile downloads a format into a file, counting into p.
func toFile(f Format, size int64, path string, alive func() bool, p *progress) error {
	fh, err := os.Create(path)
	if err != nil {
		return err
	}
	defer fh.Close()
	return pieces(f, size, alive, func(data []byte) error {
		_, err := fh.Write(data)
		p.done.Add(int64(len(data)))
		return err
	})
}

// join puts a video and an audio file in one container with ffmpeg, without re-encoding.
func join(r *http.Request, ffmpeg, vPath, aPath, out string) error {
	args := []string{"-y", "-loglevel", "error", "-i", vPath, "-i", aPath, "-map", "0:v:0", "-map", "1:a:0", "-c", "copy"}
	if strings.HasSuffix(out, ".mp4") {
		args = append(args, "-movflags", "+faststart")
	}
	cmd := exec.CommandContext(r.Context(), ffmpeg, append(args, out)...)
	if msg, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("ffmpeg: %s", strings.TrimSpace(string(msg)))
	}
	return nil
}

func sendFile(w http.ResponseWriter, r *http.Request, path, name, ext string) {
	fh, err := os.Open(path)
	if err != nil {
		sendJSON(w, 500, jmap{"error": err.Error()})
		return
	}
	defer fh.Close()
	mime := map[string]string{"mp4": "video/mp4", "webm": "video/webm", "mkv": "video/x-matroska"}[ext]
	attachment(w, name, ext, mime)
	http.ServeContent(w, r, "", time.Now(), fh)
}

// sendMerged downloads the best video up to `height` and the best audio, joins them with
// ffmpeg without re-encoding, and sends the file.
func sendMerged(w http.ResponseWriter, r *http.Request, info *Info, height int, name string, p *progress) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		sendJSON(w, 501, jmap{"error": "merging needs ffmpeg on PATH; ask for f=bv and f=ba separately instead"})
		return
	}
	video, audio, ext, err := chooseMerged(info, height)
	if err != nil {
		sendJSON(w, 404, jmap{"error": err.Error()})
		return
	}
	vSize, err := lengthOf(video)
	if err != nil {
		sendJSON(w, 502, jmap{"error": err.Error()})
		return
	}
	aSize, err := lengthOf(audio)
	if err != nil {
		sendJSON(w, 502, jmap{"error": err.Error()})
		return
	}
	dir, err := os.MkdirTemp("", "ytp-dl-")
	if err != nil {
		sendJSON(w, 500, jmap{"error": err.Error()})
		return
	}
	defer os.RemoveAll(dir)
	vPath, aPath, out := filepath.Join(dir, "v."+video.Ext), filepath.Join(dir, "a."+audio.Ext), filepath.Join(dir, "out."+ext)
	p.total.Store(vSize + aSize)
	p.stage.Store("downloading")
	alive := func() bool { return r.Context().Err() == nil }
	errs := make(chan error, 2)
	go func() { errs <- toFile(video, vSize, vPath, alive, p) }()
	go func() { errs <- toFile(audio, aSize, aPath, alive, p) }()
	for i := 0; i < 2; i++ {
		if err := <-errs; err != nil {
			sendJSON(w, 502, jmap{"error": "download: " + err.Error()})
			return
		}
	}
	p.stage.Store("merging")
	if err := join(r, ffmpeg, vPath, aPath, out); err != nil {
		sendJSON(w, 500, jmap{"error": err.Error()})
		return
	}
	os.Remove(vPath)
	os.Remove(aPath)
	p.stage.Store("sending")
	sendFile(w, r, out, name, ext)
}

// sendRecording records a live stream from now for `length`: YouTube serves live video as
// numbered pieces of about five seconds (&sq=N), each a complete fragment, so the pieces of the
// video and of the audio are appended to two files and joined at the end.
func sendRecording(w http.ResponseWriter, r *http.Request, info *Info, height int, length time.Duration, name string, p *progress) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		sendJSON(w, 501, jmap{"error": "recording needs ffmpeg on PATH"})
		return
	}
	// Live streams come as H.264 and AAC at every height: keep to those, they join into mp4.
	var video, audio *Format
	for i, f := range info.Formats {
		switch {
		case f.Kind == "video" && f.Ext == "mp4" && f.Height <= height && (video == nil || f.Height > video.Height):
			video = &info.Formats[i]
		case f.Kind == "audio" && (f.Ext == "mp4" || f.Ext == "m4a") && (audio == nil || f.Bitrate > audio.Bitrate):
			audio = &info.Formats[i]
		}
	}
	if video == nil || audio == nil {
		sendJSON(w, 404, jmap{"error": fmt.Sprintf("no recordable video at or below %dp", height)})
		return
	}
	// One piece of a format: its bytes and the number of the newest piece there is.
	piece := func(f *Format, sq int64) ([]byte, int64, error) {
		u := f.URL
		if sq >= 0 {
			u += "&sq=" + strconv.FormatInt(sq, 10)
		}
		resp, err := open("GET", u, nil, map[string]string{"User-Agent": clients[f.Client].ua}, 20*time.Second)
		if err != nil {
			return nil, 0, err
		}
		defer resp.Body.Close()
		head, _ := strconv.ParseInt(resp.Header.Get("X-Head-Seqnum"), 10, 64)
		data, err := io.ReadAll(resp.Body)
		return data, head, err
	}
	_, head, err := piece(video, -1)
	if err != nil || head == 0 {
		sendJSON(w, 502, jmap{"error": fmt.Sprintf("could not find the live edge (%v)", err)})
		return
	}
	dir, err := os.MkdirTemp("", "ytp-live-")
	if err != nil {
		sendJSON(w, 500, jmap{"error": err.Error()})
		return
	}
	defer os.RemoveAll(dir)
	vPath, aPath, out := filepath.Join(dir, "v.mp4"), filepath.Join(dir, "a.mp4"), filepath.Join(dir, "out.mp4")
	p.total.Store(int64(length.Seconds()))
	p.stage.Store("recording")
	t0 := time.Now()
	// Each format follows the stream by itself, from the same first piece.
	follow := func(f *Format, path string, counts bool) error {
		fh, err := os.Create(path)
		if err != nil {
			return err
		}
		defer fh.Close()
		misses := 0
		for sq := head; time.Since(t0) < length; {
			if r.Context().Err() != nil {
				return errors.New("cancelled")
			}
			data, _, err := piece(f, sq)
			if err != nil || len(data) == 0 {
				// Not there yet (404) or a hiccup: the next piece appears within seconds.
				if misses++; misses > 60 {
					if sq == head {
						return fmt.Errorf("the stream sent nothing (%v)", err)
					}
					return nil // it ended: keep what there is
				}
				time.Sleep(time.Second)
				continue
			}
			misses = 0
			if _, err := fh.Write(data); err != nil {
				return err
			}
			sq++
			if counts {
				p.done.Store(int64(time.Since(t0).Seconds()))
			}
		}
		return nil
	}
	errs := make(chan error, 2)
	go func() { errs <- follow(video, vPath, true) }()
	go func() { errs <- follow(audio, aPath, false) }()
	for i := 0; i < 2; i++ {
		if err := <-errs; err != nil {
			sendJSON(w, 502, jmap{"error": "recording: " + err.Error()})
			return
		}
	}
	p.stage.Store("merging")
	if err := join(r, ffmpeg, vPath, aPath, out); err != nil {
		sendJSON(w, 500, jmap{"error": err.Error()})
		return
	}
	os.Remove(vPath)
	os.Remove(aPath)
	p.stage.Store("sending")
	sendFile(w, r, out, name+" (live "+t0.UTC().Format("2006-01-02 15.04")+")", "mp4")
}

func sameLang(a, b *string) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}
