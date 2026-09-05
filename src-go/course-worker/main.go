package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"course-worker/config"
	"course-worker/model"
	"course-worker/pipeline"
	"course-worker/server"
)

func main() {
	cfg := config.LoadConfig()

	var (
		mode       string
		inputFile  string
		port       int
		concurJobs int
	)

	flag.StringVar(&mode, "mode", "serve", "Mode: 'serve' to run HTTP API daemon, 'run' to execute a course JSON file directly")
	flag.StringVar(&inputFile, "input", "", "Path to course JSON file (for mode=run)")
	flag.IntVar(&port, "port", cfg.HTTPPort, "Port to listen on for HTTP server")
	flag.IntVar(&concurJobs, "concurrency", cfg.MaxConcurrentCourses, "Maximum concurrent course jobs")
	flag.Parse()

	// Handle subcommands and loose positional arguments
	for i := 1; i < len(os.Args); i++ {
		arg := os.Args[i]
		if arg == "run" {
			mode = "run"
			if i+1 < len(os.Args) && !strings.HasPrefix(os.Args[i+1], "-") {
				inputFile = os.Args[i+1]
				i++
			}
		} else if arg == "serve" {
			mode = "serve"
		} else if (arg == "--input" || arg == "-input" || arg == "-i") && i+1 < len(os.Args) {
			inputFile = os.Args[i+1]
			mode = "run"
			i++
		} else if strings.HasSuffix(arg, ".json") {
			if _, err := os.Stat(arg); err == nil {
				inputFile = arg
				mode = "run"
			}
		}
	}

	cfg.HTTPPort = port
	cfg.MaxConcurrentCourses = concurJobs

	switch mode {
	case "run":
		if inputFile == "" {
			log.Fatalf("Error: --input <path-to-json> is required for 'run' mode")
		}
		runDirectCourse(cfg, inputFile)

	case "serve":
		runHTTPServer(cfg)

	default:
		log.Fatalf("Unknown mode: %s. Use 'serve' or 'run'", mode)
	}
}

func runHTTPServer(cfg *config.Config) {
	manager := pipeline.NewCourseManager(cfg)
	srv := server.NewServer(cfg, manager)

	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)

	httpServer := &http.Server{
		Addr:         fmt.Sprintf(":%d", cfg.HTTPPort),
		Handler:      mux,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 60 * time.Second,
	}

	log.Printf("🚀 Course Worker Daemon starting on port %d...", cfg.HTTPPort)
	log.Printf("📋 Configuration: MaxConcurrentCourses=%d, PartConcurrency=%d, DLWorkersPerPart=%d, BaseDir=%s",
		cfg.MaxConcurrentCourses, cfg.PartConcurrencyPerCourse, cfg.DLConcurrencyPerPart, cfg.BaseWorkDir)

	go func() {
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("HTTP Server failed: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop

	log.Printf("🛑 Shutting down Course Worker Server gracefully...")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(ctx)
	log.Printf("👋 Server stopped.")
}

func runDirectCourse(cfg *config.Config, inputPath string) {
	data, err := os.ReadFile(inputPath)
	if err != nil {
		log.Fatalf("Failed to read input JSON file %s: %v", inputPath, err)
	}

	var payload model.CoursePayload
	if err := json.Unmarshal(data, &payload); err != nil {
		log.Fatalf("Failed to parse course JSON: %v", err)
	}

	log.Printf("🎯 Starting Direct Execution for Course: '%s' (ID: %s)", payload.GetTitle(), payload.GetJobID())
	log.Printf("📦 Found %d download link(s)", len(payload.GetLinks()))

	pipe := pipeline.NewPipeline(cfg)
	state := &model.JobState{
		ID:        payload.GetJobID(),
		Title:     payload.GetTitle(),
		Slug:      payload.Slug,
		Phase:     model.PhasePending,
		Status:    "running",
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigChan
		log.Println("🛑 Cancellation signal received. Stopping course pipeline...")
		cancel()
	}()

	startTime := time.Now()
	lastReport := time.Now()

	err = pipe.Execute(ctx, &payload, state, func() {
		now := time.Now()
		if now.Sub(lastReport) >= 3*time.Second || state.Phase != model.PhaseDownloading {
			lastReport = now
			log.Printf("📊 [Status: %s] Progress: %.1f%% | Speed: %.2f MB/s | Parts: %d/%d | DL: %.2f MB",
				state.Phase,
				state.ProgressPercent,
				state.SpeedMBps,
				state.CompletedParts,
				state.TotalParts,
				float64(state.DownloadedBytes)/(1024*1024),
			)
		}
	})

	if err != nil {
		log.Fatalf("❌ Pipeline execution failed: %v", err)
	}

	elapsed := time.Since(startTime).Round(time.Second)
	log.Printf("==========================================================")
	log.Printf("🎉 Course Processing Finished Successfully in %s!", elapsed)
	log.Printf("📁 Output Directory: %s", state.OutputDir)
	log.Printf("🎥 Video Files Discovered: %d", len(state.VideoFiles))
	for i, v := range state.VideoFiles {
		log.Printf("   [%02d] %s (%.2f MB)", i+1, v.FileName, float64(v.SizeBytes)/(1024*1024))
	}
	log.Printf("📦 Material Zip Volume(s): %d", len(state.MaterialZips))
	for i, m := range state.MaterialZips {
		log.Printf("   [%02d] %s (%.2f MB)", i+1, m.FileName, float64(m.SizeBytes)/(1024*1024))
	}
	log.Printf("==========================================================")
}
