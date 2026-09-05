package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"course-worker/model"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow cross-origin WebSocket connections
	},
	ReadBufferSize:  2048,
	WriteBufferSize: 2048,
}

// handleWSProcess provides a unified, bidirectional WebSocket endpoint.
// Clients can either supply URLs in query parameters (?url=... / ?urls=...)
// or send a JSON message upon connecting with URLs, title, and upload options.
// The server automatically queues the course and streams real-time progress updates,
// concluding with a terminal "result" message indicating whether the course was uploaded.
func (s *Server) handleWSProcess(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("⚠️ [WS Process] WebSocket upgrade failed: %v", err)
		return
	}
	defer conn.Close()

	var payload *model.CoursePayload

	// Check if URLs were supplied in query parameters
	if r.URL.Query().Get("url") != "" || r.URL.Query().Get("urls") != "" {
		p, _, _, err := s.parseProcessRequest(r)
		if err == nil && len(p.GetLinks()) > 0 {
			payload = p
		}
	}

	// If not provided in query parameters, read initial client message
	if payload == nil {
		_ = conn.WriteJSON(map[string]interface{}{
			"type":    "ready",
			"message": "Send course JSON payload to start processing (e.g. {\"urls\": [\"https://...\"]})",
		})

		_, msgBytes, err := conn.ReadMessage()
		if err != nil {
			return
		}

		trimmed := bytes.TrimSpace(msgBytes)
		if bytes.HasPrefix(trimmed, []byte("[")) {
			var urlList []string
			if err := json.Unmarshal(trimmed, &urlList); err != nil {
				_ = conn.WriteJSON(map[string]interface{}{
					"type":     "result",
					"success":  false,
					"uploaded": false,
					"error":    fmt.Sprintf("invalid JSON array of URLs: %v", err),
				})
				return
			}
			req := model.ProcessRequest{URLs: urlList}
			p, err := req.ToCoursePayload(s.cfg.AutoUploadDrive)
			if err != nil {
				_ = conn.WriteJSON(map[string]interface{}{
					"type":     "result",
					"success":  false,
					"uploaded": false,
					"error":    err.Error(),
				})
				return
			}
			payload = p
		} else {
			var req model.ProcessRequest
			if err := json.Unmarshal(trimmed, &req); err != nil {
				_ = conn.WriteJSON(map[string]interface{}{
					"type":     "result",
					"success":  false,
					"uploaded": false,
					"error":    fmt.Sprintf("invalid JSON payload: %v", err),
				})
				return
			}
			p, err := req.ToCoursePayload(s.cfg.AutoUploadDrive)
			if err != nil {
				_ = conn.WriteJSON(map[string]interface{}{
					"type":     "result",
					"success":  false,
					"uploaded": false,
					"error":    err.Error(),
				})
				return
			}
			payload = p
		}
	}

	// Submit job to queue/pool
	jobState, err := s.manager.SubmitJob(payload)
	if err != nil {
		_ = conn.WriteJSON(map[string]interface{}{
			"type":     "result",
			"success":  false,
			"uploaded": false,
			"error":    err.Error(),
		})
		return
	}

	jobID := jobState.ID
	_ = conn.WriteJSON(map[string]interface{}{
		"type":    "started",
		"jobId":   jobID,
		"title":   jobState.Title,
		"status":  jobState.Status,
		"phase":   string(jobState.Phase),
		"message": fmt.Sprintf("Job '%s' accepted. Streaming real-time updates...", jobState.Title),
	})

	s.streamJobWS(conn, jobID)
}

// handleWSJob streams real-time updates for an existing job via /ws/jobs/{id}.
func (s *Server) handleWSJob(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("⚠️ [WS Job] WebSocket upgrade failed: %v", err)
		return
	}
	defer conn.Close()

	path := strings.TrimPrefix(r.URL.Path, "/ws/jobs/")
	path = strings.TrimPrefix(path, "/api/ws/jobs/")
	jobID := strings.Trim(path, "/")

	if jobID == "" {
		_ = conn.WriteJSON(map[string]interface{}{
			"type":  "error",
			"error": "missing job ID in path",
		})
		return
	}

	s.streamJobWS(conn, jobID)
}

