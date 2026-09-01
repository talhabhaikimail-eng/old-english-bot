package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

type StartRequest struct {
	Image             string            `json:"image"`
	Port              int               `json:"port"`
	Env               map[string]string `json:"env"`
	Name              string            `json:"name"`
	DomainMode        string            `json:"domainMode"`
	CustomDomain      string            `json:"customDomain"`
	HostPort          int               `json:"hostPort"`
	TunnelToken       string            `json:"tunnelToken"`
	ExistingSessionID string            `json:"sessionId"`
	Ports             []PortMapping     `json:"ports"`
	Volumes           []VolumeMount     `json:"volumes"`
	MemoryLimitMB     int               `json:"memoryLimitMB"`
	Cpus              float64           `json:"cpus"`
	RestartPolicy     string            `json:"restartPolicy"`
	RegistryAuth      *RegistryAuth     `json:"registryAuth"`
	Command           []string          `json:"command"`
	Args              []string          `json:"args"`
	TTLMinutes        int               `json:"ttlMinutes,omitempty"`
	IsDemo            bool              `json:"isDemo,omitempty"`
	Template          string            `json:"template,omitempty"`
	Sync              bool              `json:"sync,omitempty"`
}

type StopRequest struct {
	SessionID string `json:"sessionId"`
	Force     bool   `json:"force,omitempty"`
}

type ParseComposeRequest struct {
	YAML string `json:"yaml"`
}

type ServiceSetting struct {
	DomainMode   string            `json:"domainMode"`
	CustomDomain string            `json:"customDomain"`
	Env          map[string]string `json:"env"`
}

type DeployComposeRequest struct {
	YAML            string                    `json:"yaml"`
	ServiceSettings map[string]ServiceSetting `json:"serviceSettings"`
	SessionID       string                    `json:"sessionId,omitempty"`
}

// CORS and response helpers
func writeJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(data); err != nil {
		log.Printf("Error encoding JSON response: %v", err)
	}
}

func writeError(w http.ResponseWriter, status int, errStr string) {
	writeJSON(w, status, map[string]string{"error": errStr})
}

func corsMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Dashboard-Token")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next(w, r)
	}
}

func handleGetSessions(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		writeError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	now := time.Now()
	sessionsMu.RLock()
	list := make([]SanitizedSession, 0, len(sessions))
	for _, s := range sessions {
		var remainingSecs = 0
		if s.Metadata.ExpiresAt != nil {
			rem := int(s.Metadata.ExpiresAt.Sub(now).Seconds())
			if rem > 0 {
				remainingSecs = rem
			}
		}

		sanitizedMeta := SanitizedSessionMetadata{
			Port:             s.Metadata.Port,
			HostPort:         s.Metadata.HostPort,
			ContainerName:    s.Metadata.ContainerName,
			TargetURL:        s.Metadata.TargetURL,
			Image:            s.Metadata.Image,
			Env:              s.Metadata.Env,
			DomainMode:       s.Metadata.DomainMode,
			CustomDomain:     s.Metadata.CustomDomain,
			CloudflaredURL:   s.Metadata.CloudflaredURL,
			ComposeFile:      s.Metadata.ComposeFile,
			Status:           s.Metadata.Status,
			ExitCode:         s.Metadata.ExitCode,
			Health:           s.Metadata.Health,
			TunnelStatus:     s.Metadata.TunnelStatus,
			Ports:            s.Metadata.Ports,
			Volumes:          s.Metadata.Volumes,
			MemoryLimitMB:    s.Metadata.MemoryLimitMB,
			Cpus:             s.Metadata.Cpus,
			RestartPolicy:    s.Metadata.RestartPolicy,
			Command:          s.Metadata.Command,
			Args:             s.Metadata.Args,
			YAML:             s.Metadata.YAML,
			ServiceSettings:  s.Metadata.ServiceSettings,
			TTLMinutes:       s.Metadata.TTLMinutes,
			ExpiresAt:        s.Metadata.ExpiresAt,
			IsDemo:           s.Metadata.IsDemo,
			RemainingSeconds: remainingSecs,
		}

		if s.Metadata.Services != nil {
			sanitizedMeta.Services = make(map[string]SanitizedServiceSessionMetadata)
			for name, svc := range s.Metadata.Services {
				sanitizedMeta.Services[name] = SanitizedServiceSessionMetadata{
					ServiceName:    svc.ServiceName,
					Port:           svc.Port,
					HostPort:       svc.HostPort,
					DomainMode:     svc.DomainMode,
					CustomDomain:   svc.CustomDomain,
					CloudflaredURL: svc.CloudflaredURL,
					Status:         svc.Status,
					ExitCode:       svc.ExitCode,
					Health:         svc.Health,
					TunnelStatus:   svc.TunnelStatus,
				}
			}
		}

		list = append(list, SanitizedSession{
			ID:        s.ID,
			Type:      s.Type,
			URL:       s.URL,
			Username:  s.Username,
			StartedAt: s.StartedAt,
			Metadata:  sanitizedMeta,
		})
	}
	sessionsMu.RUnlock()

	writeJSON(w, http.StatusOK, list)
}

