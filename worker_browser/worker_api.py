from typing import Dict, Optional, List, Any, Set
from collections import deque
from fastapi import FastAPI, HTTPException, Response, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel
from seleniumbase import SB
import uvicorn
import random
import tempfile
import os
import sys
import signal
import asyncio
import subprocess
import time
import json
import shutil
import struct
from datetime import datetime, timezone
import httpx

try:
    import pty
    import termios
    import fcntl
    HAS_PTY = True
except ImportError:
    HAS_PTY = False

from course_worker import (
    course_manager,
    CourseJobRequest,
    get_disk_metrics,
    get_cpu_percent,
    WORKER_ID,
    WORKER_PUBLIC_URL,
    WORKER_API_SECRET,
    DEFAULT_CONCURRENCY,
)

app = FastAPI(title="Worker Browser API")

browser_semaphore = asyncio.Semaphore(1)

class ScrapeIndeedRequest(BaseModel):
    query: str
    location: str
    page: int = 1

class ScrapeGoogleRequest(BaseModel):
    text: str
    pageNumber: int = 1
    includeAI: bool = False
    category: str = None

class ScreenshotRequest(BaseModel):
    url: str
    full_page: bool = False

class GetHtmlRequest(BaseModel):
    url: str

class CodeExecRequest(BaseModel):
    code: str
    timeout: int = 30

NodeExecRequest = CodeExecRequest

class PythonExecRequest(BaseModel):
    code: str
    timeout: int = 30

class ShellExecRequest(BaseModel):
    command: str
    timeout: int = 30

class ProxyForwardRequest(BaseModel):
    url: str
    method: str = "GET"
    headers: Optional[Dict[str, str]] = None
    body: Optional[str] = None
    timeout: float = 15.0

def is_captcha_present(sb):
    """
    Checks the current page state for common captcha and verification indicators.
    Returns True if a captcha/challenge page is detected.
    """
    try:
        title = sb.get_title()
        if "Just a moment..." in title or "Attention Required" in title or "Security | Indeed" in title:
            return True
        
        source = sb.get_page_source()
        if "Verify you are human" in source or "Additional Verification Required" in source or "hcaptcha" in source or "g-recaptcha" in source:
            return True
            
        if sb.is_element_visible("form[action='/sorry/index']") or sb.is_element_visible("#captcha") or sb.is_element_visible(".g-recaptcha"):
            return True
            
    except Exception:
        return False
    return False

def sync_scrape_indeed(req: ScrapeIndeedRequest):
    try:
        # We run headlessly with UC mode inside SB
        with SB(uc=True, xvfb=True) as sb:
            sb.driver.set_window_size(1400, 900)
            
            start_offset = (req.page - 1) * 10
            
            domain = "www.indeed.com"
            if req.location and any(p in req.location.lower() for p in ["pakistan", "pk", "rawalpindi", "islamabad", "lahore", "karachi", "punjab", "sindh", "kpk", "balochistan"]):
                domain = "pk.indeed.com"
            
            import urllib.parse
            safe_query = urllib.parse.quote_plus(req.query)
            safe_location = urllib.parse.quote_plus(req.location)
            
            # Navigate to page 1 first to establish cookies / session
            base_url = f"https://{domain}/jobs?q={safe_query}&l={safe_location}"
            print(f"[Indeed UC] Loading page 1 first to establish session: {base_url}")
            sb.uc_open_with_reconnect(base_url, 6)
            sb.sleep(2)
            
            # If we want a later page, open it now that cookies/session are set
            if req.page > 1:
                search_url = f"https://{domain}/jobs?q={safe_query}&l={safe_location}&start={start_offset}"
                print(f"[Indeed UC] Navigating to target page {req.page}: {search_url}")
                sb.uc_open_with_reconnect(search_url, 6)
                sb.sleep(2)
            
            print(f"[Indeed UC] Loaded URL: {sb.get_current_url()}")
            
            # Try to bypass Cloudflare Turnstile if present
            for attempt in range(3):
                if not is_captcha_present(sb):
                    break
                print(f"[Indeed UC] Bypassing captcha (attempt {attempt + 1})...")
                try:
                    if sb.is_element_present("iframe[src*='challenges']"):
                        sb.sleep(2)
                    sb.uc_gui_click_captcha()
                    sb.sleep(5)
                except Exception as e:
                    print(f"[Indeed UC] Click captcha error: {e}")
                
                if not is_captcha_present(sb):
                    break
                
                try:
                    sb.uc_gui_handle_captcha()
                    sb.sleep(5)
                except Exception as e:
                    print(f"[Indeed UC] Handle captcha error: {e}")
            
            # Check for captcha
            if is_captcha_present(sb):
                print("[Indeed UC] Captcha detected on search page! Aborting.")
                raise HTTPException(status_code=403, detail="Captcha detected on search page")

            # Wait for job cards
            try:
                sb.wait_for_element(".job_seen_beacon, a.jcs-JobTitle", timeout=12)
            except Exception:
                if is_captcha_present(sb):
                    raise HTTPException(status_code=403, detail="Captcha detected on search page timeout")
                
                # Take a diagnostic screenshot to help the test kit see what happened
                try:
                    temp_dir = tempfile.gettempdir()
                    screenshot_path = os.path.join(temp_dir, "indeed_timeout_debug.png")
                    html_path = os.path.join(temp_dir, "indeed_timeout_debug.html")
                    sb.save_screenshot(screenshot_path)
                    with open(html_path, "w", encoding="utf-8") as f:
                        f.write(sb.get_page_source())
                    print(f"[Indeed UC] Timeout waiting for cards. Saved diagnostic screenshot to {screenshot_path} and html to {html_path}.")
                except Exception:
                    pass
                return []

            # Extract job cards
            jobs_on_page = sb.execute_script(f"""
                var elements = document.querySelectorAll('.job_seen_beacon');
                var results = [];
                elements.forEach(function(el) {{
                    var titleEl = el.querySelector('a.jcs-JobTitle') || el.querySelector('span[id^="jobTitle-"]');
                    var title = titleEl ? titleEl.innerText.trim() : '';
                    var jk = titleEl ? titleEl.getAttribute('data-jk') : null;
                    
                    var companyEl = el.querySelector('[data-testid="company-name"]') || el.querySelector('.companyName');
                    var company = companyEl ? companyEl.innerText.trim() : '';
                    
                    var locationEl = el.querySelector('[data-testid="text-location"]') || el.querySelector('.companyLocation');
                    var location = locationEl ? locationEl.innerText.trim() : '';
                    
                    var salaryEl = el.querySelector('[data-testid="attribute_snippet_type_salary-estimate"]') || el.querySelector('.salary-snippet-container');
                    var salary = salaryEl ? salaryEl.innerText.trim() : '';
                    
                    var snippetEl = el.querySelector('.job-snippet') || el.querySelector('.summary');
                    var snippet = snippetEl ? snippetEl.innerText.trim() : '';
                    
                    if (jk) {{
                        results.push({{
                            'jk': jk,
                            'title': title,
                            'company': company,
                            'location': location,
                            'salary': salary,
                            'snippet': snippet,
                            'url': 'https://{domain}/viewjob?jk=' + jk
                        }});
                    }}
                }});
                return results;
            """)

            if not jobs_on_page:
                return []

            scraped_jobs = []
            for job in jobs_on_page:
                jk = job['jk']
                
                # Single tab click card
                try:
                    card_selector = f'a.jcs-JobTitle[data-jk="{jk}"], [id^="jobTitle-"][data-jk="{jk}"]'
                    sb.click(card_selector)
                    sb.sleep(0.8)
                    
                    if is_captcha_present(sb):
                        print("[Indeed UC] Captcha detected after click! Aborting.")
                        raise HTTPException(status_code=403, detail="Captcha detected after job click")

                    sb.wait_for_element("#jobDescriptionText", timeout=4)
                    description = sb.get_text("#jobDescriptionText").strip()
                    job['description'] = description
                except Exception as e:
                    if is_captcha_present(sb):
                        raise HTTPException(status_code=403, detail="Captcha detected during description fetch")
                    job['description'] = job['snippet'] # Fallback
                
                scraped_jobs.append(job)
                sb.sleep(random.uniform(0.2, 0.5))

            return scraped_jobs
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

