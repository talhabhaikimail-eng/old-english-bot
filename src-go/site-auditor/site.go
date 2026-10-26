package main

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

type TLSInfo struct {
	Valid       bool      `json:"valid"`
	Error       string    `json:"error,omitempty"`
	Version     string    `json:"version,omitempty"`
	Cipher      string    `json:"cipher,omitempty"`
	ALPN        string    `json:"alpn,omitempty"`
	Subject     string    `json:"subject,omitempty"`
	Issuer      string    `json:"issuer,omitempty"`
	SANs        []string  `json:"sans,omitempty"`
	NotBefore   time.Time `json:"notBefore"`
	NotAfter    time.Time `json:"notAfter"`
	DaysLeft    int       `json:"daysLeft"`
	KeyType     string    `json:"keyType,omitempty"`
	ChainLength int       `json:"chainLength"`
}

type HeaderCheck struct {
	Name    string `json:"name"`
	Present bool   `json:"present"`
	Value   string `json:"value,omitempty"`
	Good    bool   `json:"good"`
	Note    string `json:"note,omitempty"`
}

type DNSInfo struct {
	A      []string `json:"a"`
	AAAA   []string `json:"aaaa"`
	NS     []string `json:"ns"`
	MX     []string `json:"mx"`
	TXT    []string `json:"txt"`
	SPF    string   `json:"spf,omitempty"`
	DMARC  string   `json:"dmarc,omitempty"`
	CAA    bool     `json:"caa"`
	DNSSEC bool     `json:"dnssec"`
	CNAME  string   `json:"cname,omitempty"`
	Error  string   `json:"error,omitempty"`
}

type ProbeResult struct {
	URL      string `json:"url"`
	Status   int    `json:"status"`
	Location string `json:"location,omitempty"`
	Error    string `json:"error,omitempty"`
	Ok       bool   `json:"ok"`
	Note     string `json:"note,omitempty"`
}

type RobotsInfo struct {
	URL        string      `json:"url"`
	Status     int         `json:"status"`
	Found      bool        `json:"found"`
	Size       int         `json:"size"`
	Content    string      `json:"content,omitempty"`
	Sitemaps   []string    `json:"sitemaps,omitempty"`
	Agents     []string    `json:"agents,omitempty"`
	CrawlDelay float64     `json:"crawlDelay,omitempty"`
	AIBots     []BotAccess `json:"aiBots,omitempty"`
	SearchBots []BotAccess `json:"searchBots,omitempty"`
}

type SiteInfo struct {
	Origin          string         `json:"origin"`
	FinalURL        string         `json:"finalUrl"`
	StartRedirects  []ProbeResult  `json:"startRedirects,omitempty"`
	IP              []string       `json:"ip,omitempty"`
	Server          string         `json:"server,omitempty"`
	Protocol        string         `json:"protocol,omitempty"`
	HTTP2           bool           `json:"http2"`
	TLS             *TLSInfo       `json:"tls,omitempty"`
	SecurityHeaders []HeaderCheck  `json:"securityHeaders"`
	SecurityGrade   string         `json:"securityGrade"`
	DNS             *DNSInfo       `json:"dns,omitempty"`
	HTTPSRedirect   *ProbeResult   `json:"httpsRedirect,omitempty"`
	WWWCheck        *ProbeResult   `json:"wwwCheck,omitempty"`
	Soft404         *ProbeResult   `json:"soft404,omitempty"`
	LlmsTxt         *ProbeResult   `json:"llmsTxt,omitempty"`
	SecurityTxt     *ProbeResult   `json:"securityTxt,omitempty"`
	Favicon         *ProbeResult   `json:"favicon,omitempty"`
	Robots          *RobotsInfo    `json:"robots,omitempty"`
	Sitemaps        []SitemapInfo  `json:"sitemaps"`
	SitemapURLs     int            `json:"sitemapUrls"`
	Tech            []Tech         `json:"tech"`
	PageSpeed       []PageSpeedRun `json:"pageSpeed,omitempty"`
	HomeSchema      []string       `json:"homeSchema,omitempty"`
}

func tlsVersionName(v uint16) string {
	switch v {
	case tls.VersionTLS10:
		return "TLS 1.0"
	case tls.VersionTLS11:
		return "TLS 1.1"
	case tls.VersionTLS12:
		return "TLS 1.2"
	case tls.VersionTLS13:
		return "TLS 1.3"
	}
	return fmt.Sprintf("0x%04x", v)
}

