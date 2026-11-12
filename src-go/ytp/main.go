// ytp - fast YouTube stream-URL resolver. Single static binary, no Node/Python needed.
//
//	ytp URL                  list formats
//	ytp URL -g               print best URL          (-f b | bv | ba | <itag>)
//	ytp URL -f 137 -o x.mp4  download (chunked, resumable)
//	ytp URL -j               full map as JSON
//	ytp URL -C               logged-in tv client first
//	ytp serve [-p 8765]      local test player (ui.html) on http://127.0.0.1:8765
//	ytp login [--refresh]    sign in in a browser window, write cookies.txt
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

var (
	cacheDir string
	verbose  bool
)

func debugf(f string, a ...any) {
	if verbose {
		fmt.Fprintf(os.Stderr, f+"\n", a...)
	}
}

func die(f string, a ...any) {
	fmt.Fprintf(os.Stderr, f+"\n", a...)
	os.Exit(1)
}

const usage = `ytp - fast YouTube stream URL resolver

usage: ytp URL [-f b|bv|ba|ITAG] [-g] [-o FILE] [-j] [-C] [--client ios|tv|android_vr] [-c COOKIES] [-v]
       ytp serve [-p PORT] [-c COOKIES] [-v]
       ytp login [--refresh] [--cdp HOST:PORT] [-c COOKIES]

  login            open Chrome/Edge (own profile), sign in to Google there, the YouTube cookies are
                   written to COOKIES. Later runs re-export the stored session without a window.
                   --refresh: never open a window (fail if the session has expired).
                   --cdp HOST:PORT: export from a browser that is already running with a DevTools
                   port (a remote browser on a server) instead of starting one.

  -f, --format     b (best muxed, default) | bv | ba | <itag>
  -g, --get-url    print the selected stream URL only
  -o, --output     download the selected format to FILE (resumable)
  -j, --json       dump the full map as JSON
  -C, --cookie-first  use the logged-in tv client first
      --client     force one client
  -c, --cookies    cookies file (raw Cookie header or Netscape); default cookies.txt next to ytp, else in cwd
  -p, --port       serve: port (default 8765)
  -v, --verbose    timing / solver info to stderr

cache: %s (override with YTP_CACHE)
`

