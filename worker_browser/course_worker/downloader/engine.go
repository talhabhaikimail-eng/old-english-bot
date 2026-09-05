package downloader

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"

	"course-worker/config"
	"course-worker/model"
)

var (
	ErrDownloadStalled      = errors.New("download stalled: no data or progress received within stall timeout")
	ErrDownloadTimedOut     = errors.New("download timed out: exceeded maximum duration")
	ErrInsufficientDisk     = errors.New("insufficient disk space: safety threshold reached")
	ErrEmptyFile            = errors.New("downloaded file is empty (0 bytes)")
	ErrIncompleteDownload   = errors.New("incomplete transfer: bytes downloaded less than total bytes")
)

type ProgressCallback func(downloadedBytes, totalBytes int64, percent, speedBytesSec float64)

type DLEngineEvent struct {
	Event            string  `json:"event"`
	Filename         string  `json:"filename,omitempty"`
	DestPath         string  `json:"dest_path,omitempty"`
	DownloadedBytes  int64   `json:"downloaded_bytes,omitempty"`
	TotalBytes       int64   `json:"total_bytes,omitempty"`
	Percent          float64 `json:"percent,omitempty"`
	SpeedBytesSec    float64 `json:"speed_bytes_sec,omitempty"`
	EtaSeconds       float64 `json:"eta_seconds,omitempty"`
	ElapsedSeconds   float64 `json:"elapsed_seconds,omitempty"`
	Message          string  `json:"message,omitempty"`
	StatusCode       int     `json:"status_code,omitempty"`
	AcceptRanges     bool    `json:"accept_ranges,omitempty"`
	TotalChunks      int     `json:"total_chunks,omitempty"`
}

type Downloader struct {
	cfg *config.Config
}

func NewDownloader(cfg *config.Config) *Downloader {
	return &Downloader{cfg: cfg}
}

// DownloadPart downloads a single part with retries, stall detection, and progress tracking.
func (d *Downloader) DownloadPart(
	ctx context.Context,
	part *model.PartProgress,
	onProgress ProgressCallback,
) error {
	maxRetries := 3
	var lastErr error

	for attempt := 1; attempt <= maxRetries; attempt++ {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		// Check disk space before every attempt
		freeBytes, err := config.GetDiskFreeBytes(part.DestPath)
		if err == nil && freeBytes < d.cfg.MinFreeDiskBytes {
			return fmt.Errorf("%w (free: %.2f GB, required min: %.2f GB)",
				ErrInsufficientDisk,
				float64(freeBytes)/(1024*1024*1024),
				float64(d.cfg.MinFreeDiskBytes)/(1024*1024*1024),
			)
		}

		log.Printf("📥 [%s] Downloading part %d/%s (attempt %d/%d)...",
			part.FileName, part.PartIndex, part.FileName, attempt, maxRetries)

		// Try dlengine first
		if d.isDLEngineAvailable() {
			err = d.runDLEngine(ctx, part, onProgress)
			if err == nil {
				// Verify file size
				if fi, statErr := os.Stat(part.DestPath); statErr == nil {
					if fi.Size() == 0 {
						os.Remove(part.DestPath)
						lastErr = ErrEmptyFile
						continue
					}
					part.DownloadedBytes = fi.Size()
					if part.TotalBytes > 0 && fi.Size() < part.TotalBytes {
						lastErr = fmt.Errorf("%w (%d / %d bytes)", ErrIncompleteDownload, fi.Size(), part.TotalBytes)
						continue
					}
					log.Printf("✅ [%s] Part successfully downloaded via dlengine (%d bytes)", part.FileName, fi.Size())
					return nil
				}
			}
			lastErr = err
			if IsFatalLinkError(err) {
				log.Printf("❌ [%s] Fatal link error from dlengine: %v. Aborting immediately.", part.FileName, err)
				return fmt.Errorf("%w: %v", ErrLinkNotWorking, err)
			}
			log.Printf("⚠️ [%s] dlengine attempt %d failed: %v", part.FileName, attempt, err)
		} else {
			log.Printf("ℹ️ [%s] dlengine not found; using fallback native HTTP downloader", part.FileName)
		}

		// Fallback to resilient native HTTP downloader
		err = d.runFallbackHTTP(ctx, part, onProgress)
		if err == nil {
			if fi, statErr := os.Stat(part.DestPath); statErr == nil && fi.Size() > 0 {
				part.DownloadedBytes = fi.Size()
				log.Printf("✅ [%s] Part successfully downloaded via fallback HTTP (%d bytes)", part.FileName, fi.Size())
				return nil
			}
		}
		lastErr = err
		if IsFatalLinkError(err) {
			log.Printf("❌ [%s] Fatal link error from fallback HTTP: %v. Aborting immediately.", part.FileName, err)
			return fmt.Errorf("%w: %v", ErrLinkNotWorking, err)
		}
		log.Printf("⚠️ [%s] Fallback HTTP attempt %d failed: %v", part.FileName, attempt, err)

		// Exponential backoff
		if attempt < maxRetries {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(time.Duration(attempt*2) * time.Second):
			}
		}
	}

	return fmt.Errorf("failed to download %s after %d attempts: %w", part.FileName, maxRetries, lastErr)
}

