package model

import (
	"fmt"
	"path"
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
	Password    string   `json:"password,omitempty"`
	CallbackURL string   `json:"callbackUrl,omitempty"`
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
	OutputDir       string         `json:"outputDir,omitempty"`
	WorkDir         string         `json:"workDir,omitempty"`
	CreatedAt       time.Time      `json:"createdAt"`
	UpdatedAt       time.Time      `json:"updatedAt"`
	CompletedAt     *time.Time     `json:"completedAt,omitempty"`
	Error           string         `json:"error,omitempty"`
}
