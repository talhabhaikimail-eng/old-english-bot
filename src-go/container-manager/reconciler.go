package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
)

type ComposePsService struct {
	Service  string `json:"Service"`
	Name     string `json:"Name"`
	State    string `json:"State"`
	Health   string `json:"Health"`
	ExitCode int    `json:"ExitCode"`
}

func startReconciler() {
	log.Println("[Reconciler] Starting background status, TTL and auto-recovery reconciler...")
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()

	reconcileState()
	for range ticker.C {
		reconcileState()
	}
}

func isProcessRunning(pid int) bool {
	if pid <= 0 {
		return false
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	if runtime.GOOS == "windows" {
		cmd := exec.Command("tasklist", "/FI", fmt.Sprintf("PID eq %d", pid), "/NH")
		out, err := cmd.Output()
		return err == nil && strings.Contains(string(out), fmt.Sprintf("%d", pid))
	}
	// On Unix/Linux, sending signal 0 checks if the process is alive.
	err = proc.Signal(syscall.Signal(0))
	return err == nil
}

// ── Observation (all docker calls happen WITHOUT holding sessionsMu) ────────

type svcObs struct {
	Status   string
	ExitCode int
	Health   string
}

type observation struct {
	id            string
	isCompose     bool
	containerName string
	composeFile   string

	// single container
	status       string
	exitCode     int
	health       string
	restartCount int
	oom          bool

	// compose
	svcs      map[string]svcObs
	composeOK bool
}

func observeContainer(s Session) observation {
	o := observation{id: s.ID, containerName: s.Metadata.ContainerName, status: "missing"}
	out, err := dockerOut(15*time.Second, "inspect", "--format",
		"{{.State.Status}} {{.State.ExitCode}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.RestartCount}} {{.State.OOMKilled}}",
		s.Metadata.ContainerName)
	if err != nil {
		return o
	}
	parts := strings.Fields(out)
	if len(parts) >= 2 {
		o.status = parts[0]
		fmt.Sscanf(parts[1], "%d", &o.exitCode)
	}
	if len(parts) >= 3 && parts[2] != "none" {
		o.health = parts[2]
	}
	if len(parts) >= 4 {
		fmt.Sscanf(parts[3], "%d", &o.restartCount)
	}
	if len(parts) >= 5 {
		o.oom = parts[4] == "true"
	}
	return o
}

func observeCompose(s Session) observation {
	o := observation{id: s.ID, isCompose: true, composeFile: s.Metadata.ComposeFile, svcs: map[string]svcObs{}}
	out, err := composeCmd(s.Metadata.ComposeFile, "ps", "-a", "--format", "json")
	if err != nil {
		return o
	}
	o.composeOK = true
	var psServices []ComposePsService
	outputStr := strings.TrimSpace(out)
	if strings.HasPrefix(outputStr, "[") {
		_ = json.Unmarshal([]byte(outputStr), &psServices)
	} else {
		for _, line := range strings.Split(outputStr, "\n") {
			if line = strings.TrimSpace(line); strings.HasPrefix(line, "{") {
				var svc ComposePsService
				if err := json.Unmarshal([]byte(line), &svc); err == nil {
					psServices = append(psServices, svc)
				}
			}
		}
	}
	for _, p := range psServices {
		o.svcs[p.Service] = svcObs{Status: p.State, ExitCode: p.ExitCode, Health: p.Health}
	}
	return o
}

// ── Recovery backoff ────────────────────────────────────────────────────────

type recoveryState struct {
	attempts int
	next     time.Time
	gaveUp   bool
}

var (
	recoveryMu   sync.Mutex
	recovery     = make(map[string]*recoveryState)
	recoverDelay = []time.Duration{0, 30 * time.Second, time.Minute, 2 * time.Minute, 5 * time.Minute}
	tunnelBusyMu sync.Mutex
	tunnelBusy   = make(map[string]bool)
)

// allowRecovery returns true if another recovery attempt may run now, advancing the backoff.
func allowRecovery(id string) (bool, bool) { // (allowed, justGaveUp)
	recoveryMu.Lock()
	defer recoveryMu.Unlock()
	st := recovery[id]
	if st == nil {
		st = &recoveryState{}
		recovery[id] = st
	}
	if st.gaveUp {
		return false, false
	}
	if time.Now().Before(st.next) {
		return false, false
	}
	if st.attempts >= len(recoverDelay) {
		st.gaveUp = true
		return false, true
	}
	st.next = time.Now().Add(recoverDelay[st.attempts] + 20*time.Second)
	st.attempts++
	return true, false
}

func resetRecovery(id string) {
	recoveryMu.Lock()
	delete(recovery, id)
	recoveryMu.Unlock()
}

// ── Reconcile ───────────────────────────────────────────────────────────────

type pendingEvent struct {
	sessionID, kind, level, msg string
}

type pendingTunnel struct {
	sess    Session
	service string // "" for single container
	svc     ServiceSessionMetadata
}

func reconcileState() {
	// 1. Snapshot + TTL expiry
	now := time.Now()
	sessionsMu.RLock()
	snapshot := make([]Session, 0, len(sessions))
	var expired []Session
	for _, s := range sessions {
		if s.Metadata.ExpiresAt != nil && now.After(*s.Metadata.ExpiresAt) {
			expired = append(expired, s)
			continue
		}
		snapshot = append(snapshot, s)
	}
	sessionsMu.RUnlock()

	for _, s := range expired {
		log.Printf("[Reconciler TTL] Session %s expired. Terminating and releasing resources...", s.ID)
		sessionsMu.Lock()
		delete(sessions, s.ID)
		sessionsMu.Unlock()
		if s.Type == "docker-compose" {
			_ = dockerComposeDown(s.Metadata.ComposeFile)
			for _, svc := range s.Metadata.Services {
				cleanupCloudflareResources(SessionMetadata{TunnelPid: svc.TunnelPid, TunnelID: svc.TunnelID, CustomDomain: svc.CustomDomain})
			}
		} else {
			_ = dockerStopAndRemove(s.Metadata.ContainerName)
			cleanupCloudflareResources(s.Metadata)
		}
		recordEvent(s.ID, "action", "info", "reconciler", "TTL expired — session terminated")
		saveSessions()
	}

	// 2. Observe docker state (no locks held), a few sessions at a time
	var obsMu sync.Mutex
	observations := make(map[string]observation)
	sem := make(chan struct{}, 4)
	var wg sync.WaitGroup
	for _, s := range snapshot {
		if opActive(s.ID) { // a deploy/restore is in flight; don't fight it
			continue
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(s Session) {
			defer wg.Done()
			defer func() { <-sem }()
			var o observation
			if s.Type == "docker-compose" {
				o = observeCompose(s)
			} else if s.Type == "docker-container" {
				o = observeContainer(s)
			} else {
				return
			}
			obsMu.Lock()
			observations[s.ID] = o
			obsMu.Unlock()
		}(s)
	}
	wg.Wait()

	// 3. Apply observations to the live sessions under a short lock
	var evs []pendingEvent
	var tunnels []pendingTunnel
	var recoverIDs []string
	changed := false
	settingsNow := getSettings()

	sessionsMu.Lock()
	for id, o := range observations {
		cur, ok := sessions[id]
		if !ok {
			continue
		}
		if o.isCompose != (cur.Type == "docker-compose") {
			continue
		}
		if !o.isCompose && o.containerName != cur.Metadata.ContainerName {
			continue // redeployed meanwhile
		}
		if o.isCompose && o.composeFile != cur.Metadata.ComposeFile {
			continue
		}
		desiredStopped := cur.Metadata.Desired == "stopped"
		nowT := time.Now()

		if !o.isCompose {
			m := &cur.Metadata
			prev := m.Status
			if prev != o.status {
				m.StatusSince = &nowT
				changed = true
				switch {
				case o.status == "running" && prev != "":
					evs = append(evs, pendingEvent{id, "recovered", "success", fmt.Sprintf("Container is running (was %s)", prev)})
				case (o.status == "exited" || o.status == "dead") && !desiredStopped:
					if o.exitCode != 0 || o.oom {
						msg := fmt.Sprintf("Container crashed with exit code %d", o.exitCode)
						if o.oom {
							msg += " (out of memory)"
						}
						evs = append(evs, pendingEvent{id, "crashed", "error", msg})
					} else {
						evs = append(evs, pendingEvent{id, "state", "warn", "Container exited cleanly (code 0)"})
					}
				case o.status == "missing" && !desiredStopped && prev != "":
					evs = append(evs, pendingEvent{id, "missing", "error", "Container no longer exists on the host"})
				}
			}
			if m.Health != o.health {
				if o.health == "unhealthy" {
					evs = append(evs, pendingEvent{id, "unhealthy", "warn", "Container health check is failing"})
				} else if o.health == "healthy" && m.Health == "unhealthy" {
					evs = append(evs, pendingEvent{id, "recovered", "success", "Container health check passing again"})
				}
				changed = true
			}
			if m.Status != o.status || m.ExitCode != o.exitCode || m.Health != o.health || m.RestartCount != o.restartCount || m.OOMKilled != o.oom {
				changed = true
			}
			m.Status, m.ExitCode, m.Health, m.RestartCount, m.OOMKilled = o.status, o.exitCode, o.health, o.restartCount, o.oom

			if o.status == "running" {
				if m.StatusSince != nil && time.Since(*m.StatusSince) > 2*time.Minute {
					resetRecovery(id)
				}
				if m.DomainMode == "custom" || m.DomainMode == "quick" {
					if !isProcessRunning(m.TunnelPid) {
						if m.TunnelStatus != "restarting" {
							evs = append(evs, pendingEvent{id, "tunnel_down", "warn", "Cloudflare tunnel process is not running — restarting"})
						}
						m.TunnelStatus = "restarting"
						changed = true
						tunnels = append(tunnels, pendingTunnel{sess: cur})
					} else if m.TunnelStatus != "up" {
						m.TunnelStatus = "up"
						changed = true
					}
				}
			} else if (o.status == "exited" || o.status == "dead" || o.status == "missing") && !desiredStopped && settingsNow.AutoRecover {
				recoverIDs = append(recoverIDs, id)
			}
		} else {
			m := &cur.Metadata
			running, total := 0, 0
			for name, sm := range m.Services {
				total++
				ob, found := o.svcs[name]
				next := svcObs{Status: "missing"}
				if o.composeOK && found {
					next = ob
				}
				if sm.Status != next.Status || sm.ExitCode != next.ExitCode || sm.Health != next.Health {
					if sm.Status != next.Status && !desiredStopped {
						switch {
						case next.Status == "running" && sm.Status != "":
							evs = append(evs, pendingEvent{id, "recovered", "success", fmt.Sprintf("Service %s is running (was %s)", name, sm.Status)})
						case next.Status == "exited" || next.Status == "dead":
							lvl, kind := "warn", "state"
							if next.ExitCode != 0 {
								lvl, kind = "error", "crashed"
							}
							evs = append(evs, pendingEvent{id, kind, lvl, fmt.Sprintf("Service %s exited with code %d", name, next.ExitCode)})
						case next.Status == "missing" && sm.Status != "":
							evs = append(evs, pendingEvent{id, "missing", "error", fmt.Sprintf("Service %s no longer exists", name)})
						}
					}
					if next.Health == "unhealthy" && sm.Health != "unhealthy" {
						evs = append(evs, pendingEvent{id, "unhealthy", "warn", fmt.Sprintf("Service %s health check is failing", name)})
					}
					sm.Status, sm.ExitCode, sm.Health = next.Status, next.ExitCode, next.Health
					m.Services[name] = sm
					changed = true
				}
				if sm.Status == "running" {
					running++
					if sm.DomainMode == "custom" || sm.DomainMode == "quick" {
						if !isProcessRunning(sm.TunnelPid) {
							if sm.TunnelStatus != "restarting" {
								evs = append(evs, pendingEvent{id, "tunnel_down", "warn", fmt.Sprintf("Tunnel for service %s is down — restarting", name)})
							}
							sm.TunnelStatus = "restarting"
							m.Services[name] = sm
							changed = true
							tunnels = append(tunnels, pendingTunnel{sess: cur, service: name, svc: sm})
						} else if sm.TunnelStatus != "up" {
							sm.TunnelStatus = "up"
							m.Services[name] = sm
							changed = true
						}
					}
				}
			}
			agg := "degraded"
			switch {
			case total == 0 || !o.composeOK:
				agg = "missing"
			case running == total:
				agg = "running"
			case running == 0:
				agg = "exited"
			}
			if m.Status != agg {
				m.Status = agg
				m.StatusSince = &nowT
				changed = true
			}
			if agg == "running" {
				if m.StatusSince != nil && time.Since(*m.StatusSince) > 2*time.Minute {
					resetRecovery(id)
				}
			} else if !desiredStopped && settingsNow.AutoRecover {
				recoverIDs = append(recoverIDs, id)
			}
		}
		sessions[id] = cur
	}
	sessionsMu.Unlock()

	// 4. Side effects outside the lock
	for _, e := range evs {
		recordEvent(e.sessionID, e.kind, e.level, "reconciler", "%s", e.msg)
	}
	if changed {
		saveSessions()
	}

	for _, t := range tunnels {
		go restartTunnel(t)
	}
	for _, id := range recoverIDs {
		go autoRecover(id)
	}
}

func restartTunnel(t pendingTunnel) {
	key := t.sess.ID + "/" + t.service
	tunnelBusyMu.Lock()
	if tunnelBusy[key] {
		tunnelBusyMu.Unlock()
		return
	}
	tunnelBusy[key] = true
	tunnelBusyMu.Unlock()
	defer func() {
		tunnelBusyMu.Lock()
		delete(tunnelBusy, key)
		tunnelBusyMu.Unlock()
	}()

	nameRe := regexp.MustCompile(`[^a-zA-Z0-9_-]`)
	var opts TunnelOptions
	if t.service == "" {
		m := t.sess.Metadata
		opts = TunnelOptions{
			ServiceName: "custom-container", DomainMode: m.DomainMode, CustomDomain: m.CustomDomain, HostPort: m.HostPort,
			SessionHash: strings.TrimPrefix(t.sess.ID, "docker-"), CleanName: nameRe.ReplaceAllString(m.ContainerName, "_"),
			ReuseTunnel: true, OldTunnelToken: m.TunnelToken, OldTunnelID: m.TunnelID,
		}
	} else {
		opts = TunnelOptions{
			ServiceName: t.service, DomainMode: t.svc.DomainMode, CustomDomain: t.svc.CustomDomain, HostPort: t.svc.HostPort,
			SessionHash: strings.TrimPrefix(t.sess.ID, "compose-"), CleanName: nameRe.ReplaceAllString(t.service, "_"),
			ReuseTunnel: true, OldTunnelToken: t.svc.TunnelToken, OldTunnelID: t.svc.TunnelID,
		}
	}
	log.Printf("[Reconciler Watchdog] Restarting tunnel for %s %s", t.sess.ID, t.service)
	res, err := provisionTunnel(opts)

	updateSession(t.sess.ID, func(s *Session) {
		if t.service == "" {
			if err != nil {
				s.Metadata.TunnelStatus = "down"
				return
			}
			s.Metadata.TunnelPid = res.TunnelPid
			s.URL = res.CloudflaredURL
			s.Metadata.CloudflaredURL = res.CloudflaredURL
			s.Metadata.TunnelStatus = "up"
			return
		}
		sm, ok := s.Metadata.Services[t.service]
		if !ok {
			return
		}
		if err != nil {
			sm.TunnelStatus = "down"
		} else {
			sm.TunnelPid = res.TunnelPid
			sm.CloudflaredURL = res.CloudflaredURL
			sm.TunnelStatus = "up"
			if s.URL == "" || s.URL == "http://localhost" {
				s.URL = res.CloudflaredURL
			}
		}
		s.Metadata.Services[t.service] = sm
	})
	if err != nil {
		log.Printf("[Reconciler Watchdog] Tunnel restart failed for %s %s: %v", t.sess.ID, t.service, err)
		recordEvent(t.sess.ID, "tunnel_down", "error", "reconciler", "Tunnel restart failed: %v", err)
	} else {
		recordEvent(t.sess.ID, "tunnel_up", "success", "reconciler", "Tunnel restored")
	}
}

// autoRecover brings a crashed / vanished session back (with exponential backoff, gives up after 5 tries).
func autoRecover(id string) {
	allowed, gaveUp := allowRecovery(id)
	if gaveUp {
		recordEvent(id, "crashed", "error", "reconciler", "Auto-recovery gave up after %d attempts — manual action required", len(recoverDelay))
		return
	}
	if !allowed || opActive(id) {
		return
	}
	sess, ok := getSession(id)
	if !ok {
		return
	}

	if sess.Type == "docker-container" {
		if sess.Metadata.Status == "missing" || !containerExists(sess.Metadata.ContainerName) {
			recordEvent(id, "action", "info", "reconciler", "Auto-recovery: recreating missing container")
			_, _, _ = startRedeploy(id, "reconciler", false)
			return
		}
		recordEvent(id, "action", "info", "reconciler", "Auto-recovery: starting container")
		if out, err := dockerOut(time.Minute, "start", sess.Metadata.ContainerName); err != nil {
			recordEvent(id, "crashed", "error", "reconciler", "Auto-start failed: %s", trimForEvent(out))
		}
		return
	}

	if _, err := os.Stat(sess.Metadata.ComposeFile); err != nil {
		recordEvent(id, "action", "info", "reconciler", "Auto-recovery: stack files missing, redeploying")
		_, _, _ = startRedeploy(id, "reconciler", false)
		return
	}
	recordEvent(id, "action", "info", "reconciler", "Auto-recovery: docker compose up -d")
	if err := dockerComposeUp(sess.Metadata.ComposeFile); err != nil {
		recordEvent(id, "crashed", "error", "reconciler", "Auto compose up failed: %v", err)
	}
}

// Live container inspect endpoint handler
func handleInspectContainer(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		writeError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	sID := r.URL.Query().Get("sessionId")
	if sID == "" {
		writeError(w, http.StatusBadRequest, "Missing sessionId parameter")
		return
	}

	sessionsMu.RLock()
	sess, exists := sessions[sID]
	sessionsMu.RUnlock()

	if !exists {
		writeError(w, http.StatusNotFound, "Session not found")
		return
	}

	var inspectTarget string
	if sess.Type == "docker-compose" {
		// Return inspect of first compose service or query service parameter
		serviceName := r.URL.Query().Get("service")
		if serviceName == "" {
			names := sortedServiceNames(sess)
			if len(names) > 0 {
				serviceName = names[0]
			}
		}
		if serviceName == "" {
			writeError(w, http.StatusBadRequest, "No services in compose stack")
			return
		}
		inspectTarget = composeContainerName(sID, serviceName)
	} else {
		inspectTarget = sess.Metadata.ContainerName
	}

	cmd := exec.Command("docker", "inspect", inspectTarget)
	out, err := cmd.Output()
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("Failed to inspect container: %v", err))
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write(out)
}
