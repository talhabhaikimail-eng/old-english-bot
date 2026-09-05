package packager

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestSeparateAndZip(t *testing.T) {
	extractedDir, err := os.MkdirTemp("", "extracted_*")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(extractedDir)

	outputDir, err := os.MkdirTemp("", "output_*")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(outputDir)

	// Create test video file
	videoFile := filepath.Join(extractedDir, "01-intro.mp4")
	_ = os.WriteFile(videoFile, []byte("fake video content"), 0644)

	// Create test material files (code, slides)
	materialFile1 := filepath.Join(extractedDir, "script.py")
	_ = os.WriteFile(materialFile1, []byte("print('hello world')"), 0644)

	materialSubDir := filepath.Join(extractedDir, "assets")
	_ = os.MkdirAll(materialSubDir, 0755)
	materialFile2 := filepath.Join(materialSubDir, "diagram.png")
	_ = os.WriteFile(materialFile2, []byte("fake png image bytes"), 0644)

	p := NewPackager(nil)
	res, err := p.SeparateAndZip(context.Background(), extractedDir, outputDir, "TestCourse")
	if err != nil {
		t.Fatalf("SeparateAndZip failed: %v", err)
	}

	if len(res.VideoFiles) != 1 {
		t.Fatalf("expected 1 video file, got %d", len(res.VideoFiles))
	}
	if res.VideoFiles[0].FileName != "01-intro.mp4" {
		t.Fatalf("expected video 01-intro.mp4, got %s", res.VideoFiles[0].FileName)
	}

	if len(res.MaterialZips) == 0 {
		t.Fatalf("expected at least 1 material zip file, got %d", len(res.MaterialZips))
	}

	// Verify manifest exists
	if res.ManifestPath == "" {
		t.Fatalf("expected manifestPath to be set")
	}
	if _, err := os.Stat(res.ManifestPath); os.IsNotExist(err) {
		t.Fatalf("manifest file does not exist at %s", res.ManifestPath)
	}
}
