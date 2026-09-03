"""
course_worker.py — Distributed Course Extraction & Upload Engine.

Adheres strictly to the 5-Stage Worker Disk Protocol (Preventing ENOSPC):
  Stage 1: Concurrent archive parts streaming with < 5GB disk abort check, per-part retries & 1000ms progress reports.
  Stage 2: Archive extraction (unrar, 7z, tar, zip) + recursive nested archive unpacking with volume normalization.
  Stage 3: Part reclamation (immediate deletion of all archive parts to free 10-40 GB).
  Stage 4: Progressive resumable Google Drive upload (AES-256-CTR with 308 block alignment) + immediate unlink of each file.
  Stage 5: Full wipe & idle transition + final completion callback.
"""

import os
import sys
import re
import shlex
import html
import json
import time
import shutil
import socket
import ipaddress
import asyncio
import functools
import tempfile
import logging
import urllib.parse
import threading
import random
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any, Tuple

import httpx
import requests
from requests.adapters import HTTPAdapter
from pydantic import BaseModel, Field
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

try:
    import psutil
except ImportError:
    psutil = None

try:
    from dlengine import DLEngine, ProgressEvent, DownloadEngineError
except ImportError:
    try:
        from worker_browser.dlengine import DLEngine, ProgressEvent, DownloadEngineError
    except ImportError:
        DLEngine = None
        ProgressEvent = None
        DownloadEngineError = None

# ---------------------------------------------------------------------------
# Structured Logging Setup
# ---------------------------------------------------------------------------
logger = logging.getLogger("course_worker")
if not logger.handlers:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter("[%(asctime)s] [%(levelname)s] [course_worker] %(message)s", datefmt="%Y-%m-%d %H:%M:%S"))
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)

# ---------------------------------------------------------------------------
# Worker Configuration & Constants
# ---------------------------------------------------------------------------
WORKER_ID = os.environ.get("WORKER_ID") or f"worker-{socket.gethostname()[:12]}"
WORKER_PUBLIC_URL = os.environ.get("WORKER_PUBLIC_URL", "").rstrip("/")
WORKER_API_SECRET = os.environ.get("WORKER_API_SECRET", "")
DEFAULT_CONCURRENCY = int(os.environ.get("CONCURRENCY_LIMIT", "10"))
MAX_CONCURRENT_JOBS = int(os.environ.get("MAX_CONCURRENT_JOBS", "6"))
EXTRACTION_TIMEOUT_SEC = float(os.environ.get("EXTRACTION_TIMEOUT_SEC", "3600.0"))
SAFETY_DISK_MIN_BYTES = int(os.environ.get("SAFETY_DISK_MIN_BYTES", str(5 * 1024 * 1024 * 1024))) # 5 GB
UPLOAD_CONCURRENCY = int(os.environ.get("UPLOAD_CONCURRENCY", "6"))
MAX_UPLOAD_CONCURRENCY = int(os.environ.get("MAX_UPLOAD_CONCURRENCY", "10"))
DOWNLOAD_FILE_TIMEOUT_SEC = float(os.environ.get("DOWNLOAD_FILE_TIMEOUT_SEC", os.environ.get("DOWNLOAD_PART_TIMEOUT_SEC", "1800.0"))) # 30 min per file
DOWNLOAD_STALL_TIMEOUT_SEC = float(os.environ.get("DOWNLOAD_STALL_TIMEOUT_SEC", "60.0")) # 60s stall/inactivity timeout

# Base temporary jobs directory (e.g., /tmp/jobs or system temp)
if os.path.exists("/tmp") and os.access("/tmp", os.W_OK):
    JOBS_BASE_DIR = os.environ.get("JOBS_BASE_DIR", "/tmp/jobs")
else:
    JOBS_BASE_DIR = os.environ.get("JOBS_BASE_DIR", os.path.join(tempfile.gettempdir(), "jobs"))

# Prime psutil CPU percent counter on module load
if psutil:
    try:
        psutil.cpu_percent(interval=None)
    except Exception:
        pass

# Shared HTTP connection pool
HTTP_CLIENT = httpx.AsyncClient(
    timeout=httpx.Timeout(connect=15.0, read=120.0, write=30.0, pool=30.0),
    limits=httpx.Limits(max_keepalive_connections=50, max_connections=100),
    follow_redirects=True,
)

# ---------------------------------------------------------------------------
# Dedicated upload thread pool + Thread-Local Drive HTTP sessions
# ---------------------------------------------------------------------------
# Bounded to MAX_UPLOAD_CONCURRENCY to strictly prevent Google Drive rate
# limits and thread-safety / socket pool corruption issues.
UPLOAD_EXECUTOR = ThreadPoolExecutor(
    max_workers=max(MAX_UPLOAD_CONCURRENCY, UPLOAD_CONCURRENCY, 8),
    thread_name_prefix="drive-upload",
)

_drive_thread_local = threading.local()

def get_drive_session() -> requests.Session:
    """Returns a thread-local requests.Session to avoid thread concurrency bugs and connection pool deadlocks."""
    if not hasattr(_drive_thread_local, "session"):
        session = requests.Session()
        adapter = HTTPAdapter(
            pool_connections=10,
            pool_maxsize=10,
            max_retries=0,
        )
        session.mount("https://", adapter)
        session.mount("http://", adapter)
        _drive_thread_local.session = session
    return _drive_thread_local.session

# Legacy alias for compatibility if needed
DRIVE_HTTP_SESSION = requests.Session()


def compute_adaptive_upload_concurrency(file_sizes: List[int], requested: Optional[int] = None) -> int:
    """
    Picks a safe upload concurrency level based on the mix of file sizes.
    Google Drive API rate limits user tokens to ~10 requests per second.
    To avoid 403 userRateLimitExceeded, 429 Too Many Requests, and socket resets,
    concurrency is strictly capped at a safe maximum (default 6, range 2 to 10).
    """
    cap = MAX_UPLOAD_CONCURRENCY
    if requested:
        cap = max(1, min(int(requested), MAX_UPLOAD_CONCURRENCY))

    if not file_sizes:
        return min(cap, UPLOAD_CONCURRENCY)

    avg_size = sum(file_sizes) / len(file_sizes)

    if avg_size <= 2 * 1024 * 1024:          # tiny files (< 2 MB)
        target = min(8, cap)
    elif avg_size <= 20 * 1024 * 1024:       # small/medium files
        target = min(6, cap)
    elif avg_size <= 200 * 1024 * 1024:      # larger media files
        target = min(4, cap)
    else:                                    # very large files (> 200 MB)
        target = min(3, cap)

    return max(1, min(target, cap))


# ---------------------------------------------------------------------------
# Pydantic Schemas
# ---------------------------------------------------------------------------
class DriveUploadConfig(BaseModel):
    accessToken: str
    parentFolderId: str
    encrypt: Optional[bool] = True
    encryptionKey: Optional[str] = None
    accountId: Optional[str] = None


class CourseJobRequest(BaseModel):
    jobId: str
    courseName: str
    archiveUrls: List[str]
    concurrency: Optional[int] = DEFAULT_CONCURRENCY
    drive: DriveUploadConfig
    callbackUrl: str
    password: Optional[str] = None
    tokenRefreshUrl: Optional[str] = None
    downloadTimeoutSec: Optional[float] = None
    downloadStallTimeoutSec: Optional[float] = None
    uploadConcurrency: Optional[int] = None


# ---------------------------------------------------------------------------
# Helper Utilities
# ---------------------------------------------------------------------------
def is_safe_archive_url(url: str) -> bool:
    """Validates that a URL is http/https and does not point to internal/private IP space."""
    try:
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme not in ("http", "https"):
            return False
        hostname = parsed.hostname
        if not hostname:
            return False
        if hostname.lower() in ("localhost", "127.0.0.1", "::1", "metadata.google.internal", "169.254.169.254"):
            return False
        try:
            ip_addr = socket.gethostbyname(hostname)
            ip_obj = ipaddress.ip_address(ip_addr)
            if ip_obj.is_private or ip_obj.is_loopback or ip_obj.is_link_local or ip_obj.is_reserved:
                return False
        except Exception:
            pass
        return True
    except Exception:
        return False


def get_disk_metrics(target_path: Optional[str] = None) -> Dict[str, float]:
    """Cross-platform disk space stats (in GB) without filesystem side effects."""
    check_path = target_path or JOBS_BASE_DIR
    if not os.path.exists(check_path):
        check_path = os.path.dirname(check_path) or tempfile.gettempdir()
    if not os.path.exists(check_path):
        check_path = tempfile.gettempdir()

    try:
        usage = shutil.disk_usage(check_path)
        free_gb = round(usage.free / (1024 ** 3), 2)
        total_gb = round(usage.total / (1024 ** 3), 2)
        used_gb = round(usage.used / (1024 ** 3), 2)
        used_percent = round((usage.used / usage.total) * 100, 1) if usage.total > 0 else 0.0
        return {
            "totalGB": total_gb,
            "freeGB": free_gb,
            "usedGB": used_gb,
            "usedPercent": used_percent,
        }
    except Exception as e:
        logger.error(f"Error reading disk metrics: {e}")
        return {
            "totalGB": 0.0,
            "freeGB": 0.0,
            "usedGB": 0.0,
            "usedPercent": 100.0,
        }


def get_cpu_percent() -> float:
    """Current CPU usage percentage."""
    if psutil:
        try:
            return round(psutil.cpu_percent(interval=None), 1)
        except Exception:
            pass
    return 0.0


