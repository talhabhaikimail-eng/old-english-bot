package server

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
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
	mux.HandleFunc("/worker/status", s.handleStatus)
	mux.HandleFunc("/api/status", s.handleStatus)

	mux.HandleFunc("/worker/jobs", s.handleJobs)
	mux.HandleFunc("/api/jobs", s.handleJobs)

	mux.HandleFunc("/worker/jobs/", s.handleJobDetailOrCancel)
	mux.HandleFunc("/api/jobs/", s.handleJobDetailOrCancel)
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
