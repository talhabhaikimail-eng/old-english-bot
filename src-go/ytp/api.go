package main

// Downloader API, served next to the test player by `ytp serve`.
//
//	GET /health                              {"ok":true}
//	GET /api/download?url=URL&f=b|bv|ba|ITAG one format, streamed as it is fetched
//	GET /api/download?url=URL&height=720     best video up to that height merged with the best
//	                                         audio (needs ffmpeg on PATH); mp4, or webm when the
//	                                         height only exists as VP9
//	GET /api/download?url=URL&audio=1        best audio only, as m4a when there is one (plays
//	                                         everywhere); ext=webm asks for Opus instead
//
// Add cookie_first=1 to use the logged-in tv client first. Errors are JSON: {"error": "..."}.

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

func registerAPI(mux *http.ServeMux, cookies func() string) {
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		sendJSON(w, 200, jmap{"ok": true, "cookies": cookies() != ""})
	})
	mux.HandleFunc("/api/download", func(w http.ResponseWriter, r *http.Request) {
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
		if info.Error != "" {
			sendJSON(w, 502, info)
			return
		}
		name := safeName(deref(info.Title), vid)
		if h := q.Get("height"); h != "" {
			height, err := strconv.Atoi(h)
			if err != nil || height <= 0 {
				sendJSON(w, 400, jmap{"error": "height must be a number, for example 720"})
				return
			}
			sendMerged(w, r, info, height, name)
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
			// Same track (language), in the container that was asked for.
			want := map[string]bool{"mp4": true, "m4a": true}
			if q.Get("ext") == "webm" {
				want = map[string]bool{"webm": true}
			}
			var best *Format
			for i, c := range info.Formats {
				if c.Kind == "audio" && !c.DRC && want[c.Ext] && sameLang(c.Lang, f.Lang) && (best == nil || c.Bitrate > best.Bitrate) {
					best = &info.Formats[i]
				}
			}
			if best != nil {
				f = *best
			}
		}
		sendFormat(w, r, f, name)
	})
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

// sendFormat streams one format in 10 MiB range requests, moving to a mirror node when one fails.
func sendFormat(w http.ResponseWriter, r *http.Request, f Format, name string) {
	const chunk = 10 << 20
	ua := clients[f.Client].ua
	urls := mirrors(f.URL)
	size := sizeOf(f)
	if size == 0 {
		resp, err := open("HEAD", f.URL, nil, map[string]string{"User-Agent": ua}, 15*time.Second)
		if err != nil {
			sendJSON(w, 502, jmap{"error": err.Error()})
			return
		}
		resp.Body.Close()
		size = resp.ContentLength
	}
	if size <= 0 {
		sendJSON(w, 502, jmap{"error": "the stream's size is unknown"})
		return
	}
	started := false
	for pos := int64(0); pos < size; {
		if r.Context().Err() != nil {
			return // the caller went away
		}
		end := min(pos+chunk, size) - 1
		var data []byte
		var err error
		for attempt := 0; ; attempt++ {
			data, err = fetch("GET", fmt.Sprintf("%s&range=%d-%d", urls[0], pos, end), nil, map[string]string{"User-Agent": ua}, 20*time.Second)
			if err == nil {
				break
			}
			var he *httpError
			if errors.As(err, &he) && he.code == 403 || attempt == 2*len(urls)-1 {
				break
			}
			urls = append(urls[1:], urls[0])
		}
		if err != nil || len(data) == 0 {
			if !started {
				sendJSON(w, 502, jmap{"error": fmt.Sprint(err)})
			}
			return // mid-file: the short body tells the caller it is incomplete
		}
		if !started {
			attachment(w, name, f.Ext, mimeOf(f))
			w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
			w.WriteHeader(200)
			started = true
		}
		if _, err := w.Write(data); err != nil {
			return
		}
		pos += int64(len(data))
	}
}

// sendMerged downloads the best video up to `height` and the best audio, joins them with
// ffmpeg without re-encoding, and sends the file.
func sendMerged(w http.ResponseWriter, r *http.Request, info *Info, height int, name string) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		sendJSON(w, 501, jmap{"error": "merging needs ffmpeg on PATH; ask for f=bv and f=ba separately instead"})
		return
	}
	var videos []Format
	for _, f := range info.Formats {
		if f.Kind == "video" && !f.DRM && f.Height <= height {
			videos = append(videos, f)
		}
	}
	if len(videos) == 0 {
		sendJSON(w, 404, jmap{"error": fmt.Sprintf("no video at or below %dp", height)})
		return
	}
	// The tallest; at the same height H.264 in mp4 (plays everywhere), then the higher bitrate.
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
	video := videos[0]
	audio, err := pick(info.Formats, "ba")
	if err != nil {
		sendJSON(w, 404, jmap{"error": err.Error()})
		return
	}
	// Keep both in one container family so nothing is re-encoded.
	ext := "mp4"
	if video.Ext == "webm" {
		ext = "webm"
	}
	wantAudio := map[string]bool{"m4a": true, "mp4": true}
	if ext == "webm" {
		wantAudio = map[string]bool{"webm": true}
	}
	var best *Format
	for i, f := range info.Formats {
		if f.Kind == "audio" && !f.DRC && wantAudio[f.Ext] && sameLang(f.Lang, audio.Lang) && (best == nil || f.Bitrate > best.Bitrate) {
			best = &info.Formats[i]
		}
	}
	if best != nil {
		audio = *best
	} else if ext == "webm" {
		ext = "mkv" // VP9 with AAC only fits in Matroska
	}

	dir, err := os.MkdirTemp("", "ytp-dl-")
	if err != nil {
		sendJSON(w, 500, jmap{"error": err.Error()})
		return
	}
	defer os.RemoveAll(dir)
	vPath, aPath, out := filepath.Join(dir, "v."+video.Ext), filepath.Join(dir, "a."+audio.Ext), filepath.Join(dir, "out."+ext)
	errs := make(chan error, 2)
	go func() { errs <- download(video, vPath) }()
	go func() { errs <- download(audio, aPath) }()
	for i := 0; i < 2; i++ {
		if err := <-errs; err != nil {
			sendJSON(w, 502, jmap{"error": "download: " + err.Error()})
			return
		}
	}
	args := []string{"-y", "-loglevel", "error", "-i", vPath, "-i", aPath, "-map", "0:v:0", "-map", "1:a:0", "-c", "copy"}
	if ext == "mp4" {
		args = append(args, "-movflags", "+faststart")
	}
	cmd := exec.CommandContext(r.Context(), ffmpeg, append(args, out)...)
	if msg, err := cmd.CombinedOutput(); err != nil {
		sendJSON(w, 500, jmap{"error": "ffmpeg: " + strings.TrimSpace(string(msg))})
		return
	}
	fh, err := os.Open(out)
	if err != nil {
		sendJSON(w, 500, jmap{"error": err.Error()})
		return
	}
	defer fh.Close()
	mime := map[string]string{"mp4": "video/mp4", "webm": "video/webm", "mkv": "video/x-matroska"}[ext]
	attachment(w, name, ext, mime)
	http.ServeContent(w, r, "", time.Now(), fh)
}

func sameLang(a, b *string) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}
