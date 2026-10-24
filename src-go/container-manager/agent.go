package main

// Agent API: plain-text (or ?format=json) GET endpoints that expose everything about one session and let an
// AI agent (or curl) control it, authenticated by per-session tokens carried in the URL.
//
//	r_… token (read)    → report, logs, status, events, job, inspect, deployments
//	w_… token (control) → everything above + redeploy, restart, start, stop, pause, unpause, edit, exec, backup, rotate
//
// Entry point: GET /api/agent/<sessionId>.txt?token=<token>

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

type agentScope int

const (
	scopeNone agentScope = iota
	scopeRead
	scopeWrite
)

func agentAuth(r *http.Request, sess Session) agentScope {
	token := r.URL.Query().Get("token")
	if token == "" {
		if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
			token = strings.TrimPrefix(h, "Bearer ")
		}
	}
	switch {
	case safeEqual(sess.Metadata.AgentWriteToken, token):
		return scopeWrite
	case safeEqual(sess.Metadata.AgentReadToken, token):
		return scopeRead
	}
	return scopeNone
}

func agentBaseURL(r *http.Request) string {
	if s := getSettings(); s.PublicBaseURL != "" {
		return s.PublicBaseURL
	}
	if o := r.Header.Get("X-Public-Origin"); o != "" {
		return strings.TrimRight(o, "/")
	}
	return "http://" + r.Host
}

func textOut(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Robots-Tag", "noindex, nofollow")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(body))
}

