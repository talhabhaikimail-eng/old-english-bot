package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
)

type DeploymentRecord struct {
	ID        string          `json:"id"`
	SessionID string          `json:"sessionId"`
	Type      string          `json:"type"` // "docker-container" or "docker-compose"
	Timestamp time.Time       `json:"timestamp"`
	Status    string          `json:"status"` // "success" or "failed"
	Logs      []string        `json:"logs,omitempty"`
	Error     string          `json:"error,omitempty"`
	Config    SessionMetadata `json:"config"`
}

var deploymentsMu sync.RWMutex

func getDeploymentsFilePath() string {
	root := findWorkspaceRoot()
	return filepath.Join(root, "auth_info", "go_deployments.json")
}

func loadDeployments() ([]DeploymentRecord, error) {
	deploymentsMu.RLock()
	defer deploymentsMu.RUnlock()

	filePath := getDeploymentsFilePath()
	if _, err := os.Stat(filePath); os.IsNotExist(err) {
		return []DeploymentRecord{}, nil
	}

	data, err := os.ReadFile(filePath)
	if err != nil {
		return nil, err
	}

	var records []DeploymentRecord
	if err := json.Unmarshal(data, &records); err != nil {
		return nil, err
	}

	return records, nil
}

func saveDeployments(records []DeploymentRecord) error {
	deploymentsMu.Lock()
	defer deploymentsMu.Unlock()

	filePath := getDeploymentsFilePath()
	dir := filepath.Dir(filePath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}

	data, err := json.MarshalIndent(records, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(filePath, data, 0644)
}

func appendDeployment(record DeploymentRecord) {
	records, err := loadDeployments()
	if err != nil {
		log.Printf("[Deployment History] Failed to load deployments for append: %v", err)
		records = []DeploymentRecord{}
	}

	// Add record at the beginning (newest first)
	records = append([]DeploymentRecord{record}, records...)

	// Limit history size to 100
	if len(records) > 100 {
		records = records[:100]
	}

	if err := saveDeployments(records); err != nil {
		log.Printf("[Deployment History] Failed to save deployment history: %v", err)
	}

	// Trigger R2 sync
	saveSessions()
}

func getJobLogsCopy(id string) []string {
	if job, exists := getJob(id); exists {
		return job.Logs
	}
	return nil
}

func handleGetDeployments(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		writeError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	records, err := loadDeployments()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to load deployment history: "+err.Error())
		return
	}

	writeJSON(w, http.StatusOK, records)
}

type RollbackRequest struct {
	DeploymentID string `json:"deploymentId"`
}

func handleRollback(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		writeError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	var req RollbackRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if req.DeploymentID == "" {
		writeError(w, http.StatusBadRequest, "Missing deploymentId")
		return
	}

	records, err := loadDeployments()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to load deployment history: "+err.Error())
		return
	}

	var targetRecord *DeploymentRecord
	for _, rec := range records {
		if rec.ID == req.DeploymentID {
			targetRecord = &rec
			break
		}
	}

	if targetRecord == nil {
		writeError(w, http.StatusNotFound, "Deployment record not found")
		return
	}

	// Verify Docker is running
	if err := verifyDockerRunning(); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	// Create async Job
	jobID := createJob()

	go func() {
		if targetRecord.Type == "docker-container" {
			rollbackContainerJob(jobID, *targetRecord)
		} else if targetRecord.Type == "docker-compose" {
			rollbackComposeJob(jobID, *targetRecord)
		} else {
			failJob(jobID, "Unsupported deployment type: "+targetRecord.Type)
		}
	}()

	writeJSON(w, http.StatusAccepted, map[string]string{
		"jobId": jobID,
	})
}

