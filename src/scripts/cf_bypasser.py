# DEPRECATED DON'T USE
from fastapi import FastAPI, HTTPException, File, UploadFile, Response
from pydantic import BaseModel
from seleniumbase import SB
import uvicorn
import re
import sys
import threading
import io
import tempfile
import os

app = FastAPI()

# Lazy load model references
whisper_model = None
reader = None

def get_whisper_model():
    global whisper_model
    if whisper_model is None:
        print("Loading Whisper tiny model...")
        import whisper
        whisper_model = whisper.load_model("tiny")
    return whisper_model

def get_reader():
    global reader
    if reader is None:
        print("Loading EasyOCR reader...")
        import easyocr
        reader = easyocr.Reader(['en']) # Add more languages if needed
    return reader

class FetchRequest(BaseModel):
    url: str

class ScreenshotRequest(BaseModel):
    url: str
    full_page: bool = False
    format: str = "png"

@app.post("/get_prorcp")
def get_prorcp(req: FetchRequest):
    try:
        # Using uc (Undetected Chromedriver) with headless=False so it appears on VNC display
        with SB(uc=True, headless=False) as sb:
            sb.uc_open_with_reconnect(req.url, 5)
            
            try:
                sb.uc_gui_click_captcha()
            except Exception:
                pass

            # Loop up to 30 times (120 seconds) to give user time to click Cloudflare captcha via VNC
            for i in range(30):
                sb.sleep(4)
                source = sb.get_page_source()
                
                # 1. Regex check
                match = re.search(r'[\'"](\/?prorcp\/[^\'"]+)[\'"]', source)
                if match:
                    path = match.group(1)
                    full = f"https://cloudnestra.com{path}" if path.startswith('/') else path
                    return {"url": full}
                
                # 2. Iframe check
                iframes = sb.find_elements("iframe")
                for iframe in iframes:
                    src = iframe.get_attribute("src")
                    if src and "/prorcp/" in src:
                        full = f"https://cloudnestra.com{src}" if src.startswith('/') else src
                        return {"url": full}
                        
            sb.save_screenshot("cf_screenshot.png")
            raise HTTPException(status_code=400, detail="Could not find /prorcp/")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/get_html")
def get_html(req: FetchRequest):
    try:
        with SB(uc=True, headless=False) as sb:
            sb.uc_open_with_reconnect(req.url, 5)
            try:
                sb.uc_gui_click_captcha()
            except Exception:
                pass
            sb.sleep(6)
            source = sb.get_page_source()
            return {"html": source}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/remove_bg")
async def remove_bg(file: UploadFile = File(...)):
    try:
        from rembg import remove
        input_image = await file.read()
        output_image = remove(input_image)
        return Response(content=output_image, media_type="image/png")
    except Exception as e:
        print(f"Error removing background: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/ocr")
async def ocr_image(file: UploadFile = File(...)):
    try:
        content = await file.read()
        results = get_reader().readtext(content)
        text = " ".join([res[1] for res in results])
        return {"text": text}
    except Exception as e:
        print(f"OCR Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/transcribe")
async def transcribe_audio(file: UploadFile = File(...)):
    try:
        # Whisper requires a file on disk
        with tempfile.NamedTemporaryFile(delete=False, suffix=".ogg") as tmp:
            content = await file.read()
            tmp.write(content)
            tmp_path = tmp.name

        try:
            result = get_whisper_model().transcribe(tmp_path)
            return {"text": result["text"]}
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
    except Exception as e:
        print(f"Transcription Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/screenshot")
