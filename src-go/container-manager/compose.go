package main

// compose.go holds everything specific to docker-compose stacks: the compose CLI wrapper, YAML
// rewriting (env overrides, tunnel ports), safety checks, and the deploy pipeline shared by
// dashboard deploys, redeploys and rollbacks.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
)

const (
	composeUpTimeout   = 15 * time.Minute
	composePullTimeout = 15 * time.Minute
	composeDownTimeout = 5 * time.Minute

	composeLiveFile   = "docker-compose.yml"
	composeNextFile   = "docker-compose.next.yml"
	composeSourceFile = "docker-compose.source.yml"

	// maskedEnvValue replaces compose env override values in API responses. Sending it back on a
	// deploy means "keep the stored value".
	maskedEnvValue = "__unchanged__"
)

var (
	composeIDRe    = regexp.MustCompile(`^compose-[a-f0-9]{8,32}$`)
	cleanSvcNameRe = regexp.MustCompile(`[^a-zA-Z0-9_-]`)
)

func validComposeSessionID(id string) bool { return composeIDRe.MatchString(id) }

func isTunneled(mode string) bool { return mode == "quick" || mode == "custom" }

// ── CLI ─────────────────────────────────────────────────────────────────────

var (
	composeBinOnce sync.Once
	composeBin     []string
)

// composeBase picks the compose CLI once: the docker plugin if available, else standalone docker-compose.
func composeBase() []string {
	composeBinOnce.Do(func() {
		if _, err := dockerOut(15*time.Second, "compose", "version"); err == nil {
			composeBin = []string{"docker", "compose"}
		} else if _, err := exec.LookPath("docker-compose"); err == nil {
			composeBin = []string{"docker-compose"}
		} else {
			composeBin = []string{"docker", "compose"}
		}
		log.Printf("[Docker Compose] Using %q", strings.Join(composeBin, " "))
	})
	return composeBin
}

// composeProjectForFile is the project name for a stack file: its directory name (compose-<hash>).
// Passing it explicitly keeps the name stable whatever the CLI's defaults are.
func composeProjectForFile(file string) string {
	return strings.ToLower(filepath.Base(filepath.Dir(file)))
}

func composeCommand(ctx context.Context, file string, args ...string) *exec.Cmd {
	base := composeBase()
	full := append([]string{}, base[1:]...)
	full = append(full, "-p", composeProjectForFile(file), "-f", file)
	full = append(full, args...)
	return exec.CommandContext(ctx, base[0], full...)
}

// composeCmdTimeout runs a compose command and returns its trimmed combined output.
func composeCmdTimeout(timeout time.Duration, file string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := composeCommand(ctx, file, args...)
	var buf limitedBuffer
	cmd.Stdout, cmd.Stderr = &buf, &buf
	err := cmd.Run()
	out := strings.TrimSpace(buf.String())
	if ctx.Err() == context.DeadlineExceeded {
		return out, fmt.Errorf("timed out after %v", timeout)
	}
	return out, err
}

func composeCmd(file string, args ...string) (string, error) {
	return composeCmdTimeout(2*time.Minute, file, args...)
}

func dockerComposeUp(composeFile string) error {
	log.Printf("[Docker Compose] Starting stack: %s", composeFile)
	if out, err := composeCmdTimeout(composeUpTimeout, composeFile, "up", "-d", "--remove-orphans"); err != nil {
		return fmt.Errorf("docker compose up failed: %v: %s", err, trimForEvent(out))
	}
	return nil
}

func dockerComposeDown(composeFile string) error {
	log.Printf("[Docker Compose] Stopping stack: %s", composeFile)
	if out, err := composeCmdTimeout(composeDownTimeout, composeFile, "down", "--remove-orphans"); err != nil {
		return fmt.Errorf("docker compose down failed: %v: %s", err, trimForEvent(out))
	}
	return nil
}

func dockerComposePull(composeFile string) error {
	log.Printf("[Docker Compose] Pulling images: %s", composeFile)
	if out, err := composeCmdTimeout(composePullTimeout, composeFile, "pull"); err != nil {
		return fmt.Errorf("docker compose pull failed: %v: %s", err, trimForEvent(out))
	}
	return nil
}

// limitedBuffer keeps the last 256 KiB of command output.
type limitedBuffer struct{ b []byte }

func (l *limitedBuffer) Write(p []byte) (int, error) {
	const max = 256 * 1024
	l.b = append(l.b, p...)
	if len(l.b) > max {
		l.b = l.b[len(l.b)-max:]
	}
	return len(p), nil
}