func (d *Downloader) isDLEngineAvailable() bool {
	if d.cfg.DLEnginePath == "" {
		return false
	}
	fi, err := os.Stat(d.cfg.DLEnginePath)
	return err == nil && !fi.IsDir()
}

func (d *Downloader) runDLEngine(
	ctx context.Context,
	part *model.PartProgress,
	onProgress ProgressCallback,
) error {
	partCtx, cancel := context.WithTimeout(ctx, d.cfg.DownloadPartTimeout)
	defer cancel()

	args := []string{
		"-u", part.URL,
		"-c", fmt.Sprintf("%d", d.cfg.DLConcurrencyPerPart),
		"-s", "8MB",
		"-r", "5",
		"-o", part.DestPath,
		"--json",
		"-H", "Referer: https://downloadlynet.ir/",
		"-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
	}

	cmd := exec.CommandContext(partCtx, d.cfg.DLEnginePath, args...)
	// Set process group so we can kill all subprocesses cleanly
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process != nil {
			return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		}
		return nil
	}
	cmd.WaitDelay = 2 * time.Second

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}

	if err := cmd.Start(); err != nil {
		return err
	}

	var mu sync.Mutex
	lastActivity := time.Now()
	var lastEngineErr string
	completed := false

	// Stall watchdog goroutine
	doneChan := make(chan struct{})
	defer close(doneChan)

	go func() {
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()

		for {
			select {
			case <-doneChan:
				return
			case <-ticker.C:
				mu.Lock()
				elapsedSinceActivity := time.Since(lastActivity)
				mu.Unlock()

				if elapsedSinceActivity > d.cfg.DownloadStallTimeout {
					log.Printf("⏱️ [%s] Stall detected (no progress for %.1fs > %.1fs). Terminating dlengine process.",
						part.FileName, elapsedSinceActivity.Seconds(), d.cfg.DownloadStallTimeout.Seconds())
					if cmd.Process != nil {
						_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
					}
					return
				}
			}
		}
	}()

	// Read stderr in background
	go func() {
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			text := scanner.Text()
			if text != "" {
				mu.Lock()
				lastEngineErr = text
				mu.Unlock()
				if IsFatalLinkError(errors.New(text)) {
					log.Printf("⚡ [%s] Fatal link error detected in dlengine stderr: %s. Terminating dlengine immediately.", part.FileName, text)
					if cmd.Process != nil {
						_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
					}
				}
			}
		}
	}()

	// Parse JSON lines from stdout
	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		var ev DLEngineEvent
		if err := json.Unmarshal(line, &ev); err != nil {
			continue
		}

		mu.Lock()
		lastActivity = time.Now()
		mu.Unlock()

		switch ev.Event {
		case "progress":
			if onProgress != nil {
				onProgress(ev.DownloadedBytes, ev.TotalBytes, ev.Percent, ev.SpeedBytesSec)
			}
		case "completed":
			completed = true
			if onProgress != nil {
				onProgress(ev.TotalBytes, ev.TotalBytes, 100.0, ev.SpeedBytesSec)
			}
		case "error":
			mu.Lock()
			lastEngineErr = ev.Message
			mu.Unlock()
			if IsFatalLinkError(errors.New(ev.Message)) {
				log.Printf("⚡ [%s] Fatal link error event from dlengine: %s. Terminating dlengine immediately.", part.FileName, ev.Message)
				if cmd.Process != nil {
					_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
				}
			}
		}
	}

	// Wait for process to exit
	waitErr := cmd.Wait()

	if partCtx.Err() == context.DeadlineExceeded {
		return ErrDownloadTimedOut
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}

	mu.Lock()
	stalled := time.Since(lastActivity) > d.cfg.DownloadStallTimeout
	errMsg := lastEngineErr
	mu.Unlock()

	if IsFatalLinkError(errors.New(errMsg)) {
		return fmt.Errorf("%w: %s", ErrLinkNotWorking, errMsg)
	}

	if stalled {
		return ErrDownloadStalled
	}

	if waitErr != nil && !completed {
		if errMsg != "" {
			err := fmt.Errorf("dlengine failed (%v): %s", waitErr, errMsg)
			if IsFatalLinkError(err) {
				return fmt.Errorf("%w: %s", ErrLinkNotWorking, errMsg)
			}
			return err
		}
		if IsFatalLinkError(waitErr) {
			return fmt.Errorf("%w: %v", ErrLinkNotWorking, waitErr)
		}
		return fmt.Errorf("dlengine exited with error: %w", waitErr)
	}

	return nil
}
