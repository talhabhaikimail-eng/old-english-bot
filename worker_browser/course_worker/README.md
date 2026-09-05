# High-Speed Distributed Course Worker Engine (Golang)

High-performance, fault-tolerant, concurrent course worker pipeline written in Go. Replaces single-process Python workers with high concurrency, native stall detection, multi-archive extraction, volume normalization, 1GB split material packaging, Google Drive resumable streaming, and **real-time WebSocket & SSE progress streaming**.

---

## 🚀 Quick Start: Simplified API in 1 Step

You can now process courses with a single request. Pass URLs directly as a raw array, a simple JSON object, or even query parameters.

### 1. Synchronous Single Call (Wait for Completion & Upload Status)
Blocks until the course is downloaded, extracted, packaged, and uploaded to Google Drive. Returns `uploaded: true/false`, drive links, and file manifests:

```bash
curl -X POST "http://localhost:8085/api/process?sync=true" \
  -H "Content-Type: application/json" \
  -d '{"urls": ["https://example.com/Python_Mastery.part1.rar", "https://example.com/Python_Mastery.part2.rar"]}'
```

**Success Response (`200 OK`):**
```json
{
  "success": true,
  "uploaded": true,
  "status": "completed",
  "phase": "completed",
  "jobId": "job_1788592370691",
  "title": "Python Mastery",
  "progressPercent": 100.0,
  "driveFolderId": "1LPdT6EZOsboQlUK4TnLqCu7aHJ2yjagw",
  "driveFolderUrl": "https://drive.google.com/drive/folders/1LPdT6EZOsboQlUK4TnLqCu7aHJ2yjagw",
  "driveFiles": [
    {
      "name": "01_Introduction.mp4",
      "fileId": "1aBcDeFgHiJkLmNoP",
      "sizeBytes": 52428800,
      "webViewLink": "https://drive.google.com/file/d/1aBcDeFgHiJkLmNoP/view",
      "isVideo": true
    }
  ],
  "videoFiles": [{"fileName": "01_Introduction.mp4", "sizeBytes": 52428800, "isVideo": true}],
  "materialZips": [{"fileName": "Python_Mastery.materials.zip", "sizeBytes": 104857600}],
  "completedParts": 2,
  "totalParts": 2,
  "error": ""
}
```

**Failure Response (`500 Internal Server Error`):**
```json
{
  "success": false,
  "uploaded": false,
  "status": "failed",
  "phase": "failed",
  "jobId": "job_1788592370691",
  "error": "link not working: Get \"https://example.com/part1.rar\": 404 Not Found"
}
```

---

### 2. Live WebSocket Stream (`/ws/process`)
Connect to WebSocket, send course URLs, and receive continuous live progress frames ("where we are") until the final result:

```bash
# Using wscat or any WebSocket client:
wscat -c ws://localhost:8085/ws/process
```

**Client Sends:**
```json
{
  "urls": [
    "https://example.com/Docker_Course.part1.rar",
    "https://example.com/Docker_Course.part2.rar"
  ],
  "title": "Docker Complete Guide",
  "upload": true
}
```

**Server Streams:**
```json
{"type":"started","jobId":"job_102","title":"Docker Complete Guide","status":"queued","phase":"pending"}
```
```json
{"type":"progress","jobId":"job_102","phase":"downloading","progressPercent":35.2,"speedMBps":14.8,"completedParts":1,"totalParts":2,"downloadedBytes":150000000}
```
```json
{"type":"progress","jobId":"job_102","phase":"extracting","status":"extracting"}
```
```json
{"type":"progress","jobId":"job_102","phase":"reclaiming","status":"reclaiming"}
```
```json
{"type":"progress","jobId":"job_102","phase":"separating","status":"separating"}
```
```json
{"type":"progress","jobId":"job_102","phase":"uploading","status":"uploading","driveFolderUrl":"https://drive.google.com/drive/folders/1XYZ..."}
```
**Final Terminal Result:**
```json
{
  "type": "result",
  "success": true,
  "uploaded": true,
  "phase": "completed",
  "jobId": "job_102",
  "title": "Docker Complete Guide",
  "driveFolderUrl": "https://drive.google.com/drive/folders/1XYZ...",
  "driveFiles": [...],
  "videoFiles": [...],
  "materialZips": [...],
  "error": ""
}
```

