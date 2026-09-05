package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"course-worker/config"
	"course-worker/model"
	"course-worker/pipeline"

	"github.com/gorilla/websocket"
)

func TestServerEndpoints(t *testing.T) {
	cfg := config.LoadConfig()
	cfg.BaseWorkDir = t.TempDir()
	manager := pipeline.NewCourseManager(cfg)
	defer manager.CancelAllJobsAndClean()
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

func TestSimplifiedProcessAPI(t *testing.T) {
	cfg := config.LoadConfig()
	cfg.BaseWorkDir = t.TempDir()
	manager := pipeline.NewCourseManager(cfg)
	defer manager.CancelAllJobsAndClean()
	srv := NewServer(cfg, manager)

	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)

	// Case 1: JSON array of string URLs
	bodyArray := `["https://example.com/Learn_Golang_Fast.part1.rar", "https://example.com/Learn_Golang_Fast.part2.rar"]`
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/process", strings.NewReader(bodyArray))
	req.Header.Set("Content-Type", "application/json")
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected 202 Accepted for raw JSON array, got %d (body: %s)", rec.Code, rec.Body.String())
	}

	var resp map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to parse JSON response: %v", err)
	}
	if resp["success"] != true {
		t.Fatalf("expected success=true, got %v", resp["success"])
	}
	if !strings.Contains(resp["wsUrl"].(string), "/ws/jobs/") {
		t.Fatalf("expected wsUrl to contain /ws/jobs/, got %v", resp["wsUrl"])
	}
	jobID1 := resp["jobId"].(string)
	_ = manager.CancelJob(jobID1)

	// Case 2: Object with "url" (single)
	bodySingle := `{"url": "https://example.com/Intro_To_Rust.zip", "title": "Rust Programming"}`
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/process", strings.NewReader(bodySingle))
	req.Header.Set("Content-Type", "application/json")
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected 202 Accepted for single url, got %d", rec.Code)
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp["title"] != "Rust Programming" {
		t.Fatalf("expected title 'Rust Programming', got %v", resp["title"])
	}
	jobID2 := resp["jobId"].(string)
	_ = manager.CancelJob(jobID2)

	// Case 3: Query parameter submission GET /api/process?url=...
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/process?url=https://example.com/Docker_Mastery.part1.rar", nil)
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected 202 Accepted for query param, got %d", rec.Code)
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp["success"] != true {
		t.Fatalf("expected success=true, got %v", resp["success"])
	}
	jobID3 := resp["jobId"].(string)
	_ = manager.CancelJob(jobID3)
}

func TestTitleDeduction(t *testing.T) {
	cases := []struct {
		urls     []string
		expected string
	}{
		{
			urls:     []string{"https://downloadly.ir/2024/05/Python_Zero_to_Hero.part1.rar"},
			expected: "Python Zero to Hero",
		},
		{
			urls:     []string{"https://downloadly.ir/files/Kubernetes_Mastery_Downloadly.ir.rar"},
			expected: "Kubernetes Mastery",
		},
		{
			urls:     []string{"https://cdn.example.com/archives/Advanced_Typescript.zip"},
			expected: "Advanced Typescript",
		},
	}

	for _, c := range cases {
		actual := model.DeduceTitleFromURLs(c.urls)
		if actual != c.expected {
			t.Errorf("for urls %v: expected '%s', got '%s'", c.urls, c.expected, actual)
		}
	}
}