func handleStartContainer(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		writeError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	var req StartRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid request body: "+err.Error())
		return
	}

	// Apply built-in templates if specified
	if req.Template == "vscode" {
		if req.Image == "" {
			req.Image = "codercom/code-server:latest"
		}
		if req.Port <= 0 {
			req.Port = 8080
		}
		if req.Env == nil {
			req.Env = make(map[string]string)
		}
		if _, ok := req.Env["PASSWORD"]; !ok {
			req.Env["PASSWORD"] = generateHash()
		}
		if req.MemoryLimitMB <= 0 {
			req.MemoryLimitMB = 1024
		}
		if req.Cpus <= 0 {
			req.Cpus = 1.0
		}
		if req.Name == "" {
			req.Name = "vscode"
		}
		if len(req.Args) == 0 {
			req.Args = []string{"--auth", "password", "--bind-addr", "0.0.0.0:8080"}
		}
	} else if req.Template == "terminal" {
		if req.Image == "" {
			req.Image = "tsl0922/ttyd:alpine"
		}
		if req.Port <= 0 {
			req.Port = 7681
		}
		if req.MemoryLimitMB <= 0 {
			req.MemoryLimitMB = 512
		}
		if req.Cpus <= 0 {
			req.Cpus = 0.5
		}
		if req.Name == "" {
			req.Name = "terminal"
		}
		if len(req.Command) == 0 && len(req.Args) == 0 {
			req.Command = []string{"ttyd", "-W", "-p", "7681", "sh"}
		}
	} else if req.Template == "browser" {
		if req.Image == "" {
			req.Image = "lscr.io/linuxserver/chromium:latest"
		}
		if req.Port <= 0 {
			req.Port = 3000
		}
		if req.MemoryLimitMB <= 0 {
			req.MemoryLimitMB = 1536
		}
		if req.Cpus <= 0 {
			req.Cpus = 1.5
		}
		if req.Name == "" {
			req.Name = "browser"
		}
	}

	// Validate inputs
	if req.Image == "" || strings.HasPrefix(req.Image, "-") {
		writeError(w, http.StatusBadRequest, "Invalid image name")
		return
	}
	if req.Port <= 0 || req.Port > 65535 {
		writeError(w, http.StatusBadRequest, "Invalid container port")
		return
	}

	// Demo TTL handling (5 minutes default for demo sessions)
	ttlMinutes := req.TTLMinutes
	if req.IsDemo && ttlMinutes <= 0 {
		ttlMinutes = 5
	}
	var expiresAt *time.Time
	if ttlMinutes > 0 {
		exp := time.Now().Add(time.Duration(ttlMinutes) * time.Minute)
		expiresAt = &exp
	}

	// 1. Verify Docker is running
	if err := verifyDockerRunning(); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	hash := req.ExistingSessionID
	if hash == "" {
		hash = generateHash()
	} else {
		hash = strings.TrimPrefix(hash, "docker-")
	}
	sessionID := "docker-" + hash

	// Domain determination:
	// For demo containers, use PORTFOLIO_DOMAIN (defaulting to talhacodes.site).
	// For regular containers, use MAIN_DOMAIN (e.g. ufone-claim.site).
	if req.DomainMode == "custom" && strings.TrimSpace(req.CustomDomain) == "" {
		if req.IsDemo {
			portfolioDomain := getSanitizedEnv("PORTFOLIO_DOMAIN")
			if portfolioDomain == "" {
				portfolioDomain = "talhacodes.site"
			}
			req.CustomDomain = fmt.Sprintf("demo-%s.%s", hash, portfolioDomain)
		} else {
			mainDomain := getSanitizedEnv("MAIN_DOMAIN")
			if mainDomain != "" {
				req.CustomDomain = fmt.Sprintf("sub-%s.%s", hash, mainDomain)
			}
		}
	}

	// Clean up old instance first if updating
	sessionsMu.Lock()
	oldSess, exists := sessions[sessionID]
	sessionsMu.Unlock()

	webhookSecret := generateHash()
	var activeTunnelToken = req.TunnelToken
	var activeTunnelID = ""
	var reuseTunnel = false

	if exists {
		webhookSecret = oldSess.Metadata.WebhookSecret
		targetURL := req.CustomDomain
		if targetURL != "" && !strings.HasPrefix(targetURL, "http") {
			targetURL = "https://" + targetURL
		}
		oldTargetURL := oldSess.Metadata.CustomDomain
		if oldTargetURL != "" && !strings.HasPrefix(oldTargetURL, "http") {
			oldTargetURL = "https://" + oldTargetURL
		}

		if req.DomainMode == "custom" &&
			oldSess.Metadata.DomainMode == "custom" &&
			oldSess.Metadata.TunnelToken != "" &&
			targetURL != "" &&
			targetURL == oldTargetURL {
			log.Printf("[Docker Go Start] Reusing existing Cloudflare tunnel token for: %s", oldSess.Metadata.TunnelID)
			activeTunnelToken = oldSess.Metadata.TunnelToken
			activeTunnelID = oldSess.Metadata.TunnelID
			reuseTunnel = true

			// Stop the old tunnel process if it is running
			if oldSess.Metadata.TunnelPid > 0 {
				if proc, err := os.FindProcess(oldSess.Metadata.TunnelPid); err == nil {
					_ = proc.Kill()
				}
			}
		}
	}

	cleanName := regexp.MustCompile(`[^a-zA-Z0-9_-]`).ReplaceAllString(req.Name, "_")
	if cleanName == "" {
		cleanName = "custom-app"
	}
	containerName := fmt.Sprintf("docker-custom-%s-%s", cleanName, hash)

	// Create async Job
	jobID := createJob()

	runDeploy := func(jobID string) (Session, error) {
		hostPort := req.HostPort
		defer func() {
			if jobID == "" {
				return
			}
			job, exists := getJob(jobID)
			if !exists {
				return
			}
			record := DeploymentRecord{
				ID:        generateHash(),
				SessionID: sessionID,
				Type:      "docker-container",
				Timestamp: time.Now(),
				Logs:      job.Logs,
			}
			if job.Status == "done" {
				record.Status = "success"
				sessionsMu.RLock()
				sess, ok := sessions[sessionID]
				sessionsMu.RUnlock()
				if ok {
					record.Config = sess.Metadata
				}
			} else {
				record.Status = "failed"
				record.Error = job.Error
				record.Config = SessionMetadata{
					Port:          req.Port,
					HostPort:      hostPort,
					ContainerName: containerName,
					Image:         req.Image,
					Env:           req.Env,
					Ports:         req.Ports,
					Volumes:       req.Volumes,
					MemoryLimitMB: req.MemoryLimitMB,
					Cpus:          req.Cpus,
					RestartPolicy: req.RestartPolicy,
					Command:       req.Command,
					Args:          req.Args,
					DomainMode:    req.DomainMode,
					CustomDomain:  req.CustomDomain,
					TTLMinutes:    ttlMinutes,
					ExpiresAt:     expiresAt,
					IsDemo:        req.IsDemo,
				}
			}
			appendDeployment(record)
		}()

		updateJobPhase(jobID, "validating", "Validating container configuration...")
		var err error
		if hostPort <= 0 {
			hostPort, err = allocatePort()
			if err != nil {
				failJob(jobID, "Failed to allocate host port: "+err.Error())
				return Session{}, fmt.Errorf("failed to allocate host port: %w", err)
			}
		} else {
			if isPortConflict(hostPort) {
				err = fmt.Errorf("Host port %d is already in use", hostPort)
				failJob(jobID, err.Error())
				return Session{}, err
			}
		}

		// Pulling phase (includes private registry authentication if supplied)
		updateJobPhase(jobID, "pulling", "Checking and downloading Docker image...")
		
		// Clean up old instance container before starting new one (if exists)
		if exists {
			addJobLog(jobID, "Removing old container instance...")
			if !reuseTunnel {
				cleanupCloudflareResources(oldSess.Metadata)
			}
			_ = dockerStopAndRemove(oldSess.Metadata.ContainerName)
		}

		// Starting phase
		updateJobPhase(jobID, "starting", "Starting container instance...")
		restartPolicy := req.RestartPolicy
		if req.IsDemo {
			restartPolicy = "no"
		}
		runOpts := RunOptions{
			Image:         req.Image,
			ContainerName: containerName,
			Port:          req.Port,
			HostPort:      hostPort,
			Env:           req.Env,
			Ports:         req.Ports,
			Volumes:       req.Volumes,
			MemoryLimitMB: req.MemoryLimitMB,
			Cpus:          req.Cpus,
			RestartPolicy: restartPolicy,
			RegistryAuth:  req.RegistryAuth,
			Command:       req.Command,
			Args:          req.Args,
		}
		if err := dockerRunWithJob(runOpts, jobID); err != nil {
			failJob(jobID, err.Error())
			return Session{}, err
		}

		var tunnelPid int
		var targetURL = ""

		if req.DomainMode == "custom" || req.DomainMode == "quick" {
			updateJobPhase(jobID, "tunneling", "Provisioning Cloudflare tunnel connection...")
			tOpts := TunnelOptions{
				ServiceName:    "custom-container",
				DomainMode:     req.DomainMode,
				CustomDomain:   req.CustomDomain,
				HostPort:       hostPort,
				SessionHash:    hash,
				CleanName:      cleanName,
				ReuseTunnel:    reuseTunnel,
				OldTunnelToken: activeTunnelToken,
				OldTunnelID:    activeTunnelID,
			}
			tRes, err := provisionTunnel(tOpts)
			if err != nil {
				// Clean up container since tunnel failed
				_ = dockerStopAndRemove(containerName)
				failJob(jobID, "Failed to provision Cloudflare tunnel: "+err.Error())
				return Session{}, err
			}

			tunnelPid = tRes.TunnelPid
			targetURL = tRes.CloudflaredURL
			activeTunnelToken = tRes.TunnelToken
			activeTunnelID = tRes.TunnelID

			updateJobPhase(jobID, "tunneling", fmt.Sprintf("Testing endpoint health for %s (1s delay loop)...", targetURL))
			waitForHealthyStatusWithJob(jobID, targetURL, hostPort, 45*time.Second)
		}

		sess := Session{
			ID:        sessionID,
			Type:      "docker-container",
			URL:       targetURL,
			StartedAt: time.Now(),
			Metadata: SessionMetadata{
				Port:           req.Port,
				HostPort:       hostPort,
				ContainerName:  containerName,
				Image:          req.Image,
				Env:            req.Env,
				DomainMode:     req.DomainMode,
				CustomDomain:   req.CustomDomain,
				CloudflaredURL: targetURL,
				TunnelPid:      tunnelPid,
				TunnelToken:    activeTunnelToken,
				TunnelID:       activeTunnelID,
				WebhookSecret:  webhookSecret,
				Ports:          req.Ports,
				Volumes:        req.Volumes,
				MemoryLimitMB:  req.MemoryLimitMB,
				Cpus:           req.Cpus,
				RestartPolicy:  restartPolicy,
				Command:        req.Command,
				Args:           req.Args,
				Status:         "running",
				TunnelStatus:   "up",
				TTLMinutes:     ttlMinutes,
				ExpiresAt:      expiresAt,
				IsDemo:         req.IsDemo,
			},
		}

		sessionsMu.Lock()
		sessions[sessionID] = sess
		sessionsMu.Unlock()
		saveSessions()

		completeJob(jobID, containerName)
		return sess, nil
	}

	if req.Sync {
		sess, err := runDeploy(jobID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		password := ""
		if req.Env != nil {
			password = req.Env["PASSWORD"]
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"success":   true,
			"sessionId": sess.ID,
			"url":       sess.URL,
			"password":  password,
			"expiresAt": expiresAt,
			"type":      req.Template,
			"jobId":     jobID,
		})
		return
	}

	go func() {
		_, _ = runDeploy(jobID)
	}()

	writeJSON(w, http.StatusAccepted, map[string]interface{}{
		"jobId":     jobID,
		"sessionId": sessionID,
		"expiresAt": expiresAt,
	})
}

