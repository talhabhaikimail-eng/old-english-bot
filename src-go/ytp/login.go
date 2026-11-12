package main

// `ytp login`: sign in to YouTube in a real Chrome/Edge window (own profile, never the user's main one) and
// export its youtube.com cookies to cookies.txt over the DevTools protocol. The password only ever goes to
// Google, typed by the user. Later runs re-export from that profile headless (no window) and open a window
// only when the stored session is gone; --refresh never opens one (fails instead: for scripts).

import (
	"bufio"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

const loginURL = "https://accounts.google.com/ServiceLogin?service=youtube&passive=true&continue=" +
	"https%3A%2F%2Fwww.youtube.com%2Fsignin%3Faction_handle_signin%3Dtrue%26next%3D%252F"

func browserPath() (string, error) {
	if p := os.Getenv("YTP_BROWSER"); p != "" {
		return p, nil
	}
	var cands []string
	switch runtime.GOOS {
	case "windows":
		for _, env := range []string{"ProgramFiles", "ProgramFiles(x86)", "LocalAppData"} {
			if d := os.Getenv(env); d != "" {
				cands = append(cands, filepath.Join(d, `Google\Chrome\Application\chrome.exe`),
					filepath.Join(d, `Microsoft\Edge\Application\msedge.exe`), filepath.Join(d, `Chromium\Application\chrome.exe`))
			}
		}
	case "darwin":
		cands = []string{"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Chromium.app/Contents/MacOS/Chromium"}
	default:
		for _, n := range []string{"google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"} {
			if p, err := exec.LookPath(n); err == nil {
				cands = append(cands, p)
			}
		}
	}
	for _, p := range cands {
		if fileExists(p) {
			return p, nil
		}
	}
	return "", errors.New("no Chrome/Edge/Chromium found (set YTP_BROWSER to its executable)")
}

// login: if the profile already holds a session, export it headless. Otherwise open a plain browser window
// (no DevTools/automation flags - Google refuses sign-in in a debuggable browser), wait until the user has
// signed in and closed it, then export headless.
func login(out string, refresh bool) error {
	exe, err := browserPath()
	if err != nil {
		return err
	}
	profile := filepath.Join(cacheDir, "browser-profile")
	if fileExists(profile) {
		err := exportCookies(exe, profile, out)
		if err == nil || refresh {
			return err
		}
		fmt.Fprintf(os.Stderr, "stored session not usable (%v), opening a window to sign in\n", err)
	} else if refresh {
		return errors.New("no stored session yet: run `ytp login` once")
	}
	if browserRunning(profile) {
		return errors.New("the ytp browser profile is already open: close that window first")
	}
	cmd := exec.Command(exe, "--user-data-dir="+profile, "--no-first-run", "--no-default-browser-check",
		"--disable-background-mode", loginURL)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start browser: %w", err)
	}
	go cmd.Wait()
	fmt.Fprintln(os.Stderr, "Sign in to Google in the browser window that just opened, then close the window\n"+
		"(the cookies are exported once it is closed).")
	// The launcher process may exit at once (Chrome re-spawns itself), so watch the profile lock instead.
	for t0 := time.Now(); !browserRunning(profile); time.Sleep(200 * time.Millisecond) {
		if time.Since(t0) > 30*time.Second {
			return errors.New("browser did not start")
		}
	}
	for browserRunning(profile) {
		time.Sleep(time.Second)
	}
	return exportCookies(exe, profile, out)
}

// browserRunning: Chrome holds <profile>/lockfile open on Windows and keeps a SingletonLock symlink elsewhere.
func browserRunning(profile string) bool {
	if runtime.GOOS == "windows" {
		lf := filepath.Join(profile, "lockfile")
		return fileExists(lf) && os.Remove(lf) != nil
	}
	_, err := os.Lstat(filepath.Join(profile, "SingletonLock"))
	return err == nil
}