// inspectTLS performs a verifying handshake, falling back to an unverified one to still read the cert.
func inspectTLS(ctx context.Context, host string) *TLSInfo {
	info := &TLSInfo{}
	if err := checkHostAllowed(host); err != nil {
		info.Error = err.Error()
		return info
	}
	dial := func(verify bool) (*tls.Conn, error) {
		raw, err := guardedDial(ctx, "tcp", net.JoinHostPort(host, "443"))
		if err != nil {
			return nil, err
		}
		c := tls.Client(raw, &tls.Config{ServerName: host, InsecureSkipVerify: !verify, NextProtos: []string{"h2", "http/1.1"}, MinVersion: tls.VersionTLS10})
		_ = c.SetDeadline(time.Now().Add(10 * time.Second))
		if err := c.HandshakeContext(ctx); err != nil {
			raw.Close()
			return nil, err
		}
		return c, nil
	}
	conn, err := dial(true)
	if err != nil {
		info.Error = simplifyNetErr(err).Error()
		conn, err = dial(false)
		if err != nil {
			return info
		}
	} else {
		info.Valid = true
	}
	defer conn.Close()
	st := conn.ConnectionState()
	info.Version = tlsVersionName(st.Version)
	info.Cipher = tls.CipherSuiteName(st.CipherSuite)
	info.ALPN = st.NegotiatedProtocol
	info.ChainLength = len(st.PeerCertificates)
	if len(st.PeerCertificates) > 0 {
		c := st.PeerCertificates[0]
		info.Subject = c.Subject.CommonName
		if len(c.Issuer.Organization) > 0 {
			info.Issuer = c.Issuer.Organization[0]
		} else {
			info.Issuer = c.Issuer.CommonName
		}
		if c.Issuer.CommonName != "" && info.Issuer != c.Issuer.CommonName {
			info.Issuer += " (" + c.Issuer.CommonName + ")"
		}
		info.SANs = c.DNSNames
		if len(info.SANs) > 50 {
			info.SANs = info.SANs[:50]
		}
		info.NotBefore = c.NotBefore
		info.NotAfter = c.NotAfter
		info.DaysLeft = int(time.Until(c.NotAfter).Hours() / 24)
		switch c.PublicKeyAlgorithm {
		case x509.RSA:
			info.KeyType = "RSA"
		case x509.ECDSA:
			info.KeyType = "ECDSA"
		case x509.Ed25519:
			info.KeyType = "Ed25519"
		}
	}
	return info
}

// securityHeaders grades headers the way securityheaders.com does (A+ … F).
func securityHeaders(h http.Header, https bool) ([]HeaderCheck, string) {
	get := func(k string) string { return strings.TrimSpace(h.Get(k)) }
	var out []HeaderCheck
	score := 0
	add := func(name string, val string, good bool, note string, weight int) {
		out = append(out, HeaderCheck{Name: name, Present: val != "", Value: firstN(val, 300), Good: good, Note: note})
		if good {
			score += weight
		}
	}
	hsts := get("Strict-Transport-Security")
	hstsGood := false
	hstsNote := "not set"
	if hsts != "" {
		hstsNote = "max-age too short (use ≥ 15552000)"
		if i := strings.Index(strings.ToLower(hsts), "max-age="); i >= 0 {
			var age int
			fmt.Sscanf(hsts[i+8:], "%d", &age)
			if age >= 15552000 {
				hstsGood, hstsNote = true, ""
			}
		}
	}
	if !https {
		hstsNote = "site not on HTTPS"
	}
	add("Strict-Transport-Security", hsts, hstsGood, hstsNote, 25)
	csp := get("Content-Security-Policy")
	cspNote := ""
	if csp == "" {
		cspNote = "not set"
		if ro := get("Content-Security-Policy-Report-Only"); ro != "" {
			cspNote = "only Report-Only policy present"
		}
	} else if strings.Contains(csp, "'unsafe-inline'") && !strings.Contains(csp, "nonce-") && !strings.Contains(csp, "strict-dynamic") {
		cspNote = "allows 'unsafe-inline'"
	}
	add("Content-Security-Policy", csp, csp != "", cspNote, 25)
	xfo := get("X-Frame-Options")
	fa := strings.Contains(strings.ToLower(csp), "frame-ancestors")
	note := ""
	if xfo == "" && !fa {
		note = "not set (and no CSP frame-ancestors)"
	}
	add("X-Frame-Options", xfo, xfo != "" || fa, note, 15)
	xcto := get("X-Content-Type-Options")
	add("X-Content-Type-Options", xcto, strings.EqualFold(xcto, "nosniff"), map[bool]string{true: "", false: "should be nosniff"}[strings.EqualFold(xcto, "nosniff")], 10)
	rp := get("Referrer-Policy")
	rpGood := rp != "" && !strings.Contains(strings.ToLower(rp), "unsafe-url")
	add("Referrer-Policy", rp, rpGood, map[bool]string{true: "", false: "not set or unsafe"}[rpGood], 10)
	pp := get("Permissions-Policy")
	add("Permissions-Policy", pp, pp != "", map[bool]string{true: "", false: "not set"}[pp != ""], 10)
	coop := get("Cross-Origin-Opener-Policy")
	add("Cross-Origin-Opener-Policy", coop, coop != "", map[bool]string{true: "", false: "not set (optional)"}[coop != ""], 5)

	server := get("Server")
	leak := ""
	if hasVersion(server) {
		leak = "Server: " + server
	}
	if xp := get("X-Powered-By"); xp != "" {
		if leak != "" {
			leak += "; "
		}
		leak += "X-Powered-By: " + xp
	}
	out = append(out, HeaderCheck{Name: "Server banner", Present: leak != "", Value: leak, Good: leak == "", Note: map[bool]string{true: "", false: "reveals software/version"}[leak == ""]})

	g := "F"
	switch {
	case score >= 95:
		g = "A+"
	case score >= 75:
		g = "A"
	case score >= 60:
		g = "B"
	case score >= 45:
		g = "C"
	case score >= 25:
		g = "D"
	case score >= 10:
		g = "E"
	}
	return out, g
}

