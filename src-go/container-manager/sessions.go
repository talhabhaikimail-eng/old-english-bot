package main

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type ServiceSessionMetadata struct {
	ServiceName    string `json:"serviceName"`
	Port           int    `json:"port"`
	HostPort       int    `json:"hostPort"`
	DomainMode     string `json:"domainMode"`
	CustomDomain   string `json:"customDomain,omitempty"`
	CloudflaredURL string `json:"cloudflaredUrl,omitempty"`
	TunnelPid      int    `json:"tunnelPid,omitempty"`
	TunnelToken    string `json:"tunnelToken,omitempty"`
	TunnelID       string `json:"tunnelId,omitempty"`
	Status         string `json:"status,omitempty"`
	ExitCode       int    `json:"exitCode,omitempty"`
	Health         string `json:"health,omitempty"`
	TunnelStatus   string `json:"tunnelStatus,omitempty"`
}

type SessionMetadata struct {
	Port           int                               `json:"port,omitempty"`
	HostPort       int                               `json:"hostPort,omitempty"`
	ContainerName  string                            `json:"containerName,omitempty"`
	TargetURL      string                            `json:"targetUrl,omitempty"`
	Image          string                            `json:"image,omitempty"`
	Env            map[string]string                 `json:"env,omitempty"`
	DomainMode     string                            `json:"domainMode,omitempty"`
	CustomDomain   string                            `json:"customDomain,omitempty"`
	TunnelPid      int                               `json:"tunnelPid,omitempty"`
	CloudflaredURL string                            `json:"cloudflaredUrl,omitempty"`
	WebhookSecret  string                            `json:"webhookSecret,omitempty"`
	TunnelToken    string                            `json:"tunnelToken,omitempty"`
	TunnelID       string                            `json:"tunnelId,omitempty"`
	ComposeFile    string                            `json:"composeFile,omitempty"`
	Services       map[string]ServiceSessionMetadata `json:"services,omitempty"`
	Status         string                            `json:"status,omitempty"`
	ExitCode       int                               `json:"exitCode,omitempty"`
	Health         string                            `json:"health,omitempty"`
	TunnelStatus   string                            `json:"tunnelStatus,omitempty"`
	Ports          []PortMapping                     `json:"ports,omitempty"`
	Volumes        []VolumeMount                     `json:"volumes,omitempty"`
	MemoryLimitMB  int                               `json:"memoryLimitMB,omitempty"`
	Cpus           float64                           `json:"cpus,omitempty"`
	RestartPolicy  string                            `json:"restartPolicy,omitempty"`
	Command        []string                          `json:"command,omitempty"`
	Args           []string                          `json:"args,omitempty"`
	YAML            string                            `json:"yaml,omitempty"`
	ServiceSettings map[string]ServiceSetting         `json:"serviceSettings,omitempty"`
	TTLMinutes      int                               `json:"ttlMinutes,omitempty"`
	ExpiresAt       *time.Time                        `json:"expiresAt,omitempty"`
	IsDemo          bool                              `json:"isDemo,omitempty"`
}

type Session struct {
	ID        string          `json:"id"`
	Type      string          `json:"type"`
	URL       string          `json:"url"`
	Username  string          `json:"username,omitempty"`
	Password  string          `json:"password,omitempty"`
	StartedAt time.Time       `json:"startedAt"`
	Metadata  SessionMetadata `json:"metadata,omitempty"`
}

type SanitizedServiceSessionMetadata struct {
	ServiceName    string `json:"serviceName"`
	Port           int    `json:"port"`
	HostPort       int    `json:"hostPort"`
	DomainMode     string `json:"domainMode"`
	CustomDomain   string `json:"customDomain,omitempty"`
	CloudflaredURL string `json:"cloudflaredUrl,omitempty"`
	Status         string `json:"status,omitempty"`
	ExitCode       int    `json:"exitCode,omitempty"`
	Health         string `json:"health,omitempty"`
	TunnelStatus   string `json:"tunnelStatus,omitempty"`
}

type SanitizedSessionMetadata struct {
	Port             int                                        `json:"port,omitempty"`
	HostPort         int                                        `json:"hostPort,omitempty"`
	ContainerName    string                                     `json:"containerName,omitempty"`
	TargetURL        string                                     `json:"targetUrl,omitempty"`
	Image            string                                     `json:"image,omitempty"`
	Env              map[string]string                          `json:"env,omitempty"`
	DomainMode       string                                     `json:"domainMode,omitempty"`
	CustomDomain     string                                     `json:"customDomain,omitempty"`
	CloudflaredURL   string                                     `json:"cloudflaredUrl,omitempty"`
	ComposeFile      string                                     `json:"composeFile,omitempty"`
	Services         map[string]SanitizedServiceSessionMetadata `json:"services,omitempty"`
	Status           string                                     `json:"status,omitempty"`
	ExitCode         int                                        `json:"exitCode,omitempty"`
	Health           string                                     `json:"health,omitempty"`
	TunnelStatus     string                                     `json:"tunnelStatus,omitempty"`
	Ports            []PortMapping                              `json:"ports,omitempty"`
	Volumes          []VolumeMount                              `json:"volumes,omitempty"`
	MemoryLimitMB    int                                        `json:"memoryLimitMB,omitempty"`
	Cpus             float64                                    `json:"cpus,omitempty"`
	RestartPolicy    string                                     `json:"restartPolicy,omitempty"`
	Command          []string                                   `json:"command,omitempty"`
	Args             []string                                   `json:"args,omitempty"`
	YAML             string                                     `json:"yaml,omitempty"`
	ServiceSettings  map[string]ServiceSetting                  `json:"serviceSettings,omitempty"`
	TTLMinutes       int                                        `json:"ttlMinutes,omitempty"`
	ExpiresAt        *time.Time                                 `json:"expiresAt,omitempty"`
	IsDemo           bool                                       `json:"isDemo,omitempty"`
	RemainingSeconds int                                        `json:"remainingSeconds,omitempty"`
}