func handleStopContainer(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		writeError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	var req StopRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid request body: "+err.Error())
		return
	}

	sessionsMu.RLock()
	sess, exists := sessions[req.SessionID]
	sessionsMu.RUnlock()

	if !exists {
		writeError(w, http.StatusNotFound, "Docker session not found")
		return
	}

	meta := sess.Metadata
	var stopErr error
	if sess.Type == "docker-compose" {
		stopErr = dockerComposeDown(meta.ComposeFile)
		for _, svc := range meta.Services {
			svcMeta := SessionMetadata{
				TunnelPid:    svc.TunnelPid,
				TunnelID:     svc.TunnelID,
				CustomDomain: svc.CustomDomain,
			}
			cleanupCloudflareResources(svcMeta)
		}
	} else {
		stopErr = dockerStopAndRemove(meta.ContainerName)
		cleanupCloudflareResources(meta)
	}

	if stopErr != nil && !req.Force {
		log.Printf("[Docker Go Stop] Error during resource stop: %v", stopErr)
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("Failed to stop resources: %v. Use force=true to delete session anyway.", stopErr))
		return
	}

	sessionsMu.Lock()
	delete(sessions, req.SessionID)
	sessionsMu.Unlock()
	saveSessions()

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"message": "Docker resources stopped and cleaned up.",
	})
}

