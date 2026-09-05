# High-Speed Distributed Course Worker Engine (Golang)

High-performance, fault-tolerant, concurrent course worker pipeline written in Go. Replaces single-process Python workers with high concurrency, native stall detection, multi-archive extraction, volume normalization, and 1GB split material packaging.

---

## 1. Key Capabilities & Architecture

- **Multi-Course Concurrent Pool**: Semaphore-bounded worker queue executing multiple courses simultaneously without CPU or disk thrashing.
- **High-Speed Downloads**: Multi-chunk concurrent downloading via `dlengine` (16 connections per part) with fallback to resilient Go chunked HTTP streaming with `Range:` resume.
- **Active Stall Watchdog**: Automatically detects hung network transfers (60s inactivity threshold), terminates the process tree (`syscall.Kill(-pgid, SIGKILL)`), and retries with backoff.
- **Split Volume Normalization**: Detects irregular Downloadly split archive filenames (e.g. `*.part1_Downloadly.ir.rar`) and normalizes them so `unrar` and `7z` locate subsequent volumes seamlessly.
- **Password Rotation & Extraction**: Attempts primary archive passwords (`filePassword`, `www.downloadly.ir`, etc.) across `unrar`, `7z`, and `unar`, with recursive inner archive extraction.
- **Strict Disk Space Protocol (ENOSPC Prevention)**:
  - 5 GB safety threshold: Aborts gracefully before disk exhaustion.
  - Immediate raw part reclamation: Deletes all `.rar` parts immediately after extraction to free up 10–40 GB before packaging.
  - Video/materials separation: Sorts videos (`.mp4`, `.mkv`, etc.) into `output/videos/`.
  - Packages all non-video materials into 1GB split `.zip` archives (`7z -v1024m` / `zip -s 1024m`) and immediately removes raw source files.
  - Generates `manifest.json` ready for Google Drive streaming/upload in the next part.

---

## 2. Directory Structure

```
worker_browser/course_worker/
├── cmd/
├── config/
│   └── config.go            # Configuration & disk space monitoring
├── downloader/
│   ├── engine.go            # dlengine runner, stall watchdog & JSON stream parser
│   └── fallback.go          # Resilient HTTP chunked streaming with Range resume
├── extractor/
│   ├── extractor.go         # Volume normalizer, password rotator & archiver
│   ├── extractor_test.go    # Unit tests for volume normalization & natural sorting
│   └── recursive.go         # Recursive nested archive unpacker
├── model/
│   └── course.go            # Data models for CoursePayload, JobState & PartProgress
├── packager/
│   ├── packager.go          # Video/material separation, 1GB zip packager & cleaner
│   └── packager_test.go     # Unit tests for separation and zipping
├── pipeline/
│   ├── pipeline.go          # Stage orchestration & live progress tracking
│   ├── pipeline_test.go     # Full end-to-end integration test
│   └── manager.go           # Concurrent job queue & cancellation manager
├── server/
│   ├── server.go            # REST API endpoints
│   └── server_test.go       # HTTP endpoint unit tests
├── samples/                 # Sample course JSON files
├── main.go                  # CLI entrypoint ('run' and 'serve' modes)
└── go.mod
```

---

## 3. Usage & CLI Modes

### A. Run Directly on a Course JSON
```bash
./bin/course-worker run --input samples/example_oops_in_python.json
```

### B. Run as an HTTP Daemon
```bash
./bin/course-worker serve --port 8085 --concurrency 2
```

### C. Dispatch Course via REST API
```bash
curl -X POST http://localhost:8085/worker/jobs \
  -H "Content-Type: application/json" \
  -d @samples/course_python_201_hackers.json
```

### D. Query Worker & Jobs Status
```bash
# Health & disk status
curl http://localhost:8085/worker/status

# List all jobs and live progress
curl http://localhost:8085/worker/jobs

# Specific job detail
curl http://localhost:8085/worker/jobs/<jobId>

# Cancel job and purge working files
curl -X POST http://localhost:8085/worker/jobs/<jobId>/cancel
```

---

## 4. Environment Variables

| Variable | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `MAX_CONCURRENT_COURSES` | Integer | `2` | Number of simultaneous courses processed |
| `PART_CONCURRENCY` | Integer | `3` | Parallel parts downloaded per course |
| `DL_CONCURRENCY_PER_PART`| Integer | `16` | Download chunks/workers per part |
| `JOBS_BASE_DIR` | String | `/tmp/course_jobs` | Base working directory |
| `SAFETY_DISK_MIN_BYTES` | Integer | `5368709120` (5GB) | Minimum free disk space threshold |
| `DOWNLOAD_STALL_TIMEOUT_SEC` | Integer | `60` | Inactivity watchdog timeout in seconds |
| `PORT` | Integer | `8085` | HTTP server port |
