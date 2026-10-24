package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ── Settings (persisted in auth_info → R2) ──────────────────────────────────

type Settings struct {
	NotifyURL             string `json:"notifyUrl"`             // Discord / Slack / generic JSON webhook
	NotifyMinLevel        string `json:"notifyMinLevel"`        // info | success | warn | error (default warn)
	PublicBaseURL         string `json:"publicBaseUrl"`         // used to build agent / webhook URLs
	AutoBackupEnabled     bool   `json:"autoBackupEnabled"`     // periodically push volumes to R2
	AutoBackupIntervalMin int    `json:"autoBackupIntervalMin"` // default 60
	AutoRecover           bool   `json:"autoRecover"`           // restart crashed / missing containers
	ComposeAllowUnsafe    bool   `json:"composeAllowUnsafe"`    // allow privileged / host-access options in compose stacks
}

var (
	settingsMu sync.RWMutex
	settings   = Settings{NotifyMinLevel: "warn", AutoBackupEnabled: true, AutoBackupIntervalMin: 60, AutoRecover: true}
)

func settingsFilePath() string {
	return filepath.Join(findWorkspaceRoot(), "auth_info", "go_settings.json")
}

func loadSettings() {
	data, err := os.ReadFile(settingsFilePath())
	if err != nil {
		return
	}
	settingsMu.Lock()
	defer settingsMu.Unlock()
	_ = json.Unmarshal(data, &settings)
	normalizeSettings(&settings)
}

func normalizeSettings(s *Settings) {
	switch s.NotifyMinLevel {
	case "info", "success", "warn", "error":
	default:
		s.NotifyMinLevel = "warn"
	}
	if s.AutoBackupIntervalMin < 5 {
		s.AutoBackupIntervalMin = 60
	}
	s.PublicBaseURL = strings.TrimRight(strings.TrimSpace(s.PublicBaseURL), "/")
	s.NotifyURL = strings.TrimSpace(s.NotifyURL)
}

func getSettings() Settings {
	settingsMu.RLock()
	defer settingsMu.RUnlock()
	return settings
}

func handleSettings(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case "GET":
		writeJSON(w, http.StatusOK, getSettings())
	case "POST":
		var in Settings
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid request body")
			return
		}
		normalizeSettings(&in)
		if in.NotifyURL != "" {
			u, err := url.Parse(in.NotifyURL)
			if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
				writeError(w, http.StatusBadRequest, "notifyUrl must be a valid http(s) URL")
				return
			}
		}
		settingsMu.Lock()
		settings = in
		data, _ := json.MarshalIndent(settings, "", "  ")
		settingsMu.Unlock()
		if err := writeFileAtomic(settingsFilePath(), data); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to save settings: "+err.Error())
			return
		}
		scheduleR2Sync()
		writeJSON(w, http.StatusOK, in)
	default:
		writeError(w, http.StatusMethodNotAllowed, "Method not allowed")
	}
}

func handleTestNotification(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		writeError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}
	s := getSettings()
	if s.NotifyURL == "" {
		writeError(w, http.StatusBadRequest, "No notification URL configured")
		return
	}
	ev := Event{ID: generateHash(), Time: time.Now(), Kind: "test", Level: "info", Message: "Test notification from Go Container Manager"}
	if err := sendNotification(s.NotifyURL, ev); err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"success": true})
}

// ── Event log (persisted in auth_info → R2) ─────────────────────────────────

type Event struct {
	ID        string    `json:"id"`
	Time      time.Time `json:"time"`
	SessionID string    `json:"sessionId,omitempty"`
	Name      string    `json:"name,omitempty"`
	Kind      string    `json:"kind"`  // crashed | recovered | unhealthy | missing | tunnel_down | tunnel_up | deploy_success | deploy_failed | action | webhook | edit | state
	Level     string    `json:"level"` // info | success | warn | error
	Message   string    `json:"message"`
	Actor     string    `json:"actor,omitempty"` // dashboard | webhook | agent | reconciler | system
}