func handleParseCompose(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		writeError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	var req ParseComposeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid request body: "+err.Error())
		return
	}

	normalized, err := ParseAndNormalizeCompose([]byte(req.YAML))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, normalized)
}

func parsePorts(portStr string) (int, int, error) {
	parts := strings.Split(portStr, ":")
	if len(parts) == 1 {
		var containerPort int
		_, err := fmt.Sscanf(parts[0], "%d", &containerPort)
		return 0, containerPort, err
	} else if len(parts) == 2 {
		var hostPort, containerPort int
		_, err := fmt.Sscanf(parts[0], "%d", &hostPort)
		if err != nil {
			return 0, 0, err
		}
		_, err = fmt.Sscanf(parts[1], "%d", &containerPort)
		return hostPort, containerPort, err
	} else if len(parts) == 3 {
		var hostPort, containerPort int
		_, err := fmt.Sscanf(parts[1], "%d", &hostPort)
		if err != nil {
			return 0, 0, err
		}
		_, err = fmt.Sscanf(parts[2], "%d", &containerPort)
		return hostPort, containerPort, err
	}
	return 0, 0, fmt.Errorf("invalid port format: %s", portStr)
}

func mergeEnvironment(service map[string]interface{}, overrides map[string]string) {
	env, exists := service["environment"]
	merged := make(map[string]string)

	if exists {
		switch envVal := env.(type) {
		case map[string]interface{}:
			for k, v := range envVal {
				merged[k] = fmt.Sprintf("%v", v)
			}
		case []interface{}:
			for _, item := range envVal {
				if itemStr, ok := item.(string); ok {
					parts := strings.SplitN(itemStr, "=", 2)
					if len(parts) == 2 {
						merged[parts[0]] = parts[1]
					} else if len(parts) == 1 {
						merged[parts[0]] = ""
					}
				}
			}
		case map[interface{}]interface{}:
			for k, v := range envVal {
				merged[fmt.Sprintf("%v", k)] = fmt.Sprintf("%v", v)
			}
		}
	}

	for k, v := range overrides {
		if k != "" {
			merged[k] = v
		}
	}

	service["environment"] = merged
}