func handleAgent(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		textOut(w, http.StatusMethodNotAllowed, "Only GET is supported.\n")
		return
	}
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/agent/"), "/")
	parts := strings.SplitN(rest, "/", 2)
	id := strings.TrimSuffix(strings.TrimSuffix(parts[0], ".txt"), ".json")
	action := "report"
	if len(parts) == 2 && parts[1] != "" {
		action = strings.TrimSuffix(strings.TrimSuffix(parts[1], ".txt"), ".json")
	}
	asJSON := r.URL.Query().Get("format") == "json" || strings.HasSuffix(parts[0], ".json") || (len(parts) == 2 && strings.HasSuffix(parts[1], ".json"))

	sess, ok := getSession(id)
	scope := scopeNone
	if ok {
		scope = agentAuth(r, sess)
	}
	if !ok || scope == scopeNone {
		time.Sleep(300 * time.Millisecond) // slow down token guessing
		textOut(w, http.StatusUnauthorized, "401 Unauthorized: unknown session or invalid token.\n")
		return
	}

	token := r.URL.Query().Get("token")
	base := agentBaseURL(r)
	q := r.URL.Query()

	needWrite := func() bool {
		if scope != scopeWrite {
			textOut(w, http.StatusForbidden, "403 Forbidden: this action needs the control (w_…) token; you used the read-only token.\n")
			return false
		}
		return true
	}

	switch action {
	case "report", "":
		textOut(w, http.StatusOK, buildAgentReport(sess, base, token, scope, q.Get("reveal") == "1"))

	case "logs":
		tail := 200
		if v, err := strconv.Atoi(q.Get("tail")); err == nil && v > 0 {
			tail = v
		}
		if tail > 5000 {
			tail = 5000
		}
		out := fetchLogs(sess, q.Get("service"), tail, q.Get("since"), q.Get("grep"))
		textOut(w, http.StatusOK, out+"\n")

	case "status":
		if asJSON {
			writeJSON(w, http.StatusOK, statusSummary(sess))
			return
		}
		textOut(w, http.StatusOK, buildStatusBlock(sess))

	case "events":
		limit := 50
		if v, err := strconv.Atoi(q.Get("limit")); err == nil && v > 0 && v <= 500 {
			limit = v
		}
		evs := eventsFor(sess.ID, limit)
		if asJSON {
			writeJSON(w, http.StatusOK, evs)
			return
		}
		textOut(w, http.StatusOK, formatEvents(evs)+"\n")

	case "job":
		jobID := q.Get("jobId")
		if jobID == "" {
			jobID = latestJobID(sess.ID)
		}
		if jobID == "" {
			textOut(w, http.StatusOK, "No deployment job has run for this session since the manager started.\n")
			return
		}
		job, found := getJob(jobID)
		if !found {
			textOut(w, http.StatusNotFound, "Job "+jobID+" not found (jobs are kept ~10 minutes after finishing).\n")
			return
		}
		if asJSON {
			writeJSON(w, http.StatusOK, job)
			return
		}
		textOut(w, http.StatusOK, formatJob(job, 60)+"\n")

	case "inspect":
		target := sess.Metadata.ContainerName
		if sess.Type == "docker-compose" {
			svc := q.Get("service")
			if svc == "" {
				if n := sortedServiceNames(sess); len(n) > 0 {
					svc = n[0]
				}
			}
			target = composeContainerName(sess.ID, svc)
		}
		out, _ := dockerOut(20*time.Second, "inspect", target)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(out))

	case "deployments":
		textOut(w, http.StatusOK, formatDeployments(sess.ID, 10)+"\n")

	case "redeploy", "restart", "start", "stop", "pause", "unpause":
		if !needWrite() {
			return
		}
		ifChanged := q.Get("ifChanged") == "1" || q.Get("ifChanged") == "true"
		res, err := performAction(sess.ID, action, q.Get("service"), "agent", ifChanged)
		if err != nil {
			textOut(w, http.StatusConflict, "ERROR: "+err.Error()+"\n")
			return
		}
		textOut(w, http.StatusOK, agentActionReply(res, base, sess.ID, token))

	case "edit":
		if !needWrite() {
			return
		}
		changes, err := applyAgentEdit(sess, q)
		if err != nil {
			textOut(w, http.StatusBadRequest, "ERROR: "+err.Error()+"\n")
			return
		}
		if len(changes) == 0 {
			textOut(w, http.StatusBadRequest, "ERROR: no changes supplied. See the EDIT section of the report for parameters.\n")
			return
		}
		recordEvent(sess.ID, "edit", "info", "agent", "Edited via agent API: %s", strings.Join(changes, "; "))
		var b strings.Builder
		b.WriteString("Applied changes:\n")
		for _, c := range changes {
			b.WriteString("  - " + c + "\n")
		}
		if q.Get("redeploy") == "0" {
			b.WriteString("\nSaved without redeploying (redeploy=0). Call /redeploy to apply.\n")
		} else {
			res, err := performAction(sess.ID, "redeploy", "", "agent", false)
			if err != nil {
				b.WriteString("\nRedeploy could not be started: " + err.Error() + "\n")
			} else {
				b.WriteString("\n" + agentActionReply(res, base, sess.ID, token))
			}
		}
		textOut(w, http.StatusOK, b.String())

	case "exec":
		if !needWrite() {
			return
		}
		cmd := q.Get("cmd")
		if strings.TrimSpace(cmd) == "" {
			textOut(w, http.StatusBadRequest, "ERROR: pass the shell command as ?cmd=…\n")
			return
		}
		out, err := execInSession(sess, q.Get("service"), cmd)
		recordEvent(sess.ID, "action", "info", "agent", "exec: %s", trimForEvent(cmd))
		if err != nil {
			out += "\n[exit error: " + err.Error() + "]"
		}
		textOut(w, http.StatusOK, out+"\n")

	case "backup":
		if !needWrite() {
			return
		}
		if err := backupSessionVolumes(sess); err != nil {
			textOut(w, http.StatusInternalServerError, "ERROR: "+err.Error()+"\n")
			return
		}
		textOut(w, http.StatusOK, fmt.Sprintf("Backed up volumes %v to Cloudflare R2.\n", sessionVolumeNames(sess)))

	case "rotate":
		if !needWrite() {
			return
		}
		rotateTokens(sess.ID, "agent")
		recordEvent(sess.ID, "action", "warn", "agent", "Agent tokens rotated via agent API")
		textOut(w, http.StatusOK, "Agent tokens rotated. The URL you just used no longer works; copy the new URLs from the dashboard.\n")

	default:
		textOut(w, http.StatusNotFound, "Unknown action \""+action+"\". Open the base URL (no action) for the list of endpoints.\n")
	}
}

