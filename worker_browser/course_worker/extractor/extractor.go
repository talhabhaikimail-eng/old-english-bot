package extractor

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"

	"course-worker/config"
)

var volumeRegex = regexp.MustCompile(`(?i)\.part(\d+)_([^/\\]+)\.(rar|7z|zip)$`)

type Extractor struct {
	cfg *config.Config
}

func NewExtractor(cfg *config.Config) *Extractor {
	return &Extractor{cfg: cfg}
}

// NormalizeVolumes renames split archive files like:
// "Course.part1_Downloadly.ir.rar" -> "Course_Downloadly.ir.part1.rar"
// so that unrar and 7z can automatically discover subsequent volumes.
func (e *Extractor) NormalizeVolumes(partsDir string) error {
	entries, err := os.ReadDir(partsDir)
	if err != nil {
		return err
	}

	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		oldName := entry.Name()
		if volumeRegex.MatchString(oldName) {
			newName := volumeRegex.ReplaceAllString(oldName, `_${2}.part${1}.${3}`)
			oldPath := filepath.Join(partsDir, oldName)
			newPath := filepath.Join(partsDir, newName)
			if oldPath != newPath {
				if _, err := os.Stat(newPath); os.IsNotExist(err) {
					if err := os.Rename(oldPath, newPath); err == nil {
						log.Printf("🔄 Normalized volume filename: '%s' -> '%s'", oldName, newName)
					}
				}
			}
		}
	}
	return nil
}

// NaturalSort sorts strings by natural alphanumeric order (e.g. part1 before part2 before part10)
func NaturalSort(slice []string) {
	re := regexp.MustCompile(`\d+|\D+`)
	sort.Slice(slice, func(i, j int) bool {
		partsA := re.FindAllString(strings.ToLower(slice[i]), -1)
		partsB := re.FindAllString(strings.ToLower(slice[j]), -1)
		minLen := len(partsA)
		if len(partsB) < minLen {
			minLen = len(partsB)
		}
		for k := 0; k < minLen; k++ {
			a, b := partsA[k], partsB[k]
			numA, errA := strconv.ParseInt(a, 10, 64)
			numB, errB := strconv.ParseInt(b, 10, 64)
			if errA == nil && errB == nil {
				if numA != numB {
					return numA < numB
				}
			} else if a != b {
				return a < b
			}
		}
		return len(partsA) < len(partsB)
	})
}

// FindPrimaryArchive selects the first volume to start extraction.
func (e *Extractor) FindPrimaryArchive(partsDir string) (string, error) {
	entries, err := os.ReadDir(partsDir)
	if err != nil {
		return "", err
	}

	var filenames []string
	for _, entry := range entries {
		if !entry.IsDir() {
			filenames = append(filenames, entry.Name())
		}
	}

	if len(filenames) == 0 {
		return "", fmt.Errorf("no archive parts found in %s", partsDir)
	}

	NaturalSort(filenames)

	primaryPatterns := []*regexp.Regexp{
		regexp.MustCompile(`(?i)\.(part0*1|r00|001)\.(rar|7z|zip)$`),
		regexp.MustCompile(`(?i)\.part0*1\.`),
		regexp.MustCompile(`(?i)\.7z\.001$`),
		regexp.MustCompile(`(?i)\.001$`),
	}

	for _, pattern := range primaryPatterns {
		for _, f := range filenames {
			if pattern.MatchString(f) {
				return filepath.Join(partsDir, f), nil
			}
		}
	}

	// Fallback to first archive extension
	extPatterns := []string{".rar", ".zip", ".7z", ".tar.gz", ".tar"}
	for _, ext := range extPatterns {
		for _, f := range filenames {
			if strings.HasSuffix(strings.ToLower(f), ext) {
				return filepath.Join(partsDir, f), nil
			}
		}
	}

	return filepath.Join(partsDir, filenames[0]), nil
}

// Extract extracts the multi-part archive into outputDir using unrar / 7z / unar
// with password rotation and recursive nested archive unpacking.
func (e *Extractor) Extract(
	ctx context.Context,
	partsDir, outputDir string,
	userPassword string,
) error {
	if err := os.MkdirAll(outputDir, 0755); err != nil {
		return err
	}

	// 1. Normalize split volume filenames
	if err := e.NormalizeVolumes(partsDir); err != nil {
		log.Printf("⚠️ Volume normalization error: %v", err)
	}

	// 2. Locate primary archive
	primaryArchive, err := e.FindPrimaryArchive(partsDir)
	if err != nil {
		return err
	}

	log.Printf("📦 Primary archive detected for extraction: %s", filepath.Base(primaryArchive))

	// 3. Build password list
	var passwords []string
	cleanPwd := strings.TrimSpace(userPassword)
	cleanPwd = strings.ReplaceAll(cleanPwd, "&nbsp;", "")
	if cleanPwd != "" && !strings.EqualFold(cleanPwd, "none") && !strings.EqualFold(cleanPwd, "null") {
		passwords = append(passwords, cleanPwd)
	}
	for _, fallback := range []string{"www.downloadly.ir", "www.downloadlynet.ir", "downloadly.ir", ""} {
		found := false
		for _, p := range passwords {
			if p == fallback {
				found = true
				break
			}
		}
		if !found {
			passwords = append(passwords, fallback)
		}
	}

	// 4. Extract primary archive
	if err := e.extractSingleArchive(ctx, primaryArchive, outputDir, passwords); err != nil {
		return fmt.Errorf("primary extraction failed: %w", err)
	}

	// 5. Recursively unpack any nested archives
	if err := e.RecursiveExtract(ctx, outputDir, passwords, 5); err != nil {
		log.Printf("⚠️ Warning during recursive extraction: %v", err)
	}

	return nil
}

