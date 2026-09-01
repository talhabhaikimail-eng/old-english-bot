package main

import (
	
	"net/http"
	"sync"
	"time"
)

type Job struct {
	ID        string    `json:"id"`
	Status    string    `json:"status"` // "running" | "done" | "error"
	Phase     string    `json:"phase"`  // "validating" | "pulling" | "starting" | "tunneling" | "completed" | "failed"
	Logs      []string  `json:"logs"`
	Result    string    `json:"result,omitempty"`
	Error     string    `json:"error,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
}

var (
	jobsMu sync.RWMutex
	jobs   = make(map[string]*Job)
)

func createJob() string {
	jobsMu.Lock()
	defer jobsMu.Unlock()

	// Clean up old jobs first
	cleanupOldJobs()

	id := generateHash()
	jobs[id] = &Job{
		ID:        id,
		Status:    "running",
		Phase:     "validating",
		Logs:      []string{"Job initialized"},
		CreatedAt: time.Now(),
	}
	return id
}

func getJob(id string) (*Job, bool) {
	jobsMu.RLock()
	defer jobsMu.RUnlock()
	j, exists := jobs[id]
	if exists {
		// Return a copy to avoid concurrent map read/write issues on logs slice
		logsCopy := make([]string, len(j.Logs))
		copy(logsCopy, j.Logs)
		return &Job{
			ID:        j.ID,
			Status:    j.Status,
			Phase:     j.Phase,
			Logs:      logsCopy,
			Result:    j.Result,
			Error:     j.Error,
			CreatedAt: j.CreatedAt,
		}, true
	}
	return nil, false
}

func updateJobPhase(id string, phase string, logMsg string) {
	jobsMu.Lock()
	defer jobsMu.Unlock()
	if j, exists := jobs[id]; exists {
		j.Phase = phase
		j.Logs = append(j.Logs, logMsg)
	}
}

func addJobLog(id string, logMsg string) {
	jobsMu.Lock()
	defer jobsMu.Unlock()
	if j, exists := jobs[id]; exists {
		j.Logs = append(j.Logs, logMsg)
	}
}

func failJob(id string, errStr string) {
	jobsMu.Lock()
	defer jobsMu.Unlock()
	if j, exists := jobs[id]; exists {
		j.Status = "error"
		j.Phase = "failed"
		j.Error = errStr
		j.Logs = append(j.Logs, "Error: "+errStr)
	}
}

func completeJob(id string, resultStr string) {
	jobsMu.Lock()
	defer jobsMu.Unlock()
	if j, exists := jobs[id]; exists {
		j.Status = "done"
		j.Phase = "completed"
		j.Result = resultStr
		j.Logs = append(j.Logs, "Job completed successfully")
	}
}

func cleanupOldJobs() {
	// Delete completed/failed jobs older than 10 minutes
	now := time.Now()
	for id, j := range jobs {
		if j.Status != "running" && now.Sub(j.CreatedAt) > 10*time.Minute {
			delete(jobs, id)
		}
	}
}

func handleGetJobStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		writeError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	id := r.URL.Query().Get("id")
	if id == "" {
		id = r.URL.Query().Get("jobId")
	}
	if id == "" {
		writeError(w, http.StatusBadRequest, "Missing id parameter")
		return
	}

	job, exists := getJob(id)
	if !exists {
		writeError(w, http.StatusNotFound, "Job not found")
		return
	}

	writeJSON(w, http.StatusOK, job)
}
