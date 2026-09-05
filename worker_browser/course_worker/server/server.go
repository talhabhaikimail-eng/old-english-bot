package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"path"
	"strings"
	"syscall"

	"course-worker/config"
	"course-worker/model"
	"course-worker/pipeline"
)

type Server struct {
	cfg     *config.Config
	manager *pipeline.CourseManager
}

func NewServer(cfg *config.Config, manager *pipeline.CourseManager) *Server {
	return &Server{
		cfg:     cfg,
		manager: manager,
	}
}

func (s *Server) RegisterRoutes(mux *http.ServeMux) {
	// Status & Health
	mux.HandleFunc("/worker/status", s.handleStatus)
	mux.HandleFunc("/api/status", s.handleStatus)
	mux.HandleFunc("/health", s.handleStatus)

	// Jobs Management
	mux.HandleFunc("/worker/jobs", s.handleJobs)
	mux.HandleFunc("/api/jobs", s.handleJobs)
	mux.HandleFunc("/worker/jobs/", s.handleJobDetailOrCancel)
	mux.HandleFunc("/api/jobs/", s.handleJobDetailOrCancel)

	// Global Simplified Process API (Accepts pure URLs, single URL, course payload, sync/stream/async)
	mux.HandleFunc("/api/process", s.handleProcess)
	mux.HandleFunc("/api/course", s.handleProcess)
	mux.HandleFunc("/worker/process", s.handleProcess)
	mux.HandleFunc("/worker/course", s.handleProcess)

	// WebSockets for Live Updates
	mux.HandleFunc("/ws/process", s.handleWSProcess)
	mux.HandleFunc("/api/ws/process", s.handleWSProcess)
	mux.HandleFunc("/ws/jobs", s.handleWSAllJobs)
	mux.HandleFunc("/api/ws/jobs", s.handleWSAllJobs)
	mux.HandleFunc("/ws/jobs/", s.handleWSJob)
	mux.HandleFunc("/api/ws/jobs/", s.handleWSJob)

	// Interactive Dashboard UI & Docs
	mux.HandleFunc("/", s.handleIndex)
	mux.HandleFunc("/ui", s.handleIndex)
	mux.HandleFunc("/docs", s.handleDocs)
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	freeBytes, _ := config.GetDiskFreeBytes(s.cfg.BaseWorkDir)

	var stat syscall.Statfs_t
	var totalBytes uint64
	if err := syscall.Statfs(s.cfg.BaseWorkDir, &stat); err == nil {
		totalBytes = stat.Blocks * uint64(stat.Bsize)
	}

	totalGB := float64(totalBytes) / (1024 * 1024 * 1024)
	freeGB := float64(freeBytes) / (1024 * 1024 * 1024)
	usedGB := totalGB - freeGB
	var usedPct float64
	if totalGB > 0 {
		usedPct = (usedGB / totalGB) * 100.0
	}

	jobs := s.manager.ListJobs()
	activeCount := 0
	for _, j := range jobs {
		if j.Phase == model.PhaseDownloading || j.Phase == model.PhaseExtracting ||
			j.Phase == model.PhaseReclaiming || j.Phase == model.PhaseSeparating ||
			j.Phase == model.PhaseZipping || j.Phase == model.PhaseUploading {
			activeCount++
		}
	}

	statusStr := "idle"
	if activeCount > 0 {
		statusStr = "busy"
	}

	resp := map[string]interface{}{
		"workerId": s.cfg.WorkerID,
		"status":   statusStr,
		"disk": map[string]interface{}{
			"totalGB":     round(totalGB, 1),
			"freeGB":      round(freeGB, 1),
			"usedGB":      round(usedGB, 1),
			"usedPercent": round(usedPct, 1),
		},
		"concurrencyLimit": s.cfg.MaxConcurrentCourses,
		"activeCourses":    activeCount,
		"totalJobs":        len(jobs),
	}

	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) handleJobs(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		jobs := s.manager.ListJobs()
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"success": true,
			"jobs":    jobs,
		})

	case http.MethodDelete:
		s.manager.CancelAllJobsAndClean()
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"success": true,
			"message": "All jobs cancelled and base working directory wiped clean",
		})

	case http.MethodPost:
		var req model.CoursePayload
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, fmt.Sprintf("invalid JSON payload: %v", err), http.StatusBadRequest)
			return
		}

		if len(req.GetLinks()) == 0 {
			http.Error(w, "missing download links in payload", http.StatusBadRequest)
			return
		}

		jobState, err := s.manager.SubmitJob(&req)
		if err != nil {
			if err == pipeline.ErrJobActive {
				writeJSON(w, http.StatusConflict, map[string]interface{}{
					"error": "Course job is already running or active",
				})
				return
			}
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		writeJSON(w, http.StatusAccepted, map[string]interface{}{
			"success": true,
			"jobId":   jobState.ID,
			"status":  "accepted",
			"message": fmt.Sprintf("Course job '%s' accepted and queued.", jobState.Title),
		})

	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleJobDetailOrCancel(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/worker/jobs/")
	path = strings.TrimPrefix(path, "/api/jobs/")

	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) == 0 || parts[0] == "" {
		http.Error(w, "Missing job ID", http.StatusBadRequest)
		return
	}

	jobID := parts[0]

	// Check if this is a cancel request: /worker/jobs/{id}/cancel
	if len(parts) >= 2 && parts[1] == "cancel" {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed for cancel", http.StatusMethodNotAllowed)
			return
		}

		if err := s.manager.CancelJob(jobID); err != nil {
			if err == pipeline.ErrJobNotFound {
				http.Error(w, "Job not found", http.StatusNotFound)
				return
			}
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"success":    true,
			"jobId":      jobID,
			"status":     "cancelled",
			"diskPurged": true,
		})
		return
	}

	// Check if this is an SSE events request: /worker/jobs/{id}/events or /api/jobs/{id}/events
	if len(parts) >= 2 && parts[1] == "events" {
		if r.Method != http.MethodGet {
			http.Error(w, "Method not allowed for events", http.StatusMethodNotAllowed)
			return
		}
		s.streamJobSSE(w, r, jobID)
		return
	}

	// Job detail: GET /worker/jobs/{id}
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	job, err := s.manager.GetJob(jobID)
	if err != nil {
		if err == pipeline.ErrJobNotFound {
			http.Error(w, "Job not found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"job":     job,
	})
}

