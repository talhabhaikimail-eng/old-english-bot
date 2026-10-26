package main

import (
	"compress/flate"
	"compress/gzip"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"os"
	"strings"
	"time"
)

// allowPrivateTargets disables the SSRF guard (local development and tests only). It honours the
// same variable as the Node tools backend so one setting covers both.
func allowPrivateTargets() bool {
	return os.Getenv("TOOLS_ALLOW_PRIVATE_TARGETS") == "1" || os.Getenv("AUDITOR_ALLOW_PRIVATE") == "1"
}

var blockedNets = func() []*net.IPNet {
	cidrs := []string{
		"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
		"192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24",
		"203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4", "255.255.255.255/32",
		"::/128", "::1/128", "fc00::/7", "fe80::/10", "ff00::/8", "64:ff9b::/96", "2001:db8::/32",
	}
	out := make([]*net.IPNet, 0, len(cidrs))
	for _, c := range cidrs {
		_, n, err := net.ParseCIDR(c)
		if err == nil {
			out = append(out, n)
		}
	}
	return out
}()

// isBlockedIP reports whether ip is private, loopback, link-local or otherwise not a public address.
func isBlockedIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if v4 := ip.To4(); v4 != nil {
		ip = v4
	}
	for _, n := range blockedNets {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

var errBlockedTarget = errors.New("target resolves to a private or reserved address")

// guardedDial resolves the host itself and connects to a vetted IP, so a DNS answer can't swap in
// a private address between the check and the connection.
func guardedDial(ctx context.Context, network, addr string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	d := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	if allowPrivateTargets() {
		return d.DialContext(ctx, network, addr)
	}
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	var lastErr error = errBlockedTarget
	for _, ip := range ips {
		if isBlockedIP(ip.IP) {
			continue
		}
		c, err := d.DialContext(ctx, network, net.JoinHostPort(ip.IP.String(), port))
		if err == nil {
			return c, nil
		}
		lastErr = err
	}
	return nil, lastErr
}

// checkHostAllowed rejects literal private IPs and obviously internal names before any request.
func checkHostAllowed(host string) error {
	if allowPrivateTargets() {
		return nil
	}
	h := strings.Trim(strings.ToLower(host), "[]")
	if h == "localhost" || strings.HasSuffix(h, ".localhost") || strings.HasSuffix(h, ".local") || strings.HasSuffix(h, ".internal") {
		return errBlockedTarget
	}
	if ip := net.ParseIP(h); ip != nil && isBlockedIP(ip) {
		return errBlockedTarget
	}
	return nil
}

func newTransport() *http.Transport {
	return &http.Transport{
		DialContext:           guardedDial,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          200,
		MaxIdleConnsPerHost:   32,
		IdleConnTimeout:       60 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 25 * time.Second,
		// Compression is negotiated by hand so the audit can see transfer vs. decoded size.
		DisableCompression: true,
		TLSClientConfig:    &tls.Config{MinVersion: tls.VersionTLS10},
	}
}

// Fetcher performs single, non-redirect-following requests with timing information.
type Fetcher struct {
	client    *http.Client
	userAgent string
	timeout   time.Duration
	maxBody   int64
}

func NewFetcher(userAgent string, timeout time.Duration) *Fetcher {
	return &Fetcher{
		client: &http.Client{
			Transport: newTransport(),
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		userAgent: userAgent,
		timeout:   timeout,
		maxBody:   6 << 20,
	}
}

// FetchResult is one HTTP exchange; Body holds the decoded body when it was read.
type FetchResult struct {
	URL          string
	Status       int
	Proto        string
	Header       http.Header
	Body         []byte
	TransferSize int64 // bytes on the wire (compressed)
	Truncated    bool
	TTFB         time.Duration
	Total        time.Duration
	DNS          time.Duration
	Connect      time.Duration
	TLS          time.Duration
	TLSState     *tls.ConnectionState
	Err          error
}

type fetchOpts struct {
	method   string
	readBody bool
	// readIf decides after headers whether the body is worth downloading (e.g. only HTML).
	readIf  func(h http.Header) bool
	headers map[string]string
}

func (f *Fetcher) Do(ctx context.Context, rawURL string, o fetchOpts) *FetchResult {
	res := &FetchResult{URL: rawURL}
	u, err := url.Parse(rawURL)
	if err != nil {
		res.Err = err
		return res
	}
	if err := checkHostAllowed(u.Hostname()); err != nil {
		res.Err = err
		return res
	}
	method := o.method
	if method == "" {
		method = http.MethodGet
	}
	ctx, cancel := context.WithTimeout(ctx, f.timeout)
	defer cancel()

	var start, dnsStart, connStart, tlsStart time.Time
	trace := &httptrace.ClientTrace{
		DNSStart:          func(httptrace.DNSStartInfo) { dnsStart = time.Now() },
		DNSDone:           func(httptrace.DNSDoneInfo) { res.DNS = time.Since(dnsStart) },
		ConnectStart:      func(string, string) { connStart = time.Now() },
		ConnectDone:       func(string, string, error) { res.Connect = time.Since(connStart) },
		TLSHandshakeStart: func() { tlsStart = time.Now() },
		TLSHandshakeDone:  func(tls.ConnectionState, error) { res.TLS = time.Since(tlsStart) },
		GotFirstResponseByte: func() {
			res.TTFB = time.Since(start)
		},
	}
	req, err := http.NewRequestWithContext(httptrace.WithClientTrace(ctx, trace), method, rawURL, nil)
	if err != nil {
		res.Err = err
		return res
	}
	req.Header.Set("User-Agent", f.userAgent)
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	req.Header.Set("Accept-Encoding", "gzip, deflate")
	for k, v := range o.headers {
		req.Header.Set(k, v)
	}
	start = time.Now()
	resp, err := f.client.Do(req)
	if err != nil {
		res.Err = simplifyNetErr(err)
		res.Total = time.Since(start)
		return res
	}
	defer resp.Body.Close()
	res.Status = resp.StatusCode
	res.Proto = resp.Proto
	res.Header = resp.Header
	res.TLSState = resp.TLS
	if res.TTFB == 0 {
		res.TTFB = time.Since(start)
	}

	read := o.readBody && method != http.MethodHead
	if read && o.readIf != nil {
		read = o.readIf(resp.Header)
	}
	if read {
		counter := &countingReader{r: io.LimitReader(resp.Body, f.maxBody+1)}
		var body io.Reader = counter
		switch strings.ToLower(strings.TrimSpace(resp.Header.Get("Content-Encoding"))) {
		case "gzip", "x-gzip":
			if gz, err := gzip.NewReader(counter); err == nil {
				body = gz
				defer gz.Close()
			}
		case "deflate":
			fl := flate.NewReader(counter)
			body = fl
			defer fl.Close()
		}
		data, err := io.ReadAll(io.LimitReader(body, f.maxBody+1))
		if int64(len(data)) > f.maxBody {
			data = data[:f.maxBody]
			res.Truncated = true
		}
		if err != nil && len(data) == 0 {
			res.Err = simplifyNetErr(err)
		}
		res.Body = data
		res.TransferSize = counter.n
	} else {
		// Drain a little so keep-alive connections can be reused for small bodies.
		n, _ := io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		res.TransferSize = n
		if cl := resp.ContentLength; cl > 0 {
			res.TransferSize = cl
		}
	}
	res.Total = time.Since(start)
	return res
}

type countingReader struct {
	r io.Reader
	n int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	return n, err
}

func simplifyNetErr(err error) error {
	if err == nil {
		return nil
	}
	var ue *url.Error
	if errors.As(err, &ue) {
		err = ue.Err
	}
	if errors.Is(err, errBlockedTarget) {
		return errBlockedTarget
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		if dnsErr.IsNotFound {
			return fmt.Errorf("DNS lookup failed: host not found")
		}
		return fmt.Errorf("DNS lookup failed: %s", dnsErr.Err)
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("request timed out")
	}
	var certErr *tls.CertificateVerificationError
	if errors.As(err, &certErr) {
		return fmt.Errorf("TLS certificate error: %v", certErr.Err)
	}
	msg := err.Error()
	if strings.Contains(msg, "connection refused") {
		return fmt.Errorf("connection refused")
	}
	if strings.Contains(msg, "no such host") {
		return fmt.Errorf("DNS lookup failed: host not found")
	}
	return err
}

func isHTMLContentType(ct string) bool {
	ct = strings.ToLower(ct)
	return ct == "" || strings.Contains(ct, "text/html") || strings.Contains(ct, "application/xhtml")
}