// exportCookies starts the profile headless with DevTools (no page load) and writes its YouTube cookies.
func exportCookies(exe, profile, out string) error {
	if browserRunning(profile) {
		return errors.New("profile is open in a browser window")
	}
	portFile := filepath.Join(profile, "DevToolsActivePort")
	_ = os.Remove(portFile)
	cmd := exec.Command(exe, "--user-data-dir="+profile, "--headless=new", "--remote-debugging-port=0",
		"--remote-allow-origins=*", "--no-first-run", "--no-default-browser-check", "about:blank")
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start browser: %w", err)
	}
	go cmd.Wait()
	var ws *wsConn
	for t0 := time.Now(); ws == nil; time.Sleep(150 * time.Millisecond) {
		if b, err := os.ReadFile(portFile); err == nil {
			if l := strings.SplitN(strings.TrimSpace(string(b)), "\n", 2); len(l) == 2 {
				if ws, err = wsDial("127.0.0.1:"+strings.TrimSpace(l[0]), strings.TrimSpace(l[1])); err != nil {
					cmd.Process.Kill()
					return fmt.Errorf("devtools: %w", err)
				}
			}
		}
		if ws == nil && time.Since(t0) > 20*time.Second {
			cmd.Process.Kill()
			return errors.New("DevTools port did not appear")
		}
	}
	defer func() {
		ws.call("Browser.close", nil)
		ws.Close()
		for t0 := time.Now(); browserRunning(profile) && time.Since(t0) < 5*time.Second; {
			time.Sleep(100 * time.Millisecond)
		}
	}()
	cks, err := browserCookies(ws)
	if err != nil {
		return err
	}
	if !loggedIn(cks) {
		return errors.New("not signed in to YouTube in the ytp browser profile")
	}
	n, err := writeNetscape(out, cks)
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "wrote %d youtube cookies to %s\n", n, out)
	return nil
}

// exportRunning writes the YouTube cookies of a browser that is already running with a DevTools port
// (addr is HOST:PORT), for servers where the sign-in happens in a remote browser. The browser is left open.
func exportRunning(addr, out string) error {
	b, err := fetch("GET", "http://"+addr+"/json/version", nil, nil, 10*time.Second)
	if err != nil {
		return fmt.Errorf("devtools at %s: %w", addr, err)
	}
	var v struct {
		WS string `json:"webSocketDebuggerUrl"`
	}
	if err := json.Unmarshal(b, &v); err != nil || v.WS == "" {
		return fmt.Errorf("devtools at %s gave no browser endpoint", addr)
	}
	u, err := url.Parse(v.WS)
	if err != nil {
		return err
	}
	// Dial the address we were given: the browser reports its own, which a port forward changes.
	ws, err := wsDial(addr, u.Path)
	if err != nil {
		return fmt.Errorf("devtools: %w", err)
	}
	defer ws.Close()
	cks, err := browserCookies(ws)
	if err != nil {
		return err
	}
	if !loggedIn(cks) {
		return errors.New("not signed in to YouTube in that browser: sign in there and open youtube.com once")
	}
	n, err := writeNetscape(out, cks)
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "wrote %d youtube cookies to %s\n", n, out)
	return nil
}

type cdpCookie struct {
	Name     string  `json:"name"`
	Value    string  `json:"value"`
	Domain   string  `json:"domain"`
	Path     string  `json:"path"`
	Expires  float64 `json:"expires"`
	HTTPOnly bool    `json:"httpOnly"`
	Secure   bool    `json:"secure"`
	Session  bool    `json:"session"`
}

func browserCookies(ws *wsConn) ([]cdpCookie, error) {
	res, err := ws.call("Storage.getCookies", nil)
	if err != nil {
		return nil, err
	}
	var r struct{ Cookies []cdpCookie }
	if err := json.Unmarshal(res, &r); err != nil {
		return nil, err
	}
	var yt []cdpCookie
	for _, c := range r.Cookies {
		if d := strings.TrimPrefix(c.Domain, "."); d == "youtube.com" || strings.HasSuffix(d, ".youtube.com") {
			yt = append(yt, c)
		}
	}
	return yt, nil
}

// loggedIn: YouTube's auth cookies are present (SAPISID for the Authorization hash, LOGIN_INFO is set by
// youtube.com itself once the Google sign-in redirect has landed).
func loggedIn(cks []cdpCookie) bool {
	have := map[string]bool{}
	for _, c := range cks {
		have[c.Name] = true
	}
	return have["SAPISID"] && have["__Secure-3PAPISID"] && have["LOGIN_INFO"]
}

func writeNetscape(out string, cks []cdpCookie) (int, error) {
	sort.Slice(cks, func(i, j int) bool { return cks[i].Domain+cks[i].Name < cks[j].Domain+cks[j].Name })
	var b strings.Builder
	b.WriteString("# Netscape HTTP Cookie File\n# written by `ytp login` - this is your YouTube session, keep it private\n\n")
	for _, c := range cks {
		dom := c.Domain
		if c.HTTPOnly {
			dom = "#HttpOnly_" + dom
		}
		sub, sec := "FALSE", "FALSE"
		if strings.HasPrefix(c.Domain, ".") {
			sub = "TRUE"
		}
		if c.Secure {
			sec = "TRUE"
		}
		exp := int64(0)
		if !c.Session && c.Expires > 0 {
			exp = int64(c.Expires)
		}
		fmt.Fprintf(&b, "%s\t%s\t%s\t%s\t%d\t%s\t%s\n", dom, sub, c.Path, sec, exp, c.Name, c.Value)
	}
	tmp := out + ".tmp"
	if err := os.WriteFile(tmp, []byte(b.String()), 0o600); err != nil {
		return 0, err
	}
	return len(cks), os.Rename(tmp, out)
}