// handleProcess implements the simplified Global API.
// It accepts pure URLs, single URL, or full CoursePayload.
// Supports sync mode (?sync=true / Prefer: wait), SSE stream (?stream=true), or async 202 Accepted.
func (s *Server) handleProcess(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	payload, isSync, isStream, err := s.parseProcessRequest(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{
			"success":  false,
			"uploaded": false,
			"error":    err.Error(),
		})
		return
	}

	jobState, err := s.manager.SubmitJob(payload)
	if err != nil {
		if err == pipeline.ErrJobActive {
			writeJSON(w, http.StatusConflict, map[string]interface{}{
				"success":  false,
				"uploaded": false,
				"jobId":    payload.GetJobID(),
				"error":    "Course job is already running or queued",
			})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]interface{}{
			"success":  false,
			"uploaded": false,
			"error":    err.Error(),
		})
		return
	}

	jobID := jobState.ID

	// 1. Real-time Event Stream (SSE)
	if isStream {
		s.streamJobSSE(w, r, jobID)
		return
	}

	// 2. Synchronous Mode: Wait for completion and return final uploaded status
	if isSync {
		finalState, waitErr := s.manager.WaitForJob(r.Context(), jobID)
		if waitErr != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]interface{}{
				"success":  false,
				"uploaded": false,
				"jobId":    jobID,
				"error":    waitErr.Error(),
			})
			return
		}

		isSuccess := finalState.Phase == model.PhaseCompleted
		statusCode := http.StatusOK
		if !isSuccess {
			statusCode = http.StatusInternalServerError
		}

		writeJSON(w, statusCode, map[string]interface{}{
			"success":         isSuccess,
			"uploaded":        finalState.Uploaded,
			"jobId":           finalState.ID,
			"title":           finalState.Title,
			"status":          finalState.Status,
			"phase":           string(finalState.Phase),
			"progressPercent": finalState.ProgressPercent,
			"driveFolderId":   finalState.DriveFolderID,
			"driveFolderUrl":  finalState.DriveFolderURL,
			"driveFiles":      finalState.DriveFiles,
			"videoFiles":      finalState.VideoFiles,
			"materialZips":    finalState.MaterialZips,
			"completedParts":  finalState.CompletedParts,
			"totalParts":      finalState.TotalParts,
			"error":           finalState.Error,
		})
		return
	}

	// 3. Asynchronous Mode: Return 202 Accepted with tracking endpoints
	scheme := "http"
	wsScheme := "ws"
	if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
		scheme = "https"
		wsScheme = "wss"
	}
	host := r.Host
	if host == "" {
		host = fmt.Sprintf("localhost:%d", s.cfg.HTTPPort)
	}

	writeJSON(w, http.StatusAccepted, map[string]interface{}{
		"success":   true,
		"jobId":     jobID,
		"title":     jobState.Title,
		"status":    "queued",
		"phase":     string(jobState.Phase),
		"message":   fmt.Sprintf("Course job '%s' accepted. Track live updates via WebSocket or status URL.", jobState.Title),
		"wsUrl":     fmt.Sprintf("%s://%s/ws/jobs/%s", wsScheme, host, jobID),
		"streamUrl": fmt.Sprintf("%s://%s/api/jobs/%s/events", scheme, host, jobID),
		"statusUrl": fmt.Sprintf("%s://%s/api/jobs/%s", scheme, host, jobID),
	})
}

