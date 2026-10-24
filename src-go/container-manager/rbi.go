package main

// Remote browser isolation (RBI): each "browse" session is a throwaway Chromium container (KasmVNC stream) on an
// isolated docker network, exposed through a Cloudflare tunnel with its own origin and password. Nothing the visited
// page does can touch the dashboard origin, and the container cannot reach the host, LAN or cloud metadata service.

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	rbiNetwork    = "rbi-net"
	rbiDefaultTTL = 30
	rbiMaxTTL     = 120
	rbiHardCapMin = 240 // a session can never live longer than 4h in total
)

var (
	rbiNetMu     sync.Mutex
	rbiNetReady  bool
	rbiFirewall  = "not applied"
	rbiBlockNets = []string{"169.254.0.0/16", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10"}
)

func rbiMaxSessions() int {
	if v, err := strconv.Atoi(getSanitizedEnv("RBI_MAX_SESSIONS")); err == nil && v > 0 {
		return v
	}
	return 3
}

func iptablesCmd(args ...string) *exec.Cmd {
	if os.Geteuid() == 0 {
		return exec.Command("iptables", args...)
	}
	return exec.Command("sudo", append([]string{"-n", "iptables"}, args...)...)
}

// ensureRBINetwork creates the isolated bridge network and (best effort, Linux only) drops its new connections to
// private ranges and the cloud metadata address. It never blocks session start if the firewall step fails.
func ensureRBINetwork() error {
	rbiNetMu.Lock()
	defer rbiNetMu.Unlock()
	if rbiNetReady && containerNetworkExists(rbiNetwork) {
		return nil
	}
	if !containerNetworkExists(rbiNetwork) {
		if out, err := dockerOut(30*time.Second, "network", "create", "--driver", "bridge",
			"--opt", "com.docker.network.bridge.enable_icc=false", rbiNetwork); err != nil {
			return fmt.Errorf("failed to create network %s: %s", rbiNetwork, trimForEvent(out))
		}
	}
	rbiNetReady = true

	if runtime.GOOS != "linux" {
		rbiFirewall = "skipped (not Linux)"
		return nil
	}
	subnet, err := dockerOut(15*time.Second, "network", "inspect", rbiNetwork, "--format", "{{(index .IPAM.Config 0).Subnet}}")
	if err != nil || subnet == "" {
		rbiFirewall = "skipped (could not read subnet)"
		return nil
	}
	applied := 0
	for _, dst := range rbiBlockNets {
		rule := []string{"DOCKER-USER", "-s", subnet, "-d", dst, "-m", "conntrack", "--ctstate", "NEW", "-j", "DROP"}
		if iptablesCmd(append([]string{"-C"}, rule...)...).Run() == nil {
			applied++
			continue
		}
		if out, err := iptablesCmd(append([]string{"-I"}, rule...)...).CombinedOutput(); err != nil {
			log.Printf("[RBI] iptables rule for %s failed: %v (%s)", dst, err, strings.TrimSpace(string(out)))
			continue
		}
		applied++
	}
	if applied == len(rbiBlockNets) {
		rbiFirewall = fmt.Sprintf("active (%d egress rules on %s)", applied, subnet)
	} else {
		rbiFirewall = fmt.Sprintf("PARTIAL (%d/%d rules) - host services stay protected by loopback binding only", applied, len(rbiBlockNets))
		recordEvent("", "state", "warn", "system", "Remote browser firewall incomplete: %s", rbiFirewall)
	}
	log.Printf("[RBI] Firewall: %s", rbiFirewall)
	return nil
}

func containerNetworkExists(name string) bool {
	_, err := dockerOut(10*time.Second, "network", "inspect", name)
	return err == nil
}

func rbiSessions() []Session {
	sessionsMu.RLock()
	defer sessionsMu.RUnlock()
	var out []Session
	for _, s := range sessions {
		if s.Metadata.Kind == "rbi" {
			out = append(out, s)
		}
	}
	return out
}

func normalizeBrowseURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", nil
	}
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", fmt.Errorf("start URL must be a valid http(s) address")
	}
	if strings.ContainsAny(raw, " \t\r\n\"'`$;|&<>\\") {
		return "", fmt.Errorf("start URL contains unsupported characters")
	}
	return u.String(), nil
}

func handleRBIStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		writeError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}
	var req struct {
		URL        string `json:"url"`
		TTLMinutes int    `json:"ttlMinutes"`
		DomainMode string `json:"domainMode"` // quick (default) | custom
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	startURL, err := normalizeBrowseURL(req.URL)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := verifyDockerRunning(); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if n := len(rbiSessions()); n >= rbiMaxSessions() {
		writeError(w, http.StatusTooManyRequests, fmt.Sprintf("Remote browser limit reached (%d/%d). Close one first.", n, rbiMaxSessions()))
		return
	}
	if err := ensureRBINetwork(); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	ttl := req.TTLMinutes
	if ttl <= 0 {
		ttl = rbiDefaultTTL
	}
	if ttl > rbiMaxTTL {
		ttl = rbiMaxTTL
	}
	mode := req.DomainMode
	if mode != "custom" {
		mode = "quick"
	}
	password := generateToken("")[:20]
	env := map[string]string{
		"CUSTOM_USER": "rbi",
		"PASSWORD":    password,
		"TITLE":       "Remote Browser",
	}
	if startURL != "" {
		env["CHROME_CLI"] = startURL
	}

	sr := StartRequest{
		Template:   "browser",
		Name:       "rbi",
		IsDemo:     true,
		TTLMinutes: ttl,
		DomainMode: mode,
		Env:        env,
		Kind:       "rbi",
		Network:    rbiNetwork,
		ShmSizeMB:  1024,
		PidsLimit:  768,
	}
	body, _ := json.Marshal(sr)
	inner := httptest.NewRequest("POST", "/api/go/containers/start", strings.NewReader(string(body)))
	rec := httptest.NewRecorder()
	handleStartContainer(rec, inner)

	res := map[string]interface{}{}
	_ = json.Unmarshal(rec.Body.Bytes(), &res)
	if rec.Code >= 300 {
		writeJSON(w, rec.Code, res)
		return
	}
	res["user"] = "rbi"
	res["password"] = password
	res["ttlMinutes"] = ttl
	if sid, ok := res["sessionId"].(string); ok {
		recordEvent(sid, "action", "info", "dashboard", "Remote browser session started (ttl %dm)", ttl)
	}
	writeJSON(w, http.StatusAccepted, res)
}

func handleRBIList(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		writeError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}
	type item struct {
		SessionID string     `json:"sessionId"`
		URL       string     `json:"url"`
		Status    string     `json:"status"`
		User      string     `json:"user"`
		Password  string     `json:"password"`
		StartedAt time.Time  `json:"startedAt"`
		ExpiresAt *time.Time `json:"expiresAt,omitempty"`
		Remaining int        `json:"remainingSeconds"`
	}
	list := []item{}
	for _, s := range rbiSessions() {
		it := item{
			SessionID: s.ID, URL: s.URL, Status: s.Metadata.Status, User: s.Metadata.Env["CUSTOM_USER"],
			Password: s.Metadata.Env["PASSWORD"], StartedAt: s.StartedAt, ExpiresAt: s.Metadata.ExpiresAt,
		}
		if s.Metadata.ExpiresAt != nil {
			if rem := int(time.Until(*s.Metadata.ExpiresAt).Seconds()); rem > 0 {
				it.Remaining = rem
			}
		}
		list = append(list, it)
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"sessions": list, "max": rbiMaxSessions(), "firewall": rbiFirewall,
	})
}

func handleRBIExtend(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		writeError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}
	var req struct {
		SessionID string `json:"sessionId"`
		Minutes   int    `json:"minutes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.SessionID == "" {
		writeError(w, http.StatusBadRequest, "sessionId is required")
		return
	}
	if req.Minutes <= 0 || req.Minutes > 60 {
		req.Minutes = 30
	}
	var newExp time.Time
	ok := updateSession(req.SessionID, func(s *Session) {
		if s.Metadata.Kind != "rbi" {
			return
		}
		base := time.Now()
		if s.Metadata.ExpiresAt != nil && s.Metadata.ExpiresAt.After(base) {
			base = *s.Metadata.ExpiresAt
		}
		newExp = base.Add(time.Duration(req.Minutes) * time.Minute)
		if hard := s.StartedAt.Add(rbiHardCapMin * time.Minute); newExp.After(hard) {
			newExp = hard
		}
		s.Metadata.ExpiresAt = &newExp
	})
	if !ok || newExp.IsZero() {
		writeError(w, http.StatusNotFound, "Remote browser session not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"success": true, "expiresAt": newExp})
}
