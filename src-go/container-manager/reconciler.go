package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
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
	log.Println("[Reconciler] Starting background status and TTL reconciler...")
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()

	// Initial run
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

func reconcileState() {
	sessionsMu.Lock()
	defer sessionsMu.Unlock()

	var stateChanged = false

	for sID, s := range sessions {
		// 0. Check TTL Expiration (Auto-teardown for demo sessions)
		if s.Metadata.ExpiresAt != nil && time.Now().After(*s.Metadata.ExpiresAt) {
			log.Printf("[Reconciler TTL] Session %s has expired (TTL reached at %s). Terminating and releasing resources...", s.ID, s.Metadata.ExpiresAt.Format(time.RFC3339))
			if s.Type == "docker-compose" {
				_ = dockerComposeDown(s.Metadata.ComposeFile)
				for _, svc := range s.Metadata.Services {
					svcMeta := SessionMetadata{
						TunnelPid:    svc.TunnelPid,
						TunnelID:     svc.TunnelID,
						CustomDomain: svc.CustomDomain,
					}
					cleanupCloudflareResources(svcMeta)
				}
			} else {
				_ = dockerStopAndRemove(s.Metadata.ContainerName)
				cleanupCloudflareResources(s.Metadata)
			}
			delete(sessions, sID)
			stateChanged = true
			continue
		}

		if s.Type == "docker-container" {
			// 1. Reconcile Container State
			cmd := exec.Command("docker", "inspect", "--format", "{{.State.Status}} {{.State.ExitCode}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}", s.Metadata.ContainerName)
			out, err := cmd.Output()
			
			var newStatus = "missing"
			var newExitCode = 0
			var newHealth = ""

			if err == nil {
				parts := strings.Fields(strings.TrimSpace(string(out)))
				if len(parts) >= 2 {
					newStatus = parts[0]
					fmt.Sscanf(parts[1], "%d", &newExitCode)
				}
				if len(parts) >= 3 && parts[2] != "none" {
					newHealth = parts[2]
				}
			}

			if s.Metadata.Status != newStatus || s.Metadata.ExitCode != newExitCode || s.Metadata.Health != newHealth {
				s.Metadata.Status = newStatus
				s.Metadata.ExitCode = newExitCode
				s.Metadata.Health = newHealth
				stateChanged = true
			}

			// 2. Watchdog Tunnel State
			if s.Metadata.DomainMode == "custom" || s.Metadata.DomainMode == "quick" {
				if !isProcessRunning(s.Metadata.TunnelPid) {
					log.Printf("[Reconciler Watchdog] Tunnel process for %s (PID %d) is dead. Restarting...", s.ID, s.Metadata.TunnelPid)
					s.Metadata.TunnelStatus = "restarting"
					stateChanged = true

					// Restart tunnel
					cleanName := regexp.MustCompile(`[^a-zA-Z0-9_-]`).ReplaceAllString(s.Metadata.ContainerName, "_")
					tOpts := TunnelOptions{
						ServiceName:    "custom-container",
						DomainMode:     s.Metadata.DomainMode,
						CustomDomain:   s.Metadata.CustomDomain,
						HostPort:       s.Metadata.HostPort,
						SessionHash:    strings.TrimPrefix(s.ID, "docker-"),
						CleanName:      cleanName,
						ReuseTunnel:    true,
						OldTunnelToken: s.Metadata.TunnelToken,
						OldTunnelID:    s.Metadata.TunnelID,
					}
					tRes, err := provisionTunnel(tOpts)
					if err != nil {
						log.Printf("[Reconciler Watchdog] Failed to restart tunnel for %s: %v", s.ID, err)
						s.Metadata.TunnelStatus = "down"
					} else {
						s.Metadata.TunnelPid = tRes.TunnelPid
						s.URL = tRes.CloudflaredURL
						s.Metadata.CloudflaredURL = tRes.CloudflaredURL
						s.Metadata.TunnelStatus = "up"
					}
					stateChanged = true
				} else {
					if s.Metadata.TunnelStatus != "up" {
						s.Metadata.TunnelStatus = "up"
						stateChanged = true
					}
				}
			}
			sessions[sID] = s

		} else if s.Type == "docker-compose" {
			// 1. Reconcile Compose State
			cmd := exec.Command("docker", "compose", "-f", s.Metadata.ComposeFile, "ps", "--format", "json")
			out, err := cmd.Output()
			if err != nil {
				// Try fallback docker-compose
				cmd2 := exec.Command("docker-compose", "-f", s.Metadata.ComposeFile, "ps", "--format", "json")
				out, err = cmd2.Output()
			}

			if err == nil {
				var psServices []ComposePsService
				outputStr := strings.TrimSpace(string(out))
				
				if strings.HasPrefix(outputStr, "[") {
					_ = json.Unmarshal(out, &psServices)
				} else {
					// Line separated JSON
					lines := strings.Split(outputStr, "\n")
					for _, line := range lines {
						if line = strings.TrimSpace(line); line != "" {
							var svc ComposePsService
							if err := json.Unmarshal([]byte(line), &svc); err == nil {
								psServices = append(psServices, svc)
							}
						}
					}
				}

				// Map state by ServiceName
				svcStates := make(map[string]ComposePsService)
				for _, psSvc := range psServices {
					svcStates[psSvc.Service] = psSvc
				}

				// Update stack services status
				for name, svcMeta := range s.Metadata.Services {
					psSvc, found := svcStates[name]
					
					var nextStatus = "missing"
					var nextExitCode = 0
					var nextHealth = ""

					if found {
						nextStatus = psSvc.State
						nextExitCode = psSvc.ExitCode
						nextHealth = psSvc.Health
					}

					if svcMeta.Status != nextStatus || svcMeta.ExitCode != nextExitCode || svcMeta.Health != nextHealth {
						svcMeta.Status = nextStatus
						svcMeta.ExitCode = nextExitCode
						svcMeta.Health = nextHealth
						s.Metadata.Services[name] = svcMeta
						stateChanged = true
					}

					// 2. Watchdog Service Tunnel State
					if svcMeta.DomainMode == "custom" || svcMeta.DomainMode == "quick" {
						if !isProcessRunning(svcMeta.TunnelPid) {
							log.Printf("[Reconciler Watchdog] Tunnel for compose service %s/%s (PID %d) is dead. Restarting...", s.ID, name, svcMeta.TunnelPid)
							svcMeta.TunnelStatus = "restarting"
							s.Metadata.Services[name] = svcMeta
							stateChanged = true

							cleanSvcName := regexp.MustCompile(`[^a-zA-Z0-9_-]`).ReplaceAllString(name, "_")
							tOpts := TunnelOptions{
								ServiceName:    name,
								DomainMode:     svcMeta.DomainMode,
								CustomDomain:   svcMeta.CustomDomain,
								HostPort:       svcMeta.HostPort,
								SessionHash:    strings.TrimPrefix(s.ID, "compose-"),
								CleanName:      cleanSvcName,
								ReuseTunnel:    true,
								OldTunnelToken: svcMeta.TunnelToken,
								OldTunnelID:    svcMeta.TunnelID,
							}
							tRes, err := provisionTunnel(tOpts)
							if err != nil {
								log.Printf("[Reconciler Watchdog] Failed to restart tunnel for compose service %s/%s: %v", s.ID, name, err)
								svcMeta.TunnelStatus = "down"
							} else {
								svcMeta.TunnelPid = tRes.TunnelPid
								svcMeta.CloudflaredURL = tRes.CloudflaredURL
								svcMeta.TunnelStatus = "up"
								if s.URL == "" || s.URL == "http://localhost" {
									s.URL = tRes.CloudflaredURL
								}
							}
							s.Metadata.Services[name] = svcMeta
							stateChanged = true
						} else {
							if svcMeta.TunnelStatus != "up" {
								svcMeta.TunnelStatus = "up"
								s.Metadata.Services[name] = svcMeta
								stateChanged = true
							}
						}
					}
				}
			} else {
				// Mark all stack services as missing on compose ps failure
				for name, svcMeta := range s.Metadata.Services {
					if svcMeta.Status != "missing" {
						svcMeta.Status = "missing"
						svcMeta.ExitCode = 0
						svcMeta.Health = ""
						s.Metadata.Services[name] = svcMeta
						stateChanged = true
					}
				}
			}
			sessions[sID] = s
		}
	}

	if stateChanged {
		log.Println("[Reconciler] State changes detected, saving sessions...")
		// Save sessions without locking again to prevent deadlocks
		sessList := make([]Session, 0, len(sessions))
		for _, s := range sessions {
			sessList = append(sessList, s)
		}
		
		dir := filepath.Dir(sessionsFile)
		_ = os.MkdirAll(dir, 0755)
		data, err := json.MarshalIndent(sessList, "", "  ")
		if err == nil {
			_ = os.WriteFile(sessionsFile, data, 0644)
		}
		
		go func() {
			if err := saveStateToR2(); err != nil {
				log.Printf("❌ Failed to sync state to R2: %v", err)
			}
		}()
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
			// Find first service
			for name := range sess.Metadata.Services {
				serviceName = name
				break
			}
		}
		if serviceName == "" {
			writeError(w, http.StatusBadRequest, "No services in compose stack")
			return
		}
		
		// In compose, container name is usually <project>-<service>-1
		project := strings.TrimPrefix(sID, "compose-")
		inspectTarget = fmt.Sprintf("compose-%s-%s-1", project, serviceName)
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