class FatalDownloadError(RuntimeError):
    """
    Raised only for conditions that must abort the ENTIRE download stage
    (e.g. disk full) — as opposed to a single link permanently failing,
    which should not stop other queued links from downloading.
    """
    pass


def natural_sort_key(s: str) -> List[Any]:
    """Natural numerical sort key: '02.mp4' < '10.mp4'."""
    return [int(text) if text.isdigit() else text.lower() for text in re.split(r'(\d+)', s)]


def add_blocks_to_iv_py(iv: bytes, block_count: int) -> bytes:
    """Increment a 16-byte IV by a 128-bit block count in Big-Endian."""
    iv_int = int.from_bytes(iv, byteorder="big")
    new_iv_int = (iv_int + block_count) % (1 << 128)
    return new_iv_int.to_bytes(16, byteorder="big")


async def post_webhook(url: str, payload: Dict[str, Any], timeout: float = 10.0):
    """Deliver webhook updates to Central Hub with timeout, auth, and error handling via shared connection pool."""
    if not url:
        return
    headers = {"Content-Type": "application/json"}
    if WORKER_API_SECRET:
        headers["X-Worker-Secret"] = WORKER_API_SECRET
        headers["Authorization"] = f"Bearer {WORKER_API_SECRET}"
    try:
        resp = await HTTP_CLIENT.post(url, json=payload, headers=headers, timeout=timeout)
        if resp.status_code >= 400:
            logger.warning(f"Webhook callback returned HTTP {resp.status_code}: {resp.text[:120]}")
    except Exception as e:
        logger.warning(f"Webhook callback failed for {url}: {e}")


async def fetch_refreshed_token(job_id: str, callback_url: str, account_id: Optional[str] = None, token_refresh_url: Optional[str] = None) -> Optional[str]:
    """Asynchronously requests a freshly minted Google OAuth token from the Central Hub without blocking the event loop."""
    try:
        headers = {}
        if WORKER_API_SECRET:
            headers["X-Worker-Secret"] = WORKER_API_SECRET
            headers["Authorization"] = f"Bearer {WORKER_API_SECRET}"

        endpoints = []
        if token_refresh_url:
            endpoints.append(token_refresh_url)

        parsed = urllib.parse.urlparse(callback_url)
        base_hub_url = f"{parsed.scheme}://{parsed.netloc}"
        endpoints.append(f"{base_hub_url}/api/courses/{job_id}/refresh-token")
        if account_id:
            endpoints.append(f"{base_hub_url}/api/accounts/{account_id}/token")

        for ep in endpoints:
            try:
                res = await HTTP_CLIENT.get(ep, headers=headers, timeout=10.0)
                if res.status_code == 200:
                    data = res.json()
                    token = data.get("accessToken") or data.get("token")
                    if token:
                        logger.info(f"🔑 Successfully refreshed Google Drive access token from Hub ({ep})")
                        return token
            except Exception:
                continue
    except Exception as e:
        logger.warning(f"Could not refresh access token from Hub: {e}")
    return None


def fetch_refreshed_token_sync(job_id: str, callback_url: str, account_id: Optional[str] = None, token_refresh_url: Optional[str] = None) -> Optional[str]:
    """Synchronously requests a freshly minted Google OAuth token from the Central Hub in worker threads."""
    try:
        headers = {}
        if WORKER_API_SECRET:
            headers["X-Worker-Secret"] = WORKER_API_SECRET
            headers["Authorization"] = f"Bearer {WORKER_API_SECRET}"

        endpoints = []
        if token_refresh_url:
            endpoints.append(token_refresh_url)

        parsed = urllib.parse.urlparse(callback_url)
        base_hub_url = f"{parsed.scheme}://{parsed.netloc}"
        endpoints.append(f"{base_hub_url}/api/courses/{job_id}/refresh-token")
        if account_id:
            endpoints.append(f"{base_hub_url}/api/accounts/{account_id}/token")

        for ep in endpoints:
            try:
                res = requests.get(ep, headers=headers, timeout=10)
                if res.status_code == 200:
                    data = res.json()
                    token = data.get("accessToken") or data.get("token")
                    if token:
                        logger.info(f"🔑 Successfully refreshed Google Drive access token from Hub ({ep})")
                        return token
            except Exception:
                continue
    except Exception as e:
        logger.warning(f"Could not refresh access token synchronously from Hub: {e}")
    return None