---

### 3. Terminal Live Stream with Server-Sent Events (SSE)
No WebSocket client required—watch live progress directly inside `curl`:

```bash
curl -N "http://localhost:8085/api/process?stream=true" \
  -H "Content-Type: application/json" \
  -d '{"urls": ["https://example.com/Rust_Fast.part1.rar"]}'
```

---

### 4. Interactive Web UI & Test Console
Open your browser at **`http://localhost:8085/`**:
- 🖥️ **Live System Metrics**: Free disk space, CPU load, and active courses.
- 📋 **Input Console**: Paste URLs (one per line or JSON array), set optional password, toggle Google Drive upload.
- 📊 **Visual Progress Bar**: Real-time download speed gauge, part indicators, phase badges.
- 📂 **Instant Links**: Direct clickable link to the created Google Drive course folder upon completion.

---

## 2. API Endpoints Reference

| Method | Path | Description |
| :--- | :--- | :--- |
| `POST` / `GET` | `/api/process` (or `/worker/process`) | **Global Unified API**: Accepts URLs, runs async, sync (`?sync=true`), or SSE (`?stream=true`). |
| `WS` | `/ws/process` (or `/api/ws/process`) | **Interactive WebSocket**: Connect, send payload, and receive live progress stream. |
| `WS` | `/ws/jobs/{id}` | **Job WebSocket**: Connect to monitor a specific job ID in real-time. |
| `WS` | `/ws/jobs` | **Global WebSocket**: Broadcast stream of all active course jobs. |
| `GET` | `/api/jobs/{id}/events` | **SSE Stream**: Server-Sent Events stream for an active job. |
| `GET` | `/worker/status` (or `/api/status`) | Worker health check, disk storage metrics, and concurrency stats. |
| `GET` | `/worker/jobs` (or `/api/jobs`) | List all queued, running, completed, and failed jobs. |
| `GET` | `/worker/jobs/{id}` | Detailed state of a specific course job. |
| `POST` | `/worker/jobs/{id}/cancel` | Abort a job immediately and purge its disk directory. |
| `DELETE`| `/worker/jobs` | Abort all in-flight jobs and wipe the working storage directory clean. |
| `GET` | `/` or `/ui` | Built-in interactive Web UI and testing console. |
| `GET` | `/docs` | Plain-text API specification. |

---

## 3. Global API Request Formats (`POST /api/process`)

The global API accepts any of the following formats:

### Format A: Raw JSON Array of URLs
```json
[
  "https://downloadly.ir/2024/05/Fast_Golang.part1.rar",
  "https://downloadly.ir/2024/05/Fast_Golang.part2.rar"
]
```

### Format B: Simplified Object
```json
{
  "urls": [
    "https://downloadly.ir/2024/05/Fast_Golang.part1.rar",
    "https://downloadly.ir/2024/05/Fast_Golang.part2.rar"
  ],
  "title": "Fast Golang Course",
  "password": "www.downloadly.ir",
  "upload": true
}
```

### Format C: Single URL
```json
{
  "url": "https://example.com/MachineLearning.zip",
  "title": "Machine Learning Bootcamp",
  "upload": true
}
```

### Format D: Query Parameters (GET or POST)
```bash
curl -X GET "http://localhost:8085/api/process?url=https://example.com/Course.zip&sync=true"
```

### Supported Options:

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `urls` | `string[]` | `[]` | List of archive part URLs |
| `url` | `string` | `""` | Single archive URL |
| `title` | `string` | Auto-deduced | Course name (auto-deduced from filename if omitted) |
| `password` | `string` | `www.downloadly.ir` | Archive extraction password |
| `upload` | `boolean` | `true` (if Drive configured) | Upload output files to Google Drive |
| `sync` | `boolean` | `false` | Block request until completion (`?sync=true`) |
| `stream` | `boolean` | `false` | Stream Server-Sent Events (`?stream=true`) |
| `parentFolderId` | `string` | Default Drive folder | Target Google Drive folder ID |
| `accessToken` | `string` | Auto-refreshed OAuth | Custom Google Drive OAuth2 access token |

---

## 4. Client Integration Examples

