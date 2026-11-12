//go:build cgo && ytplib

// C ABI for embedding ytp as a shared library (Android libytp.so, or .dll/.so/.dylib on desktop).
//
//	go build -tags ytplib -buildmode=c-shared -o libytp.so .     (see build-android.sh)
//
// Every function returns a malloc'd, NUL-terminated UTF-8 JSON string (never NULL).
// The caller must release it with ytp_free(). All functions are safe to call from any thread.
//
//	ytp_init(cache_dir, cookies)  -> {"ok":true} | {"error":"..."}
//	    cache_dir: writable dir for the player JS + solver script (Android: Context.getCacheDir()).
//	    cookies:   Cookie header "a=b; c=d" or Netscape cookies.txt CONTENT (not a path); NULL/"" = none.
//	    Call again any time to change cookies. Warms the player + solver in the background.
//	ytp_resolve(url, cookie_first) -> the same JSON as `ytp URL -j`; on failure {"error":..., "tried":[...]}.
//	    cookie_first is a set of flags: 1 = logged-in tv client first; 2 = skip the preview check (answers
//	    about a second sooner on a phone; resolve again without this flag in the background, and if that
//	    answer's "client" differs or its timing has "player_tv_nopyv", the first URLs were a ~60 s
//	    preview - ios and tv can both hand those out: switch to the new ones).
//	    Each format has "url" and "ua": fetch the URL from the
//	    same device (URLs are IP-bound) with that User-Agent, in "&range=START-END" chunks (<= 10 MiB).
//	ytp_serve(addr) -> {"addr":"127.0.0.1:PORT"} | {"error":"..."}
//	    Optional: starts the test-player HTTP server (UI + /api/resolve + /s/ byte-range proxy) in the
//	    background. addr "127.0.0.1:0" picks a free port.
//	ytp_version() -> {"version":"..."}
//	ytp_free(ptr)
package main

/*
#include <stdlib.h>
*/
import "C"

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"sync"
	"unsafe"
)

const libVersion = "ytp 1.0.0"

var (
	libMu      sync.Mutex
	libCookies string
	libReady   bool
)

func cJSON(v any) *C.char {
	b, err := json.Marshal(v)
	if err != nil {
		b = []byte(`{"error":"internal: json"}`)
	}
	return C.CString(string(b))
}

func cErr(err error) *C.char { return cJSON(jmap{"error": err.Error()}) }

func goStr(p *C.char) string {
	if p == nil {
		return ""
	}
	return C.GoString(p)
}

func guard(out **C.char) {
	if r := recover(); r != nil {
		*out = cErr(fmt.Errorf("panic: %v", r))
	}
}

func currentCookies() string {
	libMu.Lock()
	defer libMu.Unlock()
	return libCookies
}

//export ytp_init
func ytp_init(cacheDirC, cookiesC *C.char) (out *C.char) {
	defer guard(&out)
	dir := goStr(cacheDirC)
	if dir == "" {
		return cErr(errors.New("cache_dir is required"))
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return cErr(err)
	}
	libMu.Lock()
	cacheDir = dir
	libCookies = parseCookies(goStr(cookiesC))
	first := !libReady
	libReady = true
	libMu.Unlock()
	if first {
		go func() { _ = warmup() }()
	}
	return cJSON(jmap{"ok": true})
}

//export ytp_resolve
func ytp_resolve(urlC *C.char, cookieFirst C.int) (out *C.char) {
	defer guard(&out)
	libMu.Lock()
	ready := libReady
	libMu.Unlock()
	if !ready {
		return cErr(errors.New("call ytp_init first"))
	}
	vid, err := videoID(goStr(urlC))
	if err != nil {
		return cErr(err)
	}
	order := []string{"ios", "tv"}
	if cookieFirst&1 != 0 {
		order = []string{"tv", "ios"}
	}
	return cJSON(resolveOpt(vid, currentCookies(), order, cookieFirst&2 == 0))
}

//export ytp_serve
func ytp_serve(addrC *C.char) (out *C.char) {
	defer guard(&out)
	addr := goStr(addrC)
	if addr == "" {
		addr = "127.0.0.1:0"
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return cErr(err)
	}
	go http.Serve(ln, newMux(currentCookies))
	return cJSON(jmap{"addr": ln.Addr().String()})
}

//export ytp_version
func ytp_version() *C.char { return cJSON(jmap{"version": libVersion}) }

//export ytp_free
func ytp_free(p *C.char) {
	if p != nil {
		C.free(unsafe.Pointer(p))
	}
}