// ---------------------------------------------------------------- minimal WebSocket client (RFC 6455)

type wsConn struct {
	c  net.Conn
	r  *bufio.Reader
	id int
}

func wsDial(host, path string) (*wsConn, error) {
	c, err := net.DialTimeout("tcp", host, 5*time.Second)
	if err != nil {
		return nil, err
	}
	key := make([]byte, 16)
	rand.Read(key)
	fmt.Fprintf(c, "GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"+
		"Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n", path, host, base64.StdEncoding.EncodeToString(key))
	r := bufio.NewReader(c)
	resp, err := http.ReadResponse(r, &http.Request{Method: "GET", URL: &url.URL{Path: path}})
	if err != nil {
		c.Close()
		return nil, err
	}
	if resp.StatusCode != 101 {
		c.Close()
		return nil, fmt.Errorf("websocket handshake: %s", resp.Status)
	}
	return &wsConn{c: c, r: r}, nil
}

func (w *wsConn) Close() error { return w.c.Close() }

func (w *wsConn) send(p []byte) error {
	hdr := []byte{0x81} // FIN + text
	switch n := len(p); {
	case n < 126:
		hdr = append(hdr, 0x80|byte(n))
	case n < 1<<16:
		hdr = append(hdr, 0x80|126, byte(n>>8), byte(n))
	default:
		hdr = append(hdr, 0x80|127)
		hdr = binary.BigEndian.AppendUint64(hdr, uint64(n))
	}
	mask := make([]byte, 4)
	rand.Read(mask)
	hdr = append(hdr, mask...)
	m := make([]byte, len(p))
	for i := range p {
		m[i] = p[i] ^ mask[i%4]
	}
	_, err := w.c.Write(append(hdr, m...))
	return err
}

// recv returns the next complete text/binary message (pings answered, continuation frames joined).
func (w *wsConn) recv() ([]byte, error) {
	var msg []byte
	for {
		var h [2]byte
		if _, err := io.ReadFull(w.r, h[:]); err != nil {
			return nil, err
		}
		fin, op, n := h[0]&0x80 != 0, h[0]&0x0f, uint64(h[1]&0x7f)
		switch n {
		case 126:
			var b [2]byte
			if _, err := io.ReadFull(w.r, b[:]); err != nil {
				return nil, err
			}
			n = uint64(binary.BigEndian.Uint16(b[:]))
		case 127:
			var b [8]byte
			if _, err := io.ReadFull(w.r, b[:]); err != nil {
				return nil, err
			}
			n = binary.BigEndian.Uint64(b[:])
		}
		var mask [4]byte
		if h[1]&0x80 != 0 {
			if _, err := io.ReadFull(w.r, mask[:]); err != nil {
				return nil, err
			}
		}
		p := make([]byte, n)
		if _, err := io.ReadFull(w.r, p); err != nil {
			return nil, err
		}
		if h[1]&0x80 != 0 {
			for i := range p {
				p[i] ^= mask[i%4]
			}
		}
		switch op {
		case 0x8:
			return nil, io.EOF
		case 0x9: // ping -> pong (masked, as a client must)
			mk := make([]byte, 4)
			rand.Read(mk)
			f := append([]byte{0x8a, 0x80 | byte(len(p))}, mk...)
			for i := range p {
				f = append(f, p[i]^mk[i%4])
			}
			w.c.Write(f)
			continue
		case 0xa:
			continue
		}
		msg = append(msg, p...)
		if fin {
			return msg, nil
		}
	}
}

// call sends a CDP command on the browser target and waits for its result (events are skipped).
func (w *wsConn) call(method string, params any) (json.RawMessage, error) {
	w.id++
	req := map[string]any{"id": w.id, "method": method}
	if params != nil {
		req["params"] = params
	}
	b, _ := json.Marshal(req)
	w.c.SetDeadline(time.Now().Add(10 * time.Second))
	defer w.c.SetDeadline(time.Time{})
	if err := w.send(b); err != nil {
		return nil, err
	}
	for {
		m, err := w.recv()
		if err != nil {
			return nil, err
		}
		var r struct {
			ID     int             `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(m, &r) != nil || r.ID != w.id {
			continue
		}
		if r.Error != nil {
			return nil, fmt.Errorf("%s: %s", method, r.Error.Message)
		}
		return r.Result, nil
	}
}
