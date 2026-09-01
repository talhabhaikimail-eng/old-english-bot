package main

import (
	"bufio"
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"
)

func main() {
	log.Println("[Go Container Manager] Starting server...")

	// 1. Locate workspace root and load .env
	root := findWorkspaceRoot()
	loadEnv(filepath.Join(root, ".env"))

	sessionsFile = filepath.Join(root, "auth_info", "go_sessions.json")
	log.Printf("[Go Container Manager] Workspace Root: %s", root)
	log.Printf("[Go Container Manager] Sessions File: %s", sessionsFile)

	// 2. Load existing sessions from disk
	if err := loadSessions(); err != nil {
		log.Printf("[Go Container Manager] Warning: failed to load sessions: %v", err)
	} else {
		updateNextPort()
	}

	// 3. Restore any running containers/tunnels
	go restoreDockerContainers()

	// 4. Start background reconciler
	go startReconciler()

	// 5. Setup HTTP routes with CORS middleware
	http.HandleFunc("/api/go/containers/sessions", corsMiddleware(handleGetSessions))
	http.HandleFunc("/api/go/containers/start", corsMiddleware(handleStartContainer))
	http.HandleFunc("/api/go/containers/demo/start", corsMiddleware(handleStartDemo))
	http.HandleFunc("/api/go/containers/stop", corsMiddleware(handleStopContainer))
	http.HandleFunc("/api/go/containers/compose/parse", corsMiddleware(handleParseCompose))
	http.HandleFunc("/api/go/containers/compose/deploy", corsMiddleware(handleDeployCompose))
	http.HandleFunc("/api/go/containers/jobs", corsMiddleware(handleGetJobStatus))
	http.HandleFunc("/api/go/containers/health", corsMiddleware(handleHealth))
	http.HandleFunc("/api/go/containers/inspect", corsMiddleware(handleInspectContainer))
	http.HandleFunc("/api/go/containers/logs", corsMiddleware(handleLogsContainer))
	http.HandleFunc("/api/go/containers/stats", corsMiddleware(handleStatsContainer))
	http.HandleFunc("/api/go/containers/deployments", corsMiddleware(handleGetDeployments))
	http.HandleFunc("/api/go/containers/rollback", corsMiddleware(handleRollback))
	
	// Volume backup/restore routes (Phase 5)
	http.HandleFunc("/api/go/volumes/backup", corsMiddleware(handleBackupVolume))
	http.HandleFunc("/api/go/volumes/restore", corsMiddleware(handleRestoreVolume))
	http.HandleFunc("/api/go/volumes/backups", corsMiddleware(handleListBackups))

	// Start server in a goroutine
	srv := &http.Server{
		Addr: "127.0.0.1:18080",
	}

	go func() {
		log.Println("[Go Container Manager] Listening on port 18080...")
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server failed: %v", err)
		}
	}()

	// Graceful shutdown channel
	stopChan := make(chan os.Signal, 1)
	signal.Notify(stopChan, os.Interrupt, syscall.SIGTERM)

	<-stopChan
	log.Println("[Go Container Manager] Shutting down gracefully...")

	// Context with timeout for shutdown
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		log.Printf("[Go Container Manager] Server forced to shutdown: %v", err)
	}

	// Kill all active cloudflared processes spawned by this session
	sessionsMu.Lock()
	for _, s := range sessions {
		if s.Metadata.TunnelPid > 0 {
			log.Printf("[Go Container Manager] Stopping cloudflared process PID %d", s.Metadata.TunnelPid)
			if proc, err := os.FindProcess(s.Metadata.TunnelPid); err == nil {
				_ = proc.Kill()
			}
		}
		for _, svc := range s.Metadata.Services {
			if svc.TunnelPid > 0 {
				log.Printf("[Go Container Manager] Stopping cloudflared process PID %d", svc.TunnelPid)
				if proc, err := os.FindProcess(svc.TunnelPid); err == nil {
					_ = proc.Kill()
				}
			}
		}
	}
	sessionsMu.Unlock()

	log.Println("[Go Container Manager] Daemon stopped.")
}

// Locate workspace root by looking for package.json
func findWorkspaceRoot() string {
	dir, err := os.Getwd()
	if err != nil {
		return "."
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "package.json")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return "."
}

// Load env variables from a .env file
func loadEnv(path string) {
	file, err := os.Open(path)
	if err != nil {
		return
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		line = strings.TrimPrefix(line, "\uFEFF") // strip UTF-8 BOM if present
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "export ") {
			line = strings.TrimSpace(strings.TrimPrefix(line, "export "))
		}
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}
		key := strings.TrimSpace(parts[0])
		val := sanitizeEnvValue(parts[1])
		if key != "" {
			os.Setenv(key, val)
		}
	}
}

