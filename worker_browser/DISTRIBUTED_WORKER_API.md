# Distributed Worker Architecture & API Implementation Documentation

This document serves as the comprehensive specification, architectural guide, and integration reference for the **Distributed Worker Course Download, Extraction, and Google Drive Streaming Engine** implemented in `worker_browser`.

---

## 1. System Overview & Architecture

The worker node operates as an isolated execution unit deployed on a GitHub VM, Docker container, Pod, or standalone VPS. It receives course archive tasks from the **Central Hub Server**, downloads multi-part volumes concurrently, extracts archives locally, streams files directly into Google Drive via OAuth with optional AES-256-CTR encryption, and progressively purges disk storage to avoid running out of space (ENOSPC).

```
                               ┌─────────────────────────────────────────┐
                               │           Central Hub Server            │
                               │  - Task Queue & PostgreSQL Database     │
                               │  - Google Drive OAuth Token Manager     │
                               │  - Dispatcher & Live Progress Monitor   │
                               └────────────────────┬────────────────────┘
                                                    │
                 ┌──────────────────────────────────┼──────────────────────────────────┐
                 ▼                                  ▼                                  ▼
    ┌───────────────────────────┐      ┌───────────────────────────┐      ┌───────────────────────────┐
    │     Worker Node #1        │      │     Worker Node #2        │      │     Worker Node #N        │
    │  (GitHub VM / VPS / Pod)  │      │  (GitHub VM / VPS / Pod)  │      │  (GitHub VM / VPS / Pod)  │
    │                           │      │                           │      │                           │
    │  1. Fast multi-thread dl  │      │  1. Fast multi-thread dl  │      │  1. Fast multi-thread dl  │
    │  2. Local unrar / 7z      │      │  2. Local unrar / 7z      │      │  2. Local unrar / 7z      │
    │  3. Stream to Drive (OAuth)      │  3. Stream to Drive (OAuth)      │  3. Stream to Drive (OAuth)
    │  4. Purge disk & idle     │      │  4. Purge disk & idle     │      │  4. Purge disk & idle     │
    └───────────────────────────┘      └───────────────────────────┘      └───────────────────────────┘
```

---

## 2. File Manifest & Structure