func handleDeployCompose(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		writeError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	var req DeployComposeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid request body: "+err.Error())
		return
	}

	// 1. Verify Docker is running
	if err := verifyDockerRunning(); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	hash := req.SessionID
	if hash == "" {
		hash = generateHash()
	} else {
		hash = strings.TrimPrefix(hash, "compose-")
	}
	sessionID := "compose-" + hash

	// Clean up old instance first if updating
	sessionsMu.Lock()
	oldSess, exists := sessions[sessionID]
	sessionsMu.Unlock()

	// Create async Job
	jobID := createJob()

	go func() {
		defer func() {
			job, exists := getJob(jobID)
			if !exists {
				return
			}
			record := DeploymentRecord{
				ID:        generateHash(),
				SessionID: sessionID,
				Type:      "docker-compose",
				Timestamp: time.Now(),
				Logs:      job.Logs,
			}
			if job.Status == "done" {
				record.Status = "success"
				sessionsMu.RLock()
				sess, ok := sessions[sessionID]
				sessionsMu.RUnlock()
				if ok {
					record.Config = sess.Metadata
				}
			} else {
				record.Status = "failed"
				record.Error = job.Error
				record.Config = SessionMetadata{
					YAML:            req.YAML,
					ServiceSettings: req.ServiceSettings,
				}
			}
			appendDeployment(record)
		}()

		updateJobPhase(jobID, "validating", "Validating compose configuration...")
		
		if exists {
			addJobLog(jobID, "Stopping old compose stack...")
			_ = dockerComposeDown(oldSess.Metadata.ComposeFile)

			for _, svc := range oldSess.Metadata.Services {
				svcMeta := SessionMetadata{
					TunnelPid:    svc.TunnelPid,
					TunnelID:     svc.TunnelID,
					CustomDomain: svc.CustomDomain,
				}
				cleanupCloudflareResources(svcMeta)
			}
		}

		root := findWorkspaceRoot()
		stackDir := filepath.Join(root, "stacks", "compose-"+hash)
		if err := os.MkdirAll(stackDir, 0755); err != nil {
			failJob(jobID, "Failed to create stack directory: "+err.Error())
			return
		}
		composeFilePath := filepath.Join(stackDir, "docker-compose.yml")

		// Parse Compose YAML to modify env & ports dynamically
		var composeMap map[string]interface{}
		if err := yaml.Unmarshal([]byte(req.YAML), &composeMap); err != nil {
			failJob(jobID, "Failed to parse compose YAML: "+err.Error())
			return
		}

		servicesMap, ok := composeMap["services"].(map[string]interface{})
		if !ok || len(servicesMap) == 0 {
			failJob(jobID, "No services defined in compose file")
			return
		}

		servicePorts := make(map[string]int)

		for svcName, svcVal := range servicesMap {
			service, ok := svcVal.(map[string]interface{})
			if !ok {
				continue
			}

			setting := req.ServiceSettings[svcName]

			// Merge environment
			mergeEnvironment(service, setting.Env)

			// Parse/adjust ports
			ports, exists := service["ports"]
			var hostPort, containerPort int
			var foundPort = false

			if exists {
				if portList, ok := ports.([]interface{}); ok && len(portList) > 0 {
					if firstPort, ok := portList[0].(string); ok {
						h, c, err := parsePorts(firstPort)
						if err == nil {
							hostPort = h
							containerPort = c
							foundPort = true
						}
					} else if firstPortNum, ok := portList[0].(int); ok {
						hostPort = firstPortNum
						containerPort = firstPortNum
						foundPort = true
					}
				}
			}

			if setting.DomainMode == "quick" || setting.DomainMode == "custom" {
				if foundPort {
					if hostPort == 0 {
						var err error
						hostPort, err = allocatePort()
						if err != nil {
							failJob(jobID, "Failed to allocate host port: "+err.Error())
							return
						}
						service["ports"] = []interface{}{fmt.Sprintf("%d:%d", hostPort, containerPort)}
					}
				} else {
					containerPort = 80
					var err error
					hostPort, err = allocatePort()
					if err != nil {
						failJob(jobID, "Failed to allocate host port: "+err.Error())
						return
					}
					service["ports"] = []interface{}{fmt.Sprintf("%d:%d", hostPort, containerPort)}
				}
				servicePorts[svcName] = hostPort
			}
		}

		// Write modified compose back to file
		modifiedYaml, err := yaml.Marshal(composeMap)
		if err != nil {
			failJob(jobID, "Failed to marshal modified compose: "+err.Error())
			return
		}

		if err := os.WriteFile(composeFilePath, modifiedYaml, 0644); err != nil {
			failJob(jobID, "Failed to write docker-compose.yml: "+err.Error())
			return
		}

		// Starting phase
		updateJobPhase(jobID, "starting", "Starting Docker Compose services...")
		if err := dockerComposeUp(composeFilePath); err != nil {
			failJob(jobID, "Failed to start compose stack: "+err.Error())
			return
		}

		// Tunneling phase
		updateJobPhase(jobID, "tunneling", "Setting up Cloudflare tunnels for services...")
		serviceSessionMetas := make(map[string]ServiceSessionMetadata)
		var mainURL = ""

		for svcName, setting := range req.ServiceSettings {
			if setting.DomainMode == "quick" || setting.DomainMode == "custom" {
				hostPort := servicePorts[svcName]
				if hostPort <= 0 {
					continue
				}

				reuseTunnel := false
				oldToken := ""
				oldTID := ""
				if exists {
					if oldSvc, ok := oldSess.Metadata.Services[svcName]; ok {
						if oldSvc.DomainMode == setting.DomainMode && oldSvc.CustomDomain == setting.CustomDomain {
							reuseTunnel = true
							oldToken = oldSvc.TunnelToken
							oldTID = oldSvc.TunnelID
						}
					}
				}

				cleanSvcName := regexp.MustCompile(`[^a-zA-Z0-9_-]`).ReplaceAllString(svcName, "_")
				tOpts := TunnelOptions{
					ServiceName:    svcName,
					DomainMode:     setting.DomainMode,
					CustomDomain:   setting.CustomDomain,
					HostPort:       hostPort,
					SessionHash:    hash,
					CleanName:      cleanSvcName,
					ReuseTunnel:    reuseTunnel,
					OldTunnelToken: oldToken,
					OldTunnelID:    oldTID,
				}
				tRes, err := provisionTunnel(tOpts)
				if err != nil {
					addJobLog(jobID, "Failed to start tunnel for service "+svcName+": "+err.Error())
					continue
				}

				if mainURL == "" {
					mainURL = tRes.CloudflaredURL
				}

				waitForHealthyStatusWithJob(jobID, tRes.CloudflaredURL, hostPort, 45*time.Second)

				serviceSessionMetas[svcName] = ServiceSessionMetadata{
					ServiceName:    svcName,
					Port:           80,
					HostPort:       hostPort,
					DomainMode:     setting.DomainMode,
					CustomDomain:   setting.CustomDomain,
					CloudflaredURL: tRes.CloudflaredURL,
					TunnelPid:      tRes.TunnelPid,
					TunnelToken:    tRes.TunnelToken,
					TunnelID:       tRes.TunnelID,
					Status:         "running",
					TunnelStatus:   "up",
				}
			}
		}

		if mainURL == "" {
			mainURL = "http://localhost"
		}

		sess := Session{
			ID:        sessionID,
			Type:      "docker-compose",
			URL:       mainURL,
			StartedAt: time.Now(),
			Metadata: SessionMetadata{
				ComposeFile:     composeFilePath,
				Services:        serviceSessionMetas,
				Status:          "running",
				TunnelStatus:    "up",
				YAML:            req.YAML,
				ServiceSettings: req.ServiceSettings,
			},
		}

		sessionsMu.Lock()
		sessions[sessionID] = sess
		sessionsMu.Unlock()
		saveSessions()

		completeJob(jobID, sessionID)
	}()

	writeJSON(w, http.StatusAccepted, map[string]string{
		"jobId": jobID,
	})
}