func rollbackContainerJob(jobID string, record DeploymentRecord) {
	updateJobPhase(jobID, "validating", "Validating container configuration...")

	sessionID := record.SessionID
	hash := strings.TrimPrefix(sessionID, "docker-")

	sessionsMu.Lock()
	oldSess, exists := sessions[sessionID]
	sessionsMu.Unlock()

	// Use values from config
	image := record.Config.Image
	port := record.Config.Port
	hostPort := record.Config.HostPort
	env := record.Config.Env
	ports := record.Config.Ports
	volumes := record.Config.Volumes
	memoryLimitMB := record.Config.MemoryLimitMB
	cpus := record.Config.Cpus
	restartPolicy := record.Config.RestartPolicy
	command := record.Config.Command
	args := record.Config.Args
	domainMode := record.Config.DomainMode
	customDomain := record.Config.CustomDomain

	if !exists && isPortConflict(hostPort) {
		var err error
		hostPort, err = allocatePort()
		if err != nil {
			failJob(jobID, "Failed to allocate host port: "+err.Error())
			return
		}
	}

	updateJobPhase(jobID, "pulling", "Checking and downloading Docker image...")

	webhookSecret := generateHash()
	var activeTunnelToken = record.Config.TunnelToken
	var activeTunnelID = record.Config.TunnelID
	var reuseTunnel = false

	if exists {
		webhookSecret = oldSess.Metadata.WebhookSecret
		targetURL := customDomain
		if targetURL != "" && !strings.HasPrefix(targetURL, "http") {
			targetURL = "https://" + targetURL
		}
		oldTargetURL := oldSess.Metadata.CustomDomain
		if oldTargetURL != "" && !strings.HasPrefix(oldTargetURL, "http") {
			oldTargetURL = "https://" + oldTargetURL
		}

		if domainMode == "custom" &&
			oldSess.Metadata.DomainMode == "custom" &&
			oldSess.Metadata.TunnelToken != "" &&
			targetURL != "" &&
			targetURL == oldTargetURL {
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

		addJobLog(jobID, "Removing old container instance...")
		if !reuseTunnel {
			cleanupCloudflareResources(oldSess.Metadata)
		}
		_ = dockerStopAndRemove(oldSess.Metadata.ContainerName)
	}

	// Starting phase
	updateJobPhase(jobID, "starting", "Starting container instance...")
	containerName := record.Config.ContainerName
	if containerName == "" {
		containerName = fmt.Sprintf("docker-custom-rollback-%s", hash)
	}

	runOpts := RunOptions{
		Image:         image,
		ContainerName: containerName,
		Port:          port,
		HostPort:      hostPort,
		Env:           env,
		Ports:         ports,
		Volumes:       volumes,
		MemoryLimitMB: memoryLimitMB,
		Cpus:          cpus,
		RestartPolicy: restartPolicy,
		Command:       command,
		Args:          args,
	}

	if err := dockerRunWithJob(runOpts, jobID); err != nil {
		failJob(jobID, err.Error())
		// Record failed deployment
		record.ID = generateHash()
		record.Timestamp = time.Now()
		record.Status = "failed"
		record.Error = err.Error()
		record.Logs = getJobLogsCopy(jobID)
		appendDeployment(record)
		return
	}

	var tunnelPid int
	var targetURL = ""

	if domainMode == "custom" || domainMode == "quick" {
		updateJobPhase(jobID, "tunneling", "Provisioning Cloudflare tunnel connection...")
		tOpts := TunnelOptions{
			ServiceName:    "custom-container",
			DomainMode:     domainMode,
			CustomDomain:   customDomain,
			HostPort:       hostPort,
			SessionHash:    hash,
			CleanName:      "rollback",
			ReuseTunnel:    reuseTunnel,
			OldTunnelToken: activeTunnelToken,
			OldTunnelID:    activeTunnelID,
		}
		tRes, err := provisionTunnel(tOpts)
		if err != nil {
			_ = dockerStopAndRemove(containerName)
			failJob(jobID, "Failed to provision Cloudflare tunnel: "+err.Error())
			// Record failed deployment
			record.ID = generateHash()
			record.Timestamp = time.Now()
			record.Status = "failed"
			record.Error = err.Error()
			record.Logs = getJobLogsCopy(jobID)
			appendDeployment(record)
			return
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
			Port:           port,
			HostPort:       hostPort,
			ContainerName:  containerName,
			Image:          image,
			Env:            env,
			DomainMode:     domainMode,
			CustomDomain:   customDomain,
			CloudflaredURL: targetURL,
			TunnelPid:      tunnelPid,
			TunnelToken:    activeTunnelToken,
			TunnelID:       activeTunnelID,
			WebhookSecret:  webhookSecret,
			Ports:          ports,
			Volumes:        volumes,
			MemoryLimitMB:  memoryLimitMB,
			Cpus:           cpus,
			RestartPolicy:  restartPolicy,
			Command:        command,
			Args:           args,
			Status:         "running",
			TunnelStatus:   "up",
		},
	}

	sessionsMu.Lock()
	sessions[sessionID] = sess
	sessionsMu.Unlock()
	saveSessions()

	completeJob(jobID, containerName)

	// Record success deployment
	record.ID = generateHash()
	record.Timestamp = time.Now()
	record.Status = "success"
	record.Logs = getJobLogsCopy(jobID)
	record.Config = sess.Metadata
	appendDeployment(record)
}

func rollbackComposeJob(jobID string, record DeploymentRecord) {
	updateJobPhase(jobID, "validating", "Validating compose configuration...")

	sessionID := record.SessionID
	hash := strings.TrimPrefix(sessionID, "compose-")

	sessionsMu.Lock()
	oldSess, exists := sessions[sessionID]
	sessionsMu.Unlock()

	yamlContent := record.Config.YAML
	serviceSettings := record.Config.ServiceSettings

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
	_ = os.MkdirAll(stackDir, 0755)
	composeFilePath := filepath.Join(stackDir, "docker-compose.yml")

	// Parse Compose YAML to modify env & ports dynamically
	var composeMap map[string]interface{}
	if err := yaml.Unmarshal([]byte(yamlContent), &composeMap); err != nil {
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

		setting := serviceSettings[svcName]

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
		// Record failed deployment
		record.ID = generateHash()
		record.Timestamp = time.Now()
		record.Status = "failed"
		record.Error = err.Error()
		record.Logs = getJobLogsCopy(jobID)
		appendDeployment(record)
		return
	}

	// Tunneling phase
	updateJobPhase(jobID, "tunneling", "Setting up Cloudflare tunnels for services...")
	serviceSessionMetas := make(map[string]ServiceSessionMetadata)
	var mainURL = ""

	for svcName, setting := range serviceSettings {
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
			YAML:            yamlContent,
			ServiceSettings: serviceSettings,
		},
	}

	sessionsMu.Lock()
	sessions[sessionID] = sess
	sessionsMu.Unlock()
	saveSessions()

	completeJob(jobID, sessionID)

	// Record success deployment
	record.ID = generateHash()
	record.Timestamp = time.Now()
	record.Status = "success"
	record.Logs = getJobLogsCopy(jobID)
	record.Config = sess.Metadata
	appendDeployment(record)
}
