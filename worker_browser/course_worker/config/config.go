package config

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type Config struct {
	WorkerID                 string
	MaxConcurrentCourses     int
	PartConcurrencyPerCourse int
	DLConcurrencyPerPart     int
	BaseWorkDir              string
	MinFreeDiskBytes         uint64
	DownloadStallTimeout     time.Duration
	DownloadPartTimeout      time.Duration
	ExtractionTimeout        time.Duration
	PackagingTimeout         time.Duration
	DLEnginePath             string
	HTTPPort                 int
	DatabaseURL              string
	GoogleClientID           string
	ClientSecret             string
	DefaultDriveFolderID     string
	AutoUploadDrive          bool
}

func LoadConfig() *Config {
	loadDotEnv()

	hostname, _ := os.Hostname()
	if len(hostname) > 12 {
		hostname = hostname[:12]
	}

	cfg := &Config{
		WorkerID:                 getEnv("WORKER_ID", "worker-"+hostname),
		MaxConcurrentCourses:     getEnvInt("MAX_CONCURRENT_COURSES", 2),
		PartConcurrencyPerCourse: getEnvInt("PART_CONCURRENCY", 3),
		DLConcurrencyPerPart:     getEnvInt("DL_CONCURRENCY_PER_PART", 16),
		BaseWorkDir:              getEnv("JOBS_BASE_DIR", "/tmp/course_jobs"),
		MinFreeDiskBytes:         uint64(getEnvInt64("SAFETY_DISK_MIN_BYTES", 5*1024*1024*1024)), // 5 GB
		DownloadStallTimeout:     time.Duration(getEnvInt("DOWNLOAD_STALL_TIMEOUT_SEC", 20)) * time.Second,
		DownloadPartTimeout:      time.Duration(getEnvInt("DOWNLOAD_PART_TIMEOUT_SEC", 2700)) * time.Second, // 45 min
		ExtractionTimeout:        time.Duration(getEnvInt("EXTRACTION_TIMEOUT_SEC", 3600)) * time.Second,   // 60 min
		PackagingTimeout:         time.Duration(getEnvInt("PACKAGING_TIMEOUT_SEC", 1800)) * time.Second,    // 30 min
		DLEnginePath:             getEnv("DLENGINE_BIN", "/usr/local/bin/dlengine"),
		HTTPPort:                 getEnvInt("PORT", 8085),
		DatabaseURL:              getEnv("DATABASE_URL", ""),
		GoogleClientID:           getEnv("GOOGLE_CLIENT_ID", ""),
		ClientSecret:             getEnv("CLIENT_SECRET", ""),
		DefaultDriveFolderID:     getEnv("DEFAULT_DRIVE_FOLDER_ID", "1UmpfulblvP-fmvPia3kgXfvDUc7Zh4n1"),
		AutoUploadDrive:          getEnvBool("AUTO_UPLOAD_DRIVE", false),
	}

	// Verify dlengine path or look for local fallbacks
	if _, err := os.Stat(cfg.DLEnginePath); err != nil {
		fallbacks := []string{
			"/usr/bin/dlengine",
			"/usr/local/bin/dlengine",
			"./bin/dlengine",
			"../../bin/dlengine",
		}
		for _, fb := range fallbacks {
			if _, err := os.Stat(fb); err == nil {
				cfg.DLEnginePath = fb
				break
			}
		}
	}

	return cfg
}

func GetDiskFreeBytes(path string) (uint64, error) {
	absPath, err := filepath.Abs(path)
	if err != nil {
		absPath = path
	}

	// Find the nearest existing directory
	checkDir := absPath
	for {
		if fi, err := os.Stat(checkDir); err == nil && fi.IsDir() {
			break
		}
		parent := filepath.Dir(checkDir)
		if parent == checkDir {
			break
		}
		checkDir = parent
	}

	var stat syscall.Statfs_t
	if err := syscall.Statfs(checkDir, &stat); err != nil {
		return 0, err
	}
	// Available blocks * block size
	return stat.Bavail * uint64(stat.Bsize), nil
}

func getEnv(key, def string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return def
}

func getEnvInt(key string, def int) int {
	if val := os.Getenv(key); val != "" {
		if n, err := strconv.Atoi(val); err == nil {
			return n
		}
	}
	return def
}

func getEnvInt64(key string, def int64) int64 {
	if val := os.Getenv(key); val != "" {
		if n, err := strconv.ParseInt(val, 10, 64); err == nil {
			return n
		}
	}
	return def
}

func getEnvBool(key string, def bool) bool {
	if val := os.Getenv(key); val != "" {
		lower := strings.ToLower(val)
		return lower == "true" || lower == "1" || lower == "yes"
	}
	return def
}

func loadDotEnv() {
	candidates := []string{".env", "../.env", "../../.env"}
	for _, path := range candidates {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		lines := strings.Split(string(data), "\n")
		for _, line := range lines {
			line = strings.TrimSpace(line)
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			parts := strings.SplitN(line, "=", 2)
			if len(parts) == 2 {
				k := strings.TrimSpace(parts[0])
				v := strings.TrimSpace(parts[1])
				v = strings.Trim(v, `"'`)
				if os.Getenv(k) == "" {
					_ = os.Setenv(k, v)
				}
			}
		}
		break
	}
}