func main() {
	cacheDir = os.Getenv("YTP_CACHE")
	if cacheDir == "" {
		d, err := os.UserCacheDir()
		if err != nil {
			d = os.TempDir()
		}
		cacheDir = filepath.Join(d, "ytp")
	}
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		die("cache dir: %v", err)
	}

	opt := map[string]string{}
	bools := map[string]bool{}
	var pos []string
	alias := map[string]string{"-f": "format", "--format": "format", "-o": "output", "--output": "output",
		"-c": "cookies", "--cookies": "cookies", "--client": "client", "-p": "port", "--port": "port", "--cdp": "cdp"}
	balias := map[string]string{"-g": "get-url", "--get-url": "get-url", "-j": "json", "--json": "json",
		"-C": "cookie-first", "--cookie-first": "cookie-first", "-v": "verbose", "--verbose": "verbose", "--refresh": "refresh"}
	args := os.Args[1:]
	for i := 0; i < len(args); i++ {
		a := args[i]
		if k, v, ok := strings.Cut(a, "="); ok && alias[k] != "" {
			opt[alias[k]] = v
		} else if alias[a] != "" {
			if i+1 >= len(args) {
				die("%s needs a value", a)
			}
			opt[alias[a]] = args[i+1]
			i++
		} else if balias[a] != "" {
			bools[balias[a]] = true
		} else if a == "-h" || a == "--help" {
			fmt.Printf(usage, cacheDir)
			return
		} else if strings.HasPrefix(a, "-") && len(a) > 1 {
			die("unknown option %s (see ytp -h)", a)
		} else {
			pos = append(pos, a)
		}
	}
	verbose = bools["verbose"]
	if len(pos) != 1 {
		fmt.Fprintf(os.Stderr, usage, cacheDir)
		os.Exit(2)
	}
	cookiePath := opt["cookies"]
	if cookiePath == "" {
		cookiePath = "cookies.txt"
		if exe, err := os.Executable(); err == nil {
			if p := filepath.Join(filepath.Dir(exe), "cookies.txt"); fileExists(p) {
				cookiePath = p
			}
		}
	}

	if pos[0] == "login" {
		if addr := opt["cdp"]; addr != "" {
			if err := exportRunning(addr, cookiePath); err != nil {
				die("login: %v", err)
			}
			return
		}
		if err := login(cookiePath, bools["refresh"]); err != nil {
			die("login: %v", err)
		}
		return
	}
	if pos[0] == "serve" {
		port := opt["port"]
		if port == "" {
			port = "8765"
		}
		serve(port, cookiePath)
		return
	}

	vid, err := videoID(pos[0])
	if err != nil {
		die("%v", err)
	}
	order := []string{"ios", "tv"}
	if c := opt["client"]; c != "" {
		if _, ok := clients[c]; !ok {
			die("unknown client %s", c)
		}
		order = []string{c}
	} else if bools["cookie-first"] {
		order = []string{"tv", "ios"}
	}
	info := resolve(vid, loadCookies(cookiePath), order)
	if verbose {
		t, _ := json.Marshal(info.Timing)
		fmt.Fprintf(os.Stderr, "timing %s | %s\n", t, strings.Join(info.Tried, "; "))
	}
	if bools["json"] {
		enc := json.NewEncoder(os.Stdout)
		enc.SetEscapeHTML(false)
		enc.SetIndent("", " ")
		enc.Encode(info)
		return
	}
	if info.Error != "" {
		die("error: %s\n  %s", info.Error, strings.Join(info.Tried, "\n  "))
	}
	if bools["get-url"] || opt["output"] != "" {
		sel := opt["format"]
		if sel == "" {
			sel = "b"
		}
		f, err := pick(info.Formats, sel)
		if err != nil {
			die("%v", err)
		}
		if bools["get-url"] {
			fmt.Println(f.URL)
			return
		}
		q := f.Res
		if q == "" {
			q = fmt.Sprintf("%dk", f.AbrKbps)
		}
		fmt.Fprintf(os.Stderr, "itag %d %s %s via %s -> %s\n", f.Itag, q, f.Ext, f.Client, opt["output"])
		if err := download(f, opt["output"]); err != nil {
			die("\ndownload: %v", err)
		}
		return
	}
	fmt.Printf("%s  [%s]  %ds  via %s  urls valid ~%dh\n", deref(info.Title), deref(info.Author), info.Duration, info.Client, info.ExpiresIn/3600)
	fmt.Printf("%4s %-5s %-4s %-7s %3s %5s %7s  codecs\n", "itag", "kind", "ext", "res", "fps", "kbps", "MiB")
	fs := append([]Format(nil), info.Formats...)
	sort.SliceStable(fs, func(i, j int) bool {
		a, b := fs[i], fs[j]
		if a.Kind != b.Kind {
			return a.Kind < b.Kind
		}
		if a.Height != b.Height {
			return a.Height < b.Height
		}
		return a.Bitrate < b.Bitrate
	})
	for _, f := range fs {
		fps, extra := "", ""
		if f.FPS != nil {
			fps = fmt.Sprint(*f.FPS)
		}
		if f.Lang != nil {
			extra += "  [" + *f.Lang + "]"
		}
		if f.DRC {
			extra += " drc"
		}
		fmt.Printf("%4d %-5s %-4s %-7s %3s %5d %7.1f  %s%s\n", f.Itag, f.Kind, f.Ext, f.Res, fps, f.AbrKbps, float64(f.Size)/1048576, f.Codecs, extra)
	}
}

func deref(s *string) string {
	if s == nil {
		return "None"
	}
	return *s
}

func fileExists(p string) bool { _, err := os.Stat(p); return err == nil }
