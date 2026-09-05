package packager

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"

	"course-worker/config"
	"course-worker/model"
)

var videoExtensions = map[string]bool{
	".mp4":  true,
	".mkv":  true,
	".webm": true,
	".mov":  true,
	".avi":  true,
	".flv":  true,
	".wmv":  true,
	".m4v":  true,
	".ts":   true,
}

type Packager struct {
	cfg *config.Config
}

func NewPackager(cfg *config.Config) *Packager {
	return &Packager{cfg: cfg}
}

type PackagingResult struct {
	VideoFiles   []model.FileInfo `json:"videoFiles"`
	MaterialZips []model.FileInfo `json:"materialZips"`
	ManifestPath string           `json:"manifestPath"`
	TotalBytes   int64            `json:"totalBytes"`
}

// SeparateAndZip separates video files from non-video course materials,
// packages materials into split 1GB zip volumes, and cleans up raw materials.
func (p *Packager) SeparateAndZip(
	ctx context.Context,
	extractedDir string,
	outputDir string,
	courseTitle string,
) (*PackagingResult, error) {
	if err := os.MkdirAll(outputDir, 0755); err != nil {
		return nil, err
	}

	// 1. Unwrap single top-level directory if present
	scanDir := extractedDir
	entries, err := os.ReadDir(extractedDir)
	if err == nil {
		var validEntries []os.DirEntry
		for _, e := range entries {
			name := e.Name()
			if !strings.HasPrefix(name, ".") && name != "__MACOSX" && name != "Thumbs.db" {
				validEntries = append(validEntries, e)
			}
		}
		if len(validEntries) == 1 && validEntries[0].IsDir() {
			scanDir = filepath.Join(extractedDir, validEntries[0].Name())
			log.Printf("📁 Unwrapped single top-level directory: '%s'", validEntries[0].Name())
		}
	}

	// 2. Scan and classify files into videos and materials
	var videoPaths []string
	var materialPaths []string

	err = filepath.WalkDir(scanDir, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil || d.IsDir() {
			return nil
		}
		ext := strings.ToLower(filepath.Ext(path))
		if videoExtensions[ext] {
			videoPaths = append(videoPaths, path)
		} else {
			materialPaths = append(materialPaths, path)
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("failed to scan extracted files: %w", err)
	}

	log.Printf("📊 Discovered %d video file(s) and %d non-video material file(s)",
		len(videoPaths), len(materialPaths))

	res := &PackagingResult{}
	videosDir := filepath.Join(outputDir, "videos")
	materialsDir := filepath.Join(outputDir, "materials")
	stagingDir := filepath.Join(outputDir, "staging")

	if err := os.MkdirAll(videosDir, 0755); err != nil {
		return nil, err
	}

	// 3. Move video files preserving relative path structure
	for _, vPath := range videoPaths {
		relPath, _ := filepath.Rel(scanDir, vPath)
		destPath := filepath.Join(videosDir, relPath)

		if err := os.MkdirAll(filepath.Dir(destPath), 0755); err != nil {
			return nil, err
		}

		if err := os.Rename(vPath, destPath); err != nil {
			// Fallback to copy if cross-device
			if err := copyFile(vPath, destPath); err != nil {
				return nil, fmt.Errorf("failed to move video file: %w", err)
			}
			_ = os.Remove(vPath)
		}

		fi, err := os.Stat(destPath)
		var size int64
		if err == nil {
			size = fi.Size()
		}

		res.VideoFiles = append(res.VideoFiles, model.FileInfo{
			RelPath:   filepath.Join("videos", relPath),
			FileName:  filepath.Base(destPath),
			SizeBytes: size,
			IsVideo:   true,
		})
		res.TotalBytes += size
	}

	// 4. Package materials into 1GB split zip archives if materials exist
	if len(materialPaths) > 0 {
		if err := os.MkdirAll(materialsDir, 0755); err != nil {
			return nil, err
		}
		if err := os.MkdirAll(stagingDir, 0755); err != nil {
			return nil, err
		}
		defer os.RemoveAll(stagingDir)

		safeTitle := sanitizeFilename(courseTitle)
		if safeTitle == "" {
			safeTitle = "Course"
		}
		baseZipName := fmt.Sprintf("%s_Materials.zip", safeTitle)
		zipOutPath := filepath.Join(stagingDir, baseZipName)

		// Create filelist.txt
		filelistPath := filepath.Join(stagingDir, "filelist.txt")
		fl, err := os.Create(filelistPath)
		if err != nil {
			return nil, err
		}

		var totalMaterialBytes int64
		for _, mPath := range materialPaths {
			relPath, _ := filepath.Rel(scanDir, mPath)
			_, _ = fl.WriteString(relPath + "\n")
			if fi, err := os.Stat(mPath); err == nil {
				totalMaterialBytes += fi.Size()
			}
		}
		_ = fl.Close()

		log.Printf("📦 Packaging %d material file(s) (%.2f MB) into 1GB split zip archives...",
			len(materialPaths), float64(totalMaterialBytes)/(1024*1024))

		// Try 7z with 1024m split
		var zipSuccess bool
		if p7z, err := exec.LookPath("7z"); err == nil {
			cmd := exec.CommandContext(ctx, p7z,
				"a", "-tzip", "-v1024m", "-mmt=on", "-y",
				zipOutPath,
				"@"+filelistPath,
			)
			cmd.Dir = scanDir
			cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

			out, cmdErr := cmd.CombinedOutput()
			if cmdErr == nil {
				zipSuccess = true
				log.Printf("🎉 7z successfully packaged materials!")
			} else {
				log.Printf("⚠️ 7z packaging failed (%v): %s", cmdErr, string(out))
			}
		}

		// Fallback to zip tool if 7z failed or missing
		if !zipSuccess {
			if pZip, err := exec.LookPath("zip"); err == nil {
				cmd := exec.CommandContext(ctx, pZip,
					"-s", "1024m", "-r", zipOutPath,
					"-@",
				)
				cmd.Dir = scanDir
				cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

				fileInput, err := os.Open(filelistPath)
				if err == nil {
					cmd.Stdin = fileInput
					out, cmdErr := cmd.CombinedOutput()
					fileInput.Close()
					if cmdErr == nil {
						zipSuccess = true
						log.Printf("🎉 Standard zip tool successfully packaged materials!")
					} else {
						log.Printf("⚠️ Zip fallback failed (%v): %s", cmdErr, string(out))
					}
				}
			}
		}

		if !zipSuccess {
			return nil, fmt.Errorf("failed to package non-video materials into zip archives")
		}

		// Single volume normalization: if only .zip.001 exists and no .zip.002, rename .zip.001 -> .zip
		singleVol := zipOutPath + ".001"
		secondVol := zipOutPath + ".002"
		if _, err := os.Stat(singleVol); err == nil {
			if _, err2 := os.Stat(secondVol); os.IsNotExist(err2) {
				_ = os.Rename(singleVol, zipOutPath)
				log.Printf("🔄 Normalized single split volume %s -> %s", filepath.Base(singleVol), filepath.Base(zipOutPath))
			}
		}

		// Move generated zip files to materials directory
		zipEntries, _ := os.ReadDir(stagingDir)
		for _, ze := range zipEntries {
			if ze.Name() == "filelist.txt" || ze.IsDir() {
				continue
			}
			src := filepath.Join(stagingDir, ze.Name())
			dest := filepath.Join(materialsDir, ze.Name())
			_ = os.Rename(src, dest)

			fi, _ := os.Stat(dest)
			var sz int64
			if fi != nil {
				sz = fi.Size()
			}
			res.MaterialZips = append(res.MaterialZips, model.FileInfo{
				RelPath:   filepath.Join("materials", ze.Name()),
				FileName:  ze.Name(),
				SizeBytes: sz,
				IsZipPart: true,
			})
			res.TotalBytes += sz
		}

		// Reclaim disk: remove original source material files
		for _, mPath := range materialPaths {
			_ = os.Remove(mPath)
		}
		log.Printf("🧹 Reclaimed disk space by deleting %d raw source material files", len(materialPaths))
	}

	// 5. Generate manifest.json in output directory
	manifest := map[string]interface{}{
		"courseTitle":  courseTitle,
		"status":       "ready_for_upload",
		"totalFiles":   len(res.VideoFiles) + len(res.MaterialZips),
		"totalBytes":   res.TotalBytes,
		"videoFiles":   res.VideoFiles,
		"materialZips": res.MaterialZips,
	}

	manifestBytes, err := json.MarshalIndent(manifest, "", "  ")
	if err == nil {
		manifestPath := filepath.Join(outputDir, "manifest.json")
		_ = os.WriteFile(manifestPath, manifestBytes, 0644)
		res.ManifestPath = manifestPath
	}

	log.Printf("✅ Packaging completed: %d videos, %d material zip(s), total %.2f MB",
		len(res.VideoFiles), len(res.MaterialZips), float64(res.TotalBytes)/(1024*1024))

	return res, nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()

	_, err = out.ReadFrom(in)
	return err
}

func sanitizeFilename(name string) string {
	reg := regexp.MustCompile(`[\\/*?:"<>|]`)
	cleaned := reg.ReplaceAllString(name, "")
	return strings.TrimSpace(cleaned)
}
