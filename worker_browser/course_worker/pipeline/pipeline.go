package pipeline

import (
	"context"
	"fmt"
	"log"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"course-worker/config"
	"course-worker/downloader"
	"course-worker/extractor"
	"course-worker/model"
	"course-worker/packager"
	"course-worker/uploader"
)

type Pipeline struct {
	cfg        *config.Config
	downloader *downloader.Downloader
	extractor  *extractor.Extractor
	packager   *packager.Packager
	uploader   *uploader.DriveUploader
}

func NewPipeline(cfg *config.Config) *Pipeline {
	return &Pipeline{
		cfg:        cfg,
		downloader: downloader.NewDownloader(cfg),
		extractor:  extractor.NewExtractor(cfg),
		packager:   packager.NewPackager(cfg),
		uploader:   uploader.NewDriveUploader(cfg),
	}
}

// Execute runs the complete course pipeline:
// 1. Download archive parts concurrently
// 2. Extract multi-part volumes with password rotation
// 3. Reclaim disk by immediately deleting raw archive parts
// 4. Separate video files and non-video materials
// 5. Package materials into split 1GB zip volumes
func (p *Pipeline) Execute(
	ctx context.Context,
	req *model.CoursePayload,
	state *model.JobState,
	onUpdate func(),
) error {
	jobID := req.GetJobID()
	jobDir := filepath.Join(p.cfg.BaseWorkDir, jobID)
	partsDir := filepath.Join(jobDir, "parts")
	extractedDir := filepath.Join(jobDir, "extracted")
	outputDir := filepath.Join(jobDir, "output")

	state.WorkDir = jobDir
	state.OutputDir = outputDir

	// Clean-slate guarantee: Always purge any existing job directory before starting fresh
	_ = os.RemoveAll(jobDir)

	// Ensure clean directories
	for _, dir := range []string{partsDir, extractedDir, outputDir} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			return fmt.Errorf("failed to create directory %s: %w", dir, err)
		}
	}

	links := req.GetLinks()
	if len(links) == 0 {
		return fmt.Errorf("no download links provided for course %s", req.GetTitle())
	}

	// -------------------------------------------------------------
	// PRE-FLIGHT: PROBE LINKS FAST (FAIL-FAST ON 502 / 404 / DEAD HOST)
	// -------------------------------------------------------------
	log.Printf("🔍 [Job %s] Fast probing %d download link(s) for availability...", jobID, len(links))
	linkURLs := make([]string, len(links))
	for i, l := range links {
		linkURLs[i] = l.URL
	}
	if probeErr := p.downloader.ProbeAllLinks(ctx, linkURLs); probeErr != nil {
		state.Phase = model.PhaseFailed
		state.Status = "failed"
		if !strings.HasPrefix(probeErr.Error(), "link not working") {
			state.Error = fmt.Sprintf("link not working: %v", probeErr)
		} else {
			state.Error = probeErr.Error()
		}
		onUpdate()
		log.Printf("❌ [Job %s] Pre-flight link probe failed: %v. Aborting immediately without wasting resources.", jobID, state.Error)
		_ = os.RemoveAll(jobDir)
		return probeErr
	}
	log.Printf("✅ [Job %s] Pre-flight probe passed for all %d link(s).", jobID, len(links))

	// -------------------------------------------------------------
	// STAGE 1: CONCURRENT DOWNLOAD OF ARCHIVE PARTS
	// -------------------------------------------------------------
	state.Phase = model.PhaseDownloading
	state.Status = "downloading"
	state.TotalParts = len(links)
	state.Parts = make([]model.PartProgress, len(links))

	var totalExpectedBytes int64
	for i, link := range links {
		fname := path.Base(link.URL)
		if u, err := url.Parse(link.URL); err == nil && u.Path != "" {
			fname = path.Base(u.Path)
		}
		if fname == "" || fname == "." || fname == "/" {
			fname = fmt.Sprintf("part_%03d.rar", i+1)
		}

		state.Parts[i] = model.PartProgress{
			PartIndex:  i + 1,
			FileName:   fname,
			URL:        link.URL,
			DestPath:   filepath.Join(partsDir, fname),
			Status:     "pending",
			TotalBytes: link.Bytes,
		}
		totalExpectedBytes += link.Bytes
	}
	state.TotalBytes = totalExpectedBytes
	onUpdate()

	log.Printf("🚀 [Job %s] Starting Stage 1: Downloading %d part(s) (concurrency limit: %d)...",
		jobID, len(links), p.cfg.PartConcurrencyPerCourse)

	startDLTime := time.Now()
	sem := make(chan struct{}, p.cfg.PartConcurrencyPerCourse)
	var dlWg sync.WaitGroup
	var dlErrMu sync.Mutex
	var firstDLErr error

	// Create cancellable context for all part downloads of this course
	dlCtx, cancelDl := context.WithCancel(ctx)
	defer cancelDl()

	for i := range state.Parts {
		part := &state.Parts[i]
		dlWg.Add(1)

		go func(pRef *model.PartProgress) {
			defer dlWg.Done()

			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-dlCtx.Done():
				pRef.Status = "cancelled"
				return
			}

			if dlCtx.Err() != nil {
				pRef.Status = "cancelled"
				return
			}

			pRef.Status = "downloading"
			onUpdate()

			err := p.downloader.DownloadPart(dlCtx, pRef, func(dlBytes, totBytes int64, pct, speed float64) {
				pRef.DownloadedBytes = dlBytes
				if totBytes > 0 {
					pRef.TotalBytes = totBytes
				}
				pRef.Percent = pct
				pRef.SpeedBytesSec = speed

				// Recalculate aggregate progress
				var totalDL int64
				var completedCount int
				for _, pt := range state.Parts {
					totalDL += pt.DownloadedBytes
					if pt.Status == "completed" {
						completedCount++
					}
				}
				state.DownloadedBytes = totalDL
				state.CompletedParts = completedCount

				elapsed := time.Since(startDLTime).Seconds()
				if elapsed > 0 {
					state.SpeedMBps = (float64(totalDL) / (1024 * 1024)) / elapsed
				}
				if state.TotalBytes > 0 {
					state.ProgressPercent = (float64(totalDL) / float64(state.TotalBytes)) * 100.0
					if state.ProgressPercent > 100.0 {
						state.ProgressPercent = 100.0
					}
				} else if state.TotalParts > 0 {
					state.ProgressPercent = (float64(completedCount) / float64(state.TotalParts)) * 100.0
				}
				onUpdate()
			})

			if err != nil {
				pRef.Status = "failed"
				pRef.Error = err.Error()
				dlErrMu.Lock()
				if firstDLErr == nil {
					firstDLErr = err
					// Immediately cancel sibling downloads to stop wasting resources
					cancelDl()
				}
				dlErrMu.Unlock()
			} else {
				pRef.Status = "completed"
				pRef.Percent = 100.0
			}
			onUpdate()
		}(part)
	}

	dlWg.Wait()

	if ctx.Err() != nil {
		_ = os.RemoveAll(jobDir)
		return ctx.Err()
	}
	if firstDLErr != nil {
		log.Printf("❌ [Job %s] Download aborted due to error: %v. Purging files and skipping downstream stages.", jobID, firstDLErr)
		_ = os.RemoveAll(jobDir)
		return firstDLErr
	}

	log.Printf("🎉 [Job %s] All %d part(s) downloaded successfully in %.1fs!",
		jobID, len(links), time.Since(startDLTime).Seconds())

	// -------------------------------------------------------------
	// STAGE 2: EXTRACTION
	// -------------------------------------------------------------
	state.Phase = model.PhaseExtracting
	state.Status = "extracting"
	onUpdate()

	log.Printf("📦 [Job %s] Starting Stage 2: Extracting archives into %s...", jobID, extractedDir)

	pwd := req.GetPassword()
	if err := p.extractor.Extract(ctx, partsDir, extractedDir, pwd); err != nil {
		return fmt.Errorf("extraction stage failed: %w", err)
	}

	// -------------------------------------------------------------
	// STAGE 3: PART RECLAMATION (IMMEDIATE FREEING OF RAW PARTS)
	// -------------------------------------------------------------
	state.Phase = model.PhaseReclaiming
	state.Status = "reclaiming"
	onUpdate()

	log.Printf("🧹 [Job %s] Starting Stage 3: Reclaiming disk space by removing raw archive parts...", jobID)
	_ = os.RemoveAll(partsDir)

	// -------------------------------------------------------------
	// STAGE 4: SEPARATE & ZIP MATERIALS
	// -------------------------------------------------------------
	state.Phase = model.PhaseSeparating
	state.Status = "separating"
	onUpdate()

	log.Printf("🗂️ [Job %s] Starting Stage 4: Separating video files and packaging materials into 1GB split zips...", jobID)

	packRes, err := p.packager.SeparateAndZip(ctx, extractedDir, outputDir, req.GetTitle())
	if err != nil {
		return fmt.Errorf("packaging stage failed: %w", err)
	}

	// Cleanup extracted directory to save disk space
	_ = os.RemoveAll(extractedDir)

	// -------------------------------------------------------------
	// STAGE 5: GOOGLE DRIVE UPLOAD & RECLAMATION
	// -------------------------------------------------------------
	shouldUpload := p.cfg.AutoUploadDrive || (req.Drive != nil && (req.Drive.AutoUpload == nil || *req.Drive.AutoUpload))
	if shouldUpload {
		state.Phase = model.PhaseUploading
		state.Status = "uploading"
		onUpdate()

		log.Printf("☁️ [Job %s] Starting Stage 5: Uploading separated course files to Google Drive...", jobID)
		uploadedFiles, folderID, err := p.uploader.UploadOutputDirectory(ctx, outputDir, req.GetTitle(), req.Drive, state, onUpdate)
		if err != nil {
			return fmt.Errorf("google drive upload stage failed: %w", err)
		}
		state.DriveFolderID = folderID
		state.DriveFolderURL = fmt.Sprintf("https://drive.google.com/drive/folders/%s", folderID)
		state.DriveFiles = uploadedFiles
		log.Printf("🎉 [Job %s] Successfully uploaded %d file(s) to Google Drive folder %s",
			jobID, len(uploadedFiles), folderID)
	}

	// -------------------------------------------------------------
	// STAGE 6: FINAL READY STATE
	// -------------------------------------------------------------
	state.Phase = model.PhaseCompleted
	state.Status = "completed"
	state.VideoFiles = packRes.VideoFiles
	state.MaterialZips = packRes.MaterialZips
	now := time.Now()
	state.CompletedAt = &now
	state.ProgressPercent = 100.0
	onUpdate()

	log.Printf("🏁 [Job %s] Pipeline successfully completed! Output ready in %s (%d videos, %d material zip(s))",
		jobID, outputDir, len(packRes.VideoFiles), len(packRes.MaterialZips))

	// Clean slate: if uploaded to Google Drive, purge the local job directory
	if shouldUpload {
		_ = os.RemoveAll(jobDir)
		log.Printf("🧹 [Job %s] Purged local job directory after Google Drive upload", jobID)
	}

	return nil
}
