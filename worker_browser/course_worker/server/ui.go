package server

import (
	"fmt"
	"net/http"
)

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" && r.URL.Path != "/ui" {
		http.NotFound(w, r)
		return
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(uiHTML))
}

func (s *Server) handleDocs(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	doc := fmt.Sprintf(`================================================================================
HIGH-SPEED COURSE WORKER API REFERENCE (PORT %d)
================================================================================

1. SIMPLIFIED GLOBAL API: POST /api/process (or GET /api/process)
   Accepts:
   - {"urls": ["https://...part1.rar", "https://...part2.rar"]}
   - {"url": "https://...single.rar"}
   - ["https://...part1.rar", "https://...part2.rar"]
   - Options: "title", "password", "upload": true|false, "sync": true|false

   A. Synchronous (Wait for completion & return uploaded status):
      curl -X POST http://localhost:%d/api/process?sync=true \
        -H "Content-Type: application/json" \
        -d '{"urls": ["https://example.com/course.part1.rar"]}'

   B. Real-time Event Stream (SSE):
      curl -N http://localhost:%d/api/process?stream=true \
        -H "Content-Type: application/json" \
        -d '{"urls": ["https://example.com/course.part1.rar"]}'

   C. Asynchronous (Returns job ID & URLs):
      curl -X POST http://localhost:%d/api/process \
        -H "Content-Type: application/json" \
        -d '{"urls": ["https://example.com/course.part1.rar"]}'

2. WEBSOCKET API:
   A. Interactive Job Runner: ws://localhost:%d/ws/process
      Connect and send:
      {"urls": ["https://example.com/course.part1.rar"], "upload": true}
      Streams real-time progress events until completion:
      {"type": "progress", "phase": "downloading", "progressPercent": 45.2, ...}
      Terminal frame:
      {"type": "result", "success": true, "uploaded": true, "driveFolderUrl": "...", ...}

   B. Live Job Monitor: ws://localhost:%d/ws/jobs/{id}
      Streams live events for an existing job.

   C. Global Monitor: ws://localhost:%d/ws/jobs
      Streams live events for all jobs.

3. WORKER STATUS:
   curl http://localhost:%d/worker/status
================================================================================
`, s.cfg.HTTPPort, s.cfg.HTTPPort, s.cfg.HTTPPort, s.cfg.HTTPPort, s.cfg.HTTPPort, s.cfg.HTTPPort, s.cfg.HTTPPort, s.cfg.HTTPPort)
	_, _ = w.Write([]byte(doc))
}

const uiHTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>⚡ High-Speed Course Worker Dashboard</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --border: #334155;
      --primary: #3b82f6;
      --primary-hover: #2563eb;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
      --text: #f8fafc;
      --text-muted: #94a3b8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background: var(--bg); color: var(--text); padding: 24px; }
    .container { max-width: 1000px; margin: 0 auto; display: flex; flex-direction: column; gap: 24px; }
    .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); padding-bottom: 16px; }
    .badge { padding: 4px 10px; border-radius: 9999px; font-size: 12px; font-weight: 600; text-transform: uppercase; }
    .badge-idle { background: #064e3b; color: #6ee7b7; }
    .badge-busy { background: #78350f; color: #fcd34d; }
    .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 20px; }
    .card-title { font-size: 18px; font-weight: 600; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: center; }
    .form-group { margin-bottom: 14px; }
    label { display: block; font-size: 13px; font-weight: 500; color: var(--text-muted); margin-bottom: 6px; }
    textarea, input[type="text"], select { width: 100%; background: #0f172a; border: 1px solid var(--border); color: var(--text); padding: 10px 14px; border-radius: 8px; font-size: 14px; outline: none; transition: border-color 0.2s; }
    textarea:focus, input:focus { border-color: var(--primary); }
    .checkbox-group { display: flex; align-items: center; gap: 8px; cursor: pointer; }
    .checkbox-group input { width: 16px; height: 16px; accent-color: var(--primary); }
    .btn { background: var(--primary); color: white; border: none; padding: 12px 20px; border-radius: 8px; font-weight: 600; cursor: pointer; font-size: 15px; width: 100%; transition: background 0.2s; }
    .btn:hover { background: var(--primary-hover); }
    .btn:disabled { opacity: 0.6; cursor: not-allowed; }
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; }
    .stat-box { background: #0f172a; padding: 14px; border-radius: 8px; border: 1px solid var(--border); }
    .stat-val { font-size: 20px; font-weight: 700; margin-top: 4px; }
    .progress-bar-container { width: 100%; height: 12px; background: #0f172a; border-radius: 9999px; overflow: hidden; margin: 12px 0; }
    .progress-bar { height: 100%; width: 0%; background: var(--primary); transition: width 0.3s ease; border-radius: 9999px; }
    .phase-badge { padding: 4px 12px; border-radius: 6px; font-weight: 600; font-size: 13px; }
    .phase-downloading { background: #1e3a8a; color: #93c5fd; }
    .phase-extracting { background: #713f12; color: #fde047; }
    .phase-reclaiming { background: #581c87; color: #e9d5ff; }
    .phase-separating { background: #312e81; color: #c7d2fe; }
    .phase-uploading { background: #134e4a; color: #5eead4; }
    .phase-completed { background: #064e3b; color: #6ee7b7; }
    .phase-failed { background: #7f1d1d; color: #fca5a5; }
    .console-log { background: #020617; border: 1px solid var(--border); border-radius: 8px; padding: 12px; font-family: monospace; font-size: 12px; height: 160px; overflow-y: auto; color: #cbd5e1; display: flex; flex-direction: column; gap: 4px; }
    .result-box { padding: 14px; border-radius: 8px; margin-top: 14px; display: none; }
    .result-success { background: rgba(16, 185, 129, 0.1); border: 1px solid var(--success); }
    .result-failed { background: rgba(239, 68, 68, 0.1); border: 1px solid var(--danger); }
    .drive-link { display: inline-block; margin-top: 8px; color: #60a5fa; text-decoration: none; font-weight: 600; }
    .drive-link:hover { text-decoration: underline; }
    pre { background: #090d16; padding: 12px; border-radius: 6px; font-size: 12px; overflow-x: auto; color: #93c5fd; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div>
        <h1>⚡ High-Speed Course Worker</h1>
        <p style="color: var(--text-muted); font-size: 14px;">Concurrent Download • Password Extraction • Material Packaging • Drive Streaming</p>
      </div>
      <div id="statusBadge" class="badge badge-idle">Idle</div>
    </div>

    <!-- Metrics -->
    <div class="card">
      <div class="card-title">🖥️ Worker Node Metrics</div>
      <div class="stats-grid">
        <div class="stat-box">
          <label>Worker ID</label>
          <div class="stat-val" id="mWorkerId">-</div>
        </div>
        <div class="stat-box">
          <label>Free Disk Space</label>
          <div class="stat-val" id="mDiskFree">-</div>
        </div>
        <div class="stat-box">
          <label>Used Disk %</label>
          <div class="stat-val" id="mDiskUsed">-</div>
        </div>
        <div class="stat-box">
          <label>Active Courses</label>
          <div class="stat-val" id="mActiveCount">0</div>
        </div>
      </div>
    </div>

    <!-- Global API Runner -->
    <div class="card">
      <div class="card-title">🚀 Global Course API Runner (WebSocket / Sync / Async)</div>
      <div class="form-group">
        <label>Course Download URLs (one per line, or JSON array)</label>
        <textarea id="urlInput" rows="3" placeholder="https://example.com/files/Course.part1.rar&#10;https://example.com/files/Course.part2.rar"></textarea>
      </div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 14px;">
        <div class="form-group">
          <label>Course Title (Optional - auto-deduced if empty)</label>
          <input type="text" id="titleInput" placeholder="Auto-deduced from filename">
        </div>
        <div class="form-group">
          <label>Archive Password (Optional)</label>
          <input type="text" id="pwdInput" value="www.downloadly.ir">
        </div>
      </div>
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
        <label class="checkbox-group">
          <input type="checkbox" id="uploadDrive" checked>
          <span>Auto-Upload to Google Drive</span>
        </label>
        <span style="font-size: 13px; color: var(--text-muted);" id="wsState">WebSocket: Ready</span>
      </div>
      <button class="btn" id="startBtn" onclick="runCourse()">Start Processing with Live Updates</button>

      <!-- Live Progress View -->
      <div id="progressSection" style="display: none; margin-top: 20px;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span id="jobPhaseBadge" class="phase-badge phase-downloading">PENDING</span>
          <span id="jobPercentText" style="font-weight: 700; font-size: 16px;">0.0%</span>
        </div>
        <div class="progress-bar-container">
          <div class="progress-bar" id="progressBar"></div>
        </div>
        <div style="display: flex; justify-content: space-between; font-size: 13px; color: var(--text-muted); margin-bottom: 12px;">
          <span id="jobSpeed">Speed: 0.00 MB/s</span>
          <span id="jobParts">Parts: 0 / 0</span>
          <span id="jobBytes">Downloaded: 0 MB</span>
        </div>

        <div class="console-log" id="consoleLog"></div>

        <div class="result-box" id="resultBox">
          <div id="resultText"></div>
          <a href="#" target="_blank" class="drive-link" id="driveFolderLink" style="display:none;">📂 Open Google Drive Course Folder</a>
        </div>
      </div>
    </div>

    <!-- Quick Curl Snippets -->
    <div class="card">
      <div class="card-title">📖 Simplified API Quickstart</div>
      <p style="font-size: 14px; color: var(--text-muted); margin-bottom: 8px;">Run directly in terminal with 1 command:</p>
      <pre># 1. Single synchronous call (waits and returns uploaded: true/false):
curl -X POST http://localhost:8085/api/process?sync=true \
  -H "Content-Type: application/json" \
  -d '{"urls": ["https://example.com/course.part1.rar", "https://example.com/course.part2.rar"]}'

# 2. Real-time WebSocket connection:
wscat -c ws://localhost:8085/ws/process
# Send: {"urls": ["https://example.com/course.part1.rar"], "upload": true}

# 3. Terminal Live Stream (SSE):
curl -N http://localhost:8085/api/process?stream=true \
  -H "Content-Type: application/json" \
  -d '{"urls": ["https://example.com/course.part1.rar"]}'</pre>
    </div>
  </div>

  <script>
    async function updateMetrics() {
      try {
        const res = await fetch('/worker/status');
        const data = await res.json();
        document.getElementById('mWorkerId').innerText = data.workerId || 'worker';
        document.getElementById('mDiskFree').innerText = data.disk ? data.disk.freeGB + ' GB' : '-';
        document.getElementById('mDiskUsed').innerText = data.disk ? data.disk.usedPercent + '%' : '-';
        document.getElementById('mActiveCount').innerText = data.activeCourses || '0';
        const badge = document.getElementById('statusBadge');
        if (data.status === 'busy') {
          badge.className = 'badge badge-busy';
          badge.innerText = 'Busy (' + data.activeCourses + ')';
        } else {
          badge.className = 'badge badge-idle';
          badge.innerText = 'Idle';
        }
      } catch (e) { console.error(e); }
    }
    setInterval(updateMetrics, 5000);
    updateMetrics();

    function logMsg(msg) {
      const el = document.getElementById('consoleLog');
      const d = document.createElement('div');
      d.innerText = '[' + new Date().toLocaleTimeString() + '] ' + msg;
      el.appendChild(d);
      el.scrollTop = el.scrollHeight;
    }

    function runCourse() {
      const rawUrls = document.getElementById('urlInput').value.trim();
      if (!rawUrls) {
        alert('Please provide at least one download URL');
        return;
      }

      let urls = [];
      if (rawUrls.startsWith('[')) {
        try { urls = JSON.parse(rawUrls); } catch (e) { urls = [rawUrls]; }
      } else {
        urls = rawUrls.split('\n').map(u => u.trim()).filter(u => u.length > 0);
      }

      const title = document.getElementById('titleInput').value.trim();
      const pwd = document.getElementById('pwdInput').value.trim();
      const upload = document.getElementById('uploadDrive').checked;

      const progressSection = document.getElementById('progressSection');
      progressSection.style.display = 'block';
      document.getElementById('resultBox').style.display = 'none';
      document.getElementById('consoleLog').innerHTML = '';
      document.getElementById('startBtn').disabled = true;

      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = proto + '//' + location.host + '/ws/process';
      logMsg('Connecting to WebSocket: ' + wsUrl);

      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        logMsg('WebSocket connected. Sending course request...');
        ws.send(JSON.stringify({
          urls: urls,
          title: title,
          password: pwd,
          upload: upload
        }));
      };

      ws.onmessage = (evt) => {
        const msg = JSON.parse(evt.data);
        if (msg.type === 'started') {
          logMsg('Job started: ' + msg.jobId + ' (' + msg.title + ')');
        } else if (msg.type === 'progress') {
          const phase = msg.phase || 'downloading';
          const pBadge = document.getElementById('jobPhaseBadge');
          pBadge.className = 'phase-badge phase-' + phase;
          pBadge.innerText = phase.toUpperCase();

          const pct = (msg.progressPercent || 0).toFixed(1);
          document.getElementById('progressBar').style.width = pct + '%';
          document.getElementById('jobPercentText').innerText = pct + '%';
          document.getElementById('jobSpeed').innerText = 'Speed: ' + (msg.speedMBps || 0).toFixed(2) + ' MB/s';
          document.getElementById('jobParts').innerText = 'Parts: ' + (msg.completedParts || 0) + ' / ' + (msg.totalParts || 0);
          document.getElementById('jobBytes').innerText = 'Downloaded: ' + ((msg.downloadedBytes || 0) / (1024 * 1024)).toFixed(1) + ' MB';

          logMsg('Phase: ' + phase + ' | Progress: ' + pct + '%');
        } else if (msg.type === 'result') {
          document.getElementById('startBtn').disabled = false;
          const resBox = document.getElementById('resultBox');
          const resText = document.getElementById('resultText');
          const driveLink = document.getElementById('driveFolderLink');
          resBox.style.display = 'block';

          if (msg.success) {
            resBox.className = 'result-box result-success';
            let uploadedText = msg.uploaded ? '✅ Course Uploaded to Google Drive Successfully!' : '📦 Course Packaged Locally (Upload Skipped)';
            resText.innerHTML = '<strong>' + uploadedText + '</strong><br>' +
              'Videos: ' + (msg.videoFiles ? msg.videoFiles.length : 0) + ' | Material Zip Volumes: ' + (msg.materialZips ? msg.materialZips.length : 0);
            if (msg.driveFolderUrl) {
              driveLink.href = msg.driveFolderUrl;
              driveLink.style.display = 'inline-block';
            }
            logMsg('Job finished successfully! Uploaded: ' + msg.uploaded);
          } else {
            resBox.className = 'result-box result-failed';
            resText.innerHTML = '<strong>❌ Processing Failed:</strong> ' + (msg.error || 'Unknown error');
            driveLink.style.display = 'none';
            logMsg('Job failed: ' + msg.error);
          }
        }
      };

      ws.onerror = (err) => {
        logMsg('WebSocket error: ' + err);
        document.getElementById('startBtn').disabled = false;
      };

      ws.onclose = () => {
        logMsg('WebSocket connection closed.');
        document.getElementById('startBtn').disabled = false;
      };
    }
  </script>
</body>
</html>
`