# ---------------------------------------------------------------------------
# Course Job Manager Singleton
# ---------------------------------------------------------------------------
class CourseJobManager:
    def __init__(self):
        self.active_jobs: Dict[str, Dict[str, Any]] = {}
        self.cancel_events: Dict[str, asyncio.Event] = {}
        self.current_tasks: Dict[str, asyncio.Task] = {}
        self.current_procs: Dict[str, asyncio.subprocess.Process] = {}

    def is_busy(self) -> bool:
        """Returns True if the worker is currently running at maximum configured concurrent job capacity."""
        return len(self.active_jobs) >= MAX_CONCURRENT_JOBS

    def get_active_job_id(self) -> Optional[str]:
        return next(iter(self.active_jobs.keys()), None)

    def get_active_job_ids(self) -> List[str]:
        return list(self.active_jobs.keys())

    def get_status(self) -> str:
        return "busy" if self.active_jobs else "idle"

    async def cancel_job(self, job_id: str) -> bool:
        """Force cancels an active job, awaits task termination with timeout, and purges disk cleanly."""
        found = False
        if job_id in self.active_jobs or job_id in self.current_tasks:
            found = True
            logger.warning(f"🛑 Cancelling active job {job_id}...")
            ev = self.cancel_events.get(job_id)
            if ev:
                ev.set()

            proc = self.current_procs.get(job_id)
            if proc and proc.returncode is None:
                try:
                    proc.kill()
                except Exception:
                    pass

            task = self.current_tasks.get(job_id)
            if task and not task.done():
                task.cancel()
                try:
                    await asyncio.wait_for(asyncio.shield(task), timeout=5.0)
                except (asyncio.CancelledError, asyncio.TimeoutError, Exception):
                    pass

        job_dir = os.path.join(JOBS_BASE_DIR, job_id)
        if os.path.exists(job_dir):
            shutil.rmtree(job_dir, ignore_errors=True)
            found = True

        self.active_jobs.pop(job_id, None)
        self.cancel_events.pop(job_id, None)
        self.current_tasks.pop(job_id, None)
        self.current_procs.pop(job_id, None)
        return found

    def start_job(self, req: CourseJobRequest):
        """Initializes job state and schedules asynchronous background processing."""
        if self.is_busy():
            raise RuntimeError(f"Worker {WORKER_ID} is busy (running max {MAX_CONCURRENT_JOBS} concurrent jobs).")

        # SSRF Protection: Validate archive URLs before accepting
        for url in req.archiveUrls:
            if not is_safe_archive_url(url):
                raise ValueError(f"Invalid or disallowed archive URL: {url}")

        cancel_ev = asyncio.Event()
        self.cancel_events[req.jobId] = cancel_ev
        self.active_jobs[req.jobId] = {
            "jobId": req.jobId,
            "courseName": req.courseName,
            "status": "accepted",
            "phase": "downloading",
            "startTime": time.time(),
        }

        task = asyncio.create_task(self._execute_job_lifecycle(req, cancel_ev))
        self.current_tasks[req.jobId] = task

    async def _execute_job_lifecycle(self, req: CourseJobRequest, cancel_event: asyncio.Event):
        job_id = req.jobId
        start_time = time.time()
        job_dir = os.path.join(JOBS_BASE_DIR, job_id)
        parts_dir = os.path.join(job_dir, "parts")
        extracted_dir = os.path.join(job_dir, "extracted")

        # Upfront disk space verification
        disk_info = get_disk_metrics(JOBS_BASE_DIR)
        if disk_info["freeGB"] < (SAFETY_DISK_MIN_BYTES / (1024 ** 3)):
            err_msg = f"Insufficient disk space to accept job {job_id}: only {disk_info['freeGB']} GB free (minimum 5 GB required)."
            logger.error(err_msg)
            await post_webhook(req.callbackUrl, {
                "jobId": job_id,
                "workerId": WORKER_ID,
                "phase": "failed",
                "status": "failed",
                "error": err_msg,
            })
            self.active_jobs.pop(job_id, None)
            self.cancel_events.pop(job_id, None)
            self.current_tasks.pop(job_id, None)
            return

        os.makedirs(parts_dir, exist_ok=True)
        os.makedirs(extracted_dir, exist_ok=True)

        try:
            # ---------------------------------------------------------------
            # STAGE 1: CONCURRENT DOWNLOAD WITH 5GB DISK PROTECTION & 1000ms WEBHOOK
            # ---------------------------------------------------------------
            logger.info(f"📥 [Job {job_id}] STAGE 1: Downloading {len(req.archiveUrls)} parts...")
            if job_id in self.active_jobs:
                self.active_jobs[job_id]["phase"] = "downloading"
            await self._download_parts(req, parts_dir, cancel_event)

            if cancel_event.is_set():
                raise asyncio.CancelledError(f"Job {job_id} cancelled.")

            # ---------------------------------------------------------------
            # STAGE 2: ARCHIVE EXTRACTION (UNRAR / 7Z / TAR / ZIP)
            # ---------------------------------------------------------------
            logger.info(f"📦 [Job {job_id}] STAGE 2: Extracting archives to {extracted_dir}...")
            if job_id in self.active_jobs:
                self.active_jobs[job_id]["phase"] = "extracting"
            await post_webhook(req.callbackUrl, {
                "jobId": job_id,
                "workerId": WORKER_ID,
                "phase": "extracting",
                "message": f"Extracting archive volumes into {extracted_dir}...",
            })

            await self._extract_archives(parts_dir, extracted_dir, job_id, cancel_event, req.password)

            if cancel_event.is_set():
                raise asyncio.CancelledError(f"Job {job_id} cancelled.")

            # ---------------------------------------------------------------
            # STAGE 3: PART RECLAMATION (CRUCIAL DISK FREEING)
            # ---------------------------------------------------------------
            logger.info(f"🧹 [Job {job_id}] STAGE 3: Purging parts directory to reclaim disk...")
            if job_id in self.active_jobs:
                self.active_jobs[job_id]["phase"] = "reclaiming_disk"
            shutil.rmtree(parts_dir, ignore_errors=True)

            disk_info = get_disk_metrics(JOBS_BASE_DIR)
            logger.info(f"✅ [Job {job_id}] Parts purged! Current free disk: {disk_info['freeGB']} GB")

            if cancel_event.is_set():
                raise asyncio.CancelledError(f"Job {job_id} cancelled.")

            # ---------------------------------------------------------------
            # STAGE 4: PROGRESSIVE UPLOAD & IMMEDIATE UNLINK
            # ---------------------------------------------------------------
            logger.info(f"☁️ [Job {job_id}] STAGE 4: Progressive upload to Drive & immediate unlinking...")
            if job_id in self.active_jobs:
                self.active_jobs[job_id]["phase"] = "uploading"
            total_uploaded = await self._upload_and_unlink_files(extracted_dir, req, cancel_event)

            # ---------------------------------------------------------------
            # STAGE 5: FULL WIPE & IDLE TRANSITION
            # ---------------------------------------------------------------
            logger.info(f"✨ [Job {job_id}] STAGE 5: Full wipe and completion notification...")
            shutil.rmtree(job_dir, ignore_errors=True)

            elapsed_sec = int(time.time() - start_time)
            await post_webhook(req.callbackUrl, {
                "jobId": job_id,
                "workerId": WORKER_ID,
                "phase": "completed",
                "status": "idle",
                "totalFilesUploaded": total_uploaded,
                "driveFolderId": req.drive.parentFolderId,
                "diskCleaned": True,
                "executionDurationSec": elapsed_sec,
            })
            logger.info(f"🎉 [Job {job_id}] Successfully finished in {elapsed_sec}s! ({total_uploaded} files uploaded)")

        except asyncio.CancelledError:
            logger.warning(f"🛑 [Job {job_id}] Job was cancelled.")
            shutil.rmtree(job_dir, ignore_errors=True)
            await post_webhook(req.callbackUrl, {
                "jobId": job_id,
                "workerId": WORKER_ID,
                "phase": "cancelled",
                "status": "cancelled",
                "message": "Job cancelled and disk purged.",
            })
        except Exception as err:
            err_msg = str(err)
            logger.error(f"❌ [Job {job_id}] Execution failed: {err_msg}")
            shutil.rmtree(job_dir, ignore_errors=True)
            await post_webhook(req.callbackUrl, {
                "jobId": job_id,
                "workerId": WORKER_ID,
                "phase": "failed",
                "status": "failed",
                "error": err_msg,
            })
        finally:
            self.active_jobs.pop(job_id, None)
            self.cancel_events.pop(job_id, None)
            self.current_tasks.pop(job_id, None)
            self.current_procs.pop(job_id, None)

    # -----------------------------------------------------------------------
    # Stage 1 Details: Concurrent Download, Per-Part Retries & Throttled Reports
    # -----------------------------------------------------------------------
    async def _download_parts(self, req: CourseJobRequest, parts_dir: str, cancel_event: asyncio.Event):
        job_id = req.jobId
        urls = req.archiveUrls
        total_parts = len(urls)
        concurrency = max(1, min(req.concurrency or DEFAULT_CONCURRENCY, 20))

        parts_state = []
        for i, url in enumerate(urls):
            parsed_path = urllib.parse.urlparse(url).path
            fname = os.path.basename(parsed_path) or f"part_{i + 1:03d}.rar"
            dest_file = os.path.join(parts_dir, fname)
            parts_state.append({
                "partIndex": i + 1,
                "fileName": fname,
                "destPath": dest_file,
                "url": url,
                "percent": 0.0,
                "status": "pending",
                "downloadedBytes": 0,
                "totalBytes": 0,
            })

        sem = asyncio.Semaphore(concurrency)
        start_t = time.time()

        # Initialize High-Speed Go Multi-Part Engine if available
        engine: Optional[Any] = None
        if DLEngine and DLEngine.is_available():
            try:
                engine = DLEngine()
                logger.info(f"⚡ [Job {job_id}] High-Speed Go Multi-Part Engine active ({engine.bin_path})")
            except Exception as e:
                logger.warning(f"⚠️ [Job {job_id}] Could not initialize Go downloader: {e}")
                engine = None

        async def reporter_loop():
            while not cancel_event.is_set():
                await asyncio.sleep(1.0)
                now = time.time()
                elapsed = max(0.1, now - start_t)

                total_downloaded = sum(p["downloadedBytes"] for p in parts_state)
                known_totals = sum(p["totalBytes"] for p in parts_state if p["totalBytes"] > 0)
                completed_count = sum(1 for p in parts_state if p["status"] == "completed")

                if known_totals > 0:
                    overall_pct = round((total_downloaded / known_totals) * 100, 1)
                else:
                    overall_pct = round((completed_count / total_parts) * 100, 1)

                speed_mbps = round((total_downloaded / (1024 * 1024)) / elapsed, 2)

                payload = {
                    "jobId": job_id,
                    "workerId": WORKER_ID,
                    "phase": "downloading",
                    "overallDownloadPercent": min(100.0, overall_pct),
                    "speedMBps": speed_mbps,
                    "completedParts": completed_count,
                    "totalParts": total_parts,
                    "parts": [
                        {
                            "partIndex": p["partIndex"],
                            "fileName": p["fileName"],
                            "percent": p["percent"],
                            "status": p["status"],
                        }
                        for p in parts_state
                    ]
                }
                await post_webhook(req.callbackUrl, payload)

        reporter_task = asyncio.create_task(reporter_loop())

        file_timeout = getattr(req, "downloadTimeoutSec", None) or DOWNLOAD_FILE_TIMEOUT_SEC
        stall_timeout = getattr(req, "downloadStallTimeoutSec", None) or DOWNLOAD_STALL_TIMEOUT_SEC

        async def download_single_part(part: Dict[str, Any]):
            async with sem:
                if cancel_event.is_set():
                    return

                part["status"] = "downloading"
                url = part["url"]
                dest = part["destPath"]

                headers = {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                    "Referer": "https://downloadlynet.ir/",
                }

                # Upfront disk space verification
                usage = shutil.disk_usage(parts_dir)
                if usage.free < SAFETY_DISK_MIN_BYTES:
                    raise FatalDownloadError(
                        f"Insufficient disk space: free space ({usage.free / (1024**3):.2f} GB) "
                        f"dropped below 5 GB safety threshold."
                    )

                # Attempt fast multi-part download via Go binary
                if engine:
                    part_cancel_event = asyncio.Event()
                    start_dl_time = time.time()
                    last_activity_time = time.time()

                    def on_go_progress(evt: ProgressEvent):
                        nonlocal last_activity_time
                        last_activity_time = time.time()
                        part["downloadedBytes"] = evt.downloaded_bytes
                        part["totalBytes"] = evt.total_bytes
                        part["percent"] = evt.percent
                        part["speedBps"] = int(evt.speed_bytes_sec)

                    async def run_go_download():
                        return await engine.download_async(
                            url=url,
                            output_path=dest,
                            concurrency=16,
                            chunk_size="8MB",
                            retries=5,
                            headers=headers,
                            on_progress=on_go_progress,
                            cancel_event=part_cancel_event,
                        )

                    dl_task = asyncio.create_task(run_go_download())

                    try:
                        logger.info(f"⚡ [Job {job_id}] Downloading {part['fileName']} via Go Multi-Part Engine (16 chunks, timeout={file_timeout:.0f}s, stall_timeout={stall_timeout:.0f}s)...")

                        while not dl_task.done():
                            done, _ = await asyncio.wait({dl_task}, timeout=1.0)
                            if done:
                                break

                            if cancel_event.is_set():
                                part_cancel_event.set()
                                dl_task.cancel()
                                await asyncio.gather(dl_task, return_exceptions=True)
                                part["status"] = "failed"
                                return

                            now = time.time()
                            # Check stall timeout (waiting for files to return data/progress)
                            if stall_timeout > 0 and (now - last_activity_time) >= stall_timeout:
                                part_cancel_event.set()
                                dl_task.cancel()
                                await asyncio.gather(dl_task, return_exceptions=True)
                                raise TimeoutError(
                                    f"Download stalled: no data returned for {stall_timeout:.0f}s (file: {part['fileName']})"
                                )

                            # Check total file download timeout
                            if file_timeout > 0 and (now - start_dl_time) >= file_timeout:
                                part_cancel_event.set()
                                dl_task.cancel()
                                await asyncio.gather(dl_task, return_exceptions=True)
                                raise TimeoutError(
                                    f"Download timed out: exceeded maximum duration of {file_timeout:.0f}s (file: {part['fileName']})"
                                )

                        result = await dl_task
                        part["downloadedBytes"] = result.total_bytes
                        part["totalBytes"] = result.total_bytes
                        part["percent"] = 100.0
                        part["status"] = "completed"
                        logger.info(f"✅ [Job {job_id}] Part {part['fileName']} completed in {result.elapsed_seconds:.1f}s ({result.avg_speed_mb_s:.2f} MB/s)")
                        return
                    except Exception as go_err:
                        if cancel_event.is_set():
                            part["status"] = "failed"
                            return
                        logger.warning(f"⚠️ [Job {job_id}] Go downloader failed for {part['fileName']} ({go_err}), falling back to stream download...")

                # Fallback: Resilient single-stream download via httpx
                max_retries = 3
                for attempt in range(max_retries):
                    if cancel_event.is_set():
                        part["status"] = "failed"
                        return

                    existing_bytes = os.path.getsize(dest) if os.path.exists(dest) else 0
                    req_headers = dict(headers)
                    if existing_bytes > 0:
                        req_headers["Range"] = f"bytes={existing_bytes}-"

                    try:
                        stream_timeout = httpx.Timeout(connect=15.0, read=stall_timeout, write=30.0, pool=30.0)
                        async with HTTP_CLIENT.stream("GET", url, headers=req_headers, timeout=stream_timeout) as resp:
                            if resp.status_code not in (200, 206):
                                raise RuntimeError(f"HTTP {resp.status_code} returned by CDN")

                            is_resumed = (resp.status_code == 206)
                            file_mode = "ab" if is_resumed else "wb"
                            bytes_dl = existing_bytes if is_resumed else 0

                            cr_header = resp.headers.get("content-range")
                            if cr_header and "/" in cr_header:
                                total_str = cr_header.split("/")[-1].strip()
                                total_bytes = int(total_str) if total_str.isdigit() else 0
                            else:
                                c_len = resp.headers.get("content-length")
                                total_bytes = (bytes_dl + int(c_len)) if c_len and c_len.isdigit() else 0

                            part["totalBytes"] = total_bytes
                            part["downloadedBytes"] = bytes_dl

                            chunk_count = 0
                            last_disk_check = time.time()
                            stream_start = time.time()
                            chunk_iter = resp.aiter_bytes(chunk_size=256 * 1024).__aiter__()

                            with open(dest, file_mode) as f:
                                while True:
                                    if cancel_event.is_set():
                                        part["status"] = "failed"
                                        return

                                    now = time.time()
                                    if file_timeout > 0 and (now - stream_start) >= file_timeout:
                                        raise TimeoutError(f"Stream download exceeded maximum timeout of {file_timeout:.0f}s")

                                    try:
                                        chunk = await asyncio.wait_for(chunk_iter.__anext__(), timeout=stall_timeout)
                                    except StopAsyncIteration:
                                        break
                                    except asyncio.TimeoutError:
                                        raise TimeoutError(f"Stream download stalled: no data received for {stall_timeout:.0f}s")

                                    f.write(chunk)
                                    bytes_dl += len(chunk)
                                    chunk_count += 1
                                    part["downloadedBytes"] = bytes_dl
                                    if total_bytes > 0:
                                        part["percent"] = round((bytes_dl / total_bytes) * 100, 1)

                                    # Throttled safety disk space check
                                    now = time.time()
                                    if chunk_count % 20 == 0 or (now - last_disk_check) >= 5.0:
                                        last_disk_check = now
                                        usage = shutil.disk_usage(parts_dir)
                                        if usage.free < SAFETY_DISK_MIN_BYTES:
                                            raise FatalDownloadError(
                                                f"Insufficient disk space: free space ({usage.free / (1024**3):.2f} GB) "
                                                f"dropped below 5 GB safety threshold."
                                            )

                            if bytes_dl == 0:
                                raise RuntimeError("Downloaded file is empty (0 bytes)")

                            if total_bytes > 0 and bytes_dl < total_bytes:
                                raise RuntimeError(f"Incomplete transfer: received {bytes_dl}/{total_bytes} bytes")

                            part["percent"] = 100.0
                            part["status"] = "completed"
                            return  # Success!

                    except FatalDownloadError:
                        # Disk-full etc: do not burn retries on this, propagate immediately.
                        raise
                    except Exception as part_err:
                        logger.warning(f"⚠️ [Job {job_id}] Part {part['fileName']} stream download attempt {attempt + 1}/{max_retries} failed: {part_err}")
                        if attempt == max_retries - 1:
                            part["status"] = "failed"
                            raise RuntimeError(f"Download failed for {part['fileName']} after {max_retries} attempts: {part_err}")
                        await asyncio.sleep(2.0 * (attempt + 1))

        async def safe_download_part(part: Dict[str, Any]):
            """
            Wraps download_single_part so that ONE link permanently failing
            (timeout, 404, corrupt stream, etc.) only fails that link — it no
            longer aborts every other in-progress or still-queued download.
            Only a FatalDownloadError (disk full) is allowed to propagate and
            stop the whole batch, since that condition affects every part.
            """
            try:
                await download_single_part(part)
            except FatalDownloadError:
                part["status"] = "failed"
                raise
            except asyncio.CancelledError:
                part["status"] = "failed"
                raise
            except Exception as e:
                part["status"] = "failed"
                part["error"] = str(e)
                logger.error(
                    f"❌ [Job {job_id}] Part '{part['fileName']}' permanently failed and will be skipped "
                    f"— remaining queued links continue downloading: {e}"
                )
                # Clean up any partial/corrupt bytes left behind by the failed attempt
                # so a stale file doesn't linger or get mistaken for a real part later.
                dest_path = part.get("destPath")
                try:
                    if dest_path and os.path.exists(dest_path):
                        os.remove(dest_path)
                        logger.info(f"🧹 [Job {job_id}] Cleaned up incomplete file for failed part '{part['fileName']}'.")
                except Exception as cleanup_err:
                    logger.warning(f"⚠️ [Job {job_id}] Could not clean up partial file for '{part['fileName']}': {cleanup_err}")

        download_tasks = [asyncio.create_task(safe_download_part(p)) for p in parts_state]
        try:
            await asyncio.gather(*download_tasks)
        except FatalDownloadError as fatal_ex:
            # Only a truly job-wide condition (disk full) reaches here now —
            # this is the one case where aborting every other download is correct.
            cancel_event.set()
            for t in download_tasks:
                if not t.done():
                    t.cancel()
            await asyncio.gather(*download_tasks, return_exceptions=True)
            raise fatal_ex
        finally:
            reporter_task.cancel()
            try:
                await reporter_task
            except asyncio.CancelledError:
                pass

        # Verify all parts completed
        failed_parts = [p for p in parts_state if p["status"] != "completed"]
        if failed_parts:
            details = "; ".join(f"{p['fileName']} ({p.get('error', 'unknown error')})" for p in failed_parts)
            raise RuntimeError(f"Download incomplete or failed for {len(failed_parts)} part(s): {details}")

    # -----------------------------------------------------------------------
    # Stage 2 Details: Extraction (unrar / 7z / tar / zip) + Recursive Unpacking
    # -----------------------------------------------------------------------
    async def _extract_archives(self, parts_dir: str, extracted_dir: str, job_id: str, cancel_event: asyncio.Event, password: Optional[str] = None):
        files = [f for f in os.listdir(parts_dir) if os.path.isfile(os.path.join(parts_dir, f))]
        files.sort(key=natural_sort_key)

        if not files:
            raise RuntimeError("No archive files found in parts directory to extract.")

        for f in files:
            p = os.path.join(parts_dir, f)
            if os.path.getsize(p) == 0:
                raise RuntimeError(f"Cannot extract: Archive part '{f}' is empty (0 KB). Corrupted download.")

        # Normalize non-standard split volume filenames for 7-Zip & unrar compatibility
        for f in list(files):
            new_name = re.sub(r'\.part(\d+)_([^/\\]+)\.(rar|7z|zip)$', r'_\2.part\1.\3', f, flags=re.IGNORECASE)
            if new_name != f:
                old_p = os.path.join(parts_dir, f)
                new_p = os.path.join(parts_dir, new_name)
                try:
                    if not os.path.exists(new_p):
                        os.rename(old_p, new_p)
                        logger.info(f"🔄 [Job {job_id}] Normalized volume name: '{f}' -> '{new_name}'")
                except Exception as ren_err:
                    logger.warning(f"⚠️ [Job {job_id}] Could not rename '{f}': {ren_err}")

        files = [f for f in os.listdir(parts_dir) if os.path.isfile(os.path.join(parts_dir, f))]
        files.sort(key=natural_sort_key)

        primary_archive = None
        for f in files:
            lower = f.lower()
            if re.search(r'\.(part0*1|r00|001)\.(rar|7z|zip)$', lower) or ".part1." in lower or ".part01." in lower or ".part001." in lower:
                primary_archive = f
                break
            if ".7z.001" in lower or lower.endswith(".001"):
                primary_archive = f
                break

        if not primary_archive:
            for f in files:
                lower = f.lower()
                if lower.endswith(".rar") or lower.endswith(".zip") or lower.endswith(".7z") or lower.endswith(".tar.gz") or lower.endswith(".tar") or lower.endswith(".tgz"):
                    primary_archive = f
                    break

        if not primary_archive:
            primary_archive = files[0]

        primary_path = os.path.join(parts_dir, primary_archive)
        logger.info(f"📦 [Job {job_id}] Extracting primary archive: {primary_path}...")

        await self._extract_single_archive(primary_path, extracted_dir, job_id, password)

        # Recursive extraction for nested archives
        await self._recursive_extract(extracted_dir, job_id, cancel_event, password)

    @staticmethod
    def _summarize_extractor_output(stdout: Optional[bytes], stderr: Optional[bytes]) -> str:
        """Combine stdout+stderr of unrar/7z and surface the real error lines."""
        parts: List[str] = []
        if stderr:
            parts.append(stderr.decode(errors="replace"))
        if stdout:
            parts.append(stdout.decode(errors="replace"))
        combined = "\n".join(parts)
        lines = [ln.strip() for ln in combined.splitlines() if ln.strip()]

        key_markers = (
            "ERROR", "Can not open", "Cannot open", "Can not find", "Cannot find",
            "missing volume", "Wrong password", "CRC failed", "Data Error",
            "Unexpected end", "is corrupt", "is not supported", "checksum error",
            "Break signaled", "Cannot create", "Disk full", "No space",
        )
        key_lines: List[str] = []
        for i, ln in enumerate(lines):
            if any(m in ln for m in key_markers):
                key_lines.append(ln)
                if ln.startswith("ERROR") and i + 1 < len(lines) and len(key_lines) < 6:
                    key_lines.append(lines[i + 1])
            if len(key_lines) >= 6:
                break
        if key_lines:
            return " | ".join(key_lines[:6])
        return " | ".join(lines[-5:]) if lines else "no output captured"

    async def _extract_single_archive(self, archive_path: str, output_dir: str, job_id: str, password: Optional[str] = None):
        """Extract an archive file using unrar, 7z, tar, or Python fallback with password rotation."""
        lower = archive_path.lower()
        passwords = []
        if password and str(password).strip():
            cleaned_pwd = str(password).replace("&nbsp;", "").strip()
            if cleaned_pwd and cleaned_pwd.lower() not in ("none", "null", "undefined", ""):
                passwords.append(cleaned_pwd)
        for default_pwd in ["www.downloadly.ir", "www.downloadlynet.ir", "downloadly.ir", ""]:
            if default_pwd not in passwords:
                passwords.append(default_pwd)

        archivers = []
        unrar_bin = shutil.which("unrar")
        if unrar_bin:
            archivers.append(("unrar", unrar_bin))

        unar_bin = shutil.which("unar")
        if unar_bin:
            archivers.append(("unar", unar_bin))

        sevenz_bin = shutil.which("7z") or shutil.which("7za") or shutil.which("7zz")
        if sevenz_bin:
            archivers.append(("7z", sevenz_bin))

        attempt_errors: List[str] = []

        for arch_type, bin_path in archivers:
            for pwd in passwords:
                cmd = []
                if arch_type == "unrar":
                    p_arg = f"-p{pwd}" if pwd else "-p-"
                    cmd = [bin_path, "x", "-o+", "-y", p_arg, archive_path, f"{output_dir}/"]
                elif arch_type == "unar":
                    if pwd:
                        cmd = [bin_path, "-o", output_dir, "-f", "-p", pwd, archive_path]
                    else:
                        cmd = [bin_path, "-o", output_dir, "-f", archive_path]
                elif arch_type in ("7z", "7za", "7zz"):
                    cmd = [bin_path, "x", "-y", "-aoa"]
                    if pwd:
                        cmd.append(f"-p{pwd}")
                    cmd.extend([f"-o{output_dir}", archive_path])

                if not cmd:
                    continue

                logger.info(f"⚡ [Job {job_id}] Trying {arch_type} (pwd: '{pwd}'): {' '.join(cmd[:4])}...")
                try:
                    proc = await asyncio.create_subprocess_exec(
                        cmd[0], *cmd[1:],
                        stdin=asyncio.subprocess.DEVNULL,
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.PIPE
                    )
                    self.current_procs[job_id] = proc
                    stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=EXTRACTION_TIMEOUT_SEC)
                    self.current_procs.pop(job_id, None)

                    if proc.returncode == 0:
                        logger.info(f"🎉 [Job {job_id}] Extraction succeeded with {arch_type} (password: '{pwd}')!")
                        return
                    else:
                        summary = self._summarize_extractor_output(stdout, stderr)
                        attempt_errors.append(f"[{arch_type} pwd='{pwd}' rc={proc.returncode}] {summary}")
                        if proc.returncode < 0:
                            # Negative rc = tool was killed by a signal (e.g. SIGSEGV = -11).
                            # That is a tool/build crash, not a wrong password: retrying the
                            # same tool with other passwords will crash again. Skip to next tool.
                            logger.warning(f"💥 [Job {job_id}] {arch_type} CRASHED (signal {-proc.returncode}) pwd='{pwd}': {summary}")
                            attempt_errors.append(f"[{arch_type} pwd='{pwd}'] tool crashed (signal {-proc.returncode}); skipped remaining passwords")
                            break
                        logger.warning(f"⚠️ [Job {job_id}] {arch_type} (pwd: '{pwd}') failed rc={proc.returncode}: {summary}")
                except asyncio.TimeoutError:
                    if job_id in self.current_procs:
                        try:
                            self.current_procs[job_id].kill()
                        except Exception:
                            pass
                        self.current_procs.pop(job_id, None)
                    attempt_errors.append(f"[{arch_type} pwd='{pwd}'] extraction timed out after {EXTRACTION_TIMEOUT_SEC}s")
                except Exception as ex:
                    attempt_errors.append(f"[{arch_type} pwd='{pwd}'] {ex}")

        # Python fallbacks for zip / tar
        if lower.endswith(".zip"):
            try:
                self._extract_zip_python(archive_path, output_dir)
                return
            except Exception as e:
                attempt_errors.append(f"[python-zip] {e}")
        elif lower.endswith(".tar") or lower.endswith(".tar.gz") or lower.endswith(".tgz") or lower.endswith(".tar.bz2") or lower.endswith(".tar.xz"):
            try:
                self._extract_tar_python(archive_path, output_dir)
                return
            except Exception as e:
                attempt_errors.append(f"[python-tar] {e}")

        detail = " || ".join(attempt_errors) if attempt_errors else "unknown error (no archiver available or no output captured)"
        raise RuntimeError(
            f"Extraction failed for {os.path.basename(archive_path)} "
            f"({len(attempt_errors)} attempt(s) tried): {detail[:1200]}"
        )

    def _extract_zip_python(self, zip_path: str, output_dir: str):
        import zipfile
        abs_output = os.path.abspath(output_dir)
        with zipfile.ZipFile(zip_path, 'r') as z:
            for member in z.infolist():
                target_path = os.path.abspath(os.path.join(output_dir, member.filename))
                if not target_path.startswith(abs_output):
                    raise RuntimeError(f"Zip slip path traversal detected: {member.filename}")
            z.extractall(output_dir)

    def _extract_tar_python(self, tar_path: str, output_dir: str):
        import tarfile
        abs_output = os.path.abspath(output_dir)
        with tarfile.open(tar_path, 'r:*') as t:
            if hasattr(tarfile, 'data_filter'):
                t.extractall(output_dir, filter='data')
            else:
                for member in t.getmembers():
                    target_path = os.path.abspath(os.path.join(output_dir, member.name))
                    if not target_path.startswith(abs_output):
                        raise RuntimeError(f"Tar path traversal detected: {member.name}")
                t.extractall(output_dir)

    async def _recursive_extract(self, root_dir: str, job_id: str, cancel_event: asyncio.Event, password: Optional[str] = None, max_depth: int = 5):
        """Recursively scan for inner archives and unpack them in place, respecting cancellation."""
        archive_exts = (
            ".zip", ".rar", ".7z", ".tar.gz", ".tar.bz2", ".tbz2",
            ".tar.xz", ".txz", ".tgz", ".tar", ".7z.001", ".zip.001"
        )
        for depth in range(max_depth):
            if cancel_event.is_set():
                raise asyncio.CancelledError(f"Job {job_id} cancelled during recursive extraction.")

            nested_archives = []
            for root, _, files in os.walk(root_dir):
                for f in files:
                    lower = f.lower()
                    if any(lower.endswith(ext) for ext in archive_exts):
                        nested_archives.append(os.path.join(root, f))

            if not nested_archives:
                break

            logger.info(f"🔄 [Job {job_id}] Found {len(nested_archives)} nested archives. Unpacking depth {depth + 1}...")
            for inner_archive in nested_archives:
                if cancel_event.is_set():
                    raise asyncio.CancelledError(f"Job {job_id} cancelled during recursive extraction.")
                target_dir = os.path.dirname(inner_archive)
                try:
                    await self._extract_single_archive(inner_archive, target_dir, job_id, password)
                    if os.path.exists(inner_archive):
                        os.remove(inner_archive)
                except Exception as e:
                    logger.error(f"⚠️ [Job {job_id}] Nested archive extract failed for {inner_archive}: {e}")
                    raise RuntimeError(f"Nested archive extraction failed: {e}")

    # -----------------------------------------------------------------------
    # Stage 4 Details: Resumable Upload with 308 AES-CTR Alignment & Immediate Unlink
    # -----------------------------------------------------------------------
    async def _upload_and_unlink_files(self, extracted_dir: str, req: CourseJobRequest, cancel_event: asyncio.Event) -> int:
        job_id = req.jobId
        drive_cfg = req.drive
        access_token = drive_cfg.accessToken
        root_parent_id = drive_cfg.parentFolderId
        encrypt = bool(drive_cfg.encrypt and drive_cfg.encryptionKey)
        encryption_key = drive_cfg.encryptionKey

        # Refresh access token before multi-file upload stage begins
        refreshed_token = await fetch_refreshed_token(job_id, req.callbackUrl, drive_cfg.accountId, req.tokenRefreshUrl)
        if refreshed_token:
            access_token = refreshed_token

        # Check if the extracted directory contains a single top-level folder
        # (e.g. archive extracted as extracted_dir/<Course Name>/...)
        # If so, unwrap that single top-level folder so files live directly under root_parent_id
        scan_dir = extracted_dir
        try:
            top_entries = [
                e for e in os.listdir(extracted_dir)
                if not e.startswith('.') and e not in ('__MACOSX', 'Thumbs.db')
            ]
            if len(top_entries) == 1:
                candidate_dir = os.path.join(extracted_dir, top_entries[0])
                if os.path.isdir(candidate_dir):
                    scan_dir = candidate_dir
                    logger.info(f"📁 [Job {job_id}] Unwrapped single top-level archive directory: '{top_entries[0]}'")
        except Exception as unwrap_err:
            logger.warning(f"⚠️ [Job {job_id}] Notice checking top entries for unwrapping: {unwrap_err}")

        # Define video extensions strictly (only videos uploaded directly; all other files including subtitles will be zipped)
        VIDEO_EXTENSIONS = {
            '.mp4', '.mkv', '.webm', '.mov', '.avi',
            '.flv', '.wmv', '.m4v', '.ts'
        }

        discovered_videos: List[Tuple[str, str, str, bool]] = []
        discovered_materials: List[Tuple[str, str, str, bool]] = []

        for root, _, filenames in os.walk(scan_dir):
            for fname in filenames:
                clean_fname = html.unescape(fname).strip()
                full_path = os.path.join(root, fname)
                rel_path = os.path.relpath(full_path, scan_dir)
                ext = os.path.splitext(clean_fname)[1].lower()
                if ext in VIDEO_EXTENSIONS:
                    discovered_videos.append((full_path, rel_path, clean_fname, False))
                else:
                    discovered_materials.append((full_path, rel_path, clean_fname, True))

        discovered_videos.sort(key=lambda x: natural_sort_key(x[1]))
        discovered_materials.sort(key=lambda x: natural_sort_key(x[1]))

        generated_zip_parts: List[Tuple[str, str, str, bool]] = []
        job_dir = os.path.dirname(extracted_dir)
        materials_staging_dir = os.path.join(job_dir, "materials_staging")

        # Package all non-video files and folders into 1GB split zip parts
        if discovered_materials:
            os.makedirs(materials_staging_dir, exist_ok=True)
            mat_count = len(discovered_materials)
            mat_bytes = sum(os.path.getsize(fp) for fp, _, _, _ in discovered_materials if os.path.exists(fp))
            mat_mb = f"{mat_bytes / (1024 * 1024):.2f}"

            logger.info(f"📦 [Job {job_id}] Packaging {mat_count} non-video files ({mat_mb} MB) into 1GB split zip archives...")

            # Broadcast packaging phase to Central Hub & WebSockets
            await post_webhook(req.callbackUrl, {
                "jobId": job_id,
                "workerId": WORKER_ID,
                "phase": "packaging",
                "message": f"Packaging {mat_count} non-video materials ({mat_mb} MB) into 1GB split zip archives...",
                "materialsCount": mat_count,
                "materialsMB": mat_mb,
            })

            safe_course_title = re.sub(r'[\\/*?:"<>|]', "", req.courseName).strip() or "Course"
            base_zip_name = f"{safe_course_title}_Materials.zip"
            zip_out_path = os.path.join(materials_staging_dir, base_zip_name)

            filelist_path = os.path.join(materials_staging_dir, "filelist.txt")
            with open(filelist_path, "w", encoding="utf-8") as fl:
                for _, rel_p, _, _ in discovered_materials:
                    fl.write(f"{rel_p}\n")

            # Use zip with -s 1024m -r -@ to create 1GB split volumes
            zip_cmd = f"zip -s 1024m -r {shlex.quote(zip_out_path)} -@ < {shlex.quote(filelist_path)}"
            proc = await asyncio.create_subprocess_shell(
                zip_cmd,
                cwd=scan_dir,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await proc.communicate()

            if proc.returncode != 0:
                logger.warning(f"⚠️ [Job {job_id}] zip command exited code {proc.returncode}: {stderr.decode(errors='ignore')}. Retrying with 7z...")
                cmd_7z = f"7z a -tzip -v1024m {shlex.quote(zip_out_path)} @{shlex.quote(filelist_path)}"
                proc_7z = await asyncio.create_subprocess_shell(
                    cmd_7z,
                    cwd=scan_dir,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                await proc_7z.communicate()

            if os.path.exists(filelist_path):
                try: os.remove(filelist_path)
                except: pass

            # Reclaim disk: unlink all raw source non-video files immediately
            for fp, _, _, _ in discovered_materials:
                try:
                    if os.path.exists(fp):
                        os.remove(fp)
                except Exception as del_err:
                    logger.debug(f"Could not remove source material file {fp}: {del_err}")

            # Collect all generated split zip parts (.zip, .z01, .z02, .zip.001, etc.)
            for zfname in sorted(os.listdir(materials_staging_dir)):
                zpath = os.path.join(materials_staging_dir, zfname)
                if os.path.isfile(zpath):
                    # Destination is root course folder (rel_path = zfname)
                    generated_zip_parts.append((zpath, zfname, zfname, True))

            logger.info(f"✅ [Job {job_id}] Generated {len(generated_zip_parts)} material zip part(s)")

        # Assemble unified upload queue: all video files + all generated zip parts
        all_files: List[Tuple[str, str, str, bool]] = []
        all_files.extend(discovered_videos)
        all_files.extend(generated_zip_parts)

        total_files = len(all_files)
        logger.info(
            f"🚀 [Job {job_id}] Prepared upload queue: {len(discovered_videos)} video files "
            f"+ {len(generated_zip_parts)} material zip part(s) = {total_files} total files to upload."
        )

        if total_files == 0:
            logger.warning(f"⚠️ [Job {job_id}] No files found in extracted directory to upload.")
            return 0

        folder_cache: Dict[str, str] = {"": root_parent_id, ".": root_parent_id}
        master_folder_lock = asyncio.Lock()

        async def ensure_drive_folder(rel_dir: str) -> str:
            rel_dir = rel_dir.replace("\\", "/").strip("/")
            if not rel_dir or rel_dir == ".":
                return root_parent_id
            if rel_dir in folder_cache:
                return folder_cache[rel_dir]

            async with master_folder_lock:
                if rel_dir in folder_cache:
                    return folder_cache[rel_dir]

                parts = [p for p in rel_dir.split("/") if p and p != "."]
                current_path = ""
                current_parent = root_parent_id

                for part in parts:
                    clean_part = html.unescape(part).strip()
                    current_path = f"{current_path}/{clean_part}" if current_path else clean_part
                    if current_path in folder_cache:
                        current_parent = folder_cache[current_path]
                    else:
                        sub_id = await self._create_drive_subfolder(clean_part, current_parent, access_token)
                        folder_cache[current_path] = sub_id
                        current_parent = sub_id

                folder_cache[rel_dir] = current_parent
                return current_parent

        # Pre-resolve and create all unique directories upfront to eliminate runtime lock contention
        unique_dirs = sorted(list(set(os.path.dirname(rel_path).replace("\\", "/").strip("/") for _, rel_path, _ in all_files if rel_path)))
        for udir in unique_dirs:
            if udir and udir != ".":
                try:
                    await ensure_drive_folder(udir)
                except Exception as dir_err:
                    logger.warning(f"⚠️ [Job {job_id}] Pre-creating directory '{udir}' failed: {dir_err}")

        uploaded_count = 0
        count_lock = asyncio.Lock()

        file_sizes = [os.path.getsize(fp) for fp, _, _, _ in all_files if os.path.exists(fp)]
        upload_concurrency = compute_adaptive_upload_concurrency(file_sizes, req.uploadConcurrency)
        logger.info(
            f"⚙️ [Job {job_id}] Using upload concurrency={upload_concurrency} "
            f"for {total_files} files (avg size {(sum(file_sizes) / len(file_sizes) / (1024*1024)):.2f} MB)"
            if file_sizes else f"⚙️ [Job {job_id}] Using upload concurrency={upload_concurrency}"
        )
        upload_sem = asyncio.Semaphore(upload_concurrency)
        loop = asyncio.get_running_loop()

        async def upload_worker(index: int, item: Tuple[str, str, str, bool]):
            nonlocal uploaded_count, access_token
            full_path, rel_path, fname, is_material_zip = item

            if cancel_event.is_set():
                raise asyncio.CancelledError(f"Job {job_id} cancelled.")

            if not os.path.exists(full_path):
                return

            file_size = os.path.getsize(full_path)
            rel_dir = os.path.dirname(rel_path)
            target_folder_id = await ensure_drive_folder(rel_dir)

            logger.info(f"📤 [Job {job_id}] [{index + 1}/{total_files}] Uploading '{fname}' ({rel_path})...")

            file_result = None
            upload_err = None

            # Resilient per-file upload loop with up to 3 attempts
            for file_attempt in range(3):
                if cancel_event.is_set():
                    raise asyncio.CancelledError(f"Job {job_id} cancelled.")
                try:
                    async with upload_sem:
                        file_result = await loop.run_in_executor(
                            UPLOAD_EXECUTOR,
                            functools.partial(
                                self._upload_single_file_to_drive,
                                file_path=full_path,
                                file_name=fname,
                                folder_id=target_folder_id,
                                access_token=access_token,
                                encrypt=encrypt,
                                encryption_key=encryption_key,
                                job_id=job_id,
                                callback_url=req.callbackUrl,
                                account_id=drive_cfg.accountId,
                                token_refresh_url=req.tokenRefreshUrl,
                            ),
                        )
                    if file_result is not None:
                        break
                except Exception as ex:
                    upload_err = ex
                    logger.warning(f"⚠️ [Job {job_id}] Upload attempt {file_attempt + 1}/3 failed for '{fname}': {ex}")
                    if file_attempt < 2:
                        await asyncio.sleep(2.0 * (file_attempt + 1))

            if file_result is None:
                logger.error(f"❌ [Job {job_id}] File '{fname}' failed all 3 upload attempts: {upload_err}. Skipping to preserve job.")
                return

            # CRUCIAL DISK RULE: Immediately unlink file after upload!
            try:
                if os.path.exists(full_path):
                    os.remove(full_path)
                    if is_material_zip:
                        logger.info(f"🧹 [Job {job_id}] Cleaned up local zip part: '{fname}'")
            except Exception as unl_err:
                logger.warning(f"⚠️ [Job {job_id}] Failed to unlink {full_path}: {unl_err}")

            async with count_lock:
                uploaded_count += 1
                current_count = uploaded_count

            drive_file_id = file_result.get("id", "")
            drive_view_link = f"https://drive.google.com/file/d/{drive_file_id}/view" if drive_file_id else ""

            await post_webhook(req.callbackUrl, {
                "jobId": job_id,
                "workerId": WORKER_ID,
                "phase": "uploading",
                "currentFileIndex": current_count,
                "totalFiles": total_files,
                "currentFileName": fname,
                "currentRelativePath": rel_path.replace("\\", "/"),
                "sizeBytes": file_size,
                "sizeMB": f"{file_size / (1024 * 1024):.2f}",
                "filePercent": 100.0,
                "driveFileId": drive_file_id,
                "driveViewLink": drive_view_link,
            })

        tasks = [upload_worker(i, item) for i, item in enumerate(all_files)]
        await asyncio.gather(*tasks, return_exceptions=True)

        if os.path.exists(materials_staging_dir):
            try:
                shutil.rmtree(materials_staging_dir, ignore_errors=True)
            except Exception:
                pass

        return uploaded_count

    async def _create_drive_subfolder(self, name: str, parent_id: str, access_token: str) -> str:
        """Creates or retrieves a subfolder in Google Drive idempotently with proper query escaping and backoff."""
        clean_name = html.unescape(name).strip()
        headers = {
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
        }

        # Escape backslashes and single quotes for Google Drive API queries
        safe_name = clean_name.replace('\\', '\\\\').replace("'", "\\'")
        q = f"mimeType = 'application/vnd.google-apps.folder' and name = '{safe_name}' and trashed = false"
        if parent_id:
            q += f" and '{parent_id}' in parents"
        list_url = f"https://www.googleapis.com/drive/v3/files?q={urllib.parse.quote(q)}&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true"

        for attempt in range(4):
            try:
                list_resp = await HTTP_CLIENT.get(list_url, headers=headers, timeout=15.0)
                if list_resp.status_code == 200:
                    existing = list_resp.json().get("files", [])
                    if existing:
                        return existing[0]["id"]
                    break
                elif list_resp.status_code in (403, 429, 500, 502, 503, 504):
                    await asyncio.sleep(2 ** attempt + random.uniform(0.5, 1.5))
                else:
                    break
            except Exception:
                await asyncio.sleep(1.0 * (attempt + 1))

        url = "https://www.googleapis.com/drive/v3/files?supportsAllDrives=true"
        body = {
            "name": clean_name,
            "mimeType": "application/vnd.google-apps.folder",
            "parents": [parent_id] if parent_id else [],
        }

        last_err = ""
        for attempt in range(4):
            try:
                resp = await HTTP_CLIENT.post(url, headers=headers, json=body, timeout=20.0)
                if resp.status_code in (200, 201):
                    return resp.json().get("id", parent_id)
                elif resp.status_code in (403, 429, 500, 502, 503, 504):
                    last_err = f"HTTP {resp.status_code}: {resp.text[:150]}"
                    await asyncio.sleep(2 ** attempt + random.uniform(0.5, 1.5))
                    continue
                last_err = f"HTTP {resp.status_code}: {resp.text[:150]}"
            except Exception as e:
                last_err = str(e)
            await asyncio.sleep(1.5 * (attempt + 1))

        raise RuntimeError(f"Failed to create Drive subfolder '{name}' under parent '{parent_id}': {last_err}")

    def _upload_single_file_to_drive(
        self,
        file_path: str,
        file_name: str,
        folder_id: str,
        access_token: str,
        encrypt: bool,
        encryption_key: Optional[str],
        chunk_size: int = 16 * 1024 * 1024,
        job_id: Optional[str] = None,
        callback_url: Optional[str] = None,
        account_id: Optional[str] = None,
        token_refresh_url: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Uploads a local file to Google Drive using either fast single-request Multipart Upload
        (for files < 5 MB like subtitles, notes, small assets) or chunked Resumable Upload
        (for larger files) with exact 256KiB/16-byte AES-CTR alignment and token refreshes.
        Uses thread-local HTTP session to eliminate thread concurrency bugs.
        """
        session = get_drive_session()
        raw_size = os.path.getsize(file_path)
        final_file_name = file_name
        iv = None
        encryptor = None
        key_bytes = None

        if encrypt and encryption_key:
            if len(encryption_key) == 64 and all(c in "0123456789abcdefABCDEF" for c in encryption_key):
                key_bytes = bytes.fromhex(encryption_key)
            else:
                import hashlib
                key_bytes = hashlib.sha256(encryption_key.encode("utf-8")).digest()
            iv = os.urandom(16)
            cipher = Cipher(algorithms.AES(key_bytes), modes.CTR(iv))
            encryptor = cipher.encryptor()
            if not final_file_name.endswith(".enc"):
                final_file_name = f"{final_file_name}.enc"
            total_bytes = raw_size + 16
        else:
            total_bytes = raw_size

        # -------------------------------------------------------------
        # IDEMPOTENCY: Check if file already exists in Drive with matching size
        # Prevents duplicate uploads and skips already-uploaded files on retries
        # -------------------------------------------------------------
        try:
            safe_name = final_file_name.replace('\\', '\\\\').replace("'", "\\'")
            q = f"name = '{safe_name}' and trashed = false"
            if folder_id:
                q += f" and '{folder_id}' in parents"
            chk_url = f"https://www.googleapis.com/drive/v3/files?q={urllib.parse.quote(q)}&fields=files(id,name,size)&supportsAllDrives=true&includeItemsFromAllDrives=true"
            chk_res = session.get(chk_url, headers={"Authorization": f"Bearer {access_token}"}, timeout=15)
            if chk_res.status_code == 200:
                files_found = chk_res.json().get("files", [])
                if files_found:
                    ex_file = files_found[0]
                    ex_size = int(ex_file.get("size", 0))
                    if ex_size in (total_bytes, raw_size):
                        logger.info(f"⏩ [Idempotency] '{final_file_name}' already exists in Drive folder (ID: {ex_file['id']}). Skipping re-upload!")
                        return ex_file
        except Exception as chk_err:
            logger.debug(f"Drive existence check skipped ({chk_err})")

        # -------------------------------------------------------------
        # FAST PATH: Single-request Multipart Upload for files < 5 MB
        # -------------------------------------------------------------
        if raw_size < 5 * 1024 * 1024:
            try:
                boundary = f"-------DriveDirectUpload_{int(time.time()*1000)}_{random.randint(1000,9999)}"
                if encrypt and encryptor:
                    with open(file_path, "rb") as f:
                        raw_data = f.read()
                    file_payload = iv + encryptor.update(raw_data) + encryptor.finalize()
                else:
                    with open(file_path, "rb") as f:
                        file_payload = f.read()

                metadata = {
                    "name": final_file_name,
                    "parents": [folder_id] if folder_id else [],
                }
                metadata_json = json.dumps(metadata)

                body = (
                    f"--{boundary}\r\n"
                    f"Content-Type: application/json; charset=UTF-8\r\n\r\n"
                    f"{metadata_json}\r\n"
                    f"--{boundary}\r\n"
                    f"Content-Type: application/octet-stream\r\n\r\n"
                ).encode("utf-8") + file_payload + f"\r\n--{boundary}--\r\n".encode("utf-8")

                direct_headers = {
                    "Authorization": f"Bearer {access_token}",
                    "Content-Type": f"multipart/related; boundary={boundary}",
                    "Content-Length": str(len(body)),
                }
                direct_url = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true"

                for attempt in range(4):
                    try:
                        d_res = session.post(direct_url, headers=direct_headers, data=body, timeout=45)
                        if d_res.status_code in (200, 201):
                            return d_res.json()
                        elif d_res.status_code == 401 and job_id and callback_url:
                            fresh_tok = fetch_refreshed_token_sync(job_id, callback_url, account_id, token_refresh_url)
                            if fresh_tok:
                                access_token = fresh_tok
                                direct_headers["Authorization"] = f"Bearer {access_token}"
                        elif d_res.status_code in (403, 429, 500, 502, 503, 504):
                            is_rate_limit = "rateLimit" in d_res.text or "userRateLimit" in d_res.text
                            cooldown = min(60, 15 * (attempt + 1)) if is_rate_limit else (2 ** attempt + random.uniform(0.5, 1.5))
                            logger.warning(f"⚠️ Drive multipart upload got HTTP {d_res.status_code}, cooling down {cooldown:.1f}s (attempt {attempt + 1}/4)...")
                            time.sleep(cooldown)
                        else:
                            if attempt == 3:
                                raise RuntimeError(f"Drive direct multipart upload failed ({d_res.status_code}): {d_res.text[:200]}")
                            time.sleep(1.5 * (attempt + 1))
                    except (requests.RequestException, Exception) as req_err:
                        if attempt == 3:
                            raise
                        logger.warning(f"⚠️ Drive multipart connection error ({req_err}), retrying ({attempt + 1}/4)...")
                        time.sleep(2 ** attempt + random.uniform(0.5, 1.5))
            except Exception as direct_err:
                logger.warning(f"⚠️ Direct multipart upload failed for {final_file_name}, falling back to resumable: {direct_err}")
                # Reset encryption state for fallback
                if encrypt and encryption_key and key_bytes:
                    iv = os.urandom(16)
                    cipher = Cipher(algorithms.AES(key_bytes), modes.CTR(iv))
                    encryptor = cipher.encryptor()

        # -------------------------------------------------------------
        # RESUMABLE PATH: Chunked Streaming Upload for files >= 5 MB
        # -------------------------------------------------------------
        # 1. Initialize Resumable Upload Session with retries & backoff
        init_headers = {
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json; charset=UTF-8",
            "X-Upload-Content-Type": "application/octet-stream",
        }
        metadata = {
            "name": final_file_name,
            "parents": [folder_id] if folder_id else [],
        }
        init_url = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true"

        resumable_uri = None
        for attempt in range(4):
            try:
                init_res = session.post(init_url, headers=init_headers, json=metadata, timeout=30)
                if init_res.status_code in (200, 201):
                    resumable_uri = init_res.headers.get("Location")
                    if resumable_uri:
                        break
                elif init_res.status_code == 401 and job_id and callback_url:
                    logger.info("🔄 Token expired during resumable upload init, refreshing...")
                    fresh_tok = fetch_refreshed_token_sync(job_id, callback_url, account_id, token_refresh_url)
                    if fresh_tok:
                        access_token = fresh_tok
                        init_headers["Authorization"] = f"Bearer {access_token}"
                elif init_res.status_code in (403, 429, 500, 502, 503, 504):
                    is_rate_limit = "rateLimit" in init_res.text or "userRateLimit" in init_res.text
                    cooldown = min(60, 15 * (attempt + 1)) if is_rate_limit else (2 ** attempt + random.uniform(0.5, 1.5))
                    logger.warning(f"⚠️ Drive resumable init got HTTP {init_res.status_code}, cooling down {cooldown:.1f}s (attempt {attempt + 1}/4)...")
                    time.sleep(cooldown)
                else:
                    if attempt == 3:
                        raise RuntimeError(f"Drive resumable upload init failed ({init_res.status_code}): {init_res.text[:200]}")
                    time.sleep(2)
            except (requests.RequestException, Exception) as init_err:
                if attempt == 3:
                    raise RuntimeError(f"Drive resumable upload init connection failed: {init_err}")
                logger.warning(f"⚠️ Drive resumable init connection error ({init_err}), retrying ({attempt + 1}/4)...")
                time.sleep(2 ** attempt + random.uniform(0.5, 1.5))

        if not resumable_uri:
            raise RuntimeError("Drive did not return a resumable upload URI after retries.")

        # 2. Handle 0-byte files explicitly
        if total_bytes == 0:
            zero_headers = {
                "Authorization": f"Bearer {access_token}",
                "Content-Length": "0",
                "Content-Range": "bytes */0",
            }
            z_res = session.put(resumable_uri, headers=zero_headers, timeout=30)
            if z_res.status_code in (200, 201):
                return z_res.json()
            return {"status": "uploaded", "id": z_res.json().get("id", "")}

        # 3. Upload file in strictly 256 KiB aligned chunks
        chunk_size = (max(chunk_size, 256 * 1024) // (256 * 1024)) * (256 * 1024)
        bytes_uploaded = 0

        with open(file_path, "rb") as f:
            while bytes_uploaded < total_bytes:
                if encrypt and iv and key_bytes:
                    plain_offset = max(0, bytes_uploaded - 16)
                    block_idx = plain_offset // 16
                    byte_offset_in_block = plain_offset % 16
                    f.seek(plain_offset)
                    counter_iv = add_blocks_to_iv_py(iv, block_idx)
                    cipher = Cipher(algorithms.AES(key_bytes), modes.CTR(counter_iv))
                    encryptor = cipher.encryptor()
                    if byte_offset_in_block > 0:
                        encryptor.update(b"\x00" * byte_offset_in_block)

                    if bytes_uploaded == 0:
                        needed_raw = chunk_size - 16
                        raw_data = f.read(needed_raw)
                        enc_data = encryptor.update(raw_data) if raw_data else b""
                        current_chunk = iv + enc_data
                    else:
                        raw_data = f.read(chunk_size)
                        current_chunk = encryptor.update(raw_data) if raw_data else encryptor.finalize()
                else:
                    f.seek(bytes_uploaded)
                    current_chunk = f.read(chunk_size)

                chunk_len = len(current_chunk)
                if chunk_len == 0:
                    break

                chunk_start = bytes_uploaded
                chunk_end = bytes_uploaded + chunk_len - 1

                chunk_headers = {
                    "Content-Length": str(chunk_len),
                    "Content-Range": f"bytes {chunk_start}-{chunk_end}/{total_bytes}",
                }

                chunk_ok = False
                for attempt in range(5):
                    try:
                        put_res = session.put(resumable_uri, headers=chunk_headers, data=current_chunk, timeout=90)
                        if put_res.status_code in (200, 201):
                            bytes_uploaded += chunk_len
                            return put_res.json()
                        elif put_res.status_code == 308:
                            range_header = put_res.headers.get("Range")
                            if range_header:
                                bytes_uploaded = int(range_header.split("-")[1]) + 1
                            else:
                                logger.warning("⚠️ 308 received with no Range header (0 bytes accepted). Retrying current offset...")
                            chunk_ok = True
                            break
                        elif put_res.status_code in (403, 429, 500, 502, 503, 504):
                            is_rate_limit = "rateLimit" in put_res.text or "userRateLimit" in put_res.text
                            cooldown = min(60, 15 * (attempt + 1)) if is_rate_limit else (2 ** attempt + random.uniform(1.0, 2.5))
                            logger.warning(f"⚠️ Drive chunk upload got HTTP {put_res.status_code}, cooling down {cooldown:.1f}s (attempt {attempt + 1}/5)...")
                            time.sleep(cooldown)
                        elif put_res.status_code == 401 and job_id and callback_url:
                            logger.info("🔄 Token expired mid-upload, refreshing...")
                            fresh_tok = fetch_refreshed_token_sync(job_id, callback_url, account_id, token_refresh_url)
                            if fresh_tok:
                                access_token = fresh_tok
                            time.sleep(1)
                        else:
                            if attempt == 4:
                                raise RuntimeError(f"Drive chunk upload failed ({put_res.status_code}): {put_res.text[:200]}")
                            time.sleep(2)
                    except (requests.RequestException, Exception) as req_err:
                        logger.warning(f"⚠️ Drive chunk upload network error: {req_err} (attempt {attempt + 1}/5)")
                        if attempt == 4:
                            raise
                        # Sync confirmed byte position from Drive
                        try:
                            chk = session.put(
                                resumable_uri,
                                headers={"Content-Range": f"bytes */{total_bytes}"},
                                timeout=15,
                            )
                            if chk.status_code in (200, 201):
                                return chk.json()
                            elif chk.status_code == 308:
                                r_hdr = chk.headers.get("Range")
                                if r_hdr:
                                    bytes_uploaded = int(r_hdr.split("-")[1]) + 1
                                    chunk_ok = True
                                    break
                        except Exception:
                            pass
                        time.sleep(2 ** attempt + random.uniform(1.0, 2.5))

                if not chunk_ok and bytes_uploaded < total_bytes:
                    try:
                        chk = session.put(
                            resumable_uri,
                            headers={"Content-Range": f"bytes */{total_bytes}"},
                            timeout=15,
                        )
                        if chk.status_code in (200, 201):
                            return chk.json()
                        elif chk.status_code == 308:
                            r_hdr = chk.headers.get("Range")
                            if r_hdr:
                                bytes_uploaded = int(r_hdr.split("-")[1]) + 1
                    except Exception:
                        pass

        # Fallback: Query upload status to get file ID if stream finished
        try:
            status_chk = session.put(
                resumable_uri,
                headers={"Authorization": f"Bearer {access_token}", "Content-Range": f"bytes */{total_bytes}"},
                timeout=20,
            )
            if status_chk.status_code in (200, 201):
                return status_chk.json()
        except Exception:
            pass

        return {"status": "uploaded"}


# Singleton instance
course_manager = CourseJobManager()
