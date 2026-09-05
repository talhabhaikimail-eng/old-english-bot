package downloader

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"course-worker/config"
	"course-worker/model"
)

func TestProbeFatalStatusCodes(t *testing.T) {
	tests := []struct {
		statusCode int
		shouldFail bool
	}{
		{http.StatusBadGateway, true},        // 502
		{http.StatusServiceUnavailable, true},// 503
		{http.StatusGatewayTimeout, true},    // 504
		{http.StatusNotFound, true},          // 404
		{http.StatusForbidden, true},         // 403
		{http.StatusOK, false},               // 200
		{http.StatusPartialContent, false},   // 206
	}

	cfg := &config.Config{
		DownloadStallTimeout: 2 * time.Second,
	}
	dl := NewDownloader(cfg)

	for _, tt := range tests {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(tt.statusCode)
		}))
		defer server.Close()

		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		err := dl.ProbeLink(ctx, server.URL)
		cancel()

		if tt.shouldFail {
			if err == nil {
				t.Fatalf("expected error for HTTP %d, got nil", tt.statusCode)
			}
			if !strings.Contains(err.Error(), "link not working") {
				t.Fatalf("expected error message to contain 'link not working', got: %v", err)
			}
		} else {
			if err != nil {
				t.Fatalf("expected success for HTTP %d, got: %v", tt.statusCode, err)
			}
		}
	}
}

func TestDownloadPartFailFastOn502(t *testing.T) {
	// Server returns 502
	callCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++
		w.WriteHeader(http.StatusBadGateway)
		w.Write([]byte("502 Next Hop Connection Failed"))
	}))
	defer server.Close()

	cfg := &config.Config{
		DLEnginePath:         "/nonexistent/bin", // forces fallback HTTP
		DownloadStallTimeout: 2 * time.Second,
		DownloadPartTimeout:  5 * time.Second,
	}
	dl := NewDownloader(cfg)

	part := &model.PartProgress{
		PartIndex: 1,
		FileName:  "test.rar",
		URL:       server.URL,
		DestPath:  t.TempDir() + "/test.rar",
	}

	start := time.Now()
	err := dl.DownloadPart(context.Background(), part, nil)
	duration := time.Since(start)

	if err == nil {
		t.Fatal("expected DownloadPart to fail on 502, got nil")
	}
	if !strings.Contains(err.Error(), "link not working") {
		t.Fatalf("expected error to contain 'link not working', got: %v", err)
	}
	// Verify that it failed fast without repeating retries 3 times
	if callCount > 1 {
		t.Fatalf("expected fail-fast on 502 without retries, but server was hit %d times", callCount)
	}
	if duration > 2*time.Second {
		t.Fatalf("expected fail-fast (< 2s), but took %v", duration)
	}
}
