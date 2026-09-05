package downloader

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"course-worker/config"
	"course-worker/model"
)

func (d *Downloader) runFallbackHTTP(
	ctx context.Context,
	part *model.PartProgress,
	onProgress ProgressCallback,
) error {
	partCtx, cancel := context.WithTimeout(ctx, d.cfg.DownloadPartTimeout)
	defer cancel()

	var existingBytes int64
	if fi, err := os.Stat(part.DestPath); err == nil {
		existingBytes = fi.Size()
	}

	req, err := http.NewRequestWithContext(partCtx, "GET", part.URL, nil)
	if err != nil {
		return err
	}

	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
	req.Header.Set("Referer", "https://downloadlynet.ir/")

	if existingBytes > 0 {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-", existingBytes))
	}

	client := &http.Client{
		Timeout: 0, // Timeout handled via context and stall watchdog
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return fmt.Errorf("stopped after 10 redirects")
			}
			req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
			req.Header.Set("Referer", "https://downloadlynet.ir/")
			return nil
		},
	}

	resp, err := client.Do(req)
	if err != nil {
		if IsFatalLinkError(err) {
			return fmt.Errorf("%w: %v", ErrLinkNotWorking, err)
		}
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPartialContent {
		if resp.StatusCode == 502 || resp.StatusCode == 503 || resp.StatusCode == 504 ||
			resp.StatusCode == 404 || resp.StatusCode == 403 || resp.StatusCode == 410 ||
			resp.StatusCode >= 500 {
			return fmt.Errorf("%w: CDN responded with HTTP %d (%s)", ErrLinkNotWorking, resp.StatusCode, resp.Status)
		}
		return fmt.Errorf("CDN responded with HTTP %d", resp.StatusCode)
	}

	isResumed := resp.StatusCode == http.StatusPartialContent
	var flags int
	var currentDownloaded int64
	if isResumed {
		flags = os.O_CREATE | os.O_WRONLY | os.O_APPEND
		currentDownloaded = existingBytes
	} else {
		flags = os.O_CREATE | os.O_WRONLY | os.O_TRUNC
		currentDownloaded = 0
	}

	totalBytes := currentDownloaded
	if cr := resp.Header.Get("Content-Range"); cr != "" && strings.Contains(cr, "/") {
		parts := strings.Split(cr, "/")
		if len(parts) == 2 {
			if n, err := strconv.ParseInt(strings.TrimSpace(parts[1]), 10, 64); err == nil {
				totalBytes = n
			}
		}
	} else if cl := resp.Header.Get("Content-Length"); cl != "" {
		if n, err := strconv.ParseInt(strings.TrimSpace(cl), 10, 64); err == nil {
			totalBytes = currentDownloaded + n
		}
	}

	out, err := os.OpenFile(part.DestPath, flags, 0644)
	if err != nil {
		return err
	}
	defer out.Close()

	buf := make([]byte, 128*1024) // 128KB buffer
	startTime := time.Now()
	lastReportTime := time.Now()
	lastCheckDiskTime := time.Now()
	lastActivity := time.Now()

	for {
		select {
		case <-partCtx.Done():
			return partCtx.Err()
		default:
		}

		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			lastActivity = time.Now()
			if _, writeErr := out.Write(buf[:n]); writeErr != nil {
				return writeErr
			}
			currentDownloaded += int64(n)

			now := time.Now()
			// Progress report throttled to ~500ms
			if now.Sub(lastReportTime) >= 500*time.Millisecond {
				lastReportTime = now
				elapsedSec := now.Sub(startTime).Seconds()
				var speed float64
				if elapsedSec > 0 {
					speed = float64(currentDownloaded-existingBytes) / elapsedSec
				}
				var pct float64
				if totalBytes > 0 {
					pct = (float64(currentDownloaded) / float64(totalBytes)) * 100.0
				}
				if onProgress != nil {
					onProgress(currentDownloaded, totalBytes, pct, speed)
				}
			}

			// Disk space check every 5 seconds
			if now.Sub(lastCheckDiskTime) >= 5*time.Second {
				lastCheckDiskTime = now
				freeBytes, diskErr := config.GetDiskFreeBytes(part.DestPath)
				if diskErr == nil && freeBytes < d.cfg.MinFreeDiskBytes {
					return ErrInsufficientDisk
				}
			}
		}

		if readErr != nil {
			if readErr == io.EOF {
				break
			}
			return readErr
		}

		// Stall detection
		if time.Since(lastActivity) > d.cfg.DownloadStallTimeout {
			return ErrDownloadStalled
		}
	}

	if totalBytes > 0 && currentDownloaded < totalBytes {
		return fmt.Errorf("%w: received %d / %d bytes", ErrIncompleteDownload, currentDownloaded, totalBytes)
	}

	if onProgress != nil {
		onProgress(currentDownloaded, totalBytes, 100.0, 0)
	}

	return nil
}