async def take_screenshot(req: ScreenshotRequest):
    try:
        with SB(uc=True, headless=False) as sb:
            sb.uc_open_with_reconnect(req.url, 5)
            try:
                sb.uc_gui_click_captcha()
            except Exception:
                pass
            sb.sleep(5) # Wait for page to load
            
            sb.execute_script("document.body.style.overflow = 'hidden';")
            
            if req.full_page:
                width = sb.execute_script("return Math.max(document.body.scrollWidth, document.body.offsetWidth, document.documentElement.clientWidth, document.documentElement.scrollWidth, document.documentElement.offsetWidth);")
                height = sb.execute_script("return Math.max(document.body.scrollHeight, document.body.offsetHeight, document.documentElement.clientHeight, document.documentElement.scrollHeight, document.documentElement.offsetHeight);")
                sb.set_window_size(width, height)
                sb.sleep(1)

            import base64
            
            if req.format.lower() == "pdf":
                pdf_data = sb.driver.execute_cdp_cmd("Page.printToPDF", {
                    "printBackground": True,
                    "marginTop": 0,
                    "marginBottom": 0,
                    "marginLeft": 0,
                    "marginRight": 0,
                })
                content = base64.b64decode(pdf_data['data'])
                return Response(content=content, media_type="application/pdf")
            else:
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
        print(f"Screenshot Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

class SearchRequest(BaseModel):
    text: str
    pageNumber: int = 1

@app.post("/search")
def google_search(req: SearchRequest):
    try:
        with SB(uc=True, headless=False) as sb:
            start = (req.pageNumber - 1) * 10
            sb.uc_open_with_reconnect(
                f"https://www.google.com/search?q={req.text}&start={start}", 5
            )
            # Wait dynamically up to 4.0s (checking every 200ms) for page elements to load
            for _ in range(20):
                if (sb.is_element_visible("#search") or 
                    sb.is_element_visible(".g") or 
                    sb.is_element_visible("h3") or 
                    sb.is_element_visible("form[action*='/sorry/']") or 
                    sb.is_element_visible("#captcha") or 
                    sb.is_element_visible(".g-recaptcha")):
                    break
                sb.sleep(0.2)

            # Click "Show more" buttons to expand AI overview
            try:
                has_buttons = sb.execute_script("""
                    var btns = document.querySelectorAll('[jsname="VwDHjd"], [aria-label="Show more"], .LGOjhe, .cUnQKe');
                    if (btns.length > 0) {
                        btns.forEach(function(b) { b.click(); });
                        return true;
                    }
                    return false;
                """)
                if has_buttons:
                    sb.sleep(1.0)
            except Exception:
                pass

            # Use JS to extract results — much more reliable than Selenium selectors
            results = sb.execute_script("""
                var organic = [];
                var aiResponse = null;

                // AI Overview / SGE — return innerHTML for rich rendering
                var aiSelectors = ['.M8OgIe', '.LLtROe', '.IZ6rdc', '[data-attrid="wa:/description"]', '.wDYxhc[data-md]', '.kp-blk'];
                for (var i = 0; i < aiSelectors.length; i++) {
                    var aiEl = document.querySelector(aiSelectors[i]);
                    if (aiEl && aiEl.innerText && aiEl.innerText.trim().length > 20) {
                        aiResponse = aiEl.innerHTML || aiEl.innerText.trim();
                        break;
                    }
                }

                // Organic results — try multiple container selectors
                var containers = document.querySelectorAll('#search .g, #rso .g, .MjjYud .g');
                var seen = new Set();
                containers.forEach(function(el) {
                    var h3 = el.querySelector('h3');
                    var a = el.querySelector('a[href^="http"]');
                    if (!h3 || !a) return;
                    var link = a.getAttribute('href') || '';
                    if (seen.has(link)) return;
                    seen.add(link);

                    var snippet = '';
                    var snipSelectors = ['.VwiC3b', '.lEBKkf', '.lyLwlc', '[data-sncf]', '.IsZvec'];
                    for (var j = 0; j < snipSelectors.length; j++) {
                        var s = el.querySelector(snipSelectors[j]);
                        if (s && s.innerText) { snippet = s.innerText.trim(); break; }
                    }

                    organic.push({
                        title: h3.innerText.trim(),
                        link: link,
                        snippet: snippet
                    });
                });

                // Fallback: if nothing found above, grab all h3+a combos on the page
                if (organic.length === 0) {
                    document.querySelectorAll('a[href^="http"]').forEach(function(a) {
                        var h3 = a.querySelector('h3');
                        if (!h3) return;
                        var link = a.getAttribute('href') || '';
                        if (link.includes('google.com')) return;
                        if (seen.has(link)) return;
                        seen.add(link);
                        organic.push({ title: h3.innerText.trim(), link: link, snippet: '' });
                    });
                }

                return { organic: organic, aiResponse: aiResponse };
            """)

            # If JS extraction returned nothing, log it
            if not results or (not results.get("organic") and not results.get("aiResponse")):
                print("Search parse returned empty results")

            return results or {"organic": [], "aiResponse": None}
    except Exception as e:
        print(f"Search Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

class ExtractHtmlRequest(BaseModel):
    html: str

@app.post("/extract_html")
def extract_html(req: ExtractHtmlRequest):
    html = req.html

    # Tier 1: trafilatura (lightweight, usually installed)
    try:
        import trafilatura
        content = trafilatura.extract(html, include_comments=False, include_tables=True)
        if content and content.strip():
            print("extract_html: used trafilatura")
            return {"content": content}
    except Exception as e1:
        print(f"extract_html: trafilatura failed ({e1}), trying html2text...")

    # Tier 2: html2text (markdown-style output)
    try:
        import html2text
        h = html2text.HTML2Text()
        h.ignore_links = True
        h.ignore_images = True
        content = h.handle(html).strip()
        if content:
            print("extract_html: used html2text")
            return {"content": content}
    except Exception as e2:
        print(f"extract_html: html2text failed ({e2}), falling back to regex strip...")

    # Tier 3: bare regex strip — always works, zero deps
    try:
        import re
        text = re.sub(r'<style[^>]*>.*?</style>', ' ', html, flags=re.DOTALL | re.IGNORECASE)
        text = re.sub(r'<script[^>]*>.*?</script>', ' ', text, flags=re.DOTALL | re.IGNORECASE)
        text = re.sub(r'<[^>]+>', ' ', text)
        text = re.sub(r'&nbsp;', ' ', text)
        text = re.sub(r'&amp;', '&', text)
        text = re.sub(r'&lt;', '<', text)
        text = re.sub(r'&gt;', '>', text)
        text = re.sub(r'&quot;', '"', text)
        text = re.sub(r'\s+', ' ', text).strip()
        print("extract_html: used regex fallback")
        return {"content": text}
    except Exception as e3:
        raise HTTPException(status_code=500, detail=f"All extraction methods failed: {e3}")

@app.get("/health")
def health():
    return {"status": "ok"}

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
