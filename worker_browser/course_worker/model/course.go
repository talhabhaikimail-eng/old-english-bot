package model

import (
	"fmt"
	"net/url"
	"path"
	"regexp"
	"strings"
	"time"
)

type JobPhase string

const (
	PhasePending     JobPhase = "pending"
	PhaseDownloading JobPhase = "downloading"
	PhaseExtracting  JobPhase = "extracting"
	PhaseReclaiming  JobPhase = "reclaiming"
	PhaseSeparating  JobPhase = "separating"
	PhaseZipping     JobPhase = "zipping"
	PhaseUploading   JobPhase = "uploading"
	PhaseCompleted   JobPhase = "completed"
	PhaseFailed      JobPhase = "failed"
	PhaseCancelled   JobPhase = "cancelled"
)

type DownloadLink struct {
	URL      string `json:"url"`
	Part     int    `json:"part,omitempty"`
	Text     string `json:"text,omitempty"`
	Bytes    int64  `json:"bytes,omitempty"`
	SizeText string `json:"sizeText,omitempty"`
}

type CoursePayload struct {
	ID                  string         `json:"id,omitempty"`
	PostID              int            `json:"postId,omitempty"`
	Title               string         `json:"title,omitempty"`
	Slug                string         `json:"slug,omitempty"`
	CanonicalURL        string         `json:"canonicalUrl,omitempty"`
	FilePassword        string         `json:"filePassword,omitempty"`
	StatedSizeText      string         `json:"statedSizeText,omitempty"`
	CalculatedSizeBytes int64          `json:"calculatedSizeBytes,omitempty"`
	DownloadLinks       []DownloadLink `json:"downloadLinks,omitempty"`

	// Compatibility fields for Hub / CourseJobRequest format
	JobID       string   `json:"jobId,omitempty"`
	CourseName  string   `json:"courseName,omitempty"`
	ArchiveURLs []string `json:"archiveUrls,omitempty"`
	Password    string             `json:"password,omitempty"`
	CallbackURL string             `json:"callbackUrl,omitempty"`
	Drive       *DriveUploadConfig `json:"drive,omitempty"`
}

type DriveUploadConfig struct {
	AccessToken     string `json:"accessToken,omitempty"`
	ParentFolderId  string `json:"parentFolderId,omitempty"`
	AccountId       string `json:"accountId,omitempty"`
	TokenRefreshURL string `json:"tokenRefreshUrl,omitempty"`
	TestFolder      string `json:"testFolder,omitempty"`
	AutoUpload      *bool  `json:"autoUpload,omitempty"`
}

func (c *CoursePayload) GetJobID() string {
	if c.ID != "" {
		return c.ID
	}
	if c.JobID != "" {
		return c.JobID
	}
	if c.Slug != "" {
		return fmt.Sprintf("course_%s_%d", c.Slug, time.Now().Unix())
	}
	return fmt.Sprintf("job_%d", time.Now().UnixNano())
}

func (c *CoursePayload) GetTitle() string {
	if c.Title != "" {
		return c.Title
	}
	if c.CourseName != "" {
		return c.CourseName
	}
	if c.Slug != "" {
		return c.Slug
	}
	return "Untitled Course"
}

func (c *CoursePayload) GetPassword() string {
	if c.FilePassword != "" {
		return strings.TrimSpace(c.FilePassword)
	}
	if c.Password != "" {
		return strings.TrimSpace(c.Password)
	}
	return "www.downloadly.ir"
}

func (c *CoursePayload) GetLinks() []DownloadLink {
	if len(c.DownloadLinks) > 0 {
		return c.DownloadLinks
	}
	var links []DownloadLink
	for i, u := range c.ArchiveURLs {
		links = append(links, DownloadLink{
			URL:  u,
			Part: i + 1,
			Text: path.Base(u),
		})
	}
	return links
}

type PartProgress struct {
	PartIndex       int     `json:"partIndex"`
	FileName        string  `json:"fileName"`
	URL             string  `json:"url"`
	DestPath        string  `json:"destPath"`
	Percent         float64 `json:"percent"`
	Status          string  `json:"status"` // pending, downloading, completed, failed
	DownloadedBytes int64   `json:"downloadedBytes"`
	TotalBytes      int64   `json:"totalBytes"`
	SpeedBytesSec   float64 `json:"speedBytesSec"`
	Error           string  `json:"error,omitempty"`
}

