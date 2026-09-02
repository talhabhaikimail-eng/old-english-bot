"""
Direct Google Drive Streaming Uploader with Real-Time Progress Yielding (AES-256-CTR)
Runs inside Cloud Browser Workers (GitHub Actions / Docker VMs)
Streams files directly from source URLs to Google Drive with 0 local disk usage
and yields real-time progress events for SSE / NDJSON streams.
"""

import os
import sys
import json
import time
import requests
from typing import Optional, Dict, Any, Generator
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

# Force UTF-8 on Windows
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass


def stream_upload_to_drive(
    source_url: str,
    file_name: str,
    folder_id: str,
    access_token: str,
    encryption_key_hex: Optional[str] = None,
    chunk_size: int = 16 * 1024 * 1024  # 16 MB chunks (must be multiple of 256 KiB)
) -> Generator[Dict[str, Any], None, None]:
    """
    Generator that streams a file URL directly into Google Drive with AES-256-CTR encryption
    and yields real-time JSON progress dictionaries for each uploaded chunk.
    """
    # Ensure chunk_size is a multiple of 256 KB
    chunk_size = (max(chunk_size, 256 * 1024) // (256 * 1024)) * (256 * 1024)
    start_time = time.time()

    try:
        # 1. Inspect source stream
        yield {"status": "connecting", "message": f"Connecting to source URL: {source_url[:80]}..."}
        head_resp = requests.get(source_url, stream=True, timeout=25)
        head_resp.raise_for_status()

        content_len = head_resp.headers.get("content-length")
        source_size = int(content_len) if content_len and content_len.isdigit() else None

        final_file_name = file_name
        final_size = None

        # 2. Setup AES-256-CTR Encryption
        encryptor = None
        iv = None
        if encryption_key_hex:
            if len(encryption_key_hex) == 64 and all(c in "0123456789abcdefABCDEF" for c in encryption_key_hex):
                key_bytes = bytes.fromhex(encryption_key_hex)
            else:
                import hashlib
                key_bytes = hashlib.sha256(encryption_key_hex.encode("utf-8")).digest()
            iv = os.urandom(16)
            cipher = Cipher(algorithms.AES(key_bytes), modes.CTR(iv))
            encryptor = cipher.encryptor()
            if not final_file_name.endswith(".enc"):
                final_file_name = f"{final_file_name}.enc"
            if source_size is not None:
                final_size = source_size + 16  # 16-byte random IV prepended header

        yield {
            "status": "starting",
            "fileName": final_file_name,
            "originalFileName": file_name,
            "totalBytes": final_size or source_size,
            "isEncrypted": bool(encryption_key_hex),
        }

        # 3. Create Google Drive Resumable Upload Session (Dynamic streaming mode)
        metadata = {
            "name": final_file_name,
            "parents": [folder_id] if folder_id else []
        }

        init_headers = {
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json; charset=UTF-8",
            "X-Upload-Content-Type": "application/octet-stream",
        }

        init_url = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true"
        init_res = requests.post(init_url, headers=init_headers, json=metadata, timeout=20)

        if init_res.status_code not in (200, 201):
            raise RuntimeError(f"Google Drive initialization failed ({init_res.status_code}): {init_res.text}")

        resumable_uri = init_res.headers.get("Location")
        if not resumable_uri:
            raise RuntimeError("Google Drive did not return a resumable upload URI.")

        # 4. Stream & Encrypt Chunks Directly to Google Drive
        bytes_uploaded = 0
        buffer = bytearray()
        if iv:
            buffer.extend(iv)

        stream_iter = head_resp.iter_content(chunk_size=1024 * 256)
        stream_exhausted = False
        drive_response_data = None

        while not stream_exhausted or len(buffer) > 0:
            # Accumulate full chunk_size (or until stream ends)
            while len(buffer) < chunk_size and not stream_exhausted:
                try:
                    raw_chunk = next(stream_iter)
                    if raw_chunk:
                        if encryptor:
                            enc_chunk = encryptor.update(raw_chunk)
                            buffer.extend(enc_chunk)
                        else:
                            buffer.extend(raw_chunk)
                except StopIteration:
                    stream_exhausted = True
                    if encryptor:
                        buffer.extend(encryptor.finalize())
                    break

            if len(buffer) == 0 and stream_exhausted:
                break

            if stream_exhausted:
                current_chunk = bytes(buffer)
                buffer.clear()
            else:
                current_chunk = bytes(buffer[:chunk_size])
                del buffer[:chunk_size]

            chunk_len = len(current_chunk)
            chunk_start = bytes_uploaded
            chunk_end = bytes_uploaded + chunk_len - 1

            # On the final chunk, declare total bytes; otherwise use '*'
            if stream_exhausted:
                total_bytes_count = bytes_uploaded + chunk_len
                total_str = str(total_bytes_count)
            else:
                total_bytes_count = final_size
                total_str = "*"

            chunk_headers = {
                "Content-Length": str(chunk_len),
                "Content-Range": f"bytes {chunk_start}-{chunk_end}/{total_str}",
            }

            put_res = None
            for attempt in range(3):
                try:
                    put_res = requests.put(resumable_uri, headers=chunk_headers, data=current_chunk, timeout=60)
                    if put_res.status_code in (200, 201, 308):
                        break
                    if attempt == 2:
                        raise RuntimeError(f"Google Drive chunk upload failed ({put_res.status_code}): {put_res.text}")
                    time.sleep(2)
                except requests.RequestException as req_err:
                    if attempt == 2:
                        raise
                    time.sleep(2)

            if put_res.status_code in (200, 201):
                drive_response_data = put_res.json()
                bytes_uploaded += chunk_len
                elapsed = time.time() - start_time
                speed_mbps = round((bytes_uploaded / (1024 * 1024)) / elapsed, 2) if elapsed > 0 else 0
                yield {
                    "status": "uploading",
                    "bytesUploaded": bytes_uploaded,
                    "totalBytes": bytes_uploaded,
                    "progressPercent": 100.0,
                    "speedMBps": speed_mbps,
                }
                break
            elif put_res.status_code == 308:
                range_header = put_res.headers.get("Range")
                if range_header:
                    bytes_uploaded = int(range_header.split("-")[1]) + 1
                else:
                    bytes_uploaded += chunk_len
                elapsed = time.time() - start_time
                speed_mbps = round((bytes_uploaded / (1024 * 1024)) / elapsed, 2) if elapsed > 0 else 0
                progress_pct = round((bytes_uploaded / total_bytes_count) * 100, 2) if total_bytes_count else None

                yield {
                    "status": "uploading",
                    "bytesUploaded": bytes_uploaded,
                    "totalBytes": total_bytes_count,
                    "progressPercent": progress_pct,
                    "speedMBps": speed_mbps,
                }
            else:
                err_detail = f"Google Drive chunk upload failed ({put_res.status_code}): {put_res.text} (Headers sent: {chunk_headers})"
                raise RuntimeError(err_detail)

        head_resp.close()

        if not drive_response_data:
            raise RuntimeError("Upload finished but no file metadata was returned by Google Drive.")

        file_id = drive_response_data.get("id")
        view_link = f"https://drive.google.com/file/d/{file_id}/view?usp=drivesdk"

        yield {
            "status": "completed",
            "fileId": file_id,
            "fileName": final_file_name,
            "originalFileName": file_name,
            "sizeBytes": bytes_uploaded,
            "viewLink": view_link,
            "isEncrypted": bool(encryption_key_hex),
            "driveData": drive_response_data,
        }

    except Exception as e:
        yield {
            "status": "error",
            "error": str(e)
        }