func TestWebSocketsLiveUpdates(t *testing.T) {
	cfg := config.LoadConfig()
	cfg.BaseWorkDir = t.TempDir()
	manager := pipeline.NewCourseManager(cfg)
	defer manager.CancelAllJobsAndClean()
	srv := NewServer(cfg, manager)

	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)

	server := httptest.NewServer(mux)
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")

	// 1. Test /ws/jobs (Global subscriber)
	globalWS, _, err := websocket.DefaultDialer.Dial(wsURL+"/ws/jobs", nil)
	if err != nil {
		t.Fatalf("failed to connect to /ws/jobs: %v", err)
	}
	defer globalWS.Close()

	var initMsg map[string]interface{}
	if err := globalWS.ReadJSON(&initMsg); err != nil {
		t.Fatalf("failed to read init message from /ws/jobs: %v", err)
	}
	if initMsg["type"] != "init" {
		t.Fatalf("expected type 'init', got %v", initMsg["type"])
	}

	// 2. Test /ws/process (Interactive Course Runner)
	processWS, _, err := websocket.DefaultDialer.Dial(wsURL+"/ws/process", nil)
	if err != nil {
		t.Fatalf("failed to connect to /ws/process: %v", err)
	}
	defer processWS.Close()

	// Read ready prompt
	var readyMsg map[string]interface{}
	if err := processWS.ReadJSON(&readyMsg); err != nil {
		t.Fatalf("failed to read ready message: %v", err)
	}
	if readyMsg["type"] != "ready" {
		t.Fatalf("expected type 'ready', got %v", readyMsg["type"])
	}

	// Submit course over WebSocket
	req := model.ProcessRequest{
		URLs:     []string{"https://example.com/Fast_Go_Course.part1.rar"},
		Title:    "Fast Go Course",
		Password: "test",
	}
	if err := processWS.WriteJSON(req); err != nil {
		t.Fatalf("failed to send course payload over WS: %v", err)
	}

	// Read "started" frame
	var startedMsg map[string]interface{}
	if err := processWS.ReadJSON(&startedMsg); err != nil {
		t.Fatalf("failed to read started frame: %v", err)
	}
	if startedMsg["type"] != "started" {
		t.Fatalf("expected type 'started', got %v", startedMsg["type"])
	}
	if startedMsg["title"] != "Fast Go Course" {
		t.Fatalf("expected title 'Fast Go Course', got %v", startedMsg["title"])
	}

	jobID := startedMsg["jobId"].(string)

	// 3. Test /ws/jobs/{id}
	jobWS, _, err := websocket.DefaultDialer.Dial(wsURL+"/ws/jobs/"+jobID, nil)
	if err != nil {
		t.Fatalf("failed to connect to /ws/jobs/%s: %v", jobID, err)
	}
	defer jobWS.Close()

	var stateMsg map[string]interface{}
	if err := jobWS.ReadJSON(&stateMsg); err != nil {
		t.Fatalf("failed to read state from /ws/jobs/%s: %v", jobID, err)
	}
	if stateMsg["jobId"] != jobID && stateMsg["type"] != "progress" {
		t.Logf("received snapshot: %v", stateMsg)
	}

	// Cancel job cleanly
	_ = manager.CancelJob(jobID)
}

func TestSyncProcessAPIWithCancel(t *testing.T) {
	cfg := config.LoadConfig()
	cfg.BaseWorkDir = t.TempDir()
	manager := pipeline.NewCourseManager(cfg)
	defer manager.CancelAllJobsAndClean()
	srv := NewServer(cfg, manager)

	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)

	// Test synchronous mode: cancellation or preflight failure returns terminal status
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/process?sync=true", strings.NewReader(`{"urls": ["https://example.invalid/part1.rar"]}`))
	req = req.WithContext(ctx)
	req.Header.Set("Content-Type", "application/json")

	mux.ServeHTTP(rec, req)

	// Since example.invalid cannot be reached, preflight probe fails immediately
	var res map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &res)

	if res["uploaded"] != false {
		t.Fatalf("expected uploaded=false for failed job, got %v", res["uploaded"])
	}
	if res["success"] != false {
		t.Fatalf("expected success=false for failed job, got %v", res["success"])
	}
}

func TestUIDashboardServing(t *testing.T) {
	cfg := config.LoadConfig()
	cfg.BaseWorkDir = t.TempDir()
	manager := pipeline.NewCourseManager(cfg)
	srv := NewServer(cfg, manager)

	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK from root UI, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "High-Speed Course Worker") {
		t.Fatalf("expected UI HTML to contain 'High-Speed Course Worker'")
	}

	recDocs := httptest.NewRecorder()
	reqDocs := httptest.NewRequest(http.MethodGet, "/docs", nil)
	mux.ServeHTTP(recDocs, reqDocs)
	if recDocs.Code != http.StatusOK {
		t.Fatalf("expected 200 OK from /docs, got %d", recDocs.Code)
	}
}

