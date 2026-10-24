package main

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
)

var (
	processStartedAt = time.Now()
	deploySem        = make(chan struct{}, 3) // cap concurrent redeploys (e.g. many sessions restored after a host restart)
)

// ── Helpers ─────────────────────────────────────────────────────────────────

func getSession(id string) (Session, bool) {
	sessionsMu.RLock()
	defer sessionsMu.RUnlock()
	s, ok := sessions[id]
	return s, ok
}

// updateSession mutates the live session under the lock and persists it.
func updateSession(id string, fn func(s *Session)) bool {
	sessionsMu.Lock()
	s, ok := sessions[id]
	if ok {
		fn(&s)
		sessions[id] = s
	}
	sessionsMu.Unlock()
	if ok {
		saveSessions()
	}
	return ok
}

func safeEqual(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// composeProject returns the docker compose project name used for a compose session
// (the stack directory is stacks/compose-<hash>, so that's the implicit project name).
func composeProject(sessionID string) string {
	return sessionID // already "compose-<hash>"
}

func composeContainerName(sessionID, service string) string {
	return fmt.Sprintf("%s-%s-1", composeProject(sessionID), service)
}

func sortedServiceNames(s Session) []string {
	names := make([]string, 0, len(s.Metadata.Services))
	for n := range s.Metadata.Services {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

// dockerOut runs a docker command with a timeout and returns trimmed combined output.
func dockerOut(timeout time.Duration, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "docker", args...)
	var buf bytes.Buffer
	cmd.Stdout = &buf
	cmd.Stderr = &buf
	err := cmd.Run()
	return strings.TrimSpace(buf.String()), err
}

func containerExists(name string) bool {
	_, err := dockerOut(15*time.Second, "inspect", "--format", "{{.Id}}", name)
	return err == nil
}

// ── Per-session operation guard + job tracking ──────────────────────────────

var (
	opsMu      sync.Mutex
	activeOps  = make(map[string]string) // sessionID → jobID of the running redeploy
	lastJobFor = make(map[string]string) // sessionID → most recent jobID (for status polling)
)

func beginOp(sessionID, jobID string) (string, bool) {
	opsMu.Lock()
	defer opsMu.Unlock()
	if existing, busy := activeOps[sessionID]; busy {
		return existing, false
	}
	activeOps[sessionID] = jobID
	lastJobFor[sessionID] = jobID
	return jobID, true
}

func endOp(sessionID string) {
	opsMu.Lock()
	delete(activeOps, sessionID)
	opsMu.Unlock()
}

func opActive(sessionID string) bool {
	opsMu.Lock()
	defer opsMu.Unlock()
	_, busy := activeOps[sessionID]
	return busy
}

func latestJobID(sessionID string) string {
	opsMu.Lock()
	defer opsMu.Unlock()
	return lastJobFor[sessionID]
}

// ── Redeploy ────────────────────────────────────────────────────────────────

func parseImageRef(image string) (repo, tag string) {
	ref := image
	if i := strings.Index(ref, "@"); i >= 0 {
		ref = ref[:i]
	}
	tag = "latest"
	if i := strings.LastIndex(ref, ":"); i > strings.LastIndex(ref, "/") {
		tag = ref[i+1:]
		ref = ref[:i]
	}
	ref = strings.TrimPrefix(ref, "docker.io/")
	ref = strings.TrimPrefix(ref, "library/")
	return strings.ToLower(ref), tag
}

// startRedeploy schedules a redeploy job for the session. If one is already running its jobId is returned
// (webhooks can fire repeatedly; we never run two deploys for one session at once).
func startRedeploy(sessionID, actor string, ifChanged bool) (jobID string, started bool, err error) {
	sess, ok := getSession(sessionID)
	if !ok {
		return "", false, fmt.Errorf("session not found")
	}
	if err := verifyDockerRunning(); err != nil {
		return "", false, err
	}
	newJob := createJob()
	jobID, ok = beginOp(sessionID, newJob)
	if !ok {
		failJob(newJob, "superseded by running job "+jobID)
		return jobID, false, nil
	}
	go func() {
		defer endOp(sessionID)
		deploySem <- struct{}{}
		defer func() { <-deploySem }()
		runRedeploy(newJob, sess, actor, ifChanged)
	}()
	return newJob, true, nil
}

func runRedeploy(jobID string, sess Session, actor string, ifChanged bool) {
	recordEvent(sess.ID, "action", "info", actor, "Redeploy started (job %s)", jobID)

	// Make sure persisted volume data is present before the container comes up (fresh host after restart)
	restoreMissingVolumes(sess, jobID)

	record := DeploymentRecord{SessionID: sess.ID, Type: sess.Type, Config: sess.Metadata}

	switch sess.Type {
	case "docker-container":
		if ifChanged && containerExists(sess.Metadata.ContainerName) {
			updateJobPhase(jobID, "pulling", "Checking registry for a newer image...")
			before, _ := dockerOut(15*time.Second, "inspect", "--format", "{{.Image}}", sess.Metadata.ContainerName)
			if err := pullImageWithAuth(sess.Metadata.Image, sess.Metadata.RegistryAuth, jobID); err != nil {
				failJob(jobID, err.Error())
				recordEvent(sess.ID, "deploy_failed", "error", actor, "Image pull failed: %v", err)
				return
			}
			after, _ := dockerOut(15*time.Second, "image", "inspect", "--format", "{{.Id}}", sess.Metadata.Image)
			if before != "" && before == after && sess.Metadata.Status == "running" {
				addJobLog(jobID, "Image digest unchanged — skipping redeploy")
				completeJob(jobID, "unchanged")
				recordEvent(sess.ID, "action", "info", actor, "Redeploy skipped: image unchanged")
				return
			}
		}
		rollbackContainerJob(jobID, record)
	case "docker-compose":
		rollbackComposeJob(jobID, record, true)
	default:
		failJob(jobID, "unsupported session type "+sess.Type)
		return
	}

	if job, ok := getJob(jobID); ok {
		if job.Status == "done" {
			recordEvent(sess.ID, "deploy_success", "success", actor, "Redeploy completed")
		} else {
			recordEvent(sess.ID, "deploy_failed", "error", actor, "Redeploy failed: %s", job.Error)
		}
	}
}

// ── Lifecycle actions ───────────────────────────────────────────────────────

type ActionRequest struct {
	SessionID string `json:"sessionId"`
	Action    string `json:"action"` // start | stop | restart | pause | unpause | redeploy
	Service   string `json:"service,omitempty"`
	IfChanged bool   `json:"ifChanged,omitempty"`
}

type ActionResult struct {
	Message string `json:"message"`
	JobID   string `json:"jobId,omitempty"`
}

func composeCmd(file string, args ...string) (string, error) {
	out, err := dockerOut(2*time.Minute, append([]string{"compose", "-f", file}, args...)...)
	if err != nil {
		out2, err2 := func() (string, error) {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
			defer cancel()
			cmd := exec.CommandContext(ctx, "docker-compose", append([]string{"-f", file}, args...)...)
			var buf bytes.Buffer
			cmd.Stdout, cmd.Stderr = &buf, &buf
			e := cmd.Run()
			return strings.TrimSpace(buf.String()), e
		}()
		if err2 == nil {
			return out2, nil
		}
	}
	return out, err
}

// performAction is shared by the dashboard, the webhook and the agent API.
func performAction(sessionID, action, service, actor string, ifChanged bool) (ActionResult, error) {
	sess, ok := getSession(sessionID)
	if !ok {
		return ActionResult{}, fmt.Errorf("session not found")
	}
	if err := verifyDockerRunning(); err != nil {
		return ActionResult{}, err
	}
	isCompose := sess.Type == "docker-compose"
	name := sess.Metadata.ContainerName

	if action == "redeploy" {
		jobID, started, err := startRedeploy(sessionID, actor, ifChanged)
		if err != nil {
			return ActionResult{}, err
		}
		if !started {
			return ActionResult{Message: "A redeploy is already running for this session", JobID: jobID}, nil
		}
		return ActionResult{Message: "Redeploy scheduled", JobID: jobID}, nil
	}

	if opActive(sessionID) {
		return ActionResult{}, fmt.Errorf("a deployment is currently running for this session; wait for it to finish")
	}

	// Missing resources can't be started/restarted in place: recreate them.
	missing := false
	if isCompose {
		if _, err := os.Stat(sess.Metadata.ComposeFile); err != nil {
			missing = true
		}
	} else if !containerExists(name) {
		missing = true
	}
	if missing && (action == "start" || action == "restart") {
		updateSession(sessionID, func(s *Session) { s.Metadata.Desired = "running" })
		jobID, _, err := startRedeploy(sessionID, actor, false)
		if err != nil {
			return ActionResult{}, err
		}
		return ActionResult{Message: "Resources were missing, redeploying instead", JobID: jobID}, nil
	}

	var out string
	var err error
	switch action {
	case "start", "stop", "restart", "pause", "unpause":
		if isCompose {
			args := []string{action}
			if service != "" {
				args = append(args, service)
			}
			out, err = composeCmd(sess.Metadata.ComposeFile, args...)
		} else {
			target := name
			if action == "stop" {
				out, err = dockerOut(2*time.Minute, "stop", target)
			} else {
				out, err = dockerOut(2*time.Minute, action, target)
			}
		}
	default:
		return ActionResult{}, fmt.Errorf("unknown action %q (use start, stop, restart, pause, unpause, redeploy)", action)
	}
	if err != nil {
		recordEvent(sessionID, "action", "error", actor, "%s failed: %s", action, trimForEvent(out))
		return ActionResult{}, fmt.Errorf("%s failed: %s", action, trimForEvent(out))
	}

	now := time.Now()
	updateSession(sessionID, func(s *Session) {
		switch action {
		case "start", "restart", "unpause":
			if service == "" {
				s.Metadata.Desired = "running"
			}
		case "stop":
			if service == "" {
				s.Metadata.Desired = "stopped"
			}
		}
		if service == "" && !isCompose {
			switch action {
			case "stop":
				s.Metadata.Status = "exited"
			case "start", "restart", "unpause":
				s.Metadata.Status = "running"
			case "pause":
				s.Metadata.Status = "paused"
			}
			s.Metadata.StatusSince = &now
		}
	})

	if action == "stop" && getSettings().AutoBackupEnabled {
		go func() { _ = backupSessionVolumes(sess) }()
	}

	target := sess.ID
	if service != "" {
		target += "/" + service
	}
	recordEvent(sessionID, "action", "info", actor, "%s %s", action, target)
	return ActionResult{Message: fmt.Sprintf("%s ok", action)}, nil
}

func trimForEvent(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > 300 {
		s = s[:300] + "…"
	}
	return s
}

func handleContainerAction(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		writeError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}
	var req ActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.SessionID == "" || req.Action == "" {
		writeError(w, http.StatusBadRequest, "sessionId and action are required")
		return
	}
	res, err := performAction(req.SessionID, req.Action, req.Service, "dashboard", req.IfChanged)
	if err != nil {
		status := http.StatusInternalServerError
		if strings.Contains(err.Error(), "not found") {
			status = http.StatusNotFound
		}
		writeError(w, status, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"success": true, "message": res.Message, "jobId": res.JobID})
}

// ── Webhook (public, protected by per-session secret) ───────────────────────

func handleWebhook(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" && r.Method != "POST" {
		writeError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}
	id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/go/webhook/"), "/")
	sess, ok := getSession(id)
	secret := r.URL.Query().Get("secret")
	if secret == "" {
		secret = r.Header.Get("X-Webhook-Secret")
	}
	// Same response for "unknown session" and "bad secret" so ids can't be probed
	if !ok || !safeEqual(sess.Metadata.WebhookSecret, secret) {
		writeError(w, http.StatusUnauthorized, "Invalid session or webhook secret")
		return
	}

	// Registry push payloads: only redeploy when the pushed tag matches what this session runs
	if r.Method == "POST" {
		if r.Header.Get("X-GitHub-Event") == "ping" {
			writeJSON(w, http.StatusOK, map[string]interface{}{"success": true, "ignored": true, "reason": "ping"})
			return
		}
		body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		var payload struct {
			Repository struct {
				RepoName string `json:"repo_name"`
			} `json:"repository"`
			PushData struct {
				Tag string `json:"tag"`
			} `json:"push_data"`
		}
		if json.Unmarshal(body, &payload) == nil && payload.Repository.RepoName != "" && payload.PushData.Tag != "" {
			wantRepo, wantTag := parseImageRef(sess.Metadata.Image)
			gotRepo, _ := parseImageRef(payload.Repository.RepoName)
			if sess.Type == "docker-container" && (gotRepo != wantRepo || payload.PushData.Tag != wantTag) {
				writeJSON(w, http.StatusOK, map[string]interface{}{"success": true, "ignored": true,
					"reason": fmt.Sprintf("pushed %s:%s does not match %s:%s", gotRepo, payload.PushData.Tag, wantRepo, wantTag)})
				return
			}
		}
	}

	ifChanged := r.URL.Query().Get("ifChanged") == "1" || r.URL.Query().Get("ifChanged") == "true"
	jobID, started, err := startRedeploy(id, "webhook", ifChanged)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	recordEvent(id, "webhook", "info", "webhook", "Webhook triggered redeploy (job %s, started=%v)", jobID, started)
	writeJSON(w, http.StatusAccepted, map[string]interface{}{
		"success": true, "jobId": jobID, "alreadyRunning": !started,
		"message": "Redeploy task scheduled successfully",
	})
}