func (e *Extractor) extractSingleArchive(
	ctx context.Context,
	archivePath, destDir string,
	passwords []string,
) error {
	extractCtx, cancel := context.WithTimeout(ctx, e.cfg.ExtractionTimeout)
	defer cancel()

	type archiverInfo struct {
		name string
		path string
	}

	var archivers []archiverInfo
	if p, err := exec.LookPath("unrar"); err == nil {
		archivers = append(archivers, archiverInfo{name: "unrar", path: p})
	}
	if p, err := exec.LookPath("7z"); err == nil {
		archivers = append(archivers, archiverInfo{name: "7z", path: p})
	} else if p, err := exec.LookPath("7za"); err == nil {
		archivers = append(archivers, archiverInfo{name: "7za", path: p})
	} else if p, err := exec.LookPath("7zz"); err == nil {
		archivers = append(archivers, archiverInfo{name: "7zz", path: p})
	}
	if p, err := exec.LookPath("unar"); err == nil {
		archivers = append(archivers, archiverInfo{name: "unar", path: p})
	}

	if len(archivers) == 0 {
		return fmt.Errorf("no extraction tool found on system (checked unrar, 7z, unar)")
	}

	var attemptErrors []string

	for _, arch := range archivers {
		for _, pwd := range passwords {
			select {
			case <-extractCtx.Done():
				return extractCtx.Err()
			default:
			}

			var args []string
			switch arch.name {
			case "unrar":
				pArg := "-p-"
				if pwd != "" {
					pArg = "-p" + pwd
				}
				args = []string{"x", "-o+", "-y", pArg, archivePath, destDir + "/"}
			case "7z", "7za", "7zz":
				args = []string{"x", "-y", "-aoa"}
				if pwd != "" {
					args = append(args, "-p"+pwd)
				}
				args = append(args, "-o"+destDir, archivePath)
			case "unar":
				args = []string{"-o", destDir, "-f"}
				if pwd != "" {
					args = append(args, "-p", pwd)
				}
				args = append(args, archivePath)
			}

			log.Printf("⚡ Extracting with %s (pwd: '%s')...", arch.name, pwd)

			cmd := exec.CommandContext(extractCtx, arch.path, args...)
			cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

			outBytes, runErr := cmd.CombinedOutput()
			outputStr := string(outBytes)

			if runErr == nil {
				log.Printf("🎉 Extraction succeeded with %s (password: '%s')!", arch.name, pwd)
				return nil
			}

			// Capture diagnostic line
			summary := extractSummary(outputStr)
			attemptErrors = append(attemptErrors, fmt.Sprintf("[%s pwd='%s'] %s", arch.name, pwd, summary))
			log.Printf("⚠️ %s with pwd='%s' failed: %s", arch.name, pwd, summary)
		}
	}

	return fmt.Errorf("extraction failed for %s: %s",
		filepath.Base(archivePath),
		strings.Join(attemptErrors, " | "),
	)
}

func extractSummary(out string) string {
	lines := strings.Split(out, "\n")
	var keyLines []string
	keyMarkers := []string{
		"ERROR", "Cannot open", "Can not open", "Wrong password",
		"CRC failed", "Data Error", "checksum error", "corrupt",
	}

	for _, ln := range lines {
		trimmed := strings.TrimSpace(ln)
		for _, m := range keyMarkers {
			if strings.Contains(trimmed, m) {
				keyLines = append(keyLines, trimmed)
				break
			}
		}
		if len(keyLines) >= 3 {
			break
		}
	}

	if len(keyLines) > 0 {
		return strings.Join(keyLines, " ; ")
	}

	// Last 2 non-empty lines
	var nonEmpties []string
	for i := len(lines) - 1; i >= 0 && len(nonEmpties) < 2; i-- {
		t := strings.TrimSpace(lines[i])
		if t != "" {
			nonEmpties = append([]string{t}, nonEmpties...)
		}
	}
	if len(nonEmpties) > 0 {
		return strings.Join(nonEmpties, " ; ")
	}
	return "unknown extractor error"
}