func (l *limitedBuffer) String() string { return string(l.b) }

// logOutputTail copies the last lines of command output into the job log.
func logOutputTail(jobID, out string, lines int) {
	if jobID == "" || strings.TrimSpace(out) == "" {
		return
	}
	all := strings.Split(strings.TrimSpace(out), "\n")
	if len(all) > lines {
		all = all[len(all)-lines:]
	}
	for _, l := range all {
		addJobLog(jobID, "  "+strings.TrimRight(l, "\r"))
	}
}

// ── Services & containers ───────────────────────────────────────────────────

// yamlServiceNames lists the services defined in a compose YAML document.
func yamlServiceNames(doc string) []string {
	var cm map[string]interface{}
	if yaml.Unmarshal([]byte(doc), &cm) != nil {
		return nil
	}
	svcs, _ := cm["services"].(map[string]interface{})
	names := make([]string, 0, len(svcs))
	for n := range svcs {
		names = append(names, n)
	}
	return names
}

// sortedServiceNames is every service of a stack: the tracked ones plus any in the YAML.
func sortedServiceNames(s Session) []string {
	seen := map[string]bool{}
	var names []string
	for n := range s.Metadata.Services {
		seen[n] = true
		names = append(names, n)
	}
	for _, n := range yamlServiceNames(s.Metadata.YAML) {
		if !seen[n] {
			seen[n] = true
			names = append(names, n)
		}
	}
	sort.Strings(names)
	return names
}

// checkComposeService rejects service names that are not part of the stack (an empty name is allowed).
func checkComposeService(sess Session, service string) error {
	if service == "" || sess.Type != "docker-compose" {
		return nil
	}
	names := sortedServiceNames(sess)
	for _, n := range names {
		if n == service {
			return nil
		}
	}
	return fmt.Errorf("unknown service %q (stack services: %s)", service, strings.Join(names, ", "))
}

// composeServiceContainer resolves the container of a stack service (defaulting to the first
// service). It asks compose, so container_name overrides and scaled services work.
func composeServiceContainer(sess Session, service string) (string, error) {
	if service == "" {
		names := sortedServiceNames(sess)
		if len(names) == 0 {
			return "", fmt.Errorf("no services in compose stack")
		}
		service = names[0]
	}
	if err := checkComposeService(sess, service); err != nil {
		return "", err
	}
	out, err := composeCmdTimeout(20*time.Second, sess.Metadata.ComposeFile, "ps", "-a", "-q", service)
	if err == nil {
		for _, line := range strings.Split(out, "\n") {
			if id := strings.TrimSpace(line); id != "" {
				return id, nil
			}
		}
	}
	return composeContainerName(sess.ID, service), nil
}

// composeContainerName is the default compose container name, used when compose can't be asked.
func composeContainerName(sessionID, service string) string {
	return fmt.Sprintf("%s-%s-1", sessionID, service)
}

// composeContainers lists the stack's containers (all states) as reported by compose.
func composeContainers(file string) ([]ComposePsService, error) {
	out, err := composeCmd(file, "ps", "-a", "--format", "json")
	if err != nil {
		return nil, err
	}
	return parseComposePs(out), nil
}

// parseComposePs accepts both the JSON array (older compose) and JSON-lines output formats.
func parseComposePs(out string) []ComposePsService {
	var ps []ComposePsService
	out = strings.TrimSpace(out)
	if strings.HasPrefix(out, "[") {
		_ = json.Unmarshal([]byte(out), &ps)
		return ps
	}
	for _, line := range strings.Split(out, "\n") {
		if line = strings.TrimSpace(line); strings.HasPrefix(line, "{") {
			var svc ComposePsService
			if json.Unmarshal([]byte(line), &svc) == nil {
				ps = append(ps, svc)
			}
		}
	}
	return ps
}

// backfillComposeServices adds tracking entries for stack services that predate per-service tracking
// (older deploys only recorded tunneled services).
func backfillComposeServices() {
	sessionsMu.Lock()
	defer sessionsMu.Unlock()
	for id, s := range sessions {
		if s.Type != "docker-compose" {
			continue
		}
		changed := false
		for _, n := range yamlServiceNames(s.Metadata.YAML) {
			if _, ok := s.Metadata.Services[n]; ok {
				continue
			}
			if s.Metadata.Services == nil {
				s.Metadata.Services = map[string]ServiceSessionMetadata{}
			}
			s.Metadata.Services[n] = ServiceSessionMetadata{ServiceName: n, DomainMode: "none"}
			changed = true
		}
		if changed {
			sessions[id] = s
		}
	}
}