// Health check endpoint
func handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		writeError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	dockerStatus := "ok"
	if err := verifyDockerRunning(); err != nil {
		dockerStatus = "fail: " + err.Error()
	}

	cloudflaredStatus := "found"
	if _, err := exec.LookPath("cloudflared"); err != nil {
		cloudflaredStatus = "missing"
	}

	cfCredsStatus := "configured"
	if getSanitizedEnv("CLOUDFLARE_ACCOUNT_ID") == "" ||
		getSanitizedEnv("CLOUDFLARE_ZONE_ID") == "" ||
		getSanitizedEnv("CLOUDFLARE_API_TOKEN") == "" {
		cfCredsStatus = "partial/none"
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"docker":      dockerStatus,
		"cloudflared": cloudflaredStatus,
		"cfCreds":     cfCredsStatus,
		"version":     "1.0.0",
		"uptime":      "up",
	})
}

func handleLogsContainer(w http.ResponseWriter, r *http.Request) {
	sID := r.URL.Query().Get("sessionId")
	service := r.URL.Query().Get("service")
	tailStr := r.URL.Query().Get("tail")
	follow := r.URL.Query().Get("follow") == "true"

	tail := "200"
	if tailStr != "" {
		tail = tailStr
	}

	sessionsMu.RLock()
	sess, exists := sessions[sID]
	sessionsMu.RUnlock()

	if !exists {
		writeError(w, http.StatusNotFound, "Session not found")
		return
	}

	var cmd *exec.Cmd
	if sess.Type == "docker-compose" {
		args := []string{"-f", sess.Metadata.ComposeFile, "logs", "--tail", tail}
		if follow {
			args = append(args, "-f")
		}
		if service != "" {
			args = append(args, service)
		}
		cmd = exec.Command("docker", append([]string{"compose"}, args...)...)
	} else {
		args := []string{"logs", "--tail", tail}
		if follow {
			args = append(args, "-f")
		}
		args = append(args, sess.Metadata.ContainerName)
		cmd = exec.Command("docker", args...)
	}

	if follow {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no")

		stdout, err := cmd.StdoutPipe()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to get stdout pipe: "+err.Error())
			return
		}
		cmd.Stderr = cmd.Stdout // Merge stderr to stdout so we see error logs too

		if err := cmd.Start(); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to start logs command: "+err.Error())
			return
		}
		defer cmd.Process.Kill()

		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "Streaming unsupported", http.StatusInternalServerError)
			return
		}

		done := make(chan struct{})
		go func() {
			scanner := bufio.NewScanner(stdout)
			for scanner.Scan() {
				line := scanner.Text()
				// Write SSE data
				_, err := fmt.Fprintf(w, "data: %s\n\n", line)
				if err != nil {
					return
				}
				flusher.Flush()
			}
			close(done)
		}()

		select {
		case <-r.Context().Done():
			// Client disconnected
		case <-done:
			// Stream finished
		}
		return
	}

	// Non-follow (static logs return JSON)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("Failed to run logs command: %v (stderr: %s)", err, stderr.String()))
		return
	}

	lines := strings.Split(stdout.String(), "\n")
	// Remove trailing empty line
	if len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"lines": lines,
	})
}

