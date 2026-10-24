package main

import (
	"bufio"
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
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

	// 2. Load persisted state (restored from R2 by the workflow before we start)
	loadSettings()
	loadEvents()
	if err := loadSessions(); err != nil {
		log.Printf("[Go Container Manager] Warning: failed to load sessions: %v", err)
	} else {
		updateNextPort()
	}
	resetStalePIDs()
	backfillComposeServices()

	// 3. Background workers: debounced R2 state sync + periodic volume backups
	go startR2SyncWorker()
	go startAutoBackupWorker()

	// 4. Schedule restore of every session that should be running (registers jobs synchronously so the
	//    reconciler below does not fight them), then start the reconciler.
	restoreDockerContainers()
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
	http.HandleFunc("/api/go/containers/action", corsMiddleware(handleContainerAction))
	http.HandleFunc("/api/go/containers/events", corsMiddleware(handleGetEvents))
	http.HandleFunc("/api/go/containers/exec", corsMiddleware(handleExec))
	http.HandleFunc("/api/go/containers/rotate-tokens", corsMiddleware(handleRotateTokens))
	http.HandleFunc("/api/go/settings", corsMiddleware(handleSettings))
	http.HandleFunc("/api/go/settings/test", corsMiddleware(handleTestNotification))
	http.HandleFunc("/api/go/system/info", corsMiddleware(handleSystemInfo))
	http.HandleFunc("/api/go/system/prune", corsMiddleware(handlePrune))
	http.HandleFunc("/api/go/browser/start", corsMiddleware(handleRBIStart))
	http.HandleFunc("/api/go/browser/sessions", corsMiddleware(handleRBIList))
	http.HandleFunc("/api/go/browser/extend", corsMiddleware(handleRBIExtend))
	http.HandleFunc("/api/go/volumes", corsMiddleware(handleListVolumes))
	http.HandleFunc("/api/go/volumes/delete", corsMiddleware(handleDeleteVolume))
	http.HandleFunc("/api/go/volumes/backup-all", corsMiddleware(handleBackupAll))

	// Public, secret-protected entry points (the Node proxy exposes these without dashboard auth)
	http.HandleFunc("/api/go/webhook/", handleWebhook)
	http.HandleFunc("/api/agent/", handleAgent)
	
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

	// Final flush so the next host starts from the freshest state
	if err := flushR2Sync(); err != nil {
		log.Printf("[Go Container Manager] Final state sync failed: %v", err)
	}
	if getSettings().AutoBackupEnabled {
		done := make(chan struct{})
		go func() { _, _ = backupAllVolumes(); close(done) }()
		select {
		case <-done:
		case <-time.After(90 * time.Second):
			log.Println("[Go Container Manager] Volume backup on shutdown timed out")
		}
	}

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

// RESTORE containers and tunnels upon reboot.
// The host is ephemeral (restarted every ~5h), so containers are usually gone: state comes back from R2
// (auth_info + volume tarballs) and every session that should be running is redeployed from its stored config.
func restoreDockerContainers() {
	sessionsMu.RLock()
	var toRestore []Session
	for _, s := range sessions {
		if s.Type == "docker-container" || s.Type == "docker-compose" {
			toRestore = append(toRestore, s)
		}
	}
	sessionsMu.RUnlock()

	log.Printf("[Docker Restore] Restoring %d session(s)...", len(toRestore))
	if len(toRestore) > 0 {
		recordEvent("", "state", "info", "system", "Container manager started — restoring %d session(s) from R2 state", len(toRestore))
	}

	for _, s := range toRestore {
		// Demo / remote-browser sessions are ephemeral: never resurrect them after a host restart
		if s.Metadata.IsDemo || s.Metadata.Kind == "rbi" || (s.Metadata.ExpiresAt != nil && time.Now().After(*s.Metadata.ExpiresAt)) {
			log.Printf("[Docker Restore] Dropping ephemeral session %s", s.ID)
			sessionsMu.Lock()
			delete(sessions, s.ID)
			sessionsMu.Unlock()
			if s.Type == "docker-compose" {
				_ = teardownComposeStack(s)
			} else {
				cleanupCloudflareResources(s.Metadata)
			}
			saveSessions()
			continue
		}
		if s.Metadata.Desired == "stopped" {
			log.Printf("[Docker Restore] %s was stopped on purpose, leaving it stopped", s.ID)
			continue
		}

		if s.Type == "docker-container" {
			if containerExists(s.Metadata.ContainerName) {
				// Same host, manager restarted: just make sure it is running (reconciler repairs the tunnel)
				if s.Metadata.Status != "running" {
					_, _ = dockerOut(time.Minute, "start", s.Metadata.ContainerName)
				}
				continue
			}
		} else if _, err := os.Stat(s.Metadata.ComposeFile); err == nil {
			if out, _ := composeCmd(s.Metadata.ComposeFile, "ps", "-aq"); strings.TrimSpace(out) != "" {
				if err := dockerComposeUp(s.Metadata.ComposeFile); err != nil {
					log.Printf("[Docker Restore] compose up failed for %s: %v", s.ID, err)
				}
				continue
			}
		}

		if _, _, err := startRedeploy(s.ID, "system", false); err != nil {
			log.Printf("[Docker Restore] Failed to schedule restore of %s: %v", s.ID, err)
			recordEvent(s.ID, "deploy_failed", "error", "system", "Restore failed to start: %v", err)
		}
	}
}

// resetStalePIDs forgets tunnel PIDs from a previous host/process: they could now belong to unrelated processes.
func resetStalePIDs() {
	sessionsMu.Lock()
	defer sessionsMu.Unlock()
	for id, s := range sessions {
		s.Metadata.TunnelPid = 0
		for name, svc := range s.Metadata.Services {
			svc.TunnelPid = 0
			s.Metadata.Services[name] = svc
		}
		sessions[id] = s
	}
}