### A. Python (WebSocket with `websockets`)
```python
import asyncio
import json
import websockets

async def run_course():
    uri = "ws://localhost:8085/ws/process"
    async with websockets.connect(uri) as ws:
        # 1. Read ready handshake
        ready = await ws.recv()
        
        # 2. Submit course
        payload = {
            "urls": ["https://example.com/Python_Data_Science.part1.rar"],
            "upload": True
        }
        await ws.send(json.dumps(payload))
        
        # 3. Stream live progress
        async for msg in ws:
            event = json.loads(msg)
            if event["type"] == "progress":
                print(f"[{event['phase'].upper()}] {event.get('progressPercent', 0):.1f}% | Speed: {event.get('speedMBps', 0):.2f} MB/s")
            elif event["type"] == "result":
                if event["success"] and event["uploaded"]:
                    print(f"🎉 Course uploaded successfully to: {event['driveFolderUrl']}")
                else:
                    print(f"❌ Failed: {event.get('error')}")
                break

asyncio.run(run_course())
```

### B. JavaScript / Node.js (WebSocket)
```javascript
const WebSocket = require('ws');

const ws = new WebSocket('ws://localhost:8085/ws/process');

ws.on('open', () => {
  ws.send(JSON.stringify({
    urls: ['https://example.com/Deep_Learning.part1.rar'],
    title: 'Deep Learning',
    upload: true
  }));
});

ws.on('message', (data) => {
  const event = JSON.parse(data);
  if (event.type === 'progress') {
    console.log(`Phase: ${event.phase} | ${event.progressPercent}% | ${event.speedMBps} MB/s`);
  } else if (event.type === 'result') {
    console.log('Finished! Uploaded:', event.uploaded, 'Drive Link:', event.driveFolderUrl);
    ws.close();
  }
});
```

---

## 5. Pipeline Stages & Lifecycle

Every course follows the strict 5-stage protocol to prevent `ENOSPC` disk exhaustion:

1. **Pre-flight Probe**: Concurrently checks download links (HTTP HEAD/GET range) before allocating disk.
2. **Stage 1 (Download)**: Downloads archive parts concurrently (`dlengine` 16 connections per part or chunked resume).
3. **Stage 2 (Extraction)**: Normalizes split volumes and extracts recursively with password rotation.
4. **Stage 3 (Reclamation)**: Immediately deletes raw `.rar` / `.7z` parts to free 10–40 GB before packaging.
5. **Stage 4 (Separation & Packaging)**: Separates videos into `output/videos/` and packages non-video materials into 1GB split `.zip` volumes.
6. **Stage 5 (Google Drive Upload)**: Streams files to Google Drive using resumable chunked upload with token auto-refresh.
7. **Stage 6 (Completion & Wipe)**: Emits final completion event and purges local storage.

---

## 6. Environment Variables

| Variable | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `MAX_CONCURRENT_COURSES` | Integer | `2` | Number of simultaneous courses processed |
| `PART_CONCURRENCY` | Integer | `3` | Parallel parts downloaded per course |
| `DL_CONCURRENCY_PER_PART`| Integer | `16` | Download chunks/workers per part |
| `JOBS_BASE_DIR` | String | `/tmp/course_jobs` | Base working directory |
| `SAFETY_DISK_MIN_BYTES` | Integer | `5368709120` (5GB) | Minimum free disk space threshold |
| `DOWNLOAD_STALL_TIMEOUT_SEC` | Integer | `60` | Inactivity watchdog timeout in seconds |
| `AUTO_UPLOAD_DRIVE` | Boolean | `false` | Default auto-upload behavior when unspecified in request |
| `DATABASE_URL` | String | `""` | Neon PostgreSQL database URL for OAuth tokens & DB sync |
| `DEFAULT_DRIVE_FOLDER_ID` | String | `1UmpfulblvP-fmvPia3kgXfvDUc7Zh4n1` | Root parent folder ID in Google Drive |
| `PORT` | Integer | `8085` | HTTP & WebSocket server port |

---

## 7. Running the Daemon

```bash
# Build the binary
go build -o bin/course-worker .

# Run the HTTP & WebSocket server
./bin/course-worker serve --port 8085 --concurrency 2
```