func agentActionReply(res ActionResult, base, id, token string) string {
	var b strings.Builder
	b.WriteString(res.Message + "\n")
	if res.JobID != "" {
		b.WriteString("jobId: " + res.JobID + "\n")
		b.WriteString("Poll progress: " + agentURL(base, id, "job", token, "jobId="+res.JobID) + "\n")
	}
	return b.String()
}

func agentURL(base, id, action, token string, extra ...string) string {
	u := base + "/api/agent/" + id
	if action != "" && action != "report" {
		u += "/" + action
	} else {
		u += ".txt"
	}
	u += "?token=" + url.QueryEscape(token)
	for _, e := range extra {
		u += "&" + e
	}
	return u
}

// ── Edit ────────────────────────────────────────────────────────────────────

func applyAgentEdit(sess Session, q url.Values) ([]string, error) {
	var changes []string
	var problem error

	updateSession(sess.ID, func(s *Session) {
		m := &s.Metadata
		isCompose := s.Type == "docker-compose"

		if !isCompose {
			if v := strings.TrimSpace(q.Get("image")); v != "" {
				if strings.HasPrefix(v, "-") || strings.ContainsAny(v, " \t\r\n") {
					problem = fmt.Errorf("invalid image reference")
					return
				}
				changes = append(changes, fmt.Sprintf("image: %s → %s", m.Image, v))
				m.Image = v
			}
			if v := q.Get("port"); v != "" {
				n, err := strconv.Atoi(v)
				if err != nil || n <= 0 || n > 65535 {
					problem = fmt.Errorf("port must be 1-65535")
					return
				}
				changes = append(changes, fmt.Sprintf("container port: %d → %d", m.Port, n))
				m.Port = n
			}
			if v := q.Get("memoryMB"); v != "" {
				n, err := strconv.Atoi(v)
				if err != nil || n < 0 {
					problem = fmt.Errorf("memoryMB must be a non-negative integer")
					return
				}
				changes = append(changes, fmt.Sprintf("memoryMB: %d → %d", m.MemoryLimitMB, n))
				m.MemoryLimitMB = n
			}
			if v := q.Get("cpus"); v != "" {
				n, err := strconv.ParseFloat(v, 64)
				if err != nil || n < 0 {
					problem = fmt.Errorf("cpus must be a non-negative number")
					return
				}
				changes = append(changes, fmt.Sprintf("cpus: %.2f → %.2f", m.Cpus, n))
				m.Cpus = n
			}
			if v := q.Get("restartPolicy"); v != "" {
				switch v {
				case "no", "always", "unless-stopped", "on-failure":
					changes = append(changes, fmt.Sprintf("restartPolicy: %s → %s", m.RestartPolicy, v))
					m.RestartPolicy = v
				default:
					problem = fmt.Errorf("restartPolicy must be no, always, unless-stopped or on-failure")
					return
				}
			}
			if q.Has("args") {
				m.Args = strings.Fields(q.Get("args"))
				changes = append(changes, fmt.Sprintf("args: %v", m.Args))
			}
			if q.Has("command") {
				m.Command = strings.Fields(q.Get("command"))
				changes = append(changes, fmt.Sprintf("command: %v", m.Command))
			}
		}

		// env.KEY=VAL (container) or env.<service>.KEY=VAL (compose)
		keys := make([]string, 0, len(q))
		for k := range q {
			if strings.HasPrefix(k, "env.") {
				keys = append(keys, k)
			}
		}
		sort.Strings(keys)
		for _, k := range keys {
			name := strings.TrimPrefix(k, "env.")
			val := q.Get(k)
			if isCompose {
				svcKey := strings.SplitN(name, ".", 2)
				if len(svcKey) != 2 || svcKey[1] == "" {
					problem = fmt.Errorf("for compose use env.<service>.<KEY>=VALUE")
					return
				}
				setting := m.ServiceSettings[svcKey[0]]
				if setting.Env == nil {
					setting.Env = map[string]string{}
				}
				setting.Env[svcKey[1]] = val
				if m.ServiceSettings == nil {
					m.ServiceSettings = map[string]ServiceSetting{}
				}
				m.ServiceSettings[svcKey[0]] = setting
				changes = append(changes, fmt.Sprintf("env %s.%s set", svcKey[0], svcKey[1]))
			} else {
				if m.Env == nil {
					m.Env = map[string]string{}
				}
				m.Env[name] = val
				changes = append(changes, fmt.Sprintf("env %s set", name))
			}
		}
		if v := q.Get("unsetEnv"); v != "" {
			for _, name := range strings.Split(v, ",") {
				name = strings.TrimSpace(name)
				if isCompose {
					svcKey := strings.SplitN(name, ".", 2)
					if len(svcKey) == 2 {
						if st, ok := m.ServiceSettings[svcKey[0]]; ok {
							delete(st.Env, svcKey[1])
							changes = append(changes, fmt.Sprintf("env %s.%s removed", svcKey[0], svcKey[1]))
						}
					}
				} else if _, ok := m.Env[name]; ok {
					delete(m.Env, name)
					changes = append(changes, fmt.Sprintf("env %s removed", name))
				}
			}
		}
	})
	return changes, problem
}