type SanitizedSession struct {
	ID        string                   `json:"id"`
	Type      string                   `json:"type"`
	URL       string                   `json:"url"`
	Username  string                   `json:"username,omitempty"`
	StartedAt time.Time                `json:"startedAt"`
	Metadata  SanitizedSessionMetadata `json:"metadata,omitempty"`
}

var (
	sessionsMu   sync.RWMutex
	sessions     = make(map[string]Session)
	sessionsFile string
	nextPort     = 16000
	nextPortMu   sync.Mutex
)

// Load sessions from disk
func loadSessions() error {
	sessionsMu.Lock()
	defer sessionsMu.Unlock()

	if _, err := os.Stat(sessionsFile); os.IsNotExist(err) {
		return nil
	}

	data, err := os.ReadFile(sessionsFile)
	if err != nil {
		return err
	}

	var sessList []Session
	if err := json.Unmarshal(data, &sessList); err != nil {
		return err
	}

	for _, s := range sessList {
		sessions[s.ID] = s
	}
	log.Printf("[Go Container Manager] Loaded %d sessions from disk.", len(sessions))
	return nil
}

// Save sessions to disk and trigger R2 backup
func saveSessions() {
	sessionsMu.Lock()
	sessList := make([]Session, 0, len(sessions))
	for _, s := range sessions {
		sessList = append(sessList, s)
	}
	sessionsMu.Unlock()

	// Ensure directory exists
	dir := filepath.Dir(sessionsFile)
	if err := os.MkdirAll(dir, 0755); err != nil {
		log.Printf("Error creating sessions folder: %v", err)
		return
	}

	data, err := json.MarshalIndent(sessList, "", "  ")
	if err != nil {
		log.Printf("Error marshaling sessions: %v", err)
		return
	}

	if err := os.WriteFile(sessionsFile, data, 0644); err != nil {
		log.Printf("Error writing sessions: %v", err)
		return
	}

	// Trigger R2 upload in background (Node bridge for Phase 1, Go-native in Phase 5)
	go func() {
		if err := saveStateToR2(); err != nil {
			log.Printf("❌ Failed to sync state to R2: %v", err)
		}
	}()
}

func saveStateToR2() error {
	return backupStateToR2()
}

func updateNextPort() {
	nextPortMu.Lock()
	defer nextPortMu.Unlock()

	maxPort := 15999
	for _, s := range sessions {
		if s.Metadata.HostPort > maxPort {
			maxPort = s.Metadata.HostPort
		}
		for _, svc := range s.Metadata.Services {
			if svc.HostPort > maxPort {
				maxPort = svc.HostPort
			}
		}
	}
	nextPort = maxPort + 1
	log.Printf("[Go Container Manager] Derived nextPort as %d", nextPort)
}

func isPortAvailable(port int) bool {
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return false
	}
	ln.Close()
	return true
}

func isPortConflict(port int) bool {
	// Check against sessions
	for _, s := range sessions {
		if s.Metadata.HostPort == port {
			return true
		}
		for _, svc := range s.Metadata.Services {
			if svc.HostPort == port {
				return true
			}
		}
	}
	// Check if TCP listen is free
	if !isPortAvailable(port) {
		return true
	}
	return false
}

func allocatePort() (int, error) {
	nextPortMu.Lock()
	defer nextPortMu.Unlock()
	
	// Try up to 1000 ports starting from nextPort
	for i := 0; i < 1000; i++ {
		port := nextPort
		nextPort++
		if !isPortConflict(port) {
			return port, nil
		}
	}
	return 0, fmt.Errorf("failed to allocate a free port after 1000 attempts")
}

func generateHash() string {
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())[:8]
	}
	return fmt.Sprintf("%x", b)
}

func sanitizeEnvValue(val string) string {
	val = strings.TrimSpace(val)
	val = strings.TrimPrefix(val, "export ")
	val = strings.TrimSpace(val)
	if !strings.HasPrefix(val, "\"") && !strings.HasPrefix(val, "'") && !strings.HasPrefix(val, "`") {
		if idx := strings.Index(val, "#"); idx != -1 {
			val = strings.TrimSpace(val[:idx])
		}
	}
	val = strings.Trim(val, "\"'`")
	val = strings.TrimSuffix(val, ";")
	val = strings.Trim(val, "\"'`")
	return strings.TrimSpace(val)
}

func getSanitizedEnv(key string) string {
	raw := os.Getenv(key)
	return sanitizeEnvValue(raw)
}
