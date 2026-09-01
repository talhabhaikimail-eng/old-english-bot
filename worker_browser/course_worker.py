"""
course_worker.py — Distributed Course Extraction & Upload Engine.

Adheres strictly to the 5-Stage Worker Disk Protocol (Preventing ENOSPC):
  Stage 1: Concurrent archive parts streaming with < 5GB disk abort check & 1000ms progress reports.
  Stage 2: Archive extraction (unrar, 7z, tar, zip) + recursive nested archive unpacking.
  Stage 3: Part reclamation (immediate deletion of all archive parts to free 10-40 GB).
  Stage 4: Progressive resumable Google Drive upload (AES-256-CTR optional encryption) + immediate unlink of each file.
  Stage 5: Full wipe & idle transition + final completion callback.
"""

import os
import sys
import re
import time
import shutil
import socket
import asyncio
import tempfile
import urllib.parse
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any

import httpx
import requests
from pydantic import BaseModel, Field
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

try:
    import psutil
except ImportError:
    psutil = None

# ---------------------------------------------------------------------------
# Worker Configuration & Constants
# ---------------------------------------------------------------------------
WORKER_ID = os.environ.get("WORKER_ID") or f"worker-{socket.gethostname()[:12]}"
WORKER_PUBLIC_URL = os.environ.get("WORKER_PUBLIC_URL", "").rstrip("/")
WORKER_API_SECRET = os.environ.get("WORKER_API_SECRET", "")
DEFAULT_CONCURRENCY = int(os.environ.get("CONCURRENCY_LIMIT", "10"))
SAFETY_DISK_MIN_BYTES = int(os.environ.get("SAFETY_DISK_MIN_BYTES", str(5 * 1024 * 1024 * 1024))) # 5 GB

# Base temporary jobs directory (e.g., /tmp/jobs or system temp)
if os.path.exists("/tmp") and os.access("/tmp", os.W_OK):
    JOBS_BASE_DIR = os.environ.get("JOBS_BASE_DIR", "/tmp/jobs")
else:
    JOBS_BASE_DIR = os.environ.get("JOBS_BASE_DIR", os.path.join(tempfile.gettempdir(), "jobs"))


# ---------------------------------------------------------------------------
# Pydantic Schemas
# ---------------------------------------------------------------------------
class DriveUploadConfig(BaseModel):
    accessToken: str
    parentFolderId: str
    encrypt: Optional[bool] = True
    encryptionKey: Optional[str] = None


class CourseJobRequest(BaseModel):
    jobId: str
    courseName: str
    archiveUrls: List[str]
    concurrency: Optional[int] = DEFAULT_CONCURRENCY
    drive: DriveUploadConfig
    callbackUrl: str


# ---------------------------------------------------------------------------
# Helper Utilities
# ---------------------------------------------------------------------------
def get_disk_metrics(target_path: Optional[str] = None) -> Dict[str, float]:
    """Cross-platform disk space stats (in GB)."""
    check_path = target_path or JOBS_BASE_DIR
    try:
        os.makedirs(check_path, exist_ok=True)
    except Exception:
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
        print(f"[course_worker] Error reading disk metrics: {e}")
        return {
            "totalGB": 64.0,
            "freeGB": 50.0,
            "usedGB": 14.0,
            "usedPercent": 21.8,
        }


def get_cpu_percent() -> float:
    """Current CPU usage percentage."""
    if psutil:
        try:
            return round(psutil.cpu_percent(interval=None), 1)
        except Exception:
            pass
    return 0.0


def natural_sort_key(s: str) -> List[Any]:
    """Natural numerical sort key: '02.mp4' < '10.mp4'."""
    return [int(text) if text.isdigit() else text.lower() for text in re.split(r'(\d+)', s)]


async def post_webhook(url: str, payload: Dict[str, Any], timeout: float = 10.0):
    """Deliver webhook updates to Central Hub with timeout and error handling."""
    if not url:
        return
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(url, json=payload)
            if resp.status_code >= 400:
                print(f"[course_worker] Webhook callback returned HTTP {resp.status_code}: {resp.text[:120]}")
    except Exception as e:
        print(f"[course_worker] Webhook callback failed for {url}: {e}")


