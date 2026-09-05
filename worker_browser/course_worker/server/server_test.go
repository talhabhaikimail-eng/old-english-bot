package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"course-worker/config"
	"course-worker/model"
	"course-worker/pipeline"
)

func TestServerEndpoints(t *testing.T) {
	cfg := config.LoadConfig()
	cfg.BaseWorkDir = t.TempDir()
	manager := pipeline.NewCourseManager(cfg)
	srv := NewServer(cfg, manager)

	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)

	// Test 1: GET /worker/status
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/worker/status", nil)
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK from /worker/status, got %d", rec.Code)
	}

	var statusResp map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &statusResp); err != nil {
		t.Fatalf("failed to decode status response: %v", err)
	}
	if statusResp["status"] != "idle" {
		t.Fatalf("expected status 'idle', got %v", statusResp["status"])
	}

	// Test 2: POST /worker/jobs
	coursePayload := model.CoursePayload{
		ID:    "test-job-123",
		Title: "Test Python Course",
		Slug:  "test-python-course",
		DownloadLinks: []model.DownloadLink{
			{
				URL:  "https://example.com/part1.rar",
				Part: 1,
			},
		},
	}
	body, _ := json.Marshal(coursePayload)
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/worker/jobs", bytes.NewReader(body))
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected 202 Accepted, got %d (body: %s)", rec.Code, rec.Body.String())
	}

	// Test 3: GET /worker/jobs
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/worker/jobs", nil)
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", rec.Code)
	}

	// Test 4: POST /worker/jobs/test-job-123/cancel
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/worker/jobs/test-job-123/cancel", nil)
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", rec.Code)
	}
}