func handleStatsContainer(w http.ResponseWriter, r *http.Request) {
	sID := r.URL.Query().Get("sessionId")
	sessionsMu.RLock()
	sess, exists := sessions[sID]
	sessionsMu.RUnlock()

	if !exists {
		writeError(w, http.StatusNotFound, "Session not found")
		return
	}

	var targets []string
	if sess.Type == "docker-compose" {
		project := strings.TrimPrefix(sID, "compose-")
		for name := range sess.Metadata.Services {
			targets = append(targets, fmt.Sprintf("compose-%s-%s-1", project, name))
		}
	} else {
		targets = append(targets, sess.Metadata.ContainerName)
	}

	if len(targets) == 0 {
		writeJSON(w, http.StatusOK, []interface{}{})
		return
	}

	args := append([]string{"stats", "--no-stream", "--format", "json"}, targets...)
	cmd := exec.Command("docker", args...)
	out, err := cmd.Output()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to get docker stats: "+err.Error())
		return
	}

	var statsList []map[string]interface{}
	scanner := bufio.NewScanner(bytes.NewReader(out))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var stat map[string]interface{}
		if err := json.Unmarshal([]byte(line), &stat); err == nil {
			statsList = append(statsList, stat)
		}
	}

	writeJSON(w, http.StatusOK, statsList)
}