// ── Token rotation ──────────────────────────────────────────────────────────

func handleRotateTokens(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		writeError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}
	var req struct {
		SessionID string `json:"sessionId"`
		Which     string `json:"which"` // webhook | agent | all
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.SessionID == "" {
		writeError(w, http.StatusBadRequest, "sessionId is required")
		return
	}
	if !rotateTokens(req.SessionID, req.Which) {
		writeError(w, http.StatusNotFound, "Session not found")
		return
	}
	recordEvent(req.SessionID, "action", "info", "dashboard", "Rotated %s token(s)", req.Which)
	writeJSON(w, http.StatusOK, map[string]interface{}{"success": true})
}

func rotateTokens(sessionID, which string) bool {
	return updateSession(sessionID, func(s *Session) {
		if which == "webhook" || which == "all" || which == "" {
			s.Metadata.WebhookSecret = generateToken("")
		}
		if which == "agent" || which == "all" || which == "" {
			s.Metadata.AgentReadToken = generateToken("r_")
			s.Metadata.AgentWriteToken = generateToken("w_")
		}
	})
}

// ── Exec ────────────────────────────────────────────────────────────────────

func execInSession(sess Session, service, command string) (string, error) {
	target := sess.Metadata.ContainerName
	if sess.Type == "docker-compose" {
		if service == "" {
			names := sortedServiceNames(sess)
			if len(names) == 0 {
				return "", fmt.Errorf("no services in compose stack")
			}
			service = names[0]
		}
		if _, ok := sess.Metadata.Services[service]; !ok {
			if _, ok2 := sess.Metadata.ServiceSettings[service]; !ok2 {
				return "", fmt.Errorf("unknown service %q", service)
			}
		}
		target = composeContainerName(sess.ID, service)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "docker", "exec", target, "sh", "-c", command)
	var buf bytes.Buffer
	cmd.Stdout = &limitedWriter{w: &buf, max: 64 * 1024}
	cmd.Stderr = cmd.Stdout
	err := cmd.Run()
	out := buf.String()
	if ctx.Err() == context.DeadlineExceeded {
		return out, fmt.Errorf("command timed out after 30s")
	}
	return out, err
}

