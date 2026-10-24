package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
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

	// Rollbacks read the stored records, so the response can hide compose env overrides.
	for i := range records {
		records[i].Config.ServiceSettings = maskServiceSettings(records[i].Config.ServiceSettings)
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

	// Create async Job (one deploy per session at a time)
	jobID := createJob()
	if active, ok := beginOp(targetRecord.SessionID, jobID); !ok {
		failJob(jobID, "superseded by running job "+active)
		writeJSON(w, http.StatusConflict, map[string]string{
			"error": "A deployment is already running for this session",
			"jobId": active,
		})
		return
	}

	go func() {
		defer endOp(targetRecord.SessionID)
		if targetRecord.Type == "docker-container" {
			rollbackContainerJob(jobID, *targetRecord)
		} else if targetRecord.Type == "docker-compose" {
			_ = runComposeDeploy(composeDeploy{
				JobID:     jobID,
				SessionID: targetRecord.SessionID,
				YAML:      targetRecord.Config.YAML,
				Settings:  targetRecord.Config.ServiceSettings,
			})
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
	registryAuth := record.Config.RegistryAuth
	if registryAuth == nil && exists {
		registryAuth = oldSess.Metadata.RegistryAuth
	}

	if !exists && isPortConflict(hostPort) {
		var err error
		hostPort, err = allocatePort()
		if err != nil {
			failJob(jobID, "Failed to allocate host port: "+err.Error())
			return
		}
	}

	updateJobPhase(jobID, "pulling", "Checking and downloading Docker image...")

	webhookSecret := generateToken("")
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
		RegistryAuth:  registryAuth,
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
			RegistryAuth:   registryAuth,
			Status:         "running",
			TunnelStatus:   "up",
		},
	}
	var oldPtr *Session
	if exists {
		oldPtr = &oldSess
		sess.Metadata.TTLMinutes = oldSess.Metadata.TTLMinutes
		sess.Metadata.ExpiresAt = oldSess.Metadata.ExpiresAt
		sess.Metadata.IsDemo = oldSess.Metadata.IsDemo
	}
	finalizeSession(&sess, oldPtr)

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
