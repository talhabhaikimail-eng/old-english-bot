package pipeline

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"strings"
	"sync"
	"time"

	"course-worker/config"
	"course-worker/downloader"
	"course-worker/model"
)

var (
	ErrJobNotFound = errors.New("job not found")
	ErrJobActive   = errors.New("job is already running or queued")
)

type CourseManager struct {
	cfg        *config.Config
	pipeline   *Pipeline
	mu         sync.RWMutex
	jobs       map[string]*model.JobState
	cancels    map[string]context.CancelFunc
	courseSem  chan struct{}
}

func NewCourseManager(cfg *config.Config) *CourseManager {
	// Clean slate on worker startup: purge any stale leftover files from previous 5h cycles
	_ = os.RemoveAll(cfg.BaseWorkDir)
	_ = os.MkdirAll(cfg.BaseWorkDir, 0755)
	log.Printf("🧹 [Storage] Base work directory %s wiped and initialized clean", cfg.BaseWorkDir)

	return &CourseManager{
		cfg:       cfg,
		pipeline:  NewPipeline(cfg),
		jobs:      make(map[string]*model.JobState),
		cancels:   make(map[string]context.CancelFunc),
		courseSem: make(chan struct{}, cfg.MaxConcurrentCourses),
	}
}

// SubmitJob queues or executes a new course job.
func (m *CourseManager) SubmitJob(req *model.CoursePayload) (*model.JobState, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	jobID := req.GetJobID()
	if existing, found := m.jobs[jobID]; found {
		if existing.Phase == model.PhasePending ||
			existing.Phase == model.PhaseDownloading ||
			existing.Phase == model.PhaseExtracting ||
			existing.Phase == model.PhaseReclaiming ||
			existing.Phase == model.PhaseSeparating ||
			existing.Phase == model.PhaseZipping ||
			existing.Phase == model.PhaseUploading {
			return nil, ErrJobActive
		}
	}

	state := &model.JobState{
		ID:        jobID,
		Title:     req.GetTitle(),
		Slug:      req.Slug,
		Phase:     model.PhasePending,
		Status:    "queued",
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}

	ctx, cancel := context.WithCancel(context.Background())
	m.jobs[jobID] = state
	m.cancels[jobID] = cancel

	log.Printf("📥 [Job %s] Course job submitted: '%s'", jobID, state.Title)

	// Launch worker goroutine governed by course semaphore
	go func() {
		// Wait for slot in concurrent course pool
		select {
		case m.courseSem <- struct{}{}:
			defer func() { <-m.courseSem }()
		case <-ctx.Done():
			m.mu.Lock()
			state.Phase = model.PhaseCancelled
			state.Status = "cancelled"
			state.UpdatedAt = time.Now()
			m.mu.Unlock()
			return
		}

		if ctx.Err() != nil {
			return
		}

		err := m.pipeline.Execute(ctx, req, state, func() {
			m.mu.Lock()
			state.UpdatedAt = time.Now()
			m.mu.Unlock()
		})

		m.mu.Lock()
		defer m.mu.Unlock()
		state.UpdatedAt = time.Now()

		if err != nil {
			if ctx.Err() != nil {
				state.Phase = model.PhaseCancelled
				state.Status = "cancelled"
				state.Error = "Job cancelled by user"
				log.Printf("🛑 [Job %s] Job was cancelled.", jobID)
			} else {
				state.Phase = model.PhaseFailed
				state.Status = "failed"
				if errors.Is(err, downloader.ErrLinkNotWorking) || downloader.IsFatalLinkError(err) {
					if !strings.HasPrefix(err.Error(), "link not working") {
						state.Error = fmt.Sprintf("link not working: %v", err)
					} else {
						state.Error = err.Error()
					}
				} else {
					state.Error = err.Error()
				}
				log.Printf("❌ [Job %s] Job failed: %v", jobID, state.Error)
			}
			if state.WorkDir != "" {
				_ = os.RemoveAll(state.WorkDir)
			}
		} else {
			log.Printf("✅ [Job %s] Job completed successfully!", jobID)
		}
	}()

	return state, nil
}

// CancelJob terminates an active course job and purges working files.
func (m *CourseManager) CancelJob(jobID string) error {
	m.mu.Lock()
	cancel, hasCancel := m.cancels[jobID]
	state, hasState := m.jobs[jobID]
	m.mu.Unlock()

	if !hasState {
		return ErrJobNotFound
	}

	if hasCancel {
		cancel()
	}

	m.mu.Lock()
	state.Phase = model.PhaseCancelled
	state.Status = "cancelled"
	state.UpdatedAt = time.Now()
	m.mu.Unlock()

	// Purge working directory if exists
	if state.WorkDir != "" {
		_ = os.RemoveAll(state.WorkDir)
		log.Printf("🧹 [Job %s] Purged working directory: %s", jobID, state.WorkDir)
	}

	return nil
}

// GetJob returns current status of a job.
func (m *CourseManager) GetJob(jobID string) (*model.JobState, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	state, ok := m.jobs[jobID]
	if !ok {
		return nil, ErrJobNotFound
	}
	return state, nil
}

// ListJobs returns all jobs.
func (m *CourseManager) ListJobs() []*model.JobState {
	m.mu.RLock()
	defer m.mu.RUnlock()

	var list []*model.JobState
	for _, j := range m.jobs {
		list = append(list, j)
	}
	return list
}

// PurgeAllJobs purges all completed or failed jobs.
func (m *CourseManager) PurgeAllJobs() {
	m.mu.Lock()
	defer m.mu.Unlock()

	for _, state := range m.jobs {
		if state.Phase == model.PhaseCompleted || state.Phase == model.PhaseFailed || state.Phase == model.PhaseCancelled {
			if state.WorkDir != "" {
				_ = os.RemoveAll(state.WorkDir)
			}
		}
	}
}

// CancelAllJobsAndClean terminates all active jobs, purges job state, and wipes the entire base work directory.
func (m *CourseManager) CancelAllJobsAndClean() {
	m.mu.Lock()
	for id, cancel := range m.cancels {
		log.Printf("🛑 [Shutdown] Cancelling in-flight job: %s", id)
		cancel()
	}
	m.jobs = make(map[string]*model.JobState)
	m.cancels = make(map[string]context.CancelFunc)
	m.mu.Unlock()

	_ = os.RemoveAll(m.cfg.BaseWorkDir)
	_ = os.MkdirAll(m.cfg.BaseWorkDir, 0755)
	log.Printf("🧹 [Storage] Wiped all jobs and reset base work directory: %s", m.cfg.BaseWorkDir)
}
