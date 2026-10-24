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

	// Lifecycle / observed state (persisted so it survives a host restart via R2)
	Desired        string        `json:"desired,omitempty"` // "running" | "stopped"
	RestartCount   int           `json:"restartCount,omitempty"`
	OOMKilled      bool          `json:"oomKilled,omitempty"`
	StatusSince    *time.Time    `json:"statusSince,omitempty"`
	LastDeployedAt *time.Time    `json:"lastDeployedAt,omitempty"`
	RegistryAuth   *RegistryAuth `json:"registryAuth,omitempty"` // needed to re-pull private images after a host restart

	Kind string `json:"kind,omitempty"` // "rbi" = ephemeral remote-browser session

	// Access tokens
	AgentReadToken  string `json:"agentReadToken,omitempty"`
	AgentWriteToken string `json:"agentWriteToken,omitempty"`
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
	Desired          string                                     `json:"desired,omitempty"`
	RestartCount     int                                        `json:"restartCount,omitempty"`
	OOMKilled        bool                                       `json:"oomKilled,omitempty"`
	StatusSince      *time.Time                                 `json:"statusSince,omitempty"`
	LastDeployedAt   *time.Time                                 `json:"lastDeployedAt,omitempty"`
	WebhookSecret    string                                     `json:"webhookSecret,omitempty"`
	AgentReadToken   string                                     `json:"agentReadToken,omitempty"`
	AgentWriteToken  string                                     `json:"agentWriteToken,omitempty"`
	Kind             string                                     `json:"kind,omitempty"`
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
		ensureSessionSecrets(&s)
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

	if err := writeFileAtomic(sessionsFile, data); err != nil {
		log.Printf("Error writing sessions: %v", err)
		return
	}

	// Debounced upload of auth_info (sessions, deployments, events, settings) to R2
	scheduleR2Sync()
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

// generateToken returns a long random token, optionally prefixed ("r_" read-only, "w_" control).
func generateToken(prefix string) string {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return prefix + fmt.Sprintf("%x", time.Now().UnixNano())
	}
	return prefix + fmt.Sprintf("%x", b)
}

// ensureSessionSecrets backfills webhook / agent tokens for sessions created before they existed.
func ensureSessionSecrets(s *Session) {
	if s.Metadata.WebhookSecret == "" {
		s.Metadata.WebhookSecret = generateToken("")
	}
	if s.Metadata.AgentReadToken == "" {
		s.Metadata.AgentReadToken = generateToken("r_")
	}
	if s.Metadata.AgentWriteToken == "" {
		s.Metadata.AgentWriteToken = generateToken("w_")
	}
	if s.Metadata.Desired == "" {
		s.Metadata.Desired = "running"
	}
}

// finalizeSession carries access tokens / registry credentials over from the previous incarnation of a session
// and stamps lifecycle fields. Call it right before storing a freshly (re)deployed session.
func finalizeSession(sess *Session, old *Session) {
	if old != nil {
		if sess.Metadata.WebhookSecret == "" {
			sess.Metadata.WebhookSecret = old.Metadata.WebhookSecret
		}
		if sess.Metadata.AgentReadToken == "" {
			sess.Metadata.AgentReadToken = old.Metadata.AgentReadToken
		}
		if sess.Metadata.AgentWriteToken == "" {
			sess.Metadata.AgentWriteToken = old.Metadata.AgentWriteToken
		}
		if sess.Metadata.RegistryAuth == nil {
			sess.Metadata.RegistryAuth = old.Metadata.RegistryAuth
		}
	}
	ensureSessionSecrets(sess)
	now := time.Now()
	sess.Metadata.Desired = "running"
	sess.Metadata.LastDeployedAt = &now
	sess.Metadata.StatusSince = &now
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
