package main

import (
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// writeFileAtomic writes via a temp file + rename so a restart mid-write can't leave a truncated JSON file
// that would then be tarred into R2.
func writeFileAtomic(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(path)
		if err2 := os.Rename(tmp, path); err2 != nil {
			return err2
		}
	}
	return nil
}

// ── Debounced Cloudflare R2 state sync ──────────────────────────────────────

type R2Status struct {
	LastAttempt time.Time `json:"lastAttempt"`
	LastSuccess time.Time `json:"lastSuccess"`
	LastError   string    `json:"lastError,omitempty"`
	Pending     bool      `json:"pending"`
}

var (
	r2Kick   = make(chan struct{}, 1)
	r2Mu     sync.Mutex
	r2Status R2Status
	r2Run    sync.Mutex // serialises uploads (they share one temp tarball)
)

// scheduleR2Sync coalesces many state writes into a single upload a few seconds later.
func scheduleR2Sync() {
	r2Mu.Lock()
	r2Status.Pending = true
	r2Mu.Unlock()
	select {
	case r2Kick <- struct{}{}:
	default:
	}
}

func startR2SyncWorker() {
	for range r2Kick {
		time.Sleep(3 * time.Second)
		select { // drain kicks that arrived during the delay
		case <-r2Kick:
		default:
		}
		_ = flushR2Sync()
	}
}

// flushR2Sync uploads state immediately (also used on shutdown).
func flushR2Sync() error {
	r2Run.Lock()
	defer r2Run.Unlock()

	r2Mu.Lock()
	r2Status.Pending = false
	r2Status.LastAttempt = time.Now()
	r2Mu.Unlock()

	err := backupStateToR2()

	r2Mu.Lock()
	defer r2Mu.Unlock()
	if err != nil {
		r2Status.LastError = err.Error()
		log.Printf("❌ Failed to sync state to R2: %v", err)
	} else {
		r2Status.LastError = ""
		r2Status.LastSuccess = time.Now()
	}
	return err
}

func getR2Status() R2Status {
	r2Mu.Lock()
	defer r2Mu.Unlock()
	return r2Status
}