def sync_take_screenshot(req: ScreenshotRequest):
    try:
        with SB(uc=True, xvfb=True) as sb:
            sb.driver.set_window_size(1400, 900)
            sb.uc_open_with_reconnect(req.url, 5)
            sb.sleep(4)
            with tempfile.NamedTemporaryFile(delete=False, suffix=".png") as tmp:
                sb.save_screenshot(tmp.name)
                tmp_path = tmp.name
            try:
                with open(tmp_path, "rb") as f:
                    content = f.read()
                return Response(content=content, media_type="image/png")
            finally:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

def sync_get_html(req: GetHtmlRequest):
    try:
        with SB(uc=True, xvfb=True) as sb:
            sb.uc_open_with_reconnect(req.url, 5)
            sb.sleep(4)
            return {"html": sb.get_page_source()}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

def sync_scrape_google(req: ScrapeGoogleRequest):
    try:
        with SB(uc=True, xvfb=True) as sb:
            sb.driver.set_window_size(1400, 900)
            
            import urllib.parse
            safe_text = urllib.parse.quote_plus(req.text)
            start_offset = (req.pageNumber - 1) * 10
            
            target_url = f"https://www.google.com/search?q={safe_text}&start={start_offset}&num=10&hl=en&pws=0"
            norm_category = req.category.lower().strip() if req.category else "all"
            if norm_category in ["images", "image"]:
                target_url += "&udm=2"
            elif norm_category in ["videos", "video"]:
                target_url += "&udm=7"
            elif norm_category == "news":
                target_url += "&udm=14"
            elif norm_category in ["shopping", "shop"]:
                target_url += "&udm=3"
                
            print(f"[Google UC] Opening Google Search: {target_url}")
            sb.uc_open_with_reconnect(target_url, 6)
            sb.sleep(2)
            
            for attempt in range(3):
                if not is_captcha_present(sb):
                    break
                print(f"[Google UC] Bypassing captcha (attempt {attempt + 1})...")
                try:
                    sb.uc_gui_click_captcha()
                    sb.sleep(4)
                except Exception as e:
                    print(f"[Google UC] Click captcha error: {e}")
                    
                if not is_captcha_present(sb):
                    break
                    
                try:
                    sb.uc_gui_handle_captcha()
                    sb.sleep(4)
                except Exception as e:
                    print(f"[Google UC] Handle captcha error: {e}")
                    
            if is_captcha_present(sb):
                print("[Google UC] Captcha detected on Google search page! Aborting.")
                raise HTTPException(status_code=403, detail="Captcha detected on search page")

            data = sb.execute_script("""
                var organic = [];
                var seen = new Set();
                var cleanText = function(str) { return str ? str.trim().replace(/\\s+/g, ' ') : ''; };

                var decodeGoogleLink = function(href) {
                    if (!href) return '';
                    try {
                        if (href.indexOf('/url?q=') === 0) {
                            var urlPart = href.split('/url?q=')[1].split('&')[0];
                            if (urlPart) return decodeURIComponent(urlPart);
                        } else if (href.indexOf('/url?url=') === 0) {
                            var urlPart = href.split('/url?url=')[1].split('&')[0];
                            if (urlPart) return decodeURIComponent(urlPart);
                        }
                    } catch(e) {}
                    return href;
                };

                // 1. Primary Organic Results Extraction
                document.querySelectorAll('h3').forEach(function(h3) {
                    var headingText = cleanText(h3.textContent);
                    if (
                        !headingText ||
                        headingText === 'Search Results' ||
                        headingText === 'Weather Result' ||
                        headingText === 'Web results' ||
                        headingText === 'Featured snippet' ||
                        headingText.indexOf('People also ask') !== -1
                    ) {
                        return;
                    }

                    var container = h3.closest('.g, .MjjYud, .xpd, .Gx5Zad') || h3.parentElement;
                    if (!container) return;

                    var anchors = Array.from(container.querySelectorAll('a'));
                    var validLink = '';

                    for (var i = 0; i < anchors.length; i++) {
                        var rawHref = anchors[i].getAttribute('href') || '';
                        var decoded = decodeGoogleLink(rawHref);
                        if (
                            decoded &&
                            decoded.indexOf('http') === 0 &&
                            decoded.indexOf('google.com') === -1 &&
                            decoded.indexOf('sorry/index') === -1
                        ) {
                            validLink = decoded;
                            break;
                        }
                    }

                    if (!validLink || seen.has(validLink)) return;
                    seen.add(validLink);

                    var snippet = '';
                    var snSelectors = ['.VwiC3b', '.lEBKkf', '.lyLwlc', '[data-sncf]', '.IsZvec', '.ilUpNd.H66NU.aSRlid', '.H66NU', '.lQigmf', '.s3v9rd', '.BNeawe'];
                    for (var s = 0; s < snSelectors.length; s++) {
                        var sn = container.querySelector(snSelectors[s]);
                        if (sn && sn.textContent && sn.textContent.trim()) {
                            var txt = cleanText(sn.textContent);
                            if (txt !== headingText && txt.length > 10) {
                                snippet = txt;
                                break;
                            }
                        }
                    }

                    organic.push({
                        title: headingText,
                        link: validLink,
                        snippet: snippet
                    });
                });

                // 2. Fallback Organic Results Extraction if primary found 0
                if (organic.length === 0) {
                    document.querySelectorAll('a').forEach(function(a) {
                        var h3 = a.querySelector('h3');
                        if (!h3) return;
                        var rawHref = a.getAttribute('href') || '';
                        var link = decodeGoogleLink(rawHref);
                        if (
                            !link ||
                            link.indexOf('http') !== 0 ||
                            link.indexOf('google.com') !== -1 ||
                            seen.has(link)
                        ) return;

                        seen.add(link);
                        organic.push({
                            title: cleanText(h3.textContent),
                            link: link,
                            snippet: ''
                        });
                    });
                }

                // 3. AI Overview Extraction
                var aiResponse = null;
                var aiSelectors = ['.M8OgIe', '.LLtROe', '.IZ6rdc', '[data-attrid="wa:/description"]'];
                for (var k = 0; k < aiSelectors.length; k++) {
                    var el = document.querySelector(aiSelectors[k]);
                    if (el && el.innerText && el.innerText.trim().length > 20) {
                        var txt = el.innerText;
                        if (txt.indexOf('AI Overview is not available') === -1) {
                            aiResponse = el.innerHTML || el.innerText.trim();
                            break;
                        }
                    }
                }

                return { organic: organic, aiResponse: aiResponse };
            """)

            return data
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/scrape/google")
async def scrape_google(req: ScrapeGoogleRequest):
    async with browser_semaphore:
        return await asyncio.to_thread(sync_scrape_google, req)