type limitedWriter struct {
	w   *bytes.Buffer
	max int
}

func (l *limitedWriter) Write(p []byte) (int, error) {
	if l.w.Len() < l.max {
		room := l.max - l.w.Len()
		if len(p) > room {
			l.w.Write(p[:room])
			l.w.WriteString("\n…output truncated…")
		} else {
			l.w.Write(p)
		}
	}
	return len(p), nil
}

func handleExec(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		writeError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}
	var req struct {
		SessionID string `json:"sessionId"`
		Service   string `json:"service"`
		Command   string `json:"command"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.SessionID == "" || strings.TrimSpace(req.Command) == "" {
		writeError(w, http.StatusBadRequest, "sessionId and command are required")
		return
	}
	sess, ok := getSession(req.SessionID)
	if !ok {
		writeError(w, http.StatusNotFound, "Session not found")
		return
	}
	out, err := execInSession(sess, req.Service, req.Command)
	recordEvent(req.SessionID, "action", "info", "dashboard", "exec: %s", trimForEvent(req.Command))
	res := map[string]interface{}{"output": out, "success": err == nil}
	if err != nil {
		res["error"] = err.Error()
	}
	writeJSON(w, http.StatusOK, res)
}

// ── Volumes ─────────────────────────────────────────────────────────────────

var namedVolumeRe = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

// sessionVolumeNames lists the docker named volumes a session uses.
func sessionVolumeNames(sess Session) []string {
	seen := map[string]bool{}
	var out []string
	add := func(n string) {
		if n != "" && !seen[n] {
			seen[n] = true
			out = append(out, n)
		}
	}
	if sess.Type == "docker-container" {
		for _, v := range sess.Metadata.Volumes {
			if namedVolumeRe.MatchString(v.Source) {
				add(v.Source)
			}
		}
		return out
	}
	var cm map[string]interface{}
	if yaml.Unmarshal([]byte(sess.Metadata.YAML), &cm) == nil {
		if vols, ok := cm["volumes"].(map[string]interface{}); ok {
			for key, def := range vols {
				name := composeProject(sess.ID) + "_" + key
				if d, ok := def.(map[string]interface{}); ok {
					if explicit, ok := d["name"].(string); ok && explicit != "" {
						name = explicit
					}
					if ext, ok := d["external"].(bool); ok && ext {
						name = key
					}
				}
				add(name)
			}
		}
	}
	return out
}

// restoreMissingVolumes pulls volume data back from R2 for volumes that don't exist on this (fresh) host.
func restoreMissingVolumes(sess Session, jobID string) {
	for _, vol := range sessionVolumeNames(sess) {
		if _, err := dockerOut(15*time.Second, "volume", "inspect", vol); err == nil {
			continue
		}
		if !r2HasVolumeBackup(vol) {
			continue
		}
		msg := fmt.Sprintf("Restoring volume %s from Cloudflare R2...", vol)
		if jobID != "" {
			addJobLog(jobID, msg)
		}
		log.Println("[Volumes] " + msg)
		if err := restoreVolumeFromR2(vol); err != nil {
			recordEvent(sess.ID, "state", "warn", "system", "Volume %s restore failed: %v", vol, err)
		} else {
			recordEvent(sess.ID, "state", "success", "system", "Volume %s restored from R2", vol)
		}
	}
}

func backupSessionVolumes(sess Session) error {
	var firstErr error
	for _, vol := range sessionVolumeNames(sess) {
		if _, err := dockerOut(15*time.Second, "volume", "inspect", vol); err != nil {
			continue
		}
		if err := backupVolumeToR2(vol); err != nil {
			log.Printf("[Volumes] Backup of %s failed: %v", vol, err)
			recordEvent(sess.ID, "state", "warn", "system", "Volume %s backup failed: %v", vol, err)
			if firstErr == nil {
				firstErr = err
			}
		}
	}
	return firstErr
}

func backupAllVolumes() (int, error) {
	sessionsMu.RLock()
	list := make([]Session, 0, len(sessions))
	for _, s := range sessions {
		list = append(list, s)
	}
	sessionsMu.RUnlock()
	n := 0
	var firstErr error
	for _, s := range list {
		names := sessionVolumeNames(s)
		if err := backupSessionVolumes(s); err != nil && firstErr == nil {
			firstErr = err
		}
		n += len(names)
	}
	return n, firstErr
}

func startAutoBackupWorker() {
	last := time.Now()
	for range time.Tick(time.Minute) {
		s := getSettings()
		if !s.AutoBackupEnabled || time.Since(last) < time.Duration(s.AutoBackupIntervalMin)*time.Minute {
			continue
		}
		last = time.Now()
		if _, err := getS3ClientErr(); err != nil {
			continue
		}
		n, err := backupAllVolumes()
		if n > 0 {
			log.Printf("[Auto Backup] Backed up %d volume(s), err=%v", n, err)
		}
	}
}

func handleListVolumes(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		writeError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}
	out, err := dockerOut(20*time.Second, "volume", "ls", "--format", "{{.Name}}")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "docker volume ls failed: "+out)
		return
	}
	owners := map[string]string{}
	sessionsMu.RLock()
	for _, s := range sessions {
		for _, v := range sessionVolumeNames(s) {
			owners[v] = s.ID
		}
	}
	sessionsMu.RUnlock()
	backed := map[string]bool{}
	for _, b := range listR2VolumeBackups() {
		backed[b] = true
	}
	type vol struct {
		Name      string `json:"name"`
		SessionID string `json:"sessionId,omitempty"`
		BackedUp  bool   `json:"backedUp"`
	}
	list := []vol{}
	for _, name := range strings.Fields(out) {
		list = append(list, vol{Name: name, SessionID: owners[name], BackedUp: backed[name]})
	}
	writeJSON(w, http.StatusOK, list)
}

func handleDeleteVolume(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		writeError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}
	var req struct {
		Volume string `json:"volume"`
		Force  bool   `json:"force"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || !namedVolumeRe.MatchString(req.Volume) {
		writeError(w, http.StatusBadRequest, "valid volume name required")
		return
	}
	sessionsMu.RLock()
	for _, s := range sessions {
		for _, v := range sessionVolumeNames(s) {
			if v == req.Volume && !req.Force {
				sessionsMu.RUnlock()
				writeError(w, http.StatusConflict, fmt.Sprintf("Volume belongs to session %s; pass force=true to delete anyway", s.ID))
				return
			}
		}
	}
	sessionsMu.RUnlock()
	if out, err := dockerOut(30*time.Second, "volume", "rm", req.Volume); err != nil {
		writeError(w, http.StatusInternalServerError, out)
		return
	}
	recordEvent("", "action", "warn", "dashboard", "Deleted volume %s", req.Volume)
	writeJSON(w, http.StatusOK, map[string]interface{}{"success": true})
}

