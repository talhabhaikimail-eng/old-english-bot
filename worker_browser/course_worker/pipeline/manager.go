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
	wg         sync.WaitGroup

	subMu     sync.RWMutex
	jobSubs   map[string]map[chan *model.JobState]struct{}
	allSubs   map[chan *model.JobState]struct{}
	waitChans map[string][]chan *model.JobState
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
		jobSubs:   make(map[string]map[chan *model.JobState]struct{}),
		allSubs:   make(map[chan *model.JobState]struct{}),
		waitChans: make(map[string][]chan *model.JobState),
	}
}

// BroadcastJobUpdate transmits the latest JobState snapshot to all active WebSocket/SSE subscribers.
func (m *CourseManager) BroadcastJobUpdate(state *model.JobState) {
	if state == nil {
		return
	}
	snapshot := state.Clone()

	m.subMu.RLock()
	// 1. Notify job-specific subscribers
	if subs, ok := m.jobSubs[snapshot.ID]; ok {
		for ch := range subs {
			select {
			case ch <- snapshot:
			default:
			}
		}
	}
	// 2. Notify global subscribers
	for ch := range m.allSubs {
		select {
		case ch <- snapshot:
		default:
		}
	}
	m.subMu.RUnlock()

	// 3. If job reached terminal phase, notify waiters
	if snapshot.Phase == model.PhaseCompleted || snapshot.Phase == model.PhaseFailed || snapshot.Phase == model.PhaseCancelled {
		m.subMu.Lock()
		if waiters, ok := m.waitChans[snapshot.ID]; ok {
			for _, w := range waiters {
				select {
				case w <- snapshot:
				default:
				}
				close(w)
			}
			delete(m.waitChans, snapshot.ID)
		}
		m.subMu.Unlock()
	}
}

// SubscribeJob registers a subscriber for real-time updates of a specific job ID.
func (m *CourseManager) SubscribeJob(jobID string) (chan *model.JobState, func()) {
	ch := make(chan *model.JobState, 64)
	m.subMu.Lock()
	if m.jobSubs[jobID] == nil {
		m.jobSubs[jobID] = make(map[chan *model.JobState]struct{})
	}
	m.jobSubs[jobID][ch] = struct{}{}
	m.subMu.Unlock()

	// Send current snapshot if job exists
	m.mu.RLock()
	if st, ok := m.jobs[jobID]; ok {
		snap := st.Clone()
		select {
		case ch <- snap:
		default:
		}
	}
	m.mu.RUnlock()

	unsub := func() {
		m.subMu.Lock()
		defer m.subMu.Unlock()
		if subs, ok := m.jobSubs[jobID]; ok {
			delete(subs, ch)
			if len(subs) == 0 {
				delete(m.jobSubs, jobID)
			}
		}
	}
	return ch, unsub
}

// SubscribeAll registers a subscriber receiving updates across all active jobs.
func (m *CourseManager) SubscribeAll() (chan *model.JobState, func()) {
	ch := make(chan *model.JobState, 128)
	m.subMu.Lock()
	m.allSubs[ch] = struct{}{}
	m.subMu.Unlock()

	unsub := func() {
		m.subMu.Lock()
		defer m.subMu.Unlock()
		delete(m.allSubs, ch)
	}
	return ch, unsub
}

// WaitForJob blocks until the specified job reaches a terminal phase (completed, failed, cancelled) or ctx expires.
func (m *CourseManager) WaitForJob(ctx context.Context, jobID string) (*model.JobState, error) {
	m.mu.RLock()
	st, exists := m.jobs[jobID]
	if !exists {
		m.mu.RUnlock()
		return nil, ErrJobNotFound
	}
	if st.Phase == model.PhaseCompleted || st.Phase == model.PhaseFailed || st.Phase == model.PhaseCancelled {
		snap := st.Clone()
		m.mu.RUnlock()
		return snap, nil
	}
	m.mu.RUnlock()

	waitCh := make(chan *model.JobState, 1)
	m.subMu.Lock()
	m.waitChans[jobID] = append(m.waitChans[jobID], waitCh)
	m.subMu.Unlock()

	defer func() {
		m.subMu.Lock()
		if list, ok := m.waitChans[jobID]; ok {
			var filtered []chan *model.JobState
			for _, w := range list {
				if w != waitCh {
					filtered = append(filtered, w)
				}
			}
			if len(filtered) == 0 {
				delete(m.waitChans, jobID)
			} else {
				m.waitChans[jobID] = filtered
			}
		}
		m.subMu.Unlock()
	}()

	// Double check state to avoid missing updates during lock transitions
	m.mu.RLock()
	st, exists = m.jobs[jobID]
	if exists && (st.Phase == model.PhaseCompleted || st.Phase == model.PhaseFailed || st.Phase == model.PhaseCancelled) {
		snap := st.Clone()
		m.mu.RUnlock()
		return snap, nil
	}
	m.mu.RUnlock()

	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case finalState, ok := <-waitCh:
		if !ok || finalState == nil {
			return m.GetJob(jobID)
		}
		return finalState, nil
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
	m.BroadcastJobUpdate(state)

	// Launch worker goroutine governed by course semaphore
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
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
			m.BroadcastJobUpdate(state)
			return
		}

		if ctx.Err() != nil {
			return
		}

		m.mu.Lock()
		state.Status = "running"
		state.UpdatedAt = time.Now()
		m.mu.Unlock()
		m.BroadcastJobUpdate(state)

		err := m.pipeline.Execute(ctx, req, state, func() {
			m.mu.Lock()
			state.UpdatedAt = time.Now()
			m.mu.Unlock()
			m.BroadcastJobUpdate(state)
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
			state.Uploaded = false
			if state.WorkDir != "" {
				_ = os.RemoveAll(state.WorkDir)
			}
		} else {
			log.Printf("✅ [Job %s] Job completed successfully!", jobID)
		}
		m.BroadcastJobUpdate(state)
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

	m.BroadcastJobUpdate(state)
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

	// Wait for any running worker goroutines to exit before removing storage directories
	m.wg.Wait()

	_ = os.RemoveAll(m.cfg.BaseWorkDir)
	_ = os.MkdirAll(m.cfg.BaseWorkDir, 0755)
	log.Printf("🧹 [Storage] Wiped all jobs and reset base work directory: %s", m.cfg.BaseWorkDir)
}

// Wait blocks until all running course worker goroutines finish.
func (m *CourseManager) Wait() {
	m.wg.Wait()
}