const maxEvents = 1000

var (
	eventsMu     sync.Mutex
	events       []Event // newest first
	notifyThrott = make(map[string]time.Time)
)

func eventsFilePath() string {
	return filepath.Join(findWorkspaceRoot(), "auth_info", "go_events.json")
}

func loadEvents() {
	data, err := os.ReadFile(eventsFilePath())
	if err != nil {
		return
	}
	eventsMu.Lock()
	defer eventsMu.Unlock()
	_ = json.Unmarshal(data, &events)
}

func levelRank(l string) int {
	switch l {
	case "success":
		return 1
	case "warn":
		return 2
	case "error":
		return 3
	}
	return 0
}

func sessionDisplayName(id string) string {
	sessionsMu.RLock()
	defer sessionsMu.RUnlock()
	if s, ok := sessions[id]; ok {
		if s.Metadata.ContainerName != "" {
			return s.Metadata.ContainerName
		}
	}
	return id
}

// recordEvent appends to the persistent timeline and fires an outbound notification when the level qualifies.
// It must not be called while holding sessionsMu (it takes it briefly to resolve the display name).
func recordEvent(sessionID, kind, level, actor, format string, args ...interface{}) {
	name := ""
	if sessionID != "" {
		name = sessionDisplayName(sessionID)
	}
	ev := Event{
		ID: generateHash(), Time: time.Now(), SessionID: sessionID, Name: name,
		Kind: kind, Level: level, Actor: actor, Message: fmt.Sprintf(format, args...),
	}

	eventsMu.Lock()
	events = append([]Event{ev}, events...)
	if len(events) > maxEvents {
		events = events[:maxEvents]
	}
	data, _ := json.MarshalIndent(events, "", "  ")
	eventsMu.Unlock()

	if err := writeFileAtomic(eventsFilePath(), data); err != nil {
		log.Printf("[Events] Failed to persist events: %v", err)
	} else {
		scheduleR2Sync()
	}

	s := getSettings()
	if s.NotifyURL == "" || levelRank(level) < levelRank(s.NotifyMinLevel) {
		return
	}
	// Throttle identical (session, kind) notifications to once per 5 minutes
	key := sessionID + "|" + kind
	eventsMu.Lock()
	if last, ok := notifyThrott[key]; ok && time.Since(last) < 5*time.Minute {
		eventsMu.Unlock()
		return
	}
	notifyThrott[key] = time.Now()
	eventsMu.Unlock()

	go func() {
		if err := sendNotification(s.NotifyURL, ev); err != nil {
			log.Printf("[Notify] Failed to deliver notification: %v", err)
		}
	}()
}

func eventsFor(sessionID string, limit int) []Event {
	eventsMu.Lock()
	defer eventsMu.Unlock()
	out := make([]Event, 0, limit)
	for _, e := range events {
		if sessionID != "" && e.SessionID != sessionID {
			continue
		}
		out = append(out, e)
		if len(out) >= limit {
			break
		}
	}
	return out
}

func handleGetEvents(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		writeError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}
	limit := 100
	if v, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && v > 0 && v <= maxEvents {
		limit = v
	}
	writeJSON(w, http.StatusOK, eventsFor(r.URL.Query().Get("sessionId"), limit))
}

func sendNotification(target string, ev Event) error {
	icons := map[string]string{"info": "ℹ️", "success": "✅", "warn": "⚠️", "error": "🚨"}
	subject := ev.Name
	if subject == "" {
		subject = "container-manager"
	}
	msg := fmt.Sprintf("%s **%s** — %s: %s", icons[ev.Level], subject, ev.Kind, ev.Message)
	// `content` = Discord, `text` = Slack, `event` = structured payload for generic receivers
	body, _ := json.Marshal(map[string]interface{}{
		"username": "Container Manager",
		"content":  msg,
		"text":     msg,
		"event":    ev,
	})
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Post(target, "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("notification endpoint returned HTTP %d", resp.StatusCode)
	}
	return nil
}