func handleBackupAll(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		writeError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}
	n, err := backupAllVolumes()
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("Backed up %d volume(s) with errors: %v", n, err))
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"success": true, "message": fmt.Sprintf("Backed up %d volume(s) to R2", n)})
}

// ── System ──────────────────────────────────────────────────────────────────

func handleSystemInfo(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		writeError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}
	ver, _ := dockerOut(10*time.Second, "version", "--format", "{{.Server.Version}}")
	df, _ := dockerOut(20*time.Second, "system", "df", "--format", "{{.Type}}: {{.Size}} (reclaimable {{.Reclaimable}})")
	total, running, problem := 0, 0, 0
	sessionsMu.RLock()
	for _, s := range sessions {
		total++
		if s.Metadata.Status == "running" {
			running++
		} else if s.Metadata.Desired != "stopped" {
			problem++
		}
	}
	sessionsMu.RUnlock()
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"dockerVersion": ver,
		"diskUsage":     strings.Split(df, "\n"),
		"sessions":      map[string]int{"total": total, "running": running, "needAttention": problem},
		"startedAt":     processStartedAt,
		"uptimeSeconds": int(time.Since(processStartedAt).Seconds()),
		"r2":            getR2Status(),
		"settings":      getSettings(),
	})
}

func handlePrune(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		writeError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}
	var req struct {
		All bool `json:"all"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	args := []string{"image", "prune", "-f"}
	if req.All {
		args = append(args, "-a")
	}
	out, err := dockerOut(5*time.Minute, args...)
	if err != nil {
		writeError(w, http.StatusInternalServerError, out)
		return
	}
	recordEvent("", "action", "info", "dashboard", "Image prune (all=%v)", req.All)
	writeJSON(w, http.StatusOK, map[string]interface{}{"success": true, "output": out})
}
