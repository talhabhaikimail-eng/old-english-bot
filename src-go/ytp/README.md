# yt-parser

Fast YouTube stream-URL resolver (~1–2 s to first frame), stdlib Python reference for a Go/Rust port.

- `ytp.py` – CLI: `python ytp.py <url> [-f b|bv|ba|itag] [-g] [-o file] [-j] [-C] [-v]`
- `server.py` + `ui.html` – local test player at http://127.0.0.1:8765 (native `<video>` + MediaSource, timing breakdown)
- `MAP.md` – how it works: clients, headers, auth hash, n/sig solving, ad gate, port notes
- `ejs/` – yt-dlp EJS n/sig solver (Unlicense)

## Setup
1. Put your YouTube cookies in `cookies.txt` (raw `Cookie:` header or Netscape format). **Never commit it** (gitignored).
   Export from a private/incognito window, then close it, so the session isn't rotated away.
2. Cookie (gated / bot-checked) path needs a JS runtime on PATH: `node`, `qjs`, `deno` or `bun`.
3. `python server.py` → open http://127.0.0.1:8765

## Go binary (portable, no Node / Python)
`ytp.exe` is a single ~16 MB file with the same CLI and test server. The n/sig solver runs on an embedded
pure-Go JS engine (goja), so nothing else needs to be installed.

```
ytp URL [-f b|bv|ba|ITAG] [-g] [-o FILE] [-j] [-C] [--client ios|tv|android_vr] [-c COOKIES] [-v]
ytp serve [-p 8765]          # test player, ui.html is built in
ytp login [--refresh]        # sign in to Google in a browser window -> cookies.txt
```
- Cookies: `-c FILE`, else `cookies.txt` next to the binary, else in the current directory.
- `ytp login` opens Chrome/Edge with its own profile (`<cache>/browser-profile`, not your normal one). Sign
  in, then close the window; the YouTube cookies are read from that profile headless (DevTools) and
  written to the cookies file. Your password only goes to Google. Run `ytp login` again any time to
  re-export the stored session (no window; one opens only if it has expired). `--refresh` never opens a
  window, it fails instead (for scripts / scheduled re-exports).
  (Google refuses sign-in in a browser started with a DevTools port, hence the two steps.)
- Real-world sweep: `go test -tags live -run TestLive -v -timeout 60m` (see `live_test.go`).
- Cache (player JS + solver script): `%LOCALAPPDATA%\ytp` / `~/.cache/ytp`, override with `YTP_CACHE`.
- New YouTube player version: one-time ~1.5 s rewrite (`solver.go`), then ~0.35 s per CLI call, ms in `serve`.

Build (Go ≥ 1.26, the toolchain is fetched automatically):
```
go build -trimpath -ldflags "-s -w" -o ytp.exe .                                     # this machine
GOOS=linux   GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o ytp-linux .         # cross-compile
GOOS=darwin  GOARCH=arm64 go build -trimpath -ldflags "-s -w" -o ytp-mac .
GOOS=android GOARCH=arm64 go build -trimpath -ldflags "-s -w" -o ytp-android .
```

## Android / embedding: libytp.so (C ABI)
`./build-android.sh` → `build/android/<abi>/libytp.so` (arm64-v8a, armeabi-v7a, x86_64; ~16 MB each,
replaces nodejs-mobile's 62 MB libnode.so) and `build/android/libytp.h`. Needs the NDK (default
`C:/android/ndk/26.1.10909125`, override `ANDROID_NDK_HOME`). API (all return JSON, free with `ytp_free`):

```c
char* ytp_init(char* cache_dir, char* cookies);   // {"ok":true}; cookies = header or Netscape CONTENT; call again to change
char* ytp_resolve(char* url, int cookie_first);   // same JSON as `ytp URL -j`; formats[].url + formats[].ua
char* ytp_serve(char* addr);                      // optional test server, "127.0.0.1:0" -> {"addr":"127.0.0.1:PORT"}
char* ytp_version(void);
void  ytp_free(char* p);
```
Fetch stream URLs from the same device (IP-bound) with the format's `ua`, in `&range=a-b` chunks.
Rust: `#[link(name = "ytp")] extern "C" { fn ytp_resolve(url: *const c_char, cookie_first: c_int) -> *mut c_char; ... }`