All distributed worker code is located in [`worker_browser/`](file:///d:/discord-whatsapp/worker_browser):

| File | Purpose |
| :--- | :--- |
| [`worker_browser/course_worker.py`](file:///d:/discord-whatsapp/worker_browser/course_worker.py) | **Core Engine**: Implements the `CourseJobManager` singleton, concurrent streaming downloader, unrar/7z/tar/zip extraction engine, recursive unpacker, Drive resumable upload client (with AES-256-CTR), disk monitors, and webhook dispatcher. |
| [`worker_browser/worker_api.py`](file:///d:/discord-whatsapp/worker_browser/worker_api.py) | **FastAPI API Layer**: Exposes `/worker/status`, `/worker/jobs`, `/worker/jobs/{job_id}/cancel`, and `/api/workers/pool` alongside browser automation and code execution endpoints. |
| [`worker_browser/drive_uploader.py`](file:///d:/discord-whatsapp/worker_browser/drive_uploader.py) | **Direct Stream Uploader**: Pre-existing direct URL-to-Drive streaming generator. |

---

## 3. Strict 5-Stage Worker Disk Protocol (Preventing ENOSPC)

To guarantee containers with limited storage (e.g. 30GB–60GB) do not encounter `ENOSPC` errors while processing archives up to 40GB+, every worker enforces the following strict lifecycle:

```
[STAGE 1: DOWNLOAD]
  - Create directory: {JOBS_BASE_DIR}/{jobId}/parts/
  - Stream all archive parts concurrently (default concurrency: 10, max: 20)
  - Abort immediately if worker free disk drops below 5 GB (SAFETY_DISK_MIN_BYTES)
  - Transmit throttled 1000ms live download progress webhooks to Central Hub

[STAGE 2: EXTRACTION]
  - Auto-detect primary split archive volume (e.g., .part01.rar, .7z.001, .zip)
  - Execute native extractor: unrar x -o+ -inul / 7z x -y / tar / Python zipfile
  - Recursively unpack nested archives (.zip, .rar, .7z) depth-first
  - Immediately delete inner archives after extraction

[STAGE 3: PART RECLAMATION (CRUCIAL)]
  - IMMEDIATELY delete all files in {JOBS_BASE_DIR}/{jobId}/parts/
  - Frees up 10 GB – 40 GB of storage BEFORE Google Drive upload begins

[STAGE 4: PROGRESSIVE UPLOAD & DELETION]
  - Iterate through {JOBS_BASE_DIR}/{jobId}/extracted/* in natural numeric order
  - Automatically create matching subfolders on Google Drive if nested dirs exist
  - Stream file to Google Drive using Resumable Upload API
  - If encryption enabled: Encrypt on the fly with AES-256-CTR, prepend 16-byte random IV header, append .enc
  - IMMEDIATELY call os.remove(file) after each file uploads successfully
  - Send live upload progress report webhook per file

[STAGE 5: FULL WIPE & IDLE TRANSITION]
  - Call shutil.rmtree('{JOBS_BASE_DIR}/{jobId}', ignore_errors=True)
  - Set worker status to 'idle'
  - Send 'completed' webhook to Central Hub
```

---

## 4. API Endpoints Specification

### A. Health & Disk Status
#### `GET /worker/status`
**Caller:** Central Hub Server / Health Monitor  
**Purpose:** Returns current worker activity and real-time disk storage metrics to assess worker eligibility.

**Response (`200 OK`):**
```json
{
  "workerId": "worker-node-01",
  "status": "idle",
  "disk": {
    "totalGB": 64.0,
    "freeGB": 52.4,
    "usedGB": 11.6,
    "usedPercent": 18.1
  },
  "concurrencyLimit": 10,
  "activeJob": null,
  "activeJobId": null
}
```
*Note: Both `activeJob` and `activeJobId` are provided for backwards compatibility.*

---

### B. Worker Pool Discovery
#### `GET /api/workers/pool`
**Caller:** Central Hub Dispatcher  
**Purpose:** Discovers available idle workers capable of taking new download jobs.

**Headers:**
```http
Authorization: Basic <CREDENTIALS> (Optional)
```

**Response (`200 OK`):**
```json
{
  "success": true,
  "workers": [
    {
      "id": "worker-node-01",
      "url": "https://worker-node-01.tunnel.site",
      "status": "idle",
      "freeDiskGB": 52.4,
      "cpuPercent": 3.5,
      "activeJobId": null,
      "lastHeartbeat": "2026-09-01T12:00:00Z"
    }
  ]
}
```

---

### C. Dispatch Course Job
#### `POST /worker/jobs`
**Caller:** Central Hub Server  
**Purpose:** Dispatches an archive download, extraction, and Google Drive upload task.

**Headers:**
```http
Content-Type: application/json
Authorization: Bearer <WORKER_API_SECRET> (Enforced if WORKER_API_SECRET env is set)
```

**Request Payload:**
```json
{
  "jobId": "course_1788261052089",
  "courseName": "Udemy – 50+ Web Projects with HTML, CSS, and JavaScript in 2024",
  "archiveUrls": [
    "https://download-server.com/Udemy_50_Web_Projects.part01.rar",
    "https://download-server.com/Udemy_50_Web_Projects.part02.rar",
    "https://download-server.com/Udemy_50_Web_Projects.part03.rar"
  ],
  "concurrency": 10,
  "drive": {
    "accessToken": "ya29.a0AfH6SMDiq...",
    "parentFolderId": "1UmpfulblvP-fmvPia3kgXfvDUc7Zh4n1",
    "encrypt": true,
    "encryptionKey": "1a053a7e59b92cec01e95242739b73cbf50c14c156ab884a405035e4759d88eb"
  },
  "callbackUrl": "https://googledrive.ufone-claim.site/api/workers/callback"
}
```

**Success Response (`202 Accepted`):**
```json
{
  "success": true,
  "jobId": "course_1788261052089",
  "status": "accepted",
  "message": "Job accepted. Worker transitioning to 'busy'."
}
```

**Busy Response (`409 Conflict`):**
```json
{
  "error": "Worker is currently busy with another job"
}
```

---

### D. Cancel & Force Purge Job
#### `POST /worker/jobs/{jobId}/cancel`
*(Also accepts `POST /worker/jobs/:jobId/cancel`)*

**Caller:** Central Hub Server / User manual abort  
**Purpose:** Immediately aborts ongoing download, terminates extraction subprocess, purges all files from disk, and resets worker to `idle`.

**Response (`200 OK`):**
```json
{
  "success": true,
  "jobId": "course_1788261052089",
  "status": "cancelled",
  "diskPurged": true
}
```

---

## 5. Central Hub Webhooks Reference

The worker pushes real-time status updates to the `callbackUrl` provided in the job request.

### 1. Download Progress Report (Sent every 1000ms during Stage 1):
```json
{
  "jobId": "course_1788261052089",
  "workerId": "worker-node-01",
  "phase": "downloading",
  "overallDownloadPercent": 45.2,
  "speedMBps": 38.6,
  "completedParts": 1,
  "totalParts": 3,
  "parts": [
    { "partIndex": 1, "fileName": "part01.rar", "percent": 100.0, "status": "completed" },
    { "partIndex": 2, "fileName": "part02.rar", "percent": 35.6, "status": "downloading" },
    { "partIndex": 3, "fileName": "part03.rar", "percent": 0.0, "status": "pending" }
  ]
}
```

### 2. Extraction Progress Report (Stage 2):
```json
{
  "jobId": "course_1788261052089",
  "workerId": "worker-node-01",
  "phase": "extracting",
  "message": "Extracting archive volumes into /tmp/jobs/course_1788261052089/extracted..."
}
```

### 3. Drive Upload Progress Report (Per file in Stage 4):
```json
{
  "jobId": "course_1788261052089",
  "workerId": "worker-node-01",
  "phase": "uploading",
  "currentFileIndex": 8,
  "totalFiles": 42,
  "currentFileName": "008-navbar-styling.mp4",
  "filePercent": 100.0,
  "driveFileId": "1A_bcDEfGhIJkLmNoPqRsTuVwXyZ",
  "driveViewLink": "https://drive.google.com/file/d/1A_bcDEfGhIJkLmNoPqRsTuVwXyZ/view"
}
```

### 4. Final Completion & Disk Wipe Report (Stage 5):
```json
{
  "jobId": "course_1788261052089",
  "workerId": "worker-node-01",
  "phase": "completed",
  "status": "idle",
  "totalFilesUploaded": 42,
  "driveFolderId": "1UmpfulblvP-fmvPia3kgXfvDUc7Zh4n1",
  "diskCleaned": true,
  "executionDurationSec": 284
}
```

### 5. Failure Report (On unexpected error or < 5GB disk abort):
```json
{
  "jobId": "course_1788261052089",
  "workerId": "worker-node-01",
  "phase": "failed",
  "status": "failed",
  "error": "Insufficient disk space: free space (4.12 GB) dropped below 5 GB safety threshold."
}
```

### 6. Cancelled Report:
```json
{
  "jobId": "course_1788261052089",
  "workerId": "worker-node-01",
  "phase": "cancelled",
  "status": "cancelled",
  "message": "Job cancelled and disk purged."
}
```

---

## 6. Environment Variables Configuration

| Variable | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `WORKER_ID` | String | `worker-{hostname}` | Unique identifier for this worker node. |
| `WORKER_PUBLIC_URL` | String | *Empty (falls back to request URL)* | Public URL or Cloudflare Tunnel endpoint (e.g. `https://node-1.tunnel.site`). |
| `WORKER_API_SECRET` | String | *Empty (auth disabled)* | Shared secret for `Authorization: Bearer <SECRET>` on `POST /worker/jobs`. |
| `CONCURRENCY_LIMIT` | Integer | `10` | Maximum parallel part download streams. |
| `SAFETY_DISK_MIN_BYTES` | Integer | `5368709120` (5 GB) | Threshold below which download operations abort to prevent host system freeze. |
| `JOBS_BASE_DIR` | String | `/tmp/jobs` (or system temp) | Directory where working volumes and extractions reside. |

---

## 7. Central Hub Dispatcher Integration Reference

For the next agent working on the **Central Hub Server** (`d:\DataNodes\google-drive-api` or central coordinator), here is the reference dispatch logic in TypeScript:

```typescript
import axios from 'axios';

interface RemoteWorkerPoolResponse {
  success: boolean;
  workers: Array<{
    id: string;
    url: string;
    status: 'idle' | 'busy';
    freeDiskGB: number;
    cpuPercent: number;
    activeJobId: string | null;
  }>;
}

export async function dispatchCourseToRemoteWorker(
  task: { id: string; courseName: string; urls: string[]; createdFolderId: string; concurrency?: number },
  driveToken: string,
  encryptionKeyHex?: string
): Promise<boolean> {
  const poolUrl = process.env.BROWSER_POOL_API_URL;
  if (!poolUrl) return false;

  try {
    // 1. Query available workers
    const poolRes = await axios.get<RemoteWorkerPoolResponse>(poolUrl, {
      headers: { Authorization: process.env.BROWSER_POOL_AUTH || '' },
      timeout: 5000,
    });

    // 2. Select an idle worker with at least 25GB free disk
    const idleWorker = poolRes.data.workers?.find(
      (w) => w.status === 'idle' && w.freeDiskGB >= 25
    );

    if (!idleWorker) {
      console.log('All remote workers busy or low on disk. Holding in local queue.');
      return false;
    }

    // 3. Dispatch job payload
    await axios.post(
      `${idleWorker.url}/worker/jobs`,
      {
        jobId: task.id,
        courseName: task.courseName,
        archiveUrls: task.urls,
        concurrency: task.concurrency || 10,
        drive: {
          accessToken: driveToken,
          parentFolderId: task.createdFolderId,
          encrypt: Boolean(encryptionKeyHex),
          encryptionKey: encryptionKeyHex,
        },
        callbackUrl: `${process.env.PUBLIC_HUB_URL}/api/workers/callback`,
      },
      {
        headers: {
          Authorization: process.env.WORKER_API_SECRET ? `Bearer ${process.env.WORKER_API_SECRET}` : undefined,
        },
        timeout: 10000,
      }
    );

    console.log(`✅ Dispatched task "${task.id}" to worker "${idleWorker.id}"`);
    return true;
  } catch (err: any) {
    console.warn(`Failed to dispatch task to remote worker: ${err.message}`);
    return false;
  }
}
```

---

## 8. Verification & Test Evidence

All functionality was verified via automated integration tests against the live FastAPI ASGI application.

### Test Suite Execution Summary
- **Test 1**: `GET /worker/status` returns correct schema, disk properties (`totalGB`, `freeGB`, `usedGB`, `usedPercent`), and status `idle`.
- **Test 2**: `GET /api/workers/pool` returns worker object list with ISO timestamps and active resource usage.
- **Test 3**: `POST /worker/jobs` returns `202 Accepted` with `status: accepted`.
- **Test 4**: State transition verification: worker status becomes `busy`, `activeJob` matches dispatched `jobId`.
- **Test 5**: Concurrent dispatch protection: subsequent `POST /worker/jobs` calls return `409 Conflict`.
- **Test 6**: `POST /worker/jobs/{jobId}/cancel` terminates ongoing tasks and returns `status: cancelled, diskPurged: true`.
- **Test 7**: Reset verification: worker status returns to `idle`, `activeJob` returns to `null`.
- **Test 8**: Multi-level extraction: extracted `.zip` files containing nested inner archives successfully unpack all media files and purge the inner archives from disk.
- **Test 9**: AES-256-CTR streaming encryption: verified random 16-byte IV prepending and bit-for-bit decryption integrity.

---

## 9. Interactive WebSocket Shell, Agent Discovery & SSH Protocol

Every worker node provides direct shell and agent access via WebSocket and OpenSSH.

### A. Interactive WebSocket Shell (`/ws/shell` & `/ws/ssh`)
- **Protocol**: WebSocket (Bidirectional, ANSI text & control frames)
- **Endpoint**: `wss://<worker-api-url>/ws/shell` or relayed through dashboard at `wss://<dashboard>/api/workers/ws/shell?workerId=<id>`
- **PTY Session**: Spawns an interactive login shell (`/bin/bash -l` on Linux) inside a pseudo-terminal.
- **Control Messages**:
  - Window Resize: `{"type": "resize", "cols": 120, "rows": 35}` (handled via `termios.TIOCSWINSZ`)
  - Direct Keystrokes: Plain string or binary chunks forwarded to terminal `stdin`.
- **Environment**: Automatically inherits paths to Antigravity CLI (`agy`), Go Course Worker (`course-worker`), Node.js, and Python.

### B. Agent Discovery (`GET /api/agents/status`)
Returns health, presence, and version of running worker agents:
```json
{
  "workerId": "worker-1",
  "status": "idle",
  "agents": {
    "antigravityCli": { "available": true, "version": "1.0.0", "description": "Google Antigravity CLI Agent (agy)" },
    "courseWorker": { "available": true, "url": "http://127.0.0.1:8085" },
    "codeServer": { "available": true, "url": "https://...trycloudflare.com" },
    "dlengine": { "available": true },
    "puppeteerCdp": { "available": true, "port": 9222 },
    "seleniumCdp": { "available": true, "port": 9223 }
  },
  "ssh": {
    "port": 2222,
    "user": "runner",
    "command": "ssh -p 2222 runner@localhost"
  }
}
```
