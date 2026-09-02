"""
Python Controller & SDK for the Go High-Speed Multi-Part Download & Streaming Engine.
Compatible with Windows, Linux (Ubuntu/Debian), macOS, and GitHub Actions.
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
import os
import platform
import shutil
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any, AsyncGenerator, Callable, Dict, Generator, Optional


@dataclasses.dataclass
class ProbeResult:
    filename: str
    total_bytes: int
    accept_ranges: bool
    status_code: int
    final_url: str
    total_chunks: int

    @property
    def total_mb(self) -> float:
        return self.total_bytes / (1024 * 1024)

    @property
    def total_gb(self) -> float:
        return self.total_bytes / (1024 * 1024 * 1024)


@dataclasses.dataclass
class ProgressEvent:
    downloaded_bytes: int
    total_bytes: int
    percent: float
    speed_bytes_sec: float
    eta_seconds: float
    elapsed_seconds: float
    active_workers: int
    completed_chunks: int
    total_chunks: int

    @property
    def speed_mb_s(self) -> float:
        return self.speed_bytes_sec / (1024 * 1024)

    @property
    def downloaded_mb(self) -> float:
        return self.downloaded_bytes / (1024 * 1024)

    @property
    def total_mb(self) -> float:
        return self.total_bytes / (1024 * 1024)


@dataclasses.dataclass
class DownloadResult:
    filename: str
    dest_path: str
    total_bytes: int
    elapsed_seconds: float
    avg_speed_bytes_sec: float

    @property
    def total_mb(self) -> float:
        return self.total_bytes / (1024 * 1024)

    @property
    def avg_speed_mb_s(self) -> float:
        return self.avg_speed_bytes_sec / (1024 * 1024)


class DownloadEngineError(Exception):
    """Raised when the download engine encounters a fatal error."""
    pass


class DLEngine:
    """
    High-Speed Multi-Part Downloader & Streamer controlled from Python.
    """

    def __init__(self, bin_path: Optional[str | Path] = None):
        if bin_path:
            self.bin_path = Path(bin_path).resolve()
        else:
            self.bin_path = self._auto_detect_binary()

        if not self.bin_path.exists():
            raise FileNotFoundError(
                f"DLEngine binary not found at '{self.bin_path}'. "
                "Please install dlengine or provide the binary path."
            )

        # On Linux/macOS ensure binary has executable permissions
        if platform.system() != "Windows":
            try:
                os.chmod(self.bin_path, 0o755)
            except Exception:
                pass

        self.last_progress: Optional[ProgressEvent] = None

    @staticmethod
    def is_available(bin_path: Optional[str | Path] = None) -> bool:
        """Returns True if the dlengine binary is present and executable."""
        try:
            if bin_path:
                p = Path(bin_path).resolve()
                return p.exists() and (os.access(p, os.X_OK) or platform.system() == "Windows")
            detected = DLEngine._auto_detect_binary()
            return detected.exists() and (os.access(detected, os.X_OK) or platform.system() == "Windows")
        except Exception:
            return False

    @staticmethod
    def _auto_detect_binary() -> Path:
        # 1. Environment variable override
        env_bin = os.environ.get("DLENGINE_BIN") or os.environ.get("DLENGINE_PATH")
        if env_bin:
            p = Path(env_bin).resolve()
            if p.exists():
                return p

        # 2. System PATH check
        which_path = shutil.which("dlengine") or shutil.which("dlengine.exe")
        if which_path:
            return Path(which_path).resolve()

        # 3. Known standard system locations
        standard_paths = [
            Path("/usr/local/bin/dlengine"),
            Path("/usr/bin/dlengine"),
            Path("/opt/dlengine/dlengine"),
        ]
        for p in standard_paths:
            if p.exists():
                return p

        # 4. Local directory candidates relative to this file and workspace
        base_dir = Path(__file__).resolve().parent
        workspace_dir = base_dir.parent
        is_windows = platform.system() == "Windows"
        arch = platform.machine().lower()

        candidates = []
        if is_windows:
            candidates.extend([
                base_dir / "dlengine.exe",
                base_dir / "bin" / "dlengine.exe",
                base_dir / "bin" / "dlengine-windows-amd64.exe",
                workspace_dir / "bin" / "dlengine.exe",
                Path("d:/download-engine/dlengine.exe"),
                Path("d:/download-engine/bin/dlengine-windows-amd64.exe"),
            ])
        else:
            if "arm" in arch or "aarch64" in arch:
                candidates.extend([
                    base_dir / "dlengine",
                    base_dir / "bin" / "dlengine",
                    base_dir / "bin" / "dlengine-linux-arm64",
                    workspace_dir / "bin" / "dlengine-linux-arm64",
                ])
            else:
                candidates.extend([
                    base_dir / "dlengine",
                    base_dir / "bin" / "dlengine",
                    base_dir / "bin" / "dlengine-linux-amd64",
                    workspace_dir / "bin" / "dlengine-linux-amd64",
                ])

        for p in candidates:
            if p.exists():
                return p

        # Fallback default
        if is_windows:
            return Path("dlengine.exe")
        return Path("/usr/local/bin/dlengine")

    def probe(self, url: str, headers: Optional[Dict[str, str]] = None) -> ProbeResult:
        """
        Probe remote target metadata (size, ranges, filename) without downloading.
        """
        cmd = [str(self.bin_path), "-u", url, "--probe-only", "--json"]
        if headers:
            for k, v in headers.items():
                cmd.extend(["-H", f"{k}: {v}"])

        proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if proc.returncode != 0:
            raise DownloadEngineError(f"Probe failed: {proc.stderr or proc.stdout}")

        for line in proc.stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                data = json.loads(line)
                if data.get("event") == "probe":
                    return ProbeResult(
                        filename=data.get("filename", ""),
                        total_bytes=data.get("total_bytes", 0),
                        accept_ranges=data.get("accept_ranges", False),
                        status_code=data.get("status_code", 0),
                        final_url=data.get("final_url", ""),
                        total_chunks=data.get("total_chunks", 1),
                    )
                elif data.get("event") == "error":
                    raise DownloadEngineError(data.get("message", "Unknown probe error"))
            except json.JSONDecodeError:
                continue

        raise DownloadEngineError(f"Failed to parse probe output: {proc.stdout}")

    def download(
        self,
        url: str,
        output_path: Optional[str | Path] = None,
        concurrency: int = 16,
        chunk_size: str = "8MB",
        stream_mode: bool = False,
        retries: int = 5,
        headers: Optional[Dict[str, str]] = None,
        on_progress: Optional[Callable[[ProgressEvent], None]] = None,
        timeout: Optional[float] = None,
    ) -> DownloadResult:
        """
        Download file with synchronous real-time progress callbacks.
        """
        cmd = [
            str(self.bin_path),
            "-u", url,
            "-c", str(concurrency),
            "-s", chunk_size,
            "-r", str(retries),
            "--json",
        ]
        if output_path:
            cmd.extend(["-o", str(output_path)])
        if stream_mode:
            cmd.append("--stream")
        if headers:
            for k, v in headers.items():
                cmd.extend(["-H", f"{k}: {v}"])

        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            universal_newlines=True,
        )

        result: Optional[DownloadResult] = None
        last_error: Optional[str] = None

        try:
            for line in process.stdout:
                line = line.strip()
                if not line:
                    continue
                try:
                    data = json.loads(line)
                    event_type = data.get("event")

                    if event_type == "progress" and on_progress:
                        evt = ProgressEvent(
                            downloaded_bytes=data.get("downloaded_bytes", 0),
                            total_bytes=data.get("total_bytes", 0),
                            percent=data.get("percent", 0.0),
                            speed_bytes_sec=data.get("speed_bytes_sec", 0.0),
                            eta_seconds=data.get("eta_seconds", 0.0),
                            elapsed_seconds=data.get("elapsed_seconds", 0.0),
                            active_workers=data.get("active_workers", 0),
                            completed_chunks=data.get("completed_chunks", 0),
                            total_chunks=data.get("total_chunks", 0),
                        )
                        self.last_progress = evt
                        on_progress(evt)

                    elif event_type == "completed":
                        result = DownloadResult(
                            filename=data.get("filename", ""),
                            dest_path=data.get("dest_path", ""),
                            total_bytes=data.get("total_bytes", 0),
                            elapsed_seconds=data.get("elapsed_seconds", 0.0),
                            avg_speed_bytes_sec=data.get("avg_speed_bytes_sec", 0.0),
                        )

                    elif event_type == "error":
                        last_error = data.get("message", "Unknown error")

                except json.JSONDecodeError:
                    continue

            process.wait(timeout=timeout)
            if process.returncode != 0:
                stderr_output = process.stderr.read()
                raise DownloadEngineError(
                    last_error or f"Process exited with code {process.returncode}: {stderr_output}"
                )

            if result is None:
                raise DownloadEngineError(last_error or "Download finished without completion event")

            return result

        except Exception:
            process.kill()
            raise

    async def download_async(
        self,
        url: str,
        output_path: Optional[str | Path] = None,
        concurrency: int = 16,
        chunk_size: str = "8MB",
        stream_mode: bool = False,
        retries: int = 5,
        headers: Optional[Dict[str, str]] = None,
        on_progress: Optional[Callable[[ProgressEvent], None]] = None,
        cancel_event: Optional[asyncio.Event] = None,
    ) -> DownloadResult:
        """
        Asynchronous download for asyncio event loops with cancellation support.
        """
        cmd = [
            str(self.bin_path),
            "-u", url,
            "-c", str(concurrency),
            "-s", chunk_size,
            "-r", str(retries),
            "--json",
        ]
        if output_path:
            cmd.extend(["-o", str(output_path)])
        if stream_mode:
            cmd.append("--stream")
        if headers:
            for k, v in headers.items():
                cmd.extend(["-H", f"{k}: {v}"])

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        result: Optional[DownloadResult] = None
        last_error: Optional[str] = None

        async def check_cancellation():
            if not cancel_event:
                return
            while proc.returncode is None:
                if cancel_event.is_set():
                    try:
                        proc.kill()
                    except Exception:
                        pass
                    break
                await asyncio.sleep(0.5)

        cancel_task = asyncio.create_task(check_cancellation()) if cancel_event else None

        try:
            while True:
                line_bytes = await proc.stdout.readline()
                if not line_bytes:
                    break
                line = line_bytes.decode("utf-8", errors="replace").strip()
                if not line:
                    continue

                try:
                    data = json.loads(line)
                    event_type = data.get("event")

                    if event_type == "progress" and on_progress:
                        evt = ProgressEvent(
                            downloaded_bytes=data.get("downloaded_bytes", 0),
                            total_bytes=data.get("total_bytes", 0),
                            percent=data.get("percent", 0.0),
                            speed_bytes_sec=data.get("speed_bytes_sec", 0.0),
                            eta_seconds=data.get("eta_seconds", 0.0),
                            elapsed_seconds=data.get("elapsed_seconds", 0.0),
                            active_workers=data.get("active_workers", 0),
                            completed_chunks=data.get("completed_chunks", 0),
                            total_chunks=data.get("total_chunks", 0),
                        )
                        self.last_progress = evt
                        if asyncio.iscoroutinefunction(on_progress):
                            await on_progress(evt)
                        else:
                            on_progress(evt)

                    elif event_type == "completed":
                        result = DownloadResult(
                            filename=data.get("filename", ""),
                            dest_path=data.get("dest_path", ""),
                            total_bytes=data.get("total_bytes", 0),
                            elapsed_seconds=data.get("elapsed_seconds", 0.0),
                            avg_speed_bytes_sec=data.get("avg_speed_bytes_sec", 0.0),
                        )

                    elif event_type == "error":
                        last_error = data.get("message")

                except json.JSONDecodeError:
                    continue

            await proc.wait()
            if cancel_event and cancel_event.is_set():
                raise asyncio.CancelledError("Download was cancelled.")

            if proc.returncode != 0:
                stderr_bytes = await proc.stderr.read()
                raise DownloadEngineError(
                    last_error or f"Process exited with code {proc.returncode}: {stderr_bytes.decode()}"
                )

            if result is None:
                raise DownloadEngineError(last_error or "Download finished without completion event")

            return result

        finally:
            if cancel_task and not cancel_task.done():
                cancel_task.cancel()
                try:
                    await cancel_task
                except (asyncio.CancelledError, Exception):
                    pass
            if proc.returncode is None:
                try:
                    proc.kill()
                except Exception:
                    pass