func TestEndToEndSampleCourseViaWebSocketAndSync(t *testing.T) {
	p7z, err := exec.LookPath("7z")
	if err != nil {
		t.Skip("7z not installed, skipping end-to-end sample course test")
	}

	// 1. Create a sample course directory with 1 video and 1 material file
	srcDir := t.TempDir()
	_ = os.WriteFile(filepath.Join(srcDir, "lesson_01.mp4"), []byte("sample video data"), 0644)
	_ = os.WriteFile(filepath.Join(srcDir, "notes.pdf"), []byte("sample course notes"), 0644)

	// 2. Compress into a password-protected split 7z archive
	archiveDir := t.TempDir()
	archivePath := filepath.Join(archiveDir, "Python_Quickstart.part1_Downloadly.ir.7z")
	cmd := exec.Command(p7z, "a", "-t7z", "-pwww.downloadly.ir", "-y", archivePath, "*")
	cmd.Dir = srcDir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("failed to create sample 7z archive: %v (%s)", err, string(out))
	}

	// 3. Serve the archive via local HTTP test server
	sampleServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, archivePath)
	}))
	defer sampleServer.Close()

	archiveURL := sampleServer.URL + "/Python_Quickstart.part1_Downloadly.ir.7z"

	// 4. Spin up the Course Worker server
	cfg := config.LoadConfig()
	cfg.BaseWorkDir = t.TempDir()
	cfg.AutoUploadDrive = false
	manager := pipeline.NewCourseManager(cfg)
	defer manager.CancelAllJobsAndClean()
	srv := NewServer(cfg, manager)

	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)

	workerServer := httptest.NewServer(srv.WithCORS(mux))
	defer workerServer.Close()

	// Part A: Test via WebSocket /ws/process
	wsURL := "ws" + strings.TrimPrefix(workerServer.URL, "http") + "/ws/process"
	ws, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("failed to dial /ws/process: %v", err)
	}
	defer ws.Close()

	var readyMsg map[string]interface{}
	_ = ws.ReadJSON(&readyMsg)

	req := model.ProcessRequest{
		URLs:     []string{archiveURL},
		Title:    "Python Quickstart",
		Password: "www.downloadly.ir",
	}
	if err := ws.WriteJSON(req); err != nil {
		t.Fatalf("failed to send course payload to WS: %v", err)
	}

	var startedMsg map[string]interface{}
	_ = ws.ReadJSON(&startedMsg)
	if startedMsg["type"] != "started" {
		t.Fatalf("expected started frame, got %v", startedMsg)
	}

	var finalResult map[string]interface{}
	for {
		var frame map[string]interface{}
		if err := ws.ReadJSON(&frame); err != nil {
			t.Fatalf("error reading from websocket: %v", err)
		}
		if frame["type"] == "result" {
			finalResult = frame
			break
		}
	}

	if finalResult["success"] != true {
		t.Fatalf("expected success=true in WebSocket result, got %v (error: %v)", finalResult["success"], finalResult["error"])
	}
	if finalResult["uploaded"] != false {
		t.Fatalf("expected uploaded=false since drive upload was skipped, got %v", finalResult["uploaded"])
	}

	// Part B: Test via Synchronous API POST /api/process?sync=true
	syncReq := httptest.NewRequest(http.MethodPost, "/api/process?sync=true", strings.NewReader(fmt.Sprintf(`{"urls": ["%s"], "upload": false}`, archiveURL)))
	syncReq.Header.Set("Content-Type", "application/json")
	syncRec := httptest.NewRecorder()
	srv.WithCORS(mux).ServeHTTP(syncRec, syncReq)

	if syncRec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK from sync process API, got %d (body: %s)", syncRec.Code, syncRec.Body.String())
	}

	var syncResp map[string]interface{}
	_ = json.Unmarshal(syncRec.Body.Bytes(), &syncResp)

	if syncResp["success"] != true {
		t.Fatalf("expected success=true from sync response, got %v", syncResp["success"])
	}
	if syncResp["uploaded"] != false {
		t.Fatalf("expected uploaded=false, got %v", syncResp["uploaded"])
	}
	if syncResp["phase"] != "completed" {
		t.Fatalf("expected phase 'completed', got %v", syncResp["phase"])
	}
}