# ---------------------------------------------------------------------------
# Course Job Manager Singleton (Unlimited Jobs - Managed by Central Hub)
# ---------------------------------------------------------------------------
class CourseJobManager:
    def __init__(self):
        self.active_jobs: Dict[str, Dict[str, Any]] = {}
        self.cancel_events: Dict[str, asyncio.Event] = {}
        self.current_tasks: Dict[str, asyncio.Task] = {}
        self.current_procs: Dict[str, asyncio.subprocess.Process] = {}

    def is_busy(self) -> bool:
        # Hub manages concurrency; worker accepts jobs without arbitrary hard limit
        return False

    def get_active_job_id(self) -> Optional[str]:
        return next(iter(self.active_jobs.keys()), None)

    def get_active_job_ids(self) -> List[str]:
        return list(self.active_jobs.keys())

    def get_status(self) -> str:
        return "busy" if self.active_jobs else "idle"

    async def cancel_job(self, job_id: str) -> bool:
        """Force cancels an active job and purges disk immediately."""
        if job_id not in self.active_jobs:
            job_dir = os.path.join(JOBS_BASE_DIR, job_id)
            if os.path.exists(job_dir):
                shutil.rmtree(job_dir, ignore_errors=True)
            return False

        print(f"🛑 [course_worker] Cancelling job {job_id}...")
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

        job_dir = os.path.join(JOBS_BASE_DIR, job_id)
        if os.path.exists(job_dir):
            shutil.rmtree(job_dir, ignore_errors=True)

        self.active_jobs.pop(job_id, None)
        self.cancel_events.pop(job_id, None)
        self.current_tasks.pop(job_id, None)
        self.current_procs.pop(job_id, None)
        return True

    def start_job(self, req: CourseJobRequest):
        """Initializes job state and schedules asynchronous background processing."""
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

        os.makedirs(parts_dir, exist_ok=True)
        os.makedirs(extracted_dir, exist_ok=True)

        try:
            # ---------------------------------------------------------------
            # STAGE 1: CONCURRENT DOWNLOAD WITH 5GB DISK PROTECTION & 1000ms WEBHOOK
            # ---------------------------------------------------------------
            print(f"📥 [course_worker] [Job {job_id}] STAGE 1: Downloading {len(req.archiveUrls)} parts...")
            if job_id in self.active_jobs:
                self.active_jobs[job_id]["phase"] = "downloading"
            await self._download_parts(req, parts_dir, cancel_event)

            if cancel_event.is_set():
                raise asyncio.CancelledError(f"Job {job_id} cancelled.")

            # ---------------------------------------------------------------
            # STAGE 2: ARCHIVE EXTRACTION (UNRAR / 7Z / TAR / ZIP)
            # ---------------------------------------------------------------
            print(f"📦 [course_worker] [Job {job_id}] STAGE 2: Extracting archives to {extracted_dir}...")
            if job_id in self.active_jobs:
                self.active_jobs[job_id]["phase"] = "extracting"
            await post_webhook(req.callbackUrl, {
                "jobId": job_id,
                "workerId": WORKER_ID,
                "phase": "extracting",
                "message": f"Extracting archive volumes into {extracted_dir}...",
            })

            await self._extract_archives(parts_dir, extracted_dir, job_id, cancel_event)

            if cancel_event.is_set():
                raise asyncio.CancelledError(f"Job {job_id} cancelled.")

            # ---------------------------------------------------------------
            # STAGE 3: PART RECLAMATION (CRUCIAL DISK FREEING)
            # ---------------------------------------------------------------
            print(f"🧹 [course_worker] [Job {job_id}] STAGE 3: Purging parts directory to reclaim disk...")
            if job_id in self.active_jobs:
                self.active_jobs[job_id]["phase"] = "reclaiming_disk"
            shutil.rmtree(parts_dir, ignore_errors=True)

            # Check available disk after parts purge
            disk_info = get_disk_metrics(JOBS_BASE_DIR)
            print(f"✅ [course_worker] [Job {job_id}] Parts purged! Current free disk: {disk_info['freeGB']} GB")

            if cancel_event.is_set():
                raise asyncio.CancelledError(f"Job {job_id} cancelled.")

            # ---------------------------------------------------------------
            # STAGE 4: PROGRESSIVE UPLOAD & IMMEDIATE UNLINK
            # ---------------------------------------------------------------
            print(f"☁️ [course_worker] [Job {job_id}] STAGE 4: Progressive upload to Drive & immediate unlinking...")
            if job_id in self.active_jobs:
                self.active_jobs[job_id]["phase"] = "uploading"
            total_uploaded = await self._upload_and_unlink_files(extracted_dir, req)

            # ---------------------------------------------------------------
            # STAGE 5: FULL WIPE & IDLE TRANSITION
            # ---------------------------------------------------------------
            print(f"✨ [course_worker] [Job {job_id}] STAGE 5: Full wipe and completion notification...")
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
            print(f"🎉 [course_worker] [Job {job_id}] Successfully finished in {elapsed_sec}s! ({total_uploaded} files uploaded)")

        except asyncio.CancelledError:
            print(f"🛑 [course_worker] [Job {job_id}] Job was cancelled by user.")
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
            print(f"❌ [course_worker] [Job {job_id}] Execution failed: {err_msg}")
            # Ensure disk is purged on error
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
    # Stage 1 Details: Concurrent Download & 1000ms Throttled Reports
    # -----------------------------------------------------------------------
    async def _download_parts(self, req: CourseJobRequest, parts_dir: str, cancel_event: asyncio.Event):
        job_id = req.jobId
        urls = req.archiveUrls
        total_parts = len(urls)
        concurrency = max(1, min(req.concurrency or DEFAULT_CONCURRENCY, 20))

        # Build part tracking records
        parts_state = []
        for i, url in enumerate(urls):
            # Extract clean filename from URL
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
        last_progress_time = 0.0
        start_t = time.time()

        async def reporter_loop():
            nonlocal last_progress_time
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

        async def download_single_part(part: Dict[str, Any]):
            async with sem:
                if cancel_event.is_set():
                    return

                part["status"] = "downloading"
                url = part["url"]
                dest = part["destPath"]

                headers = {
                    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                }

                # Stream with httpx
                async with httpx.AsyncClient(timeout=httpx.Timeout(connect=30.0, read=120.0, write=30.0, pool=30.0), follow_redirects=True) as client:
                    async with client.stream("GET", url, headers=headers) as resp:
                        if resp.status_code != 200:
                            part["status"] = "failed"
                            raise RuntimeError(f"Download failed for {part['fileName']} (HTTP {resp.status_code})")

                        c_len = resp.headers.get("content-length")
                        total_bytes = int(c_len) if c_len and c_len.isdigit() else 0
                        part["totalBytes"] = total_bytes

                        bytes_dl = 0
                        with open(dest, "wb") as f:
                            async for chunk in resp.aiter_bytes(chunk_size=256 * 1024):
                                if cancel_event.is_set():
                                    part["status"] = "failed"
                                    return

                                f.write(chunk)
                                bytes_dl += len(chunk)
                                part["downloadedBytes"] = bytes_dl
                                if total_bytes > 0:
                                    part["percent"] = round((bytes_dl / total_bytes) * 100, 1)

                                # ENOSPC Guard: Check free disk space every chunk
                                usage = shutil.disk_usage(parts_dir)
                                if usage.free < SAFETY_DISK_MIN_BYTES:
                                    raise RuntimeError(
                                        f"Insufficient disk space: free space ({usage.free / (1024**3):.2f} GB) "
                                        f"dropped below 5 GB safety threshold."
                                    )

                        if bytes_dl < 1024:
                            if os.path.exists(dest):
                                try: os.remove(dest)
                                except Exception: pass
                            part["status"] = "failed"
                            raise RuntimeError(f"Downloaded file {part['fileName']} is empty ({bytes_dl} bytes). Download failed.")

                        if total_bytes > 0 and bytes_dl < (total_bytes * 0.95):
                            if os.path.exists(dest):
                                try: os.remove(dest)
                                except Exception: pass
                            part["status"] = "failed"
                            raise RuntimeError(f"Incomplete download for {part['fileName']}: received {bytes_dl}/{total_bytes} bytes.")

                        part["percent"] = 100.0
                        part["status"] = "completed"

        try:
            tasks = [download_single_part(p) for p in parts_state]
            await asyncio.gather(*tasks)
        finally:
            reporter_task.cancel()
            try:
                await reporter_task
            except asyncio.CancelledError:
                pass

        # Check all completed
        failed = [p["fileName"] for p in parts_state if p["status"] != "completed"]
        if failed:
            raise RuntimeError(f"Download incomplete or failed for parts: {', '.join(failed)}")

    # -----------------------------------------------------------------------
    # Stage 2 Details: Extraction (unrar / 7z / tar / zip) + Recursive Unpacking
    # -----------------------------------------------------------------------
    async def _extract_archives(self, parts_dir: str, extracted_dir: str, job_id: str, cancel_event: asyncio.Event):
        # 1. Inspect parts folder to locate primary archive volume
        files = [f for f in os.listdir(parts_dir) if os.path.isfile(os.path.join(parts_dir, f))]
        files.sort(key=natural_sort_key)

        if not files:
            raise RuntimeError("No archive files found in parts directory to extract.")

        # Verify no 0 KB empty parts exist before attempting extraction
        for f in files:
            p = os.path.join(parts_dir, f)
            if os.path.getsize(p) < 1024:
                raise RuntimeError(f"Cannot extract: Archive part '{f}' is empty (0 KB). Corrupted download.")

        # Find primary multi-part archive file
        primary_archive = None
        for f in files:
            lower = f.lower()
            if ".part1" in lower or ".part01" in lower or ".part001" in lower:
                primary_archive = f
                break
            if ".7z.001" in lower or ".001" in lower:
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
        print(f"📦 [course_worker] [Job {job_id}] Extracting primary archive: {primary_path}...")

        await self._extract_single_archive(primary_path, extracted_dir, job_id)

        # 2. Recursive extraction for any nested .zip, .rar, .7z, .tar in extracted_dir
        await self._recursive_extract(extracted_dir)

    async def _extract_single_archive(self, archive_path: str, output_dir: str, job_id: str):
        """Extract an archive file using unrar, 7z, tar, or Python fallback with password rotation."""
        lower = archive_path.lower()
        passwords = ["www.downloadly.ir", "www.downloadlynet.ir", "downloadly.ir", ""]

        # Build list of archivers available on worker node
        archivers = []
        if shutil.which("unrar"):
            archivers.append("unrar")
        if shutil.which("7z"):
            archivers.append("7z")
        elif shutil.which("7za"):
            archivers.append("7za")

        last_error = ""

        # Try archivers with known downloadly passwords
        for archiver in archivers:
            for pwd in passwords:
                cmd = []
                if archiver == "unrar":
                    p_arg = f"-p{pwd}" if pwd else "-p-"
                    cmd = ["unrar", "x", "-o+", "-y", p_arg, archive_path, f"{output_dir}/"]
                elif archiver in ("7z", "7za"):
                    p_arg = f"-p{pwd}" if pwd else "-p-"
                    cmd = [archiver, "x", "-y", "-aoa", p_arg, f"-o{output_dir}", archive_path]

                if not cmd:
                    continue

                print(f"⚡ [course_worker] [Job {job_id}] Trying {archiver} (pwd: '{pwd}'): {' '.join(cmd[:4])}...")
                proc = await asyncio.create_subprocess_exec(
                    cmd[0], *cmd[1:],
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE
                )
                self.current_procs[job_id] = proc
                stdout, stderr = await proc.communicate()
                self.current_procs.pop(job_id, None)

                if proc.returncode == 0:
                    print(f"🎉 [course_worker] [Job {job_id}] Extraction succeeded with {archiver} (password: '{pwd}')!")
                    return
                else:
                    err_text = stderr.decode(errors="replace") or stdout.decode(errors="replace")
                    last_error = err_text.strip()

        # Fallbacks for zip / tar
        if lower.endswith(".zip"):
            try:
                self._extract_zip_python(archive_path, output_dir)
                return
            except Exception as e:
                last_error = str(e)
        elif lower.endswith(".tar") or lower.endswith(".tar.gz") or lower.endswith(".tgz"):
            try:
                self._extract_tar_python(archive_path, output_dir)
                return
            except Exception as e:
                last_error = str(e)

        raise RuntimeError(f"Extraction failed for {os.path.basename(archive_path)}: {last_error[:350]}")

    def _extract_zip_python(self, zip_path: str, output_dir: str):
        import zipfile
        with zipfile.ZipFile(zip_path, 'r') as z:
            z.extractall(output_dir)

    def _extract_tar_python(self, tar_path: str, output_dir: str):
        import tarfile
        with tarfile.open(tar_path, 'r:*') as t:
            t.extractall(output_dir)

    async def _recursive_extract(self, root_dir: str, max_depth: int = 5):
        """Recursively scan for inner archives and unpack them in place, deleting inner archives."""
        for depth in range(max_depth):
            nested_archives = []
            for root, _, files in os.walk(root_dir):
                for f in files:
                    lower = f.lower()
                    if lower.endswith(".zip") or lower.endswith(".rar") or lower.endswith(".7z") or lower.endswith(".tar.gz") or lower.endswith(".tgz"):
                        nested_archives.append(os.path.join(root, f))

            if not nested_archives:
                break

            print(f"🔄 [course_worker] Found {len(nested_archives)} nested archives. Unpacking depth {depth + 1}...")
            for inner_archive in nested_archives:
                target_dir = os.path.dirname(inner_archive)
                try:
                    await self._extract_single_archive(inner_archive, target_dir)
                    os.remove(inner_archive)
                except Exception as e:
                    print(f"⚠️ [course_worker] Nested archive extract error for {inner_archive}: {e}")

    # -----------------------------------------------------------------------
    # Stage 4 Details: Progressive Resumable Upload & Immediate Unlink
    # -----------------------------------------------------------------------
    async def _upload_and_unlink_files(self, extracted_dir: str, req: CourseJobRequest) -> int:
        job_id = req.jobId
        drive_cfg = req.drive
        access_token = drive_cfg.accessToken
        root_parent_id = drive_cfg.parentFolderId
        encrypt = bool(drive_cfg.encrypt and drive_cfg.encryptionKey)
        encryption_key = drive_cfg.encryptionKey

        # 1. Collect all extracted files
        all_files = []
        for root, _, filenames in os.walk(extracted_dir):
            for fname in filenames:
                full_path = os.path.join(root, fname)
                rel_path = os.path.relpath(full_path, extracted_dir)
                all_files.append((full_path, rel_path, fname))

        # Natural sort by relative path
        all_files.sort(key=lambda x: natural_sort_key(x[1]))
        total_files = len(all_files)
        print(f"🚀 [course_worker] Found {total_files} extracted files to upload.")

        if total_files == 0:
            print("⚠️ [course_worker] No files found in extracted directory to upload.")
            return 0

        # Subfolder cache: rel_dir -> drive_folder_id
        folder_cache: Dict[str, str] = {"": root_parent_id, ".": root_parent_id}

        async def ensure_drive_folder(rel_dir: str) -> str:
            rel_dir = rel_dir.replace("\\", "/").strip("/")
            if not rel_dir:
                return root_parent_id
            if rel_dir in folder_cache:
                return folder_cache[rel_dir]

            parts = rel_dir.split("/")
            current_path = ""
            current_parent = root_parent_id

            for part in parts:
                current_path = f"{current_path}/{part}" if current_path else part
                if current_path in folder_cache:
                    current_parent = folder_cache[current_path]
                else:
                    # Create subfolder on Google Drive
                    sub_id = await self._create_drive_subfolder(part, current_parent, access_token)
                    folder_cache[current_path] = sub_id
                    current_parent = sub_id

            return current_parent

        uploaded_count = 0

        # Process and upload files progressively
        for i, (full_path, rel_path, fname) in enumerate(all_files):
            if self.cancel_event.is_set():
                raise asyncio.CancelledError(f"Job {job_id} cancelled.")

            if not os.path.exists(full_path):
                continue

            rel_dir = os.path.dirname(rel_path)
            target_folder_id = await ensure_drive_folder(rel_dir)

            print(f"📤 [course_worker] [{i + 1}/{total_files}] Uploading '{fname}' ({rel_path})...")
            file_result = await asyncio.to_thread(
                self._upload_single_file_to_drive,
                file_path=full_path,
                file_name=fname,
                folder_id=target_folder_id,
                access_token=access_token,
                encrypt=encrypt,
                encryption_key=encryption_key,
            )

            # CRUCIAL DISK RULE: Immediately unlink file after upload!
            try:
                os.remove(full_path)
            except Exception as unl_err:
                print(f"⚠️ [course_worker] Failed to unlink {full_path}: {unl_err}")

            uploaded_count += 1
            drive_file_id = file_result.get("id", "")
            drive_view_link = f"https://drive.google.com/file/d/{drive_file_id}/view" if drive_file_id else ""

            # Send Live Upload Progress Report
            await post_webhook(req.callbackUrl, {
                "jobId": job_id,
                "workerId": WORKER_ID,
                "phase": "uploading",
                "currentFileIndex": i + 1,
                "totalFiles": total_files,
                "currentFileName": fname,
                "filePercent": 100.0,
                "driveFileId": drive_file_id,
                "driveViewLink": drive_view_link,
            })

        return uploaded_count

    async def _create_drive_subfolder(self, name: str, parent_id: str, access_token: str) -> str:
        """Creates a folder in Google Drive using REST API."""
        url = "https://www.googleapis.com/drive/v3/files"
        headers = {
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
        }
        body = {
            "name": name,
            "mimeType": "application/vnd.google-apps.folder",
            "parents": [parent_id] if parent_id else [],
        }

        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(url, headers=headers, json=body)
            if resp.status_code in (200, 201):
                return resp.json().get("id", parent_id)
            else:
                print(f"⚠️ [course_worker] Subfolder creation failed ({resp.status_code}): {resp.text[:150]}")
                return parent_id

    def _upload_single_file_to_drive(
        self,
        file_path: str,
        file_name: str,
        folder_id: str,
        access_token: str,
        encrypt: bool,
        encryption_key: Optional[str],
        chunk_size: int = 16 * 1024 * 1024,
    ) -> Dict[str, Any]:
        """
        Uploads a local file to Google Drive using the Resumable Upload API with
        optional AES-256-CTR streaming encryption.
        """
        raw_size = os.path.getsize(file_path)
        final_file_name = file_name
        iv = None
        encryptor = None

        if encrypt and encryption_key:
            key_bytes = bytes.fromhex(encryption_key)
            iv = os.urandom(16)
            cipher = Cipher(algorithms.AES(key_bytes), modes.CTR(iv))
            encryptor = cipher.encryptor()
            if not final_file_name.endswith(".enc"):
                final_file_name = f"{final_file_name}.enc"
            total_bytes = raw_size + 16
        else:
            total_bytes = raw_size

        # 1. Initialize Resumable Upload Session
        init_headers = {
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json; charset=UTF-8",
            "X-Upload-Content-Type": "application/octet-stream",
        }
        metadata = {
            "name": final_file_name,
            "parents": [folder_id] if folder_id else [],
        }
        init_url = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable"
        init_res = requests.post(init_url, headers=init_headers, json=metadata, timeout=20)

        if init_res.status_code not in (200, 201):
            raise RuntimeError(f"Drive resumable upload init failed ({init_res.status_code}): {init_res.text}")

        resumable_uri = init_res.headers.get("Location")
        if not resumable_uri:
            raise RuntimeError("Drive did not return a resumable upload URI.")

        # 2. Upload file in chunks
        # Ensure chunk_size is multiple of 256 KiB
        chunk_size = (max(chunk_size, 256 * 1024) // (256 * 1024)) * (256 * 1024)
        bytes_uploaded = 0

        with open(file_path, "rb") as f:
            is_first_chunk = True
            while bytes_uploaded < total_bytes:
                # Prepare chunk
                if is_first_chunk and iv:
                    # Prepend 16-byte IV header to first chunk
                    needed_raw = chunk_size - 16
                    raw_data = f.read(needed_raw)
                    enc_data = encryptor.update(raw_data) if encryptor else raw_data
                    current_chunk = iv + enc_data
                    is_first_chunk = False
                else:
                    raw_data = f.read(chunk_size)
                    if encryptor:
                        if not raw_data:
                            current_chunk = encryptor.finalize()
                        else:
                            current_chunk = encryptor.update(raw_data)
                    else:
                        current_chunk = raw_data

                chunk_len = len(current_chunk)
                if chunk_len == 0:
                    break

                chunk_start = bytes_uploaded
                chunk_end = bytes_uploaded + chunk_len - 1

                chunk_headers = {
                    "Content-Length": str(chunk_len),
                    "Content-Range": f"bytes {chunk_start}-{chunk_end}/{total_bytes}",
                }

                # PUT with retry
                for attempt in range(3):
                    try:
                        put_res = requests.put(resumable_uri, headers=chunk_headers, data=current_chunk, timeout=90)
                        if put_res.status_code in (200, 201):
                            bytes_uploaded += chunk_len
                            return put_res.json()
                        elif put_res.status_code == 308:
                            bytes_uploaded += chunk_len
                            break
                        else:
                            if attempt == 2:
                                raise RuntimeError(f"Drive chunk upload failed ({put_res.status_code}): {put_res.text}")
                            time.sleep(2)
                    except requests.RequestException as req_err:
                        if attempt == 2:
                            raise
                        time.sleep(2)

        return {"status": "uploaded"}


# Singleton instance
course_manager = CourseJobManager()