// ── Report building ─────────────────────────────────────────────────────────

func humanDur(d time.Duration) string {
	if d < 0 {
		d = 0
	}
	d = d.Round(time.Second)
	days := int(d.Hours()) / 24
	h := int(d.Hours()) % 24
	m := int(d.Minutes()) % 60
	s := int(d.Seconds()) % 60
	switch {
	case days > 0:
		return fmt.Sprintf("%dd %dh %dm", days, h, m)
	case h > 0:
		return fmt.Sprintf("%dh %dm", h, m)
	case m > 0:
		return fmt.Sprintf("%dm %ds", m, s)
	}
	return fmt.Sprintf("%ds", s)
}

func fetchLogs(sess Session, service string, tail int, since, grep string) string {
	args := []string{}
	if sess.Type == "docker-compose" {
		args = []string{"compose", "-f", sess.Metadata.ComposeFile, "logs", "--no-color", "--tail", strconv.Itoa(tail)}
		if since != "" {
			args = append(args, "--since", since)
		}
		if service != "" {
			args = append(args, service)
		}
	} else {
		args = []string{"logs", "--tail", strconv.Itoa(tail)}
		if since != "" {
			args = append(args, "--since", since)
		}
		args = append(args, sess.Metadata.ContainerName)
	}
	out, err := dockerOut(30*time.Second, args...)
	if err != nil && out == "" {
		return "(could not read logs: " + err.Error() + ")"
	}
	if grep != "" {
		needle := strings.ToLower(grep)
		var kept []string
		for _, l := range strings.Split(out, "\n") {
			if strings.Contains(strings.ToLower(l), needle) {
				kept = append(kept, l)
			}
		}
		out = strings.Join(kept, "\n")
		if out == "" {
			out = "(no log lines matched \"" + grep + "\")"
		}
	}
	if out == "" {
		out = "(no log output)"
	}
	return out
}

func statusSummary(sess Session) map[string]interface{} {
	m := sess.Metadata
	res := map[string]interface{}{
		"id": sess.ID, "type": sess.Type, "name": m.ContainerName, "image": m.Image, "url": sess.URL,
		"desired": m.Desired, "status": m.Status, "health": m.Health, "exitCode": m.ExitCode,
		"restartCount": m.RestartCount, "oomKilled": m.OOMKilled, "tunnelStatus": m.TunnelStatus,
		"statusSince": m.StatusSince, "lastDeployedAt": m.LastDeployedAt,
		"redeployRunning": opActive(sess.ID),
	}
	if sess.Type == "docker-compose" {
		svcs := map[string]interface{}{}
		for n, s := range m.Services {
			svcs[n] = map[string]interface{}{"status": s.Status, "health": s.Health, "exitCode": s.ExitCode, "tunnelStatus": s.TunnelStatus, "url": s.CloudflaredURL}
		}
		res["services"] = svcs
	}
	return res
}