// RESTORE containers and tunnels upon reboot
func restoreDockerContainers() {
	log.Println("[Docker Restore] Restoring running containers...")
	sessionsMu.RLock()
	var toRestore []Session
	for _, s := range sessions {
		if s.Type == "docker-container" || s.Type == "docker-compose" {
			toRestore = append(toRestore, s)
		}
	}
	sessionsMu.RUnlock()

	for _, s := range toRestore {
		go func(sess Session) {
			meta := sess.Metadata
			if sess.Type == "docker-compose" {
				log.Printf("[Docker Restore] Restoring compose stack %s...", sess.ID)
				if err := dockerComposeUp(meta.ComposeFile); err != nil {
					log.Printf("[Docker Restore] Failed to restore compose stack %s: %v", sess.ID, err)
				}

				updatedServices := make(map[string]ServiceSessionMetadata)
				for name, svc := range meta.Services {
					if svc.DomainMode == "custom" || svc.DomainMode == "quick" {
						cleanSvcName := regexp.MustCompile(`[^a-zA-Z0-9_-]`).ReplaceAllString(name, "_")
						tOpts := TunnelOptions{
							ServiceName:    name,
							DomainMode:     svc.DomainMode,
							CustomDomain:   svc.CustomDomain,
							HostPort:       svc.HostPort,
							SessionHash:    strings.TrimPrefix(sess.ID, "compose-"),
							CleanName:      cleanSvcName,
							ReuseTunnel:    true,
							OldTunnelToken: svc.TunnelToken,
							OldTunnelID:    svc.TunnelID,
						}
						tRes, err := provisionTunnel(tOpts)
						if err != nil {
							log.Printf("[Docker Restore] Failed to restore tunnel for service %s: %v", name, err)
						} else {
							svc.TunnelPid = tRes.TunnelPid
							svc.CloudflaredURL = tRes.CloudflaredURL
							svc.TunnelToken = tRes.TunnelToken
							svc.TunnelID = tRes.TunnelID
						}
					}
					updatedServices[name] = svc
				}

				sessionsMu.Lock()
				if s, ok := sessions[sess.ID]; ok {
					s.Metadata.Services = updatedServices
					sessions[sess.ID] = s
				}
				sessionsMu.Unlock()
				saveSessions()
				return
			}

			// Single container
			// Check if container is running
			cmd := exec.Command("docker", "ps", "--filter", "name="+meta.ContainerName, "--format", "{{.Names}}")
			out, _ := cmd.Output()
			isRunning := strings.TrimSpace(string(out)) == meta.ContainerName

			if !isRunning {
				log.Printf("[Docker Restore] Starting container %s...", meta.ContainerName)
				runOpts := RunOptions{
					Image:         meta.Image,
					ContainerName: meta.ContainerName,
					Port:          meta.Port,
					HostPort:      meta.HostPort,
					Env:           meta.Env,
				}
				if err := dockerRun(runOpts); err != nil {
					log.Printf("[Docker Restore] Failed to run container %s: %v", meta.ContainerName, err)
				}
			}

			// Restore Tunnel
			if meta.DomainMode == "custom" || meta.DomainMode == "quick" {
				cleanName := regexp.MustCompile(`[^a-zA-Z0-9_-]`).ReplaceAllString(meta.ContainerName, "_")
				tOpts := TunnelOptions{
					ServiceName:    "custom-container",
					DomainMode:     meta.DomainMode,
					CustomDomain:   meta.CustomDomain,
					HostPort:       meta.HostPort,
					SessionHash:    strings.TrimPrefix(sess.ID, "docker-"),
					CleanName:      cleanName,
					ReuseTunnel:    true,
					OldTunnelToken: meta.TunnelToken,
					OldTunnelID:    meta.TunnelID,
				}
				tRes, err := provisionTunnel(tOpts)
				if err != nil {
					log.Printf("[Docker Restore] Failed to restore tunnel for container %s: %v", meta.ContainerName, err)
				} else {
					sess.Metadata.TunnelPid = tRes.TunnelPid
					sess.URL = tRes.CloudflaredURL
					sess.Metadata.CloudflaredURL = tRes.CloudflaredURL
					sess.Metadata.TunnelToken = tRes.TunnelToken
					sess.Metadata.TunnelID = tRes.TunnelID
					
					sessionsMu.Lock()
					sessions[sess.ID] = sess
					sessionsMu.Unlock()
					saveSessions()
				}
			}
		}(s)
	}
}