type DemoStartRequest struct {
	Type         string            `json:"type"` // "vscode" | "terminal" | "browser" | "custom"
	Image        string            `json:"image,omitempty"`
	Port         int               `json:"port,omitempty"`
	Env          map[string]string `json:"env,omitempty"`
	TTLMinutes   int               `json:"ttlMinutes,omitempty"`
	CustomDomain string            `json:"customDomain,omitempty"`
	Command      []string          `json:"command,omitempty"`
	Sync         *bool             `json:"sync,omitempty"`
}

func handleStartDemo(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		writeError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	var req DemoStartRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid request body: "+err.Error())
		return
	}

	ttl := req.TTLMinutes
	if ttl <= 0 || ttl > 30 {
		ttl = 5 // enforce 5 minutes default
	}

	targetType := strings.ToLower(strings.TrimSpace(req.Type))
	if targetType == "" {
		targetType = "terminal"
	}

	isSync := true
	if req.Sync != nil {
		isSync = *req.Sync
	}

	startReq := StartRequest{
		DomainMode:   "custom",
		CustomDomain: req.CustomDomain,
		Command:      req.Command,
		IsDemo:       true,
		TTLMinutes:   ttl,
		Env:          req.Env,
		Sync:         isSync,
	}

	switch targetType {
	case "vscode":
		startReq.Template = "vscode"
		startReq.Name = "demo-vscode"
	case "terminal":
		startReq.Template = "terminal"
		startReq.Name = "demo-term"
	case "browser":
		startReq.Template = "browser"
		startReq.Name = "demo-browser"
	case "custom":
		startReq.Image = req.Image
		startReq.Port = req.Port
		startReq.Name = "demo-custom"
		if startReq.Image == "" {
			writeError(w, http.StatusBadRequest, "Image is required for custom demo container")
			return
		}
		if startReq.Port <= 0 {
			writeError(w, http.StatusBadRequest, "Port is required for custom demo container")
			return
		}
	default:
		writeError(w, http.StatusBadRequest, "Unknown demo type: "+targetType+". Supported: vscode, terminal, browser, custom")
		return
	}

	// Re-encode and pass to handleStartContainer
	bodyBytes, _ := json.Marshal(startReq)
	r.Body = io.NopCloser(bytes.NewBuffer(bodyBytes))
	handleStartContainer(w, r)
}
