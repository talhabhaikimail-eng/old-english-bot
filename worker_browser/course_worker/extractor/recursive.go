package extractor

import (
	"context"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"
)

var nestedArchiveExts = []string{
	".zip", ".rar", ".7z", ".tar.gz", ".tar.bz2",
	".tgz", ".tar", ".7z.001", ".zip.001",
}

func (e *Extractor) RecursiveExtract(
	ctx context.Context,
	rootDir string,
	passwords []string,
	maxDepth int,
) error {
	for depth := 1; depth <= maxDepth; depth++ {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		var nestedArchives []string
		err := filepath.WalkDir(rootDir, func(path string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return nil
			}
			lower := strings.ToLower(path)
			for _, ext := range nestedArchiveExts {
				if strings.HasSuffix(lower, ext) {
					nestedArchives = append(nestedArchives, path)
					break
				}
			}
			return nil
		})
		if err != nil {
			return err
		}

		if len(nestedArchives) == 0 {
			break
		}

		log.Printf("🔄 Found %d nested archive(s) (depth %d/%d). Unpacking...", len(nestedArchives), depth, maxDepth)

		for _, archPath := range nestedArchives {
			select {
			case <-ctx.Done():
				return ctx.Err()
			default:
			}

			destDir := filepath.Dir(archPath)
			log.Printf("📦 Unpacking nested archive: %s", filepath.Base(archPath))
			if err := e.extractSingleArchive(ctx, archPath, destDir, passwords); err != nil {
				log.Printf("⚠️ Nested archive extraction failed for %s: %v", archPath, err)
			} else {
				// Delete inner archive after extraction
				_ = os.Remove(archPath)
				log.Printf("🗑️ Removed inner archive: %s", filepath.Base(archPath))
			}
		}
	}

	return nil
}