func buildStatusBlock(sess Session) string {
	m := sess.Metadata
	var b strings.Builder
	line := func(k string, v interface{}) { fmt.Fprintf(&b, "%-16s %v\n", k+":", v) }
	line("Desired state", orDash(m.Desired))
	line("Actual state", orDash(m.Status))
	if m.Health != "" {
		line("Health", m.Health)
	}
	if m.StatusSince != nil && m.Status != "" {
		line("In this state", humanDur(time.Since(*m.StatusSince)))
	}
	if sess.Type == "docker-container" {
		line("Exit code", m.ExitCode)
		line("Restart count", m.RestartCount)
		if m.OOMKilled {
			line("OOM killed", "YES — raise memoryMB")
		}
	}
	if m.TunnelStatus != "" {
		line("Tunnel", m.TunnelStatus)
	}
	line("Public URL", orDash(sess.URL))
	if opActive(sess.ID) {
		line("Deployment", "IN PROGRESS (job "+latestJobID(sess.ID)+")")
	} else {
		line("Deployment", "idle")
	}
	if sess.Type == "docker-compose" {
		b.WriteString("Services:\n")
		for _, n := range sortedServiceNames(sess) {
			s := m.Services[n]
			fmt.Fprintf(&b, "  - %-20s status=%s health=%s exit=%d tunnel=%s url=%s\n", n, orDash(s.Status), orDash(s.Health), s.ExitCode, orDash(s.TunnelStatus), orDash(s.CloudflaredURL))
		}
	}
	return b.String()
}

func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

func formatEvents(evs []Event) string {
	if len(evs) == 0 {
		return "(no events recorded)"
	}
	var b strings.Builder
	for _, e := range evs {
		fmt.Fprintf(&b, "%s  %-7s %-14s [%s] %s\n", e.Time.UTC().Format("2006-01-02 15:04:05Z"), strings.ToUpper(e.Level), e.Kind, orDash(e.Actor), e.Message)
	}
	return strings.TrimRight(b.String(), "\n")
}