// ── Teardown ────────────────────────────────────────────────────────────────

// teardownComposeStack stops the stack, releases its tunnels and removes its generated files.
func teardownComposeStack(sess Session) error {
	var err error
	if _, statErr := os.Stat(sess.Metadata.ComposeFile); statErr == nil {
		err = dockerComposeDown(sess.Metadata.ComposeFile)
	}
	for _, svc := range sess.Metadata.Services {
		cleanupCloudflareResources(SessionMetadata{TunnelPid: svc.TunnelPid, TunnelID: svc.TunnelID, CustomDomain: svc.CustomDomain})
	}
	if err == nil {
		removeStackDir(sess.Metadata.ComposeFile)
	}
	return err
}

// removeStackDir deletes the files we generated and the directory if nothing else is in it.
// Anything else (bind-mounted data under ./) is left alone.
func removeStackDir(composeFile string) {
	if composeFile == "" {
		return
	}
	dir := filepath.Dir(composeFile)
	if !strings.HasPrefix(filepath.Base(dir), "compose-") {
		return
	}
	for _, f := range []string{composeLiveFile, composeNextFile, composeSourceFile} {
		_ = os.Remove(filepath.Join(dir, f))
	}
	if err := os.Remove(dir); err != nil && !os.IsNotExist(err) {
		log.Printf("[Docker Compose] Left %s in place (it holds data): %v", dir, err)
	}
}

// ── Safety ──────────────────────────────────────────────────────────────────

var (
	blockedHostPathPrefixes = []string{"/etc", "/root", "/proc", "/sys", "/dev", "/boot", "/var/lib/docker", "/var/run", "/run"}
	blockedCaps             = map[string]bool{"ALL": true, "SYS_ADMIN": true, "SYS_MODULE": true, "SYS_PTRACE": true, "SYS_RAWIO": true, "SYS_BOOT": true, "SYS_TIME": true, "NET_ADMIN": true, "DAC_READ_SEARCH": true, "BPF": true, "PERFMON": true}
)

// hostPathProblem explains why a bind-mount source is not allowed ("" when it's fine).
func hostPathProblem(src string) string {
	s := strings.TrimSpace(src)
	if s == "" {
		return ""
	}
	if strings.Contains(s, "docker.sock") {
		return "mounts the Docker socket"
	}
	if strings.HasPrefix(s, "~") {
		return "mounts a home directory"
	}
	if strings.HasPrefix(s, ".") {
		if strings.HasPrefix(filepath.ToSlash(filepath.Clean(s)), "..") {
			return "escapes the stack directory"
		}
		return ""
	}
	if !strings.HasPrefix(s, "/") {
		return "" // named volume
	}
	clean := filepath.ToSlash(filepath.Clean(s))
	if clean == "/" {
		return "mounts the host root filesystem"
	}
	for _, p := range blockedHostPathPrefixes {
		if clean == p || strings.HasPrefix(clean, p+"/") {
			return "mounts the sensitive host path " + p
		}
	}
	return ""
}

// volumeSource extracts the host side of a service volume entry ("" when there is none).
func volumeSource(v interface{}) string {
	switch t := v.(type) {
	case string:
		parts := strings.SplitN(t, ":", 2)
		if len(parts) < 2 {
			return "" // anonymous volume
		}
		return parts[0]
	case map[string]interface{}:
		if typ, _ := t["type"].(string); typ != "" && typ != "bind" {
			return ""
		}
		s, _ := t["source"].(string)
		return s
	}
	return ""
}