@app.post("/scrape/indeed")
async def scrape_indeed(req: ScrapeIndeedRequest):
    async with browser_semaphore:
        return await asyncio.to_thread(sync_scrape_indeed, req)

@app.post("/screenshot")
async def take_screenshot(req: ScreenshotRequest):
    async with browser_semaphore:
        return await asyncio.to_thread(sync_take_screenshot, req)

@app.post("/get_html")
async def get_html(req: GetHtmlRequest):
    async with browser_semaphore:
        return await asyncio.to_thread(sync_get_html, req)

@app.post("/exec/node")
async def exec_node(req: NodeExecRequest):
    start_t = time.time()
    try:
        with tempfile.NamedTemporaryFile(suffix=".js", mode="w", delete=False, encoding="utf-8") as tmp:
            tmp.write(req.code)
            tmp_path = tmp.name

        proc = await asyncio.create_subprocess_exec(
            "node", tmp_path,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE
        )

        try:
            stdout_bytes, stderr_bytes = await asyncio.wait_for(proc.communicate(), timeout=req.timeout)
        except asyncio.TimeoutError:
            try:
                proc.kill()
            except Exception:
                pass
            raise HTTPException(status_code=408, detail=f"Node.js script execution timed out after {req.timeout}s")

        duration_ms = int((time.time() - start_t) * 1000)
        return {
            "exit_code": proc.returncode,
            "stdout": stdout_bytes.decode("utf-8", errors="replace"),
            "stderr": stderr_bytes.decode("utf-8", errors="replace"),
            "execution_time_ms": duration_ms
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if 'tmp_path' in locals() and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except Exception:
                pass

@app.post("/exec/python")
async def exec_python(req: PythonExecRequest):
    start_t = time.time()
    try:
        with tempfile.NamedTemporaryFile(suffix=".py", mode="w", delete=False, encoding="utf-8") as tmp:
            tmp.write(req.code)
            tmp_path = tmp.name

        proc = await asyncio.create_subprocess_exec(
            "python3", tmp_path,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE
        )

        try:
            stdout_bytes, stderr_bytes = await asyncio.wait_for(proc.communicate(), timeout=req.timeout)
        except asyncio.TimeoutError:
            try:
                proc.kill()
            except Exception:
                pass
            raise HTTPException(status_code=408, detail=f"Python script execution timed out after {req.timeout}s")

        duration_ms = int((time.time() - start_t) * 1000)
        return {
            "exit_code": proc.returncode,
            "stdout": stdout_bytes.decode("utf-8", errors="replace"),
            "stderr": stderr_bytes.decode("utf-8", errors="replace"),
            "execution_time_ms": duration_ms
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if 'tmp_path' in locals() and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except Exception:
                pass

@app.post("/exec/shell")
async def exec_shell(req: ShellExecRequest):
    start_t = time.time()
    try:
        proc = await asyncio.create_subprocess_shell(
            req.command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE
        )

        try:
            stdout_bytes, stderr_bytes = await asyncio.wait_for(proc.communicate(), timeout=req.timeout)
        except asyncio.TimeoutError:
            try:
                proc.kill()
            except Exception:
                pass
            raise HTTPException(status_code=408, detail=f"Shell command execution timed out after {req.timeout}s")

        duration_ms = int((time.time() - start_t) * 1000)
        return {
            "exit_code": proc.returncode,
            "stdout": stdout_bytes.decode("utf-8", errors="replace"),
            "stderr": stderr_bytes.decode("utf-8", errors="replace"),
            "execution_time_ms": duration_ms
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/proxy/request")
@app.post("/proxy/request/")
async def proxy_request(req: ProxyForwardRequest):
    start_t = time.time()
    headers = dict(req.headers) if req.headers else {}
    if "user-agent" not in {k.lower() for k in headers}:
        headers["User-Agent"] = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

    async with httpx.AsyncClient(timeout=req.timeout, follow_redirects=True) as client:
        try:
            resp = await client.request(
                method=req.method.upper(),
                url=req.url,
                headers=headers,
                content=req.body.encode("utf-8") if req.body else None
            )
            duration_ms = int((time.time() - start_t) * 1000)
            return {
                "status_code": resp.status_code,
                "headers": dict(resp.headers),
                "body": resp.text,
                "execution_time_ms": duration_ms
            }
        except httpx.TimeoutException:
            raise HTTPException(status_code=504, detail=f"Proxy target {req.url} timed out after {req.timeout}s")
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Proxy error fetching {req.url}: {str(e)}")

_chunk_client: Optional[httpx.AsyncClient] = None

def get_chunk_client() -> httpx.AsyncClient:
    global _chunk_client
    if _chunk_client is None or _chunk_client.is_closed:
        limits = httpx.Limits(max_connections=200, max_keepalive_connections=100, keepalive_expiry=120.0)
        timeout = httpx.Timeout(120.0, connect=10.0, read=60.0)
        _chunk_client = httpx.AsyncClient(limits=limits, timeout=timeout, follow_redirects=True)
    return _chunk_client

@app.get("/worker/chunk")
async def worker_chunk(url: str, start: int, end: int, request: Request):
    """
    Streams a single byte-range slice [start, end] for the Distributed Downloader Coordinator.
    Uses persistent HTTP keep-alive connection pooling for maximum throughput.
    """
    if WORKER_API_SECRET:
        secret = request.headers.get("x-worker-secret") or request.query_params.get("secret")
        auth = request.headers.get("authorization")
        if secret != WORKER_API_SECRET and auth != f"Bearer {WORKER_API_SECRET}":
            raise HTTPException(status_code=401, detail="Unauthorized worker request")

    headers = {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Range": f"bytes={start}-{end}",
    }

    client = get_chunk_client()
    try:
        req = client.build_request("GET", url, headers=headers)
        resp = await client.send(req, stream=True)

        expected_bytes = end - start + 1

        # If server returns 200 OK instead of 206 Partial Content:
        # If start > 0, the server ignored Range and sent the file from byte 0. Reject immediately.
        if resp.status_code == 200 and start > 0:
            await resp.aclose()
            raise HTTPException(status_code=416, detail="Upstream server does not support byte ranges (returned 200 OK)")

        if resp.status_code not in (200, 206):
            await resp.aclose()
            raise HTTPException(status_code=resp.status_code, detail=f"Target returned HTTP {resp.status_code}")

        async def stream_generator():
            bytes_sent = 0
            try:
                async for data in resp.aiter_bytes(chunk_size=256 * 1024):
                    if bytes_sent + len(data) > expected_bytes:
                        remaining = expected_bytes - bytes_sent
                        if remaining > 0:
                            yield data[:remaining]
                            bytes_sent += remaining
                        break
                    yield data
                    bytes_sent += len(data)
                    if bytes_sent >= expected_bytes:
                        break
            finally:
                await resp.aclose()

        response_headers = {
            "Content-Type": "application/octet-stream",
            "Content-Length": str(expected_bytes),
            "Accept-Ranges": "bytes",
        }
        return StreamingResponse(stream_generator(), status_code=200, headers=response_headers)
    except Exception as e:
        if isinstance(e, HTTPException):
            raise e
        raise HTTPException(status_code=502, detail=f"Failed to stream chunk: {str(e)}")

@app.get("/logs")
def get_logs():
    try:
        log_path = "/tmp/worker_api.log"
        if os.path.exists(log_path):
            with open(log_path, "r", encoding="utf-8") as f:
                # return last 100 lines or full logs
                lines = f.readlines()
                return {"logs": "".join(lines[-200:])}
        return {"logs": "Log file not found"}
    except Exception as e:
        return {"logs": f"Error reading log: {str(e)}"}

@app.get("/health")
def health():
    return {"status": "ok"}

# ---------------------------------------------------------------------------
# Direct Google Drive Streaming Uploader Endpoints (Option A - Real-time SSE/NDJSON)
# ---------------------------------------------------------------------------
try:
    from fastapi.responses import StreamingResponse
    from drive_uploader import stream_upload_to_drive

    class DirectDriveUploadRequest(BaseModel):
        url: str
        fileName: str
        folderId: str
        accessToken: str
        encryptionKey: Optional[str] = None
        chunkSizeMB: Optional[int] = 16

    @app.post("/drive/upload/stream")
    def drive_upload_stream(req: DirectDriveUploadRequest):
        def event_generator():
            chunk_size = (req.chunkSizeMB or 16) * 1024 * 1024
            for event in stream_upload_to_drive(
                source_url=req.url,
                file_name=req.fileName,
                folder_id=req.folderId,
                access_token=req.accessToken,
                encryption_key_hex=req.encryptionKey,
                chunk_size=chunk_size
            ):
                yield json.dumps(event) + "\n"

        return StreamingResponse(event_generator(), media_type="application/x-ndjson")

    @app.post("/drive/upload/direct")
    def drive_upload_direct(req: DirectDriveUploadRequest):
        try:
            chunk_size = (req.chunkSizeMB or 16) * 1024 * 1024
            last_event = None
            for event in stream_upload_to_drive(
                source_url=req.url,
                file_name=req.fileName,
                folder_id=req.folderId,
                access_token=req.accessToken,
                encryption_key_hex=req.encryptionKey,
                chunk_size=chunk_size
            ):
                last_event = event
                if event.get("status") == "error":
                    raise HTTPException(status_code=500, detail=event.get("error"))
            return last_event or {"status": "unknown"}
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

except Exception as e:
    print(f"[*] Direct Drive uploader initialization error: {e}")


def get_vscode_state() -> Dict[str, Optional[str]]:
    """
    Retrieves dynamically generated Web VS Code tunnel URL and session password.
    Reads from /tmp/vscode-info.json (written by browser-worker runner), /tmp/vscode_url / /tmp/vscode_password,
    or falls back to environment variables.
    """
    url = os.getenv("VSCODE_URL")
    password = os.getenv("VSCODE_PASSWORD")

    # 1. Try reading from shared state file written dynamically by runner script
    info_file = "/tmp/vscode-info.json"
    if os.path.exists(info_file):
        try:
            with open(info_file, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict):
                    url = data.get("url") or url
                    password = data.get("password") or password
        except Exception:
            pass

    # 2. Try discrete temp files if present
    if not url and os.path.exists("/tmp/vscode_url"):
        try:
            with open("/tmp/vscode_url", "r", encoding="utf-8") as f:
                val = f.read().strip()
                if val:
                    url = val
        except Exception:
            pass

    if not password and os.path.exists("/tmp/vscode_password"):
        try:
            with open("/tmp/vscode_password", "r", encoding="utf-8") as f:
                val = f.read().strip()
                if val:
                    password = val
        except Exception:
            pass

    return {
        "url": url,
        "password": password
    }


def get_ssh_state() -> Dict[str, Any]:
    """
    Retrieves dynamically configured OpenSSH daemon connection parameters.
    Reads from /tmp/ssh-info.json (or /tmp/ssh_info.json) written by browser-worker runner,
    discrete temp files, or environment variables.
    """
    port = int(os.getenv("SSH_PORT", "2222"))
    user = os.getenv("SSH_USER", os.getenv("USER", "runner"))
    password = os.getenv("SSH_PASSWORD")
    url = os.getenv("SSH_URL")
    command = os.getenv("SSH_COMMAND")

    for info_file in ("/tmp/ssh-info.json", "/tmp/ssh_info.json"):
        if os.path.exists(info_file):
            try:
                with open(info_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    if isinstance(data, dict):
                        if data.get("port"):
                            port = int(data["port"])
                        user = data.get("user") or user
                        password = data.get("password") or password
                        url = data.get("url") or url
                        command = data.get("command") or command
                        break
            except Exception:
                pass

    if not password and os.path.exists("/tmp/ssh_password"):
        try:
            with open("/tmp/ssh_password", "r", encoding="utf-8") as f:
                val = f.read().strip()
                if val:
                    password = val
        except Exception:
            pass

    if not url and os.path.exists("/tmp/ssh_url"):
        try:
            with open("/tmp/ssh_url", "r", encoding="utf-8") as f:
                val = f.read().strip()
                if val:
                    url = val
        except Exception:
            pass

    if not command:
        if url:
            clean_host = url.replace("tcp://", "").replace("https://", "").replace("http://", "").rstrip("/")
            if ":" in clean_host:
                h_parts = clean_host.split(":")
                command = f"ssh -p {h_parts[1]} {user}@{h_parts[0]}"
            else:
                command = f"ssh -p {port} {user}@{clean_host}"
        else:
            command = f"ssh -p {port} {user}@localhost"

    return {
        "port": port,
        "user": user,
        "password": password,
        "url": url,
        "command": command
    }


def check_antigravity_token_configured() -> bool:
    """Checks if Antigravity CLI OAuth token is configured on the worker filesystem."""
    candidates = [
        os.path.expanduser("~/.gemini/antigravity-cli/antigravity-oauth-token"),
        "/home/runner/.gemini/antigravity-cli/antigravity-oauth-token",
        "/root/.gemini/antigravity-cli/antigravity-oauth-token",
    ]
    for path in candidates:
        if os.path.exists(path) and os.path.getsize(path) > 0:
            return True
    return bool(os.environ.get("ANTIGRAVITY_CLI_OAUTH_JSON"))


def ensure_antigravity_auth_from_env():
    """
    Reads ANTIGRAVITY_CLI_OAUTH_JSON from os.environ or .env (without hardcoding)
    and ensures ~/.gemini/antigravity-cli/antigravity-oauth-token is created.
    """
    auth_json = os.environ.get("ANTIGRAVITY_CLI_OAUTH_JSON")
    if not auth_json and os.path.exists(".env"):
        try:
            with open(".env", "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("ANTIGRAVITY_CLI_OAUTH_JSON="):
                        val = line.split("=", 1)[1].strip().strip("'\"")
                        if val:
                            auth_json = val
                            os.environ["ANTIGRAVITY_CLI_OAUTH_JSON"] = val
                            break
        except Exception:
            pass

    if auth_json:
        target_homes = [os.path.expanduser("~")]
        if os.path.isdir("/home/runner") and "/home/runner" not in target_homes:
            target_homes.append("/home/runner")
        if os.path.isdir("/root") and "/root" not in target_homes:
            target_homes.append("/root")

        for h in target_homes:
            agy_dir = os.path.join(h, ".gemini", "antigravity-cli")
            token_path = os.path.join(agy_dir, "antigravity-oauth-token")
            try:
                os.makedirs(agy_dir, exist_ok=True)
                if not os.path.exists(token_path) or os.path.getsize(token_path) == 0:
                    with open(token_path, "w", encoding="utf-8") as f:
                        f.write(auth_json)
                    try:
                        os.chmod(token_path, 0o600)
                    except Exception:
                        pass
            except Exception:
                pass


# Initialize token from environment/.env on module load
ensure_antigravity_auth_from_env()



# ---------------------------------------------------------------------------
# Distributed Course Worker & Central Hub Protocol Endpoints
# ---------------------------------------------------------------------------

@app.get("/worker/status")
def worker_status(request: Request):
    """
    Worker Health, SSH & Disk Metric (ENOSPC prevention)
    Returns worker ID, status ('idle' | 'busy'), disk metrics, concurrency limit,
    active jobs count, SSH credentials, and live shell WebSocket URL.
    """
    disk = get_disk_metrics()
    active_job_ids = course_manager.get_active_job_ids()
    vsc_info = get_vscode_state()
    ssh_info = get_ssh_state()
    is_agy = shutil.which("agy") is not None
    has_agy_auth = check_antigravity_token_configured()
    public_url = WORKER_PUBLIC_URL or str(request.base_url).rstrip("/")
    ws_base = public_url.replace("https://", "wss://").replace("http://", "ws://")

    return {
        "workerId": WORKER_ID,
        "status": course_manager.get_status(),
        "disk": disk,
        "concurrencyLimit": DEFAULT_CONCURRENCY,
        "activeJobsCount": len(active_job_ids),
        "activeJob": active_job_ids[0] if active_job_ids else None,
        "activeJobId": active_job_ids[0] if active_job_ids else None,
        "activeJobIds": active_job_ids,
        "vscodeUrl": vsc_info["url"],
        "vscodePassword": vsc_info["password"],
        "antigravityCli": is_agy,
        "antigravityAuth": has_agy_auth,
        "courseWorkerUrl": os.getenv("COURSE_WORKER_URL", "http://127.0.0.1:8085"),
        "shellWsUrl": f"{ws_base}/ws/shell",
        "ssh": ssh_info,
        "sshPort": ssh_info["port"],
        "sshUser": ssh_info["user"],
        "sshPassword": ssh_info["password"],
        "sshUrl": ssh_info["url"],
        "sshCommand": ssh_info["command"],
    }


@app.get("/api/agents/status")
def get_agents_status():
    """
    Discover AI, automation, and developer agents active on this worker node.
    Reports Antigravity CLI (agy), Course Worker, VS Code, and runtime environments.
    """
    agy_path = shutil.which("agy")
    code_server_path = shutil.which("code-server")
    cw_path = shutil.which("course-worker") or (os.path.exists("./bin/course-worker") and "./bin/course-worker")
    dlengine_path = shutil.which("dlengine") or (os.path.exists("/usr/local/bin/dlengine") and "/usr/local/bin/dlengine")
    python_bin = sys.executable
    node_path = shutil.which("node")

    disk = get_disk_metrics()
    vsc_info = get_vscode_state()
    ssh_info = get_ssh_state()

    # Query agy version if present
    agy_version = None
    if agy_path:
        try:
            res = subprocess.run([agy_path, "--version"], capture_output=True, text=True, timeout=3)
            agy_version = res.stdout.strip() or res.stderr.strip() or "Installed"
        except Exception:
            agy_version = "Installed"

    return {
        "workerId": WORKER_ID,
        "status": course_manager.get_status(),
        "agents": {
            "antigravityCli": {
                "available": agy_path is not None,
                "path": agy_path,
                "version": agy_version,
                "authenticated": check_antigravity_token_configured(),
                "description": "Google Antigravity CLI Agent (agy) for autonomous tasks"
            },
            "courseWorker": {
                "available": bool(cw_path),
                "url": os.getenv("COURSE_WORKER_URL", "http://127.0.0.1:8085"),
                "description": "Go Multi-Part Course Archive Streamer & Drive Engine"
            },
            "codeServer": {
                "available": code_server_path is not None,
                "url": vsc_info["url"],
                "description": "Web VS Code IDE & Cloud Workspace"
            },
            "dlengine": {
                "available": bool(dlengine_path),
                "path": dlengine_path,
                "description": "High-speed Multi-connection Go Download Engine"
            },
            "puppeteerCdp": {
                "available": True,
                "port": 9222,
                "description": "Headless Chromium Remote Debugging Port"
            },
            "seleniumCdp": {
                "available": True,
                "port": 9223,
                "description": "SeleniumBase UC Stealth Browser CDP Port"
            }
        },
        "runtimes": {
            "python": {
                "version": sys.version.split()[0],
                "executable": python_bin
            },
            "node": {
                "available": node_path is not None,
                "path": node_path
            }
        },
        "ssh": ssh_info,
        "system": {
            "platform": sys.platform,
            "cpuPercent": get_cpu_percent(),
            "freeDiskGB": disk["freeGB"],
            "totalDiskGB": disk["totalGB"],
            "hasPty": HAS_PTY
        }
    }


# ---------------------------------------------------------------------------
# Persistent Background PTY Shell Sessions (Runs continuously in background)
# ---------------------------------------------------------------------------

def build_shell_env() -> dict:
    """Prepares enriched execution environment for persistent shells."""
    ensure_antigravity_auth_from_env()
    env = os.environ.copy()
    env["TERM"] = "xterm-256color"
    env["COLORTERM"] = "truecolor"
    env["LANG"] = "en_US.UTF-8"

    extra_paths = [
        os.path.expanduser("~/.local/bin"),
        os.path.expanduser("~/.antigravity/bin"),
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        os.path.abspath("./bin"),
        os.getcwd(),
    ]
    curr_path = env.get("PATH", "")
    for p in extra_paths:
        if p and p not in curr_path and os.path.exists(p):
            curr_path = f"{p}:{curr_path}"
    env["PATH"] = curr_path
    return env


class PersistentShellSession:
    """
    A persistent interactive shell session running independently in the background.
    Survives frontend tab closures, page refreshes, and network drops.
    Maintains a circular scrollback ring buffer so reconnecting clients immediately
    see everything printed while disconnected.
    """
    def __init__(self, session_id: str, env: dict):
        self.session_id = session_id
        self.env = env
        self.proc: Optional[Any] = None
        self.master_fd: Optional[int] = None
        self.scrollback: deque = deque(maxlen=15000)
        self.active_clients: Set[WebSocket] = set()
        self.created_at: float = time.time()
        self.last_activity: float = time.time()
        self.reader_task: Optional[asyncio.Task] = None
        self.stop_event: asyncio.Event = asyncio.Event()
        self.is_windows: bool = not HAS_PTY
        self.win_proc: Optional[asyncio.subprocess.Process] = None

    def is_alive(self) -> bool:
        if self.is_windows:
            return self.win_proc is not None and self.win_proc.returncode is None
        return self.proc is not None and self.proc.poll() is None

    @property
    def pid(self) -> Optional[int]:
        if self.is_windows:
            return self.win_proc.pid if self.win_proc else None
        return self.proc.pid if self.proc else None

    async def start(self):
        if self.is_alive():
            return

        is_agy = shutil.which("agy") is not None
        has_token = check_antigravity_token_configured()
        agy_badge = "⚡ READY (Auth)" if is_agy and has_token else ("⚡ READY" if is_agy else "offline")

        if HAS_PTY:
            master_fd, slave_fd = pty.openpty()
            flags = fcntl.fcntl(master_fd, fcntl.F_GETFL)
            fcntl.fcntl(master_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)
            self.master_fd = master_fd

            shell_bin = "/bin/bash" if os.path.exists("/bin/bash") else "/bin/sh"
            self.proc = subprocess.Popen(
                [shell_bin, "-l"],
                preexec_fn=os.setsid,
                stdin=slave_fd,
                stdout=slave_fd,
                stderr=slave_fd,
                close_fds=True,
                env=self.env,
                cwd=os.getcwd()
            )
            os.close(slave_fd)

            banner = (
                f"\r\n\x1b[1;36m======================================================================\x1b[0m\r\n"
                f"\x1b[1;32m  🟢 Persistent Background Worker Shell: {WORKER_ID} [Session: {self.session_id}]\x1b[0m\r\n"
                f"\x1b[0;37m  Directory: {os.getcwd()} | PID: {self.proc.pid}\x1b[0m\r\n"
                f"\x1b[1;34m  Agents: Antigravity CLI ({agy_badge}), Course Worker (:8085), CDP (:9222/:9223)\x1b[0m\r\n"
                f"\x1b[0;33m  ⚡ Note: Background persistent session active. Closing browser page will NOT stop your tasks!\x1b[0m\r\n"
                f"\x1b[1;36m======================================================================\x1b[0m\r\n\r\n"
            )
            self.scrollback.append(banner)

            loop = asyncio.get_running_loop()

            async def pty_reader():
                while not self.stop_event.is_set() and self.proc.poll() is None:
                    try:
                        data = await loop.run_in_executor(None, os.read, self.master_fd, 4096)
                        if not data:
                            break
                        chunk = data.decode("utf-8", errors="replace")
                        self.scrollback.append(chunk)
                        self.last_activity = time.time()

                        dead_clients = []
                        for ws in list(self.active_clients):
                            try:
                                await ws.send_text(chunk)
                            except Exception:
                                dead_clients.append(ws)
                        for ws in dead_clients:
                            self.active_clients.discard(ws)
                    except (BlockingIOError, InterruptedError):
                        await asyncio.sleep(0.01)
                    except OSError as e:
                        if e.errno in (5, 9):  # EIO or EBADF when child shell exits
                            break
                        await asyncio.sleep(0.01)
                    except Exception:
                        break

            self.reader_task = asyncio.create_task(pty_reader())

        else:
            # Windows fallback
            shell_cmd = "powershell.exe" if shutil.which("powershell.exe") else "cmd.exe"
            self.win_proc = await asyncio.create_subprocess_exec(
                shell_cmd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=self.env,
                cwd=os.getcwd()
            )
            banner = (
                f"\r\n\x1b[1;36m======================================================================\x1b[0m\r\n"
                f"\x1b[1;32m  🟢 Persistent Worker Shell (Windows Emulation): {WORKER_ID} [Session: {self.session_id}]\x1b[0m\r\n"
                f"\x1b[0;33m  ⚡ Note: Background persistent session active. Closing browser page will NOT stop your tasks!\x1b[0m\r\n"
                f"\x1b[1;36m======================================================================\x1b[0m\r\n\r\n"
            )
            self.scrollback.append(banner)

            async def win_reader(stream):
                while True:
                    try:
                        data = await stream.read(1024)
                        if not data:
                            break
                        chunk = data.decode("utf-8", errors="replace")
                        self.scrollback.append(chunk)
                        self.last_activity = time.time()
                        dead_clients = []
                        for ws in list(self.active_clients):
                            try:
                                await ws.send_text(chunk)
                            except Exception:
                                dead_clients.append(ws)
                        for ws in dead_clients:
                            self.active_clients.discard(ws)
                    except Exception:
                        break

            asyncio.create_task(win_reader(self.win_proc.stdout))
            asyncio.create_task(win_reader(self.win_proc.stderr))

    async def attach(self, websocket: WebSocket):
        self.active_clients.add(websocket)
        self.last_activity = time.time()
        # Replay scrollback buffer so reconnected client sees prior output
        if self.scrollback:
            full_history = "".join(self.scrollback)
            try:
                await websocket.send_text(full_history)
            except Exception:
                pass

    def detach(self, websocket: WebSocket):
        self.active_clients.discard(websocket)
        # Process and reader task keep running uninterrupted in background!

    async def write(self, data: str | bytes):
        self.last_activity = time.time()
        if HAS_PTY and self.master_fd is not None:
            raw = data.encode("utf-8") if isinstance(data, str) else data
            try:
                os.write(self.master_fd, raw)
            except Exception:
                pass
        elif self.win_proc and self.win_proc.stdin:
            raw = data.encode("utf-8") if isinstance(data, str) else data
            try:
                self.win_proc.stdin.write(raw)
                await self.win_proc.stdin.drain()
            except Exception:
                pass

    def resize(self, cols: int, rows: int):
        if HAS_PTY and self.master_fd is not None:
            try:
                fcntl.ioctl(self.master_fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
            except Exception:
                pass

    async def kill(self):
        self.stop_event.set()
        if self.reader_task:
            self.reader_task.cancel()
        if HAS_PTY and self.proc:
            try:
                if self.proc.poll() is None:
                    os.killpg(os.getpgid(self.proc.pid), signal.SIGTERM)
                    await asyncio.sleep(0.1)
                    if self.proc.poll() is None:
                        os.killpg(os.getpgid(self.proc.pid), signal.SIGKILL)
            except Exception:
                pass
            try:
                if self.master_fd is not None:
                    os.close(self.master_fd)
            except Exception:
                pass
        elif self.win_proc:
            try:
                self.win_proc.kill()
            except Exception:
                pass


class WorkerSessionManager:
    """Manages persistent background shell sessions on the worker node."""
    def __init__(self):
        self.sessions: Dict[str, PersistentShellSession] = {}

    async def get_or_create(self, session_id: str = "default", env: Optional[dict] = None) -> PersistentShellSession:
        if session_id in self.sessions:
            sess = self.sessions[session_id]
            if sess.is_alive():
                return sess
            await sess.kill()
            del self.sessions[session_id]

        if env is None:
            env = build_shell_env()

        new_sess = PersistentShellSession(session_id, env)
        await new_sess.start()
        self.sessions[session_id] = new_sess
        return new_sess

    def list_sessions(self) -> List[Dict[str, Any]]:
        result = []
        now = time.time()
        for sid, sess in list(self.sessions.items()):
            result.append({
                "sessionId": sid,
                "pid": sess.pid,
                "alive": sess.is_alive(),
                "attachedClients": len(sess.active_clients),
                "uptimeSeconds": round(now - sess.created_at, 1),
                "idleSeconds": round(now - sess.last_activity, 1),
                "scrollbackLength": len(sess.scrollback),
            })
        return result

    async def kill_session(self, session_id: str) -> bool:
        if session_id in self.sessions:
            sess = self.sessions[session_id]
            await sess.kill()
            del self.sessions[session_id]
            return True
        return False


session_manager = WorkerSessionManager()


@app.websocket("/ws/shell")
@app.websocket("/ws/ssh")
async def websocket_shell_endpoint(websocket: WebSocket):
    """
    Live interactive pseudo-terminal (PTY) shell accessible via WebSocket.
    Runs persistently in the background: if client closes tab, session remains active.
    """
    token = websocket.query_params.get("token") or websocket.query_params.get("secret")
    if WORKER_API_SECRET and token and token != WORKER_API_SECRET:
        await websocket.close(code=1008, reason="Unauthorized")
        return

    await websocket.accept()

    session_id = websocket.query_params.get("sessionId") or "default"
    session = await session_manager.get_or_create(session_id)
    await session.attach(websocket)

    try:
        while session.is_alive():
            msg = await websocket.receive()
            if msg["type"] == "websocket.disconnect":
                break

            text_data = msg.get("text")
            bytes_data = msg.get("bytes")

            if text_data is not None:
                if text_data.startswith("{") and "resize" in text_data:
                    try:
                        ctrl = json.loads(text_data)
                        if ctrl.get("type") == "resize":
                            cols = int(ctrl.get("cols", 80))
                            rows = int(ctrl.get("rows", 24))
                            session.resize(cols, rows)
                            continue
                    except Exception:
                        pass
                await session.write(text_data)
            elif bytes_data is not None:
                await session.write(bytes_data)
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        # Detach websocket only — background process keeps executing!
        session.detach(websocket)


@app.get("/api/shell/sessions")
def list_active_shell_sessions():
    """List persistent background shell sessions."""
    return {
        "workerId": WORKER_ID,
        "sessions": session_manager.list_sessions()
    }


@app.post("/api/shell/sessions/{session_id}/kill")
async def kill_active_shell_session(session_id: str):
    """Explicitly terminate a background shell session."""
    killed = await session_manager.kill_session(session_id)
    return {"sessionId": session_id, "killed": killed}


@app.post("/api/shell/sessions/{session_id}/exec")
async def exec_in_shell_session(session_id: str, req: Request):
    """Inject a command into a persistent background shell session."""
    body = await req.json()
    command = body.get("command", "")
    if not command:
        raise HTTPException(status_code=400, detail="Command is required")
    sess = await session_manager.get_or_create(session_id)
    await sess.write(command.rstrip("\r\n") + "\n")
    return {"status": "dispatched", "sessionId": session_id, "command": command}



@app.post("/worker/jobs", status_code=202)
async def dispatch_course_job(req: CourseJobRequest, request: Request):
    """
    Dispatch Course Download & Extraction Job to this isolated worker node.
    Accepts job and runs in isolated directory; Hub controls concurrency and limits.
    """
    if WORKER_API_SECRET:
        auth_header = request.headers.get("authorization", "")
        secret_header = request.headers.get("x-worker-secret", "")
        if auth_header != f"Bearer {WORKER_API_SECRET}" and secret_header != WORKER_API_SECRET:
            raise HTTPException(status_code=401, detail="Unauthorized")

    try:
        active_cnt = len(course_manager.active_jobs)
        if active_cnt >= DEFAULT_CONCURRENCY:
            return JSONResponse(
                status_code=429,
                content={
                    "error": f"Worker concurrency limit reached ({active_cnt}/{DEFAULT_CONCURRENCY}).",
                    "activeJobs": course_manager.get_active_job_ids()
                }
            )

        job_id = await course_manager.start_job(req)
        return JSONResponse(
            status_code=202,
            content={
                "jobId": job_id,
                "status": "accepted",
                "activeJobsCount": len(course_manager.active_jobs),
                "message": f"Job accepted. Running {len(course_manager.active_jobs)} concurrent jobs on worker."
            }
        )
    except RuntimeError as e:
        return JSONResponse(
            status_code=400,
            content={"error": str(e)}
        )


@app.post("/worker/jobs/{job_id}/cancel")
async def cancel_course_job(job_id: str, request: Request):
    """
    Cancel & Force Purge Worker Job.
    Terminates ongoing operations, recursively wipes job directories, and marks worker idle.
    """
    if WORKER_API_SECRET:
        auth_header = request.headers.get("authorization", "")
        secret_header = request.headers.get("x-worker-secret", "")
        if auth_header != f"Bearer {WORKER_API_SECRET}" and secret_header != WORKER_API_SECRET:
            raise HTTPException(status_code=401, detail="Unauthorized")

    purged = await course_manager.cancel_job(job_id)
    return {
        "success": True,
        "jobId": job_id,
        "status": "cancelled",
        "diskPurged": purged,
    }


@app.get("/api/workers/pool")
def get_worker_pool(request: Request):
    """
    Central Worker Pool Discovery Endpoint.
    Returns array of available workers with status, free disk, and heartbeat.
    Supplies both 'workers' and 'browsers' keys for full backward/forward compatibility.
    """
    disk = get_disk_metrics()
    public_url = WORKER_PUBLIC_URL or str(request.base_url).rstrip("/")
    active_job_id = course_manager.get_active_job_id()
    status_val = course_manager.get_status()
    vsc_info = get_vscode_state()
    ssh_info = get_ssh_state()
    is_agy = shutil.which("agy") is not None
    ws_base = public_url.replace("https://", "wss://").replace("http://", "ws://")

    worker_entry = {
        "id": WORKER_ID,
        "url": public_url,
        "status": status_val,
        "freeDiskGB": disk["freeGB"],
        "cpuPercent": get_cpu_percent(),
        "activeJobId": active_job_id,
        "vscodeUrl": vsc_info["url"],
        "vscodePassword": vsc_info["password"],
        "antigravityCli": is_agy,
        "shellWsUrl": f"{ws_base}/ws/shell",
        "ssh": ssh_info,
        "sshPort": ssh_info["port"],
        "sshUser": ssh_info["user"],
        "sshPassword": ssh_info["password"],
        "sshUrl": ssh_info["url"],
        "sshCommand": ssh_info["command"],
        "lastHeartbeat": datetime.now(timezone.utc).isoformat(),
    }

    browser_entry = {
        "workerId": WORKER_ID,
        "apiUrl": public_url,
        "status": "active" if status_val in ("idle", "busy") else "offline",
        "freeDiskGB": disk["freeGB"],
        "cpuPercent": get_cpu_percent(),
        "activeJobId": active_job_id,
        "vscodeUrl": vsc_info["url"],
        "vscodePassword": vsc_info["password"],
        "antigravityCli": is_agy,
        "shellWsUrl": f"{ws_base}/ws/shell",
        "ssh": ssh_info,
        "sshPort": ssh_info["port"],
        "sshUser": ssh_info["user"],
        "sshPassword": ssh_info["password"],
        "sshUrl": ssh_info["url"],
        "sshCommand": ssh_info["command"],
        "lastHeartbeat": datetime.now(timezone.utc).isoformat(),
    }

    return {
        "success": True,
        "workers": [worker_entry],
        "browsers": [browser_entry],
    }


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