func formatJob(j *Job, maxLogs int) string {
	var b strings.Builder
	fmt.Fprintf(&b, "jobId: %s\nstatus: %s\nphase: %s\nstarted: %s (%s ago)\n", j.ID, j.Status, j.Phase, j.CreatedAt.UTC().Format(time.RFC3339), humanDur(time.Since(j.CreatedAt)))
	if j.Result != "" {
		fmt.Fprintf(&b, "result: %s\n", j.Result)
	}
	if j.Error != "" {
		fmt.Fprintf(&b, "error: %s\n", j.Error)
	}
	logs := j.Logs
	if len(logs) > maxLogs {
		logs = logs[len(logs)-maxLogs:]
	}
	b.WriteString("log:\n")
	for _, l := range logs {
		b.WriteString("  " + l + "\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

func formatDeployments(sessionID string, limit int) string {
	recs, err := loadDeployments()
	if err != nil {
		return "(could not load deployment history: " + err.Error() + ")"
	}
	var b strings.Builder
	n := 0
	for _, r := range recs {
		if r.SessionID != sessionID {
			continue
		}
		fmt.Fprintf(&b, "%s  %-7s id=%s image=%s", r.Timestamp.UTC().Format("2006-01-02 15:04:05Z"), r.Status, r.ID, orDash(r.Config.Image))
		if r.Error != "" {
			fmt.Fprintf(&b, " error=%q", trimForEvent(r.Error))
		}
		b.WriteString("\n")
		if n++; n >= limit {
			break
		}
	}
	if n == 0 {
		return "(no deployments recorded)"
	}
	return strings.TrimRight(b.String(), "\n")
}

func buildAgentReport(sess Session, base, token string, scope agentScope, reveal bool) string {
	m := sess.Metadata
	var b strings.Builder
	h := func(title string) { fmt.Fprintf(&b, "\n==== %s ====\n", title) }
	kv := func(k string, v interface{}) { fmt.Fprintf(&b, "%-16s %v\n", k+":", v) }

	scopeName := "read-only"
	if scope == scopeWrite {
		scopeName = "control (read + write)"
	}
	name := m.ContainerName
	if name == "" {
		name = sess.ID
	}
	fmt.Fprintf(&b, "CONTAINER REPORT — %s\n", name)
	fmt.Fprintf(&b, "Generated: %s   Access: %s\n", time.Now().UTC().Format(time.RFC3339), scopeName)
	b.WriteString("This is a plain-text status page meant for humans and AI agents. Every endpoint below is a GET request;\n")
	b.WriteString("append ?format=json to status/events/job for JSON. The token in the URL is the credential — keep it private.\n")

	h("OVERVIEW")
	kv("Session id", sess.ID)
	kv("Type", sess.Type)
	if sess.Type == "docker-container" {
		kv("Container", m.ContainerName)
		kv("Image", m.Image)
	}
	kv("Public URL", orDash(sess.URL))
	kv("Domain mode", orDash(m.DomainMode))
	if m.CustomDomain != "" {
		kv("Custom domain", m.CustomDomain)
	}
	if m.LastDeployedAt != nil {
		kv("Last deployed", fmt.Sprintf("%s (%s ago)", m.LastDeployedAt.UTC().Format(time.RFC3339), humanDur(time.Since(*m.LastDeployedAt))))
	}
	if m.ExpiresAt != nil {
		kv("Expires", m.ExpiresAt.UTC().Format(time.RFC3339))
	}

	h("STATE")
	b.WriteString(buildStatusBlock(sess))
	if sess.Type == "docker-container" && containerExists(m.ContainerName) {
		info, _ := dockerOut(15*time.Second, "inspect", "--format",
			"{{.State.StartedAt}}|{{.State.FinishedAt}}|{{.State.Pid}}|{{.State.Error}}|{{.HostConfig.RestartPolicy.Name}}|{{.Image}}", m.ContainerName)
		if f := strings.Split(info, "|"); len(f) >= 6 {
			kv("Started at", f[0])
			if !strings.HasPrefix(f[1], "0001") {
				kv("Finished at", f[1])
			}
			if f[3] != "" {
				kv("Docker error", f[3])
			}
			kv("Restart policy", orDash(f[4]))
			kv("Image id", f[5])
		}
		if stats, err := dockerOut(20*time.Second, "stats", "--no-stream", "--format", "cpu {{.CPUPerc}} | mem {{.MemUsage}} ({{.MemPerc}}) | net {{.NetIO}} | block {{.BlockIO}} | pids {{.PIDs}}", m.ContainerName); err == nil {
			kv("Live usage", stats)
		}
	}

	if sess.Type == "docker-container" {
		h("IMAGE")
		if out, err := dockerOut(15*time.Second, "image", "inspect", "--format", "{{.Id}}|{{.Created}}|{{.Size}}|{{join .RepoDigests \",\"}}|{{.Os}}/{{.Architecture}}", m.Image); err == nil {
			if f := strings.Split(out, "|"); len(f) >= 5 {
				kv("Reference", m.Image)
				kv("Image id", f[0])
				kv("Built", f[1])
				if sz, err := strconv.ParseInt(f[2], 10, 64); err == nil {
					kv("Size", fmt.Sprintf("%.1f MB", float64(sz)/1e6))
				}
				kv("Digests", orDash(f[3]))
				kv("Platform", f[4])
			}
		} else {
			kv("Reference", m.Image)
			kv("Note", "image not present locally")
		}

		h("CONFIGURATION")
		kv("Host → container", fmt.Sprintf("%d → %d", m.HostPort, m.Port))
		for _, p := range m.Ports {
			kv("Extra port", fmt.Sprintf("%d → %d/%s", p.Host, p.Container, p.Protocol))
		}
		for _, v := range m.Volumes {
			ro := ""
			if v.ReadOnly {
				ro = " (read-only)"
			}
			kv("Volume", fmt.Sprintf("%s → %s%s", v.Source, v.Destination, ro))
		}
		kv("Memory limit", limitStr(m.MemoryLimitMB, "MB"))
		kv("CPU limit", func() string {
			if m.Cpus <= 0 {
				return "unlimited"
			}
			return fmt.Sprintf("%.2f", m.Cpus)
		}())
		if len(m.Command) > 0 {
			kv("Command", strings.Join(m.Command, " "))
		}
		if len(m.Args) > 0 {
			kv("Args", strings.Join(m.Args, " "))
		}
		writeEnv(&b, m.Env, "Environment", reveal && scope == scopeWrite)
	} else {
		h("COMPOSE")
		kv("Project", composeProject(sess.ID))
		kv("Compose file", m.ComposeFile)
		for _, n := range sortedServiceNames(sess) {
			s := m.Services[n]
			kv("Service "+n, fmt.Sprintf("host port %d, domain mode %s", s.HostPort, orDash(s.DomainMode)))
		}
		for _, n := range sortedKeys(m.ServiceSettings) {
			writeEnv(&b, m.ServiceSettings[n].Env, "Env ("+n+")", reveal && scope == scopeWrite)
		}
	}
	if vols := sessionVolumeNames(sess); len(vols) > 0 {
		kv("R2-backed vols", strings.Join(vols, ", "))
	}

	h("LATEST DEPLOYMENT JOB")
	if jid := latestJobID(sess.ID); jid != "" {
		if job, ok := getJob(jid); ok {
			b.WriteString(formatJob(job, 15) + "\n")
		} else {
			b.WriteString("(job " + jid + " expired)\n")
		}
	} else {
		b.WriteString("(none since the manager started)\n")
	}

	h("DEPLOYMENT HISTORY (newest first)")
	b.WriteString(formatDeployments(sess.ID, 5) + "\n")

	h("RECENT EVENTS (newest first)")
	b.WriteString(formatEvents(eventsFor(sess.ID, 20)) + "\n")

	h("RECENT LOGS (last 80 lines)")
	b.WriteString(fetchLogs(sess, "", 80, "", "") + "\n")

	h("ENDPOINTS")
	b.WriteString("READ\n")
	ep := func(label, action string, extra ...string) {
		fmt.Fprintf(&b, "  %-34s %s\n", label, agentURL(base, sess.ID, action, token, extra...))
	}
	ep("this report", "report")
	ep("logs (tail, since, grep, service)", "logs", "tail=300")
	ep("status (add &format=json)", "status")
	ep("events (add &limit=N)", "events")
	ep("deployment job progress", "job")
	ep("docker inspect (JSON)", "inspect")
	ep("deployment history", "deployments")
	if scope == scopeWrite {
		b.WriteString("CONTROL (each is a GET that changes things)\n")
		ep("redeploy (pull latest + recreate)", "redeploy")
		ep("redeploy only if image changed", "redeploy", "ifChanged=1")
		ep("restart", "restart")
		ep("stop (keeps config & data)", "stop")
		ep("start", "start")
		ep("pause / unpause", "pause")
		ep("run a command in the container", "exec", "cmd=ls%20-la")
		ep("back up volumes to R2 now", "backup")
		ep("edit config + redeploy", "edit", "image=NEW_IMAGE&env.KEY=VALUE&memoryMB=512")
		ep("rotate agent tokens (revokes this URL)", "rotate")
		b.WriteString("\nEDIT parameters: image, port, memoryMB, cpus, restartPolicy(no|always|unless-stopped|on-failure), command, args (space separated),\n")
		b.WriteString("  env.KEY=VALUE, unsetEnv=KEY1,KEY2, redeploy=0 (save without redeploying). Compose stacks: env.<service>.<KEY>=VALUE.\n")
		b.WriteString("Add &service=<name> to logs / restart / start / stop / exec for compose services. Add &reveal=1 to this report to show env values.\n")
	} else {
		b.WriteString("CONTROL endpoints (redeploy, restart, stop, edit, exec …) require the control token; ask the dashboard owner for the control URL.\n")
	}
	return b.String()
}

func limitStr(v int, unit string) string {
	if v <= 0 {
		return "unlimited"
	}
	return fmt.Sprintf("%d %s", v, unit)
}

func sortedKeys(m map[string]ServiceSetting) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func writeEnv(b *strings.Builder, env map[string]string, title string, reveal bool) {
	if len(env) == 0 {
		return
	}
	keys := make([]string, 0, len(env))
	for k := range env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	fmt.Fprintf(b, "%s:\n", title)
	for _, k := range keys {
		v := "••••••"
		if reveal {
			v = env[k]
		}
		fmt.Fprintf(b, "  %s=%s\n", k, v)
	}
}

var _ = json.Marshal