func hasVersion(s string) bool {
	for i := 0; i+1 < len(s); i++ {
		if s[i] == '/' && s[i+1] >= '0' && s[i+1] <= '9' {
			return true
		}
	}
	return false
}

func lookupDNS(ctx context.Context, host string) *DNSInfo {
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	r := net.DefaultResolver
	info := &DNSInfo{}
	if ip := net.ParseIP(strings.Trim(host, "[]")); ip != nil {
		if ip.To4() != nil {
			info.A = []string{ip.String()}
		} else {
			info.AAAA = []string{ip.String()}
		}
		info.Error = "IP address — no DNS records"
		return info
	}
	apex := siteHost(host)
	var wg sync.WaitGroup
	var mu sync.Mutex
	run := func(f func()) {
		wg.Add(1)
		go func() { defer wg.Done(); f() }()
	}
	run(func() {
		ips, err := r.LookupIPAddr(ctx, host)
		mu.Lock()
		defer mu.Unlock()
		if err != nil {
			info.Error = simplifyNetErr(err).Error()
		}
		for _, ip := range ips {
			if ip.IP.To4() != nil {
				info.A = append(info.A, ip.IP.String())
			} else {
				info.AAAA = append(info.AAAA, ip.IP.String())
			}
		}
	})
	run(func() {
		if cname, err := r.LookupCNAME(ctx, host); err == nil && strings.TrimSuffix(cname, ".") != host {
			mu.Lock()
			info.CNAME = strings.TrimSuffix(cname, ".")
			mu.Unlock()
		}
	})
	run(func() {
		ns, _ := r.LookupNS(ctx, apex)
		mu.Lock()
		for _, n := range ns {
			info.NS = append(info.NS, strings.TrimSuffix(n.Host, "."))
		}
		mu.Unlock()
	})
	run(func() {
		mx, _ := r.LookupMX(ctx, apex)
		mu.Lock()
		for _, m := range mx {
			info.MX = append(info.MX, fmt.Sprintf("%d %s", m.Pref, strings.TrimSuffix(m.Host, ".")))
		}
		mu.Unlock()
	})
	run(func() {
		txt, _ := r.LookupTXT(ctx, apex)
		mu.Lock()
		for _, t := range txt {
			if strings.HasPrefix(strings.ToLower(t), "v=spf1") {
				info.SPF = t
			}
			info.TXT = append(info.TXT, firstN(t, 300))
		}
		mu.Unlock()
	})
	run(func() {
		txt, _ := r.LookupTXT(ctx, "_dmarc."+apex)
		mu.Lock()
		for _, t := range txt {
			if strings.HasPrefix(strings.ToLower(t), "v=dmarc1") {
				info.DMARC = t
			}
		}
		mu.Unlock()
	})
	run(func() {
		ok := hasCAA(ctx, apex)
		mu.Lock()
		info.CAA = ok
		mu.Unlock()
	})
	run(func() {
		ok := dnssecValidated(ctx, apex)
		mu.Lock()
		info.DNSSEC = ok
		mu.Unlock()
	})
	wg.Wait()
	return info
}

// probe fetches a URL once (no redirects followed) and summarises the result.
func probe(ctx context.Context, f *Fetcher, u string, readBody bool) (*ProbeResult, *FetchResult) {
	res := f.Do(ctx, u, fetchOpts{readBody: readBody})
	p := &ProbeResult{URL: u, Status: res.Status}
	if res.Err != nil {
		p.Error = res.Err.Error()
	}
	if res.Header != nil {
		if loc := res.Header.Get("Location"); loc != "" {
			if base, err := url.Parse(u); err == nil {
				if l, err := base.Parse(loc); err == nil {
					p.Location = l.String()
				}
			}
		}
	}
	return p, res
}

func randomToken() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