// validateComposeSafety rejects options that give a stack control over the host. Settings can turn it off.
func validateComposeSafety(cm map[string]interface{}) error {
	if getSettings().ComposeAllowUnsafe {
		return nil
	}
	svcs, _ := cm["services"].(map[string]interface{})
	var problems []string
	add := func(svc, msg string) { problems = append(problems, fmt.Sprintf("%s: %s", svc, msg)) }

	names := make([]string, 0, len(svcs))
	for n := range svcs {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, name := range names {
		svc, ok := svcs[name].(map[string]interface{})
		if !ok {
			continue
		}
		if p, _ := svc["privileged"].(bool); p {
			add(name, "privileged mode is not allowed")
		}
		for _, key := range []string{"network_mode", "pid", "ipc", "uts", "userns_mode", "cgroup"} {
			v, _ := svc[key].(string)
			if v == "host" || strings.HasPrefix(v, "container:") {
				add(name, fmt.Sprintf("%s: %s is not allowed", key, v))
			}
		}
		if caps, ok := svc["cap_add"].([]interface{}); ok {
			for _, c := range caps {
				cs := strings.ToUpper(strings.TrimPrefix(fmt.Sprint(c), "CAP_"))
				if blockedCaps[cs] {
					add(name, "cap_add "+cs+" is not allowed")
				}
			}
		}
		if devs, ok := svc["devices"].([]interface{}); ok && len(devs) > 0 {
			add(name, "host devices are not allowed")
		}
		if opts, ok := svc["security_opt"].([]interface{}); ok {
			for _, o := range opts {
				if opt := fmt.Sprint(o); strings.Contains(opt, "unconfined") || strings.Contains(opt, "no-new-privileges:false") {
					add(name, "security_opt "+opt+" is not allowed")
				}
			}
		}
		if vols, ok := svc["volumes"].([]interface{}); ok {
			for _, v := range vols {
				src := volumeSource(v)
				if msg := hostPathProblem(src); msg != "" {
					add(name, fmt.Sprintf("volume %q %s", src, msg))
				}
			}
		}
	}
	if vols, ok := cm["volumes"].(map[string]interface{}); ok {
		for vName, def := range vols {
			d, _ := def.(map[string]interface{})
			opts, _ := d["driver_opts"].(map[string]interface{})
			if dev, _ := opts["device"].(string); dev != "" {
				if msg := hostPathProblem(dev); msg != "" {
					problems = append(problems, fmt.Sprintf("volume %s: device %q %s", vName, dev, msg))
				}
			}
		}
	}
	if len(problems) > 0 {
		return fmt.Errorf("compose file uses options that are blocked for safety (enable \"Allow unsafe compose options\" in settings to override):\n- %s", strings.Join(problems, "\n- "))
	}
	return nil
}

// validateComposeSupport rejects features that can't work from the stack directory.
func validateComposeSupport(cm map[string]interface{}) error {
	svcs, ok := cm["services"].(map[string]interface{})
	if !ok || len(svcs) == 0 {
		return errors.New("compose file must define at least one service")
	}
	var problems []string
	for name, raw := range svcs {
		svc, ok := raw.(map[string]interface{})
		if !ok {
			problems = append(problems, fmt.Sprintf("%s: service must be a mapping", name))
			continue
		}
		image, _ := svc["image"].(string)
		if _, hasBuild := svc["build"]; hasBuild && strings.TrimSpace(image) == "" {
			problems = append(problems, fmt.Sprintf("%s: build: is not supported (there is no build context on the server); push the image to a registry and use image:", name))
		} else if strings.TrimSpace(image) == "" {
			problems = append(problems, fmt.Sprintf("%s: image: is required", name))
		}
		if _, ok := svc["env_file"]; ok {
			problems = append(problems, fmt.Sprintf("%s: env_file: is not supported; use environment: or the per-service environment overrides", name))
		}
	}
	if len(problems) > 0 {
		sort.Strings(problems)
		return errors.New(strings.Join(problems, "\n"))
	}
	return nil
}

// parseComposeForDeploy decodes and validates a compose document.
func parseComposeForDeploy(doc string) (map[string]interface{}, error) {
	var cm map[string]interface{}
	if err := yaml.Unmarshal([]byte(doc), &cm); err != nil {
		return nil, fmt.Errorf("invalid compose YAML: %v", err)
	}
	if err := validateComposeSupport(cm); err != nil {
		return nil, err
	}
	if err := validateComposeSafety(cm); err != nil {
		return nil, err
	}
	return cm, nil
}

// ── Environment ─────────────────────────────────────────────────────────────

// serviceEnv reads a service's environment (map or list syntax). A nil value means "pass through
// from the shell", which compose writes as a bare KEY.
func serviceEnv(service map[string]interface{}) map[string]interface{} {
	out := map[string]interface{}{}
	switch env := service["environment"].(type) {
	case map[string]interface{}:
		for k, v := range env {
			out[k] = v
		}
	case []interface{}:
		for _, item := range env {
			s, ok := item.(string)
			if !ok {
				continue
			}
			if k, v, found := strings.Cut(s, "="); found {
				out[k] = v
			} else {
				out[s] = nil
			}
		}
	}
	return out
}

func envString(v interface{}) string {
	if v == nil {
		return ""
	}
	return fmt.Sprint(v)
}

// pruneEnvOverrides drops override values that just repeat what the YAML already sets, so only real
// overrides are stored.
func pruneEnvOverrides(cm map[string]interface{}, settings map[string]ServiceSetting) map[string]ServiceSetting {
	svcs, _ := cm["services"].(map[string]interface{})
	out := make(map[string]ServiceSetting, len(settings))
	for name, st := range settings {
		svc, _ := svcs[name].(map[string]interface{})
		orig := serviceEnv(svc)
		env := map[string]string{}
		for k, v := range st.Env {
			if k == "" {
				continue
			}
			if o, ok := orig[k]; ok && envString(o) == v {
				continue
			}
			env[k] = v
		}
		st.Env = env
		out[name] = st
	}
	return out
}

// restoreMaskedEnv swaps masked override values sent back by the dashboard for the stored ones.
func restoreMaskedEnv(settings map[string]ServiceSetting, old *Session) map[string]ServiceSetting {
	out := make(map[string]ServiceSetting, len(settings))
	for name, st := range settings {
		env := make(map[string]string, len(st.Env))
		for k, v := range st.Env {
			if v == maskedEnvValue {
				if old == nil {
					continue
				}
				prev, ok := old.Metadata.ServiceSettings[name].Env[k]
				if !ok {
					continue
				}
				v = prev
			}
			env[k] = v
		}
		st.Env = env
		out[name] = st
	}
	return out
}

// maskServiceSettings hides compose env override values in API responses.
func maskServiceSettings(in map[string]ServiceSetting) map[string]ServiceSetting {
	if in == nil {
		return nil
	}
	out := make(map[string]ServiceSetting, len(in))
	for name, st := range in {
		env := make(map[string]string, len(st.Env))
		for k := range st.Env {
			env[k] = maskedEnvValue
		}
		st.Env = env
		out[name] = st
	}
	return out
}

// mergeEnvironment applies overrides to a service. Override values are literal: "$" is escaped so
// compose doesn't treat it as interpolation.
func mergeEnvironment(service map[string]interface{}, overrides map[string]string) {
	env := serviceEnv(service)
	if len(env) == 0 && len(overrides) == 0 {
		return
	}
	for k, v := range overrides {
		if k != "" {
			env[k] = strings.ReplaceAll(v, "$", "$$")
		}
	}
	service["environment"] = env
}

// ── Ports ───────────────────────────────────────────────────────────────────

func toInt(v interface{}) (int, bool) {
	switch t := v.(type) {
	case int:
		return t, true
	case string:
		n, err := strconv.Atoi(strings.TrimSpace(t))
		return n, err == nil
	}
	return 0, false
}

// portEntry is the parts of one `ports:` entry we care about. Ranges leave container at 0.
type portEntry struct {
	host      int
	container int
	proto     string
}

func parsePortEntry(v interface{}) portEntry {
	switch t := v.(type) {
	case int:
		return portEntry{container: t, proto: "tcp"}
	case string:
		spec, proto, _ := strings.Cut(t, "/")
		if proto == "" {
			proto = "tcp"
		}
		parts := strings.Split(spec, ":")
		e := portEntry{proto: proto}
		e.container, _ = toInt(parts[len(parts)-1])
		if len(parts) >= 2 {
			e.host, _ = toInt(parts[len(parts)-2])
		}
		return e
	case map[string]interface{}:
		e := portEntry{proto: "tcp"}
		e.container, _ = toInt(t["target"])
		e.host, _ = toInt(t["published"])
		if p, _ := t["protocol"].(string); p != "" {
			e.proto = p
		}
		return e
	}
	return portEntry{}
}

// pickContainerPort decides which container port a tunnel should reach: the explicit setting, then
// the first published TCP port, then the first exposed port, then 80.
func pickContainerPort(svc map[string]interface{}, setting ServiceSetting) int {
	if setting.Port > 0 {
		return setting.Port
	}
	if list, ok := svc["ports"].([]interface{}); ok {
		for _, p := range list {
			if e := parsePortEntry(p); e.container > 0 && e.proto == "tcp" {
				return e.container
			}
		}
	}
	if list, ok := svc["expose"].([]interface{}); ok {
		for _, p := range list {
			if e := parsePortEntry(p); e.container > 0 {
				return e.container
			}
		}
	}
	return 80
}

// planServicePort publishes the tunnel's container port on a host port and rewrites that one
// `ports:` entry (other entries are kept). A host port the user fixed is kept when it is free or
// already ours; otherwise a managed port is allocated.
func planServicePort(jobID, name string, svc map[string]interface{}, setting ServiceSetting, old *ServiceSessionMetadata) (int, int, error) {
	cport := pickContainerPort(svc, setting)
	list, _ := svc["ports"].([]interface{})

	idx, fixedHost := -1, 0
	for i, p := range list {
		if e := parsePortEntry(p); e.container == cport && e.proto == "tcp" {
			idx, fixedHost = i, e.host
			break
		}
	}

	hostPort := 0
	switch {
	case fixedHost > 0 && old != nil && old.HostPort == fixedHost:
		hostPort = fixedHost
	case fixedHost > 0 && !isPortConflict(fixedHost):
		hostPort = fixedHost
	case old != nil && old.HostPort > 0 && old.Port == cport:
		hostPort = old.HostPort
	default:
		p, err := allocatePort()
		if err != nil {
			return 0, 0, fmt.Errorf("failed to allocate host port: %w", err)
		}
		hostPort = p
	}
	if fixedHost > 0 && hostPort != fixedHost {
		addJobLog(jobID, fmt.Sprintf("%s: host port %d is taken, publishing container port %d on %d instead", name, fixedHost, cport, hostPort))
	}

	entry := fmt.Sprintf("%d:%d", hostPort, cport)
	if idx >= 0 {
		list[idx] = entry
	} else {
		list = append(list, entry)
	}
	svc["ports"] = list
	return cport, hostPort, nil
}

// ── Deploy pipeline ─────────────────────────────────────────────────────────

type composeDeploy struct {
	JobID     string
	SessionID string
	YAML      string
	Settings  map[string]ServiceSetting
	Pull      bool
}

// runComposeDeploy deploys a stack and records the outcome in the job and deployment history.
// The caller must hold the session op (beginOp) so nothing else touches the stack meanwhile.
func runComposeDeploy(d composeDeploy) error {
	sess, err := deployComposeStack(d)
	record := DeploymentRecord{SessionID: d.SessionID, Type: "docker-compose"}
	if err != nil {
		failJob(d.JobID, err.Error())
		record.Status = "failed"
		record.Error = err.Error()
		record.Config = SessionMetadata{YAML: d.YAML, ServiceSettings: d.Settings}
	} else {
		completeJob(d.JobID, d.SessionID)
		record.Status = "success"
		record.Config = sess.Metadata
	}
	record.ID = generateHash()
	record.Timestamp = time.Now()
	record.Logs = getJobLogsCopy(d.JobID)
	appendDeployment(record)
	return err
}

func deployComposeStack(d composeDeploy) (*Session, error) {
	jobID := d.JobID
	if !validComposeSessionID(d.SessionID) {
		return nil, fmt.Errorf("invalid compose session id %q", d.SessionID)
	}
	updateJobPhase(jobID, "validating", "Validating compose configuration...")

	oldSess, exists := getSession(d.SessionID)
	var old *Session
	if exists {
		old = &oldSess
	}

	cm, err := parseComposeForDeploy(d.YAML)
	if err != nil {
		return nil, err
	}
	settings := pruneEnvOverrides(cm, restoreMaskedEnv(d.Settings, old))
	servicesMap := cm["services"].(map[string]interface{})

	names := make([]string, 0, len(servicesMap))
	for n := range servicesMap {
		names = append(names, n)
	}
	sort.Strings(names)

	// Rewrite env and tunnel ports
	servicesMeta := make(map[string]ServiceSessionMetadata, len(names))
	for _, name := range names {
		svc := servicesMap[name].(map[string]interface{})
		if _, hasBuild := svc["build"]; hasBuild {
			delete(svc, "build")
			addJobLog(jobID, fmt.Sprintf("%s: ignoring build: (no build context on the server), using image %v", name, svc["image"]))
		}
		setting := settings[name]
		mergeEnvironment(svc, setting.Env)

		meta := ServiceSessionMetadata{ServiceName: name, DomainMode: "none"}
		if isTunneled(setting.DomainMode) {
			var oldSvc *ServiceSessionMetadata
			if old != nil {
				if o, ok := old.Metadata.Services[name]; ok {
					oldSvc = &o
				}
			}
			cport, hport, err := planServicePort(jobID, name, svc, setting, oldSvc)
			if err != nil {
				return nil, err
			}
			meta.Port, meta.HostPort = cport, hport
			meta.DomainMode, meta.CustomDomain = setting.DomainMode, setting.CustomDomain
		}
		servicesMeta[name] = meta
	}

	stackDir := filepath.Join(findWorkspaceRoot(), "stacks", d.SessionID)
	if err := os.MkdirAll(stackDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create stack directory: %v", err)
	}
	livePath := filepath.Join(stackDir, composeLiveFile)
	nextPath := filepath.Join(stackDir, composeNextFile)

	generated, err := yaml.Marshal(cm)
	if err != nil {
		return nil, fmt.Errorf("failed to render compose file: %v", err)
	}
	if err := os.WriteFile(nextPath, generated, 0600); err != nil {
		return nil, fmt.Errorf("failed to write compose file: %v", err)
	}
	// Keep the user's file untouched next to the generated one, for reading and diffing.
	_ = os.WriteFile(filepath.Join(stackDir, composeSourceFile), []byte(d.YAML), 0600)

	// Check the new config with compose itself before the running stack is touched.
	if out, err := composeCmdTimeout(time.Minute, nextPath, "config", "-q"); err != nil {
		_ = os.Remove(nextPath)
		return nil, fmt.Errorf("compose rejected the configuration: %s", trimForEvent(orErr(out, err)))
	}

	if d.Pull {
		updateJobPhase(jobID, "pulling", "Pulling latest service images...")
		out, err := composeCmdTimeout(composePullTimeout, nextPath, "pull")
		logOutputTail(jobID, out, 20)
		if err != nil {
			addJobLog(jobID, "Warning: image pull failed, continuing with local images: "+err.Error())
		}
	}

	// Swap in the new file and let compose recreate only what changed (no full down → minimal downtime).
	prevContent, prevErr := os.ReadFile(livePath)
	hadPrev := prevErr == nil
	if err := os.Rename(nextPath, livePath); err != nil {
		return nil, fmt.Errorf("failed to install compose file: %v", err)
	}
	if old != nil && old.Metadata.ComposeFile != "" && filepath.Clean(old.Metadata.ComposeFile) != filepath.Clean(livePath) {
		addJobLog(jobID, "Stopping stack at its previous location...")
		_ = dockerComposeDown(old.Metadata.ComposeFile)
	}

	updateJobPhase(jobID, "starting", "Starting Docker Compose services...")
	out, err := composeCmdTimeout(composeUpTimeout, livePath, "up", "-d", "--remove-orphans")
	logOutputTail(jobID, out, 30)
	if err != nil {
		upErr := fmt.Errorf("failed to start compose stack: %v: %s", err, trimForEvent(out))
		if hadPrev {
			addJobLog(jobID, "Restoring the previous stack configuration...")
			_ = os.WriteFile(livePath, prevContent, 0600)
			if rOut, rErr := composeCmdTimeout(composeUpTimeout, livePath, "up", "-d", "--remove-orphans"); rErr != nil {
				addJobLog(jobID, "Restore failed: "+trimForEvent(orErr(rOut, rErr)))
			} else {
				addJobLog(jobID, "Previous configuration is running again")
			}
		} else {
			addJobLog(jobID, "Removing the partially created stack...")
			_ = dockerComposeDown(livePath)
			removeStackDir(livePath)
		}
		return nil, upErr
	}

	// Tunnels
	requested, failed := provisionComposeTunnels(jobID, d.SessionID, names, servicesMeta, old)

	// Release tunnels of services that are no longer exposed (or no longer exist)
	if old != nil {
		for name, o := range old.Metadata.Services {
			if isTunneled(o.DomainMode) && !isTunneled(servicesMeta[name].DomainMode) {
				addJobLog(jobID, fmt.Sprintf("%s: removing tunnel (no longer exposed)", name))
				cleanupCloudflareResources(SessionMetadata{TunnelPid: o.TunnelPid, TunnelID: o.TunnelID, CustomDomain: o.CustomDomain})
			}
		}
	}

	mainURL := ""
	for _, name := range names {
		if settings[name].Primary && servicesMeta[name].CloudflaredURL != "" {
			mainURL = servicesMeta[name].CloudflaredURL
			break
		}
	}
	for _, name := range names {
		if mainURL == "" && servicesMeta[name].CloudflaredURL != "" {
			mainURL = servicesMeta[name].CloudflaredURL
		}
	}
	if mainURL == "" {
		mainURL = "http://localhost"
	}

	tunnelStatus := ""
	switch {
	case requested == 0:
	case failed == 0:
		tunnelStatus = "up"
	case failed == requested:
		tunnelStatus = "down"
	default:
		tunnelStatus = "degraded"
	}
	if failed > 0 {
		addJobLog(jobID, fmt.Sprintf("Warning: %d of %d tunnel(s) failed; the stack is running but those services are not reachable from outside", failed, requested))
		recordEvent(d.SessionID, "tunnel_down", "error", "deploy", "%d of %d tunnel(s) failed to start", failed, requested)
	}

	sess := Session{
		ID:        d.SessionID,
		Type:      "docker-compose",
		URL:       mainURL,
		StartedAt: time.Now(),
		Metadata: SessionMetadata{
			ComposeFile:     livePath,
			Services:        servicesMeta,
			Status:          "running",
			TunnelStatus:    tunnelStatus,
			YAML:            d.YAML,
			ServiceSettings: settings,
		},
	}
	if old != nil {
		sess.Metadata.TTLMinutes = old.Metadata.TTLMinutes
		sess.Metadata.ExpiresAt = old.Metadata.ExpiresAt
		sess.Metadata.IsDemo = old.Metadata.IsDemo
	}
	finalizeSession(&sess, old)

	sessionsMu.Lock()
	sessions[d.SessionID] = sess
	sessionsMu.Unlock()
	saveSessions()
	return &sess, nil
}

// provisionComposeTunnels starts (or keeps) a tunnel per exposed service, in parallel, filling in
// servicesMeta. It returns how many tunnels were requested and how many failed.
func provisionComposeTunnels(jobID, sessionID string, names []string, servicesMeta map[string]ServiceSessionMetadata, old *Session) (int, int) {
	var exposed []string
	for _, n := range names {
		if isTunneled(servicesMeta[n].DomainMode) {
			exposed = append(exposed, n)
		}
	}
	if len(exposed) == 0 {
		return 0, 0
	}
	updateJobPhase(jobID, "tunneling", fmt.Sprintf("Setting up Cloudflare tunnels for %d service(s)...", len(exposed)))

	var mu sync.Mutex
	var wg sync.WaitGroup
	failed := 0
	hash := strings.TrimPrefix(sessionID, "compose-")
	for _, name := range exposed {
		wg.Add(1)
		go func(name string) {
			defer wg.Done()
			mu.Lock()
			meta := servicesMeta[name]
			mu.Unlock()

			var oldSvc ServiceSessionMetadata
			hadOld := false
			if old != nil {
				oldSvc, hadOld = old.Metadata.Services[name]
			}
			sameRoute := hadOld && oldSvc.DomainMode == meta.DomainMode && oldSvc.CustomDomain == meta.CustomDomain

			if sameRoute && oldSvc.HostPort == meta.HostPort && isProcessRunning(oldSvc.TunnelPid) {
				// Same route to the same host port: the running tunnel keeps working (and quick
				// tunnels keep their URL).
				meta.CloudflaredURL, meta.TunnelPid, meta.TunnelToken, meta.TunnelID = oldSvc.CloudflaredURL, oldSvc.TunnelPid, oldSvc.TunnelToken, oldSvc.TunnelID
				meta.TunnelStatus = "up"
				addJobLog(jobID, fmt.Sprintf("%s: keeping existing tunnel %s", name, meta.CloudflaredURL))
			} else {
				if hadOld && isTunneled(oldSvc.DomainMode) {
					if sameRoute {
						killTunnelProcess(oldSvc.TunnelPid)
					} else {
						cleanupCloudflareResources(SessionMetadata{TunnelPid: oldSvc.TunnelPid, TunnelID: oldSvc.TunnelID, CustomDomain: oldSvc.CustomDomain})
					}
				}
				opts := TunnelOptions{
					ServiceName: name, DomainMode: meta.DomainMode, CustomDomain: meta.CustomDomain,
					HostPort: meta.HostPort, SessionHash: hash, CleanName: cleanSvcNameRe.ReplaceAllString(name, "_"),
				}
				if sameRoute {
					opts.ReuseTunnel, opts.OldTunnelToken, opts.OldTunnelID = true, oldSvc.TunnelToken, oldSvc.TunnelID
				}
				res, err := provisionTunnel(opts)
				if err != nil {
					addJobLog(jobID, fmt.Sprintf("%s: tunnel failed: %v", name, err))
					meta.TunnelStatus = "down"
					mu.Lock()
					failed++
					mu.Unlock()
				} else {
					meta.CloudflaredURL, meta.TunnelPid, meta.TunnelToken, meta.TunnelID = res.CloudflaredURL, res.TunnelPid, res.TunnelToken, res.TunnelID
					meta.TunnelStatus = "up"
					addJobLog(jobID, fmt.Sprintf("%s: reachable at %s", name, res.CloudflaredURL))
				}
			}
			mu.Lock()
			servicesMeta[name] = meta
			mu.Unlock()
		}(name)
	}
	wg.Wait()
	return len(exposed), failed
}

func killTunnelProcess(pid int) {
	if pid <= 0 {
		return
	}
	if proc, err := os.FindProcess(pid); err == nil {
		_ = proc.Kill()
	}
}

func orErr(out string, err error) string {
	if strings.TrimSpace(out) != "" {
		return out
	}
	if err != nil {
		return err.Error()
	}
	return ""
}