type FileInfo struct {
	RelPath   string `json:"relPath"`
	FileName  string `json:"fileName"`
	SizeBytes int64  `json:"sizeBytes"`
	IsVideo   bool   `json:"isVideo"`
	IsZipPart bool   `json:"isZipPart"`
}

type DriveFile struct {
	Name        string `json:"name"`
	FileID      string `json:"fileId"`
	SizeBytes   int64  `json:"sizeBytes"`
	WebViewLink string `json:"webViewLink"`
	IsVideo     bool   `json:"isVideo"`
}

type JobState struct {
	ID              string         `json:"id"`
	Title           string         `json:"title"`
	Slug            string         `json:"slug,omitempty"`
	Phase           JobPhase       `json:"phase"`
	Status          string         `json:"status"`
	ProgressPercent float64        `json:"progressPercent"`
	SpeedMBps       float64        `json:"speedMBps"`
	CompletedParts  int            `json:"completedParts"`
	TotalParts      int            `json:"totalParts"`
	DownloadedBytes int64          `json:"downloadedBytes"`
	TotalBytes      int64          `json:"totalBytes"`
	Parts           []PartProgress `json:"parts,omitempty"`
	VideoFiles      []FileInfo     `json:"videoFiles,omitempty"`
	MaterialZips    []FileInfo     `json:"materialZips,omitempty"`
	DriveFolderID   string         `json:"driveFolderId,omitempty"`
	DriveFolderURL  string         `json:"driveFolderUrl,omitempty"`
	DriveFiles      []DriveFile    `json:"driveFiles,omitempty"`
	Uploaded        bool           `json:"uploaded"`
	OutputDir       string         `json:"outputDir,omitempty"`
	WorkDir         string         `json:"workDir,omitempty"`
	CreatedAt       time.Time      `json:"createdAt"`
	UpdatedAt       time.Time      `json:"updatedAt"`
	CompletedAt     *time.Time     `json:"completedAt,omitempty"`
	Error           string         `json:"error,omitempty"`
}

// Clone creates a thread-safe deep copy of JobState for broadcasting.
func (s *JobState) Clone() *JobState {
	if s == nil {
		return nil
	}
	cp := *s
	if len(s.Parts) > 0 {
		cp.Parts = make([]PartProgress, len(s.Parts))
		copy(cp.Parts, s.Parts)
	}
	if len(s.VideoFiles) > 0 {
		cp.VideoFiles = make([]FileInfo, len(s.VideoFiles))
		copy(cp.VideoFiles, s.VideoFiles)
	}
	if len(s.MaterialZips) > 0 {
		cp.MaterialZips = make([]FileInfo, len(s.MaterialZips))
		copy(cp.MaterialZips, s.MaterialZips)
	}
	if len(s.DriveFiles) > 0 {
		cp.DriveFiles = make([]DriveFile, len(s.DriveFiles))
		copy(cp.DriveFiles, s.DriveFiles)
	}
	return &cp
}

// ProcessRequest provides a highly simplified, universal request schema.
// Clients can pass pure URLs, single URL, or full configurations.
type ProcessRequest struct {
	URLs           []string           `json:"urls,omitempty"`
	URL            string             `json:"url,omitempty"`
	Title          string             `json:"title,omitempty"`
	CourseName     string             `json:"courseName,omitempty"`
	Slug           string             `json:"slug,omitempty"`
	Password       string             `json:"password,omitempty"`
	FilePassword   string             `json:"filePassword,omitempty"`
	Upload         *bool              `json:"upload,omitempty"`
	Sync           bool               `json:"sync,omitempty"`
	Stream         bool               `json:"stream,omitempty"`
	ParentFolderId string             `json:"parentFolderId,omitempty"`
	AccessToken    string             `json:"accessToken,omitempty"`
	Drive          *DriveUploadConfig `json:"drive,omitempty"`
}

