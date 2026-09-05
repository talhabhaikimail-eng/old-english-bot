package pipeline

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"course-worker/config"
	"course-worker/model"
)

func TestFullPipelineIntegration(t *testing.T) {
	// 1. Setup temporary source directory with videos and non-video materials
	sourceDir := t.TempDir()
	_ = os.WriteFile(filepath.Join(sourceDir, "lecture01.mp4"), []byte("video lecture 1 data"), 0644)
	subDir := filepath.Join(sourceDir, "Section 2")
	_ = os.MkdirAll(subDir, 0755)
	_ = os.WriteFile(filepath.Join(subDir, "lecture02.mkv"), []byte("video lecture 2 data"), 0644)
	_ = os.WriteFile(filepath.Join(sourceDir, "readme.txt"), []byte("course instructions"), 0644)
	_ = os.WriteFile(filepath.Join(subDir, "exercise.py"), []byte("def solve(): pass"), 0644)

	// 2. Create multi-part archive using 7z with password 'www.downloadly.ir'
	archiveStagingDir := t.TempDir()
	baseArchiveName := "Udemy_OOPs_Test_2024.part1_Downloadly.ir.7z"
	archivePath := filepath.Join(archiveStagingDir, baseArchiveName)

	p7z, err := exec.LookPath("7z")
	if err != nil {
		t.Skip("7z not available on system, skipping integration test")
	}

	cmd := exec.Command(p7z, "a", "-t7z", "-pwww.downloadly.ir", "-v100k", "-y", archivePath, "*")
	cmd.Dir = sourceDir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("failed to create test multi-part 7z archive: %v (%s)", err, string(out))
	}

	// 3. Serve archive parts via httptest.Server
	archiveFiles, _ := os.ReadDir(archiveStagingDir)
	var downloadLinks []model.DownloadLink

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		filename := filepath.Base(r.URL.Path)
		filePath := filepath.Join(archiveStagingDir, filename)
		http.ServeFile(w, r, filePath)
	}))
	defer ts.Close()

	for i, f := range archiveFiles {
		fi, _ := f.Info()
		downloadLinks = append(downloadLinks, model.DownloadLink{
			URL:      fmt.Sprintf("%s/%s", ts.URL, f.Name()),
			Part:     i + 1,
			Text:     f.Name(),
			Bytes:    fi.Size(),
			SizeText: fmt.Sprintf("%d B", fi.Size()),
		})
	}

	// 4. Configure Course Worker Pipeline
	cfg := config.LoadConfig()
	cfg.BaseWorkDir = t.TempDir()
	cfg.PartConcurrencyPerCourse = 2
	cfg.DLConcurrencyPerPart = 4
	cfg.MinFreeDiskBytes = 1024 * 1024 // 1 MB min for test

	p := NewPipeline(cfg)

	payload := &model.CoursePayload{
		ID:            "test-integration-course-001",
		Title:         "Udemy - OOPs in Python Test",
		Slug:          "oops-in-python-test",
		FilePassword:  "www.downloadly.ir",
		DownloadLinks: downloadLinks,
	}

	state := &model.JobState{
		ID:        payload.ID,
		Title:     payload.Title,
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}

	// 5. Execute Pipeline
	err = p.Execute(context.Background(), payload, state, func() {})
	if err != nil {
		t.Fatalf("pipeline execution failed: %v", err)
	}

	// 6. Verify Results
	if state.Phase != model.PhaseCompleted {
		t.Fatalf("expected phase to be completed, got %s", state.Phase)
	}

	// Verify Video Files in Output
	if len(state.VideoFiles) != 2 {
		t.Fatalf("expected 2 video files, got %d", len(state.VideoFiles))
	}
	for _, v := range state.VideoFiles {
		fullPath := filepath.Join(state.OutputDir, v.RelPath)
		if _, err := os.Stat(fullPath); os.IsNotExist(err) {
			t.Fatalf("video file %s does not exist on disk", fullPath)
		}
	}

	// Verify Material Zip(s) in Output
	if len(state.MaterialZips) == 0 {
		t.Fatalf("expected at least 1 material zip, got 0")
	}
	for _, m := range state.MaterialZips {
		fullPath := filepath.Join(state.OutputDir, m.RelPath)
		if _, err := os.Stat(fullPath); os.IsNotExist(err) {
			t.Fatalf("material zip %s does not exist on disk", fullPath)
		}
	}

	// Verify Manifest exists
	manifestPath := filepath.Join(state.OutputDir, "manifest.json")
	if _, err := os.Stat(manifestPath); os.IsNotExist(err) {
		t.Fatalf("manifest.json was not generated at %s", manifestPath)
	}

	// Verify parts directory was cleaned up (reclaimed)
	partsDir := filepath.Join(state.WorkDir, "parts")
	if _, err := os.Stat(partsDir); !os.IsNotExist(err) {
		t.Fatalf("parts directory was not purged: %s", partsDir)
	}
}