// handleWSAllJobs streams real-time events across all running jobs via /ws/jobs.
func (s *Server) handleWSAllJobs(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("⚠️ [WS All] WebSocket upgrade failed: %v", err)
		return
	}
	defer conn.Close()

	ch, unsub := s.manager.SubscribeAll()
	defer unsub()

	// Configure keepalive and read limits
	conn.SetReadLimit(65536)
	_ = conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	conn.SetPongHandler(func(string) error {
		_ = conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})

	// Transmit initial active jobs list
	jobs := s.manager.ListJobs()
	_ = conn.WriteJSON(map[string]interface{}{
		"type": "init",
		"jobs": jobs,
	})

	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()

	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-done:
			return
		case <-ticker.C:
			if err := conn.WriteControl(websocket.PingMessage, []byte{}, time.Now().Add(10*time.Second)); err != nil {
				return
			}
		case update, ok := <-ch:
			if !ok {
				return
			}
			msgType := "progress"
			if update.Phase == model.PhaseCompleted || update.Phase == model.PhaseFailed || update.Phase == model.PhaseCancelled {
				msgType = "result"
			}
			err := conn.WriteJSON(map[string]interface{}{
				"type":            msgType,
				"jobId":           update.ID,
				"title":           update.Title,
				"phase":           string(update.Phase),
				"status":          update.Status,
				"progressPercent": update.ProgressPercent,
				"speedMBps":       update.SpeedMBps,
				"completedParts":  update.CompletedParts,
				"totalParts":      update.TotalParts,
				"downloadedBytes": update.DownloadedBytes,
				"totalBytes":      update.TotalBytes,
				"uploaded":        update.Uploaded,
				"driveFolderId":   update.DriveFolderID,
				"driveFolderUrl":  update.DriveFolderURL,
				"driveFiles":      update.DriveFiles,
				"videoFiles":      update.VideoFiles,
				"materialZips":    update.MaterialZips,
				"error":           update.Error,
				"success":         update.Phase == model.PhaseCompleted,
				"updatedAt":       update.UpdatedAt,
			})
			if err != nil {
				return
			}
		}
	}
}

// streamJobWS pumps events for a specific job into the given WebSocket connection.
func (s *Server) streamJobWS(conn *websocket.Conn, jobID string) {
	ch, unsub := s.manager.SubscribeJob(jobID)
	defer unsub()

	// Configure keepalive and read limits
	conn.SetReadLimit(65536)
	_ = conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	conn.SetPongHandler(func(string) error {
		_ = conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})

	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			// Client can send {"action": "cancel"} over WebSocket to abort
			var clientMsg struct {
				Action string `json:"action"`
			}
			if err := conn.ReadJSON(&clientMsg); err != nil {
				return
			}
			if strings.EqualFold(clientMsg.Action, "cancel") {
				_ = s.manager.CancelJob(jobID)
			}
		}
	}()

	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-done:
			return
		case <-ticker.C:
			if err := conn.WriteControl(websocket.PingMessage, []byte{}, time.Now().Add(10*time.Second)); err != nil {
				return
			}
		case update, ok := <-ch:
			if !ok {
				return
			}
			msgType := "progress"
			isTerminal := false
			if update.Phase == model.PhaseCompleted || update.Phase == model.PhaseFailed || update.Phase == model.PhaseCancelled {
				msgType = "result"
				isTerminal = true
			}

			err := conn.WriteJSON(map[string]interface{}{
				"type":            msgType,
				"jobId":           update.ID,
				"title":           update.Title,
				"phase":           string(update.Phase),
				"status":          update.Status,
				"progressPercent": update.ProgressPercent,
				"speedMBps":       update.SpeedMBps,
				"completedParts":  update.CompletedParts,
				"totalParts":      update.TotalParts,
				"downloadedBytes": update.DownloadedBytes,
				"totalBytes":      update.TotalBytes,
				"parts":           update.Parts,
				"uploaded":        update.Uploaded,
				"driveFolderId":   update.DriveFolderID,
				"driveFolderUrl":  update.DriveFolderURL,
				"driveFiles":      update.DriveFiles,
				"videoFiles":      update.VideoFiles,
				"materialZips":    update.MaterialZips,
				"error":           update.Error,
				"success":         update.Phase == model.PhaseCompleted,
				"updatedAt":       update.UpdatedAt,
			})
			if err != nil {
				return
			}

			if isTerminal {
				// Allow client to receive the final result message before closing
				time.Sleep(300 * time.Millisecond)
				return
			}
		}
	}
}