func (r *ProcessRequest) CollectURLs() []string {
	var list []string
	if r.URL != "" {
		trimmed := strings.TrimSpace(r.URL)
		if trimmed != "" {
			list = append(list, trimmed)
		}
	}
	for _, u := range r.URLs {
		trimmed := strings.TrimSpace(u)
		if trimmed != "" {
			list = append(list, trimmed)
		}
	}
	return list
}

// DeduceTitleFromURLs extracts a human-friendly course name from archive URLs if title is omitted.
func DeduceTitleFromURLs(urls []string) string {
	if len(urls) == 0 {
		return "Course"
	}
	first := urls[0]
	parsed, err := url.Parse(first)
	raw := first
	if err == nil && parsed.Path != "" {
		raw = path.Base(parsed.Path)
	} else {
		raw = path.Base(first)
	}

	rePart := regexp.MustCompile(`(?i)\.part\d+(_[a-z0-9\._-]+)?\.rar$`)
	cleaned := rePart.ReplaceAllString(raw, "")

	reExt := regexp.MustCompile(`(?i)\.(rar|zip|7z|tar\.gz|tar)$`)
	cleaned = reExt.ReplaceAllString(cleaned, "")

	cleaned = strings.ReplaceAll(cleaned, "_Downloadly.ir", "")
	cleaned = strings.ReplaceAll(cleaned, ".Downloadly.ir", "")
	cleaned = strings.ReplaceAll(cleaned, "Downloadly.ir", "")
	cleaned = strings.ReplaceAll(cleaned, "_", " ")
	cleaned = strings.ReplaceAll(cleaned, ".", " ")
	cleaned = strings.TrimSpace(cleaned)

	if cleaned == "" {
		return fmt.Sprintf("Course_%d", time.Now().Unix())
	}
	return cleaned
}

// ToCoursePayload translates the simplified ProcessRequest into the engine's CoursePayload.
func (r *ProcessRequest) ToCoursePayload(autoUploadDrive bool) (*CoursePayload, error) {
	urls := r.CollectURLs()
	if len(urls) == 0 {
		return nil, fmt.Errorf("no download URLs provided in request")
	}

	title := strings.TrimSpace(r.Title)
	if title == "" {
		title = strings.TrimSpace(r.CourseName)
	}
	if title == "" {
		title = DeduceTitleFromURLs(urls)
	}

	pwd := strings.TrimSpace(r.Password)
	if pwd == "" {
		pwd = strings.TrimSpace(r.FilePassword)
	}
	if pwd == "" {
		pwd = "www.downloadly.ir"
	}

	var links []DownloadLink
	for i, u := range urls {
		fname := path.Base(u)
		if parsed, err := url.Parse(u); err == nil && parsed.Path != "" {
			fname = path.Base(parsed.Path)
		}
		links = append(links, DownloadLink{
			URL:  u,
			Part: i + 1,
			Text: fname,
		})
	}

	shouldUpload := autoUploadDrive
	if r.Upload != nil {
		shouldUpload = *r.Upload
	}

	driveCfg := r.Drive
	if driveCfg == nil && (shouldUpload || r.AccessToken != "" || r.ParentFolderId != "") {
		driveCfg = &DriveUploadConfig{
			AccessToken:    r.AccessToken,
			ParentFolderId: r.ParentFolderId,
			AutoUpload:     &shouldUpload,
		}
	} else if driveCfg != nil {
		if r.AccessToken != "" && driveCfg.AccessToken == "" {
			driveCfg.AccessToken = r.AccessToken
		}
		if r.ParentFolderId != "" && driveCfg.ParentFolderId == "" {
			driveCfg.ParentFolderId = r.ParentFolderId
		}
		if driveCfg.AutoUpload == nil {
			driveCfg.AutoUpload = &shouldUpload
		}
	}

	payload := &CoursePayload{
		Title:         title,
		CourseName:    title,
		Slug:          r.Slug,
		FilePassword:  pwd,
		Password:      pwd,
		ArchiveURLs:   urls,
		DownloadLinks: links,
		Drive:         driveCfg,
	}

	return payload, nil
}