// WithCORS wraps an http.Handler with universal CORS headers for cross-origin browser access.
func (s *Server) WithCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, Prefer, Accept, X-Requested-With")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	})
}

// parseProcessRequest extracts URLs, options, and streaming preferences from JSON or query parameters.
func (s *Server) parseProcessRequest(r *http.Request) (*model.CoursePayload, bool, bool, error) {
	q := r.URL.Query()
	isSync := q.Get("sync") == "true" || q.Get("sync") == "1" || q.Get("wait") == "true" || r.Header.Get("Prefer") == "wait"
	isStream := q.Get("stream") == "true" || q.Get("stream") == "1" || strings.Contains(r.Header.Get("Accept"), "text/event-stream")

	var urls []string
	var title string
	var password string
	var uploadRequested *bool
	var driveCfg *model.DriveUploadConfig

	// 1. Query parameters (supports ?url=... &urls=... with repeated params, commas, and newlines)
	for _, key := range []string{"url", "urls"} {
		for _, val := range q[key] {
			for _, line := range strings.Split(val, "\n") {
				for _, item := range strings.Split(line, ",") {
					item = strings.Trim(strings.TrimSpace(item), "\"'")
					if item != "" {
						urls = append(urls, item)
					}
				}
			}
		}
	}

	if qTitle := q.Get("title"); qTitle != "" {
		title = strings.TrimSpace(qTitle)
	}
	if qPwd := q.Get("password"); qPwd != "" {
		password = strings.TrimSpace(qPwd)
	}
	if qUpload := q.Get("upload"); qUpload != "" {
		up := strings.ToLower(qUpload) == "true" || qUpload == "1"
		uploadRequested = &up
	}

	// 2. Body parsing (JSON)
	if r.Body != nil && r.ContentLength != 0 {
		bodyBytes, err := io.ReadAll(r.Body)
		if err == nil && len(bodyBytes) > 0 {
			trimmedBody := bytes.TrimSpace(bodyBytes)
			if bytes.HasPrefix(trimmedBody, []byte("[")) {
				var rawList []string
				if err := json.Unmarshal(trimmedBody, &rawList); err != nil {
					return nil, false, false, fmt.Errorf("invalid JSON array of URLs: %w", err)
				}
				for _, u := range rawList {
					u = strings.Trim(strings.TrimSpace(u), "\"'")
					if u != "" {
						urls = append(urls, u)
					}
				}
			} else if bytes.HasPrefix(trimmedBody, []byte("{")) {
				var procReq model.ProcessRequest
				if err := json.Unmarshal(trimmedBody, &procReq); err != nil {
					return nil, false, false, fmt.Errorf("invalid JSON payload: %w", err)
				}
				for _, u := range procReq.CollectURLs() {
					u = strings.Trim(strings.TrimSpace(u), "\"'")
					if u != "" {
						urls = append(urls, u)
					}
				}
				if procReq.Title != "" && title == "" {
					title = procReq.Title
				} else if procReq.CourseName != "" && title == "" {
					title = procReq.CourseName
				}
				if procReq.Password != "" && password == "" {
					password = procReq.Password
				} else if procReq.FilePassword != "" && password == "" {
					password = procReq.FilePassword
				}
				if procReq.Upload != nil && uploadRequested == nil {
					uploadRequested = procReq.Upload
				}
				if procReq.Sync {
					isSync = true
				}
				if procReq.Stream {
					isStream = true
				}
				if procReq.Drive != nil {
					driveCfg = procReq.Drive
				} else if procReq.AccessToken != "" || procReq.ParentFolderId != "" {
					driveCfg = &model.DriveUploadConfig{
						AccessToken:    procReq.AccessToken,
						ParentFolderId: procReq.ParentFolderId,
					}
				}

				// Also check if CoursePayload with downloadLinks was provided
				var rawPayload model.CoursePayload
				if err := json.Unmarshal(trimmedBody, &rawPayload); err == nil {
					for _, dl := range rawPayload.DownloadLinks {
						u := strings.Trim(strings.TrimSpace(dl.URL), "\"'")
						if u != "" {
							urls = append(urls, u)
						}
					}
					if rawPayload.Title != "" && title == "" {
						title = rawPayload.Title
					}
					if rawPayload.FilePassword != "" && password == "" {
						password = rawPayload.FilePassword
					}
					if rawPayload.Drive != nil && driveCfg == nil {
						driveCfg = rawPayload.Drive
					}
				}
			}
		}
	}

	// De-duplicate URLs while preserving order
	var uniqueURLs []string
	seen := make(map[string]bool)
	for _, u := range urls {
		u = strings.TrimSpace(u)
		if u != "" && !seen[u] {
			seen[u] = true
			uniqueURLs = append(uniqueURLs, u)
		}
	}

	if len(uniqueURLs) == 0 {
		return nil, false, false, fmt.Errorf("missing download URLs: provide 'url' or 'urls' in JSON payload or query parameters")
	}

	if title == "" {
		title = model.DeduceTitleFromURLs(uniqueURLs)
	}

	if password == "" {
		password = "www.downloadly.ir"
	}

	// Determine upload preference
	shouldUpload := s.cfg.AutoUploadDrive
	if uploadRequested != nil {
		shouldUpload = *uploadRequested
	} else if s.cfg.DatabaseURL != "" || (driveCfg != nil && driveCfg.AccessToken != "") {
		shouldUpload = true
	}

	if driveCfg == nil {
		driveCfg = &model.DriveUploadConfig{
			AutoUpload: &shouldUpload,
		}
	} else {
		if driveCfg.AutoUpload == nil {
			driveCfg.AutoUpload = &shouldUpload
		}
	}

	var downloadLinks []model.DownloadLink
	for i, u := range uniqueURLs {
		fname := path.Base(u)
		if parsed, err := url.Parse(u); err == nil && parsed.Path != "" {
			fname = path.Base(parsed.Path)
		}
		downloadLinks = append(downloadLinks, model.DownloadLink{
			URL:  u,
			Part: i + 1,
			Text: fname,
		})
	}

	payload := &model.CoursePayload{
		Title:         title,
		CourseName:    title,
		FilePassword:  password,
		Password:      password,
		ArchiveURLs:   uniqueURLs,
		DownloadLinks: downloadLinks,
		Drive:         driveCfg,
	}

	return payload, isSync, isStream, nil
}

// streamJobSSE pushes Server-Sent Events to the client for real-time progress without WebSockets.
func (s *Server) streamJobSSE(w http.ResponseWriter, r *http.Request, jobID string) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	ch, unsub := s.manager.SubscribeJob(jobID)
	defer unsub()

	ctx := r.Context()

	for {
		select {
		case <-ctx.Done():
			return
		case update, ok := <-ch:
			if !ok {
				return
			}
			data, _ := json.Marshal(update)
			eventType := "progress"
			if update.Phase == model.PhaseCompleted || update.Phase == model.PhaseFailed || update.Phase == model.PhaseCancelled {
				eventType = "result"
			}
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", eventType, data)
			flusher.Flush()

			if eventType == "result" {
				return
			}
		}
	}
}

func writeJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(data); err != nil {
		log.Printf("Failed to write JSON response: %v", err)
	}
}

func round(val float64, precision int) float64 {
	p := 1.0
	for i := 0; i < precision; i++ {
		p *= 10.0
	}
	return float64(int(val*p+0.5)) / p
}
