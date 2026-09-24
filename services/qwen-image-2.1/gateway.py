import os
import json
import time
import base64
import asyncio
import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="Qwen Image 2.1 Gateway & Gallery")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

OUTPUTS_DIR = "/home/runner/outputs"
HISTORY_FILE = os.path.join(OUTPUTS_DIR, "history.json")
SD_SERVER_URL = "http://127.0.0.1:8081"
WEBUI_PATH = "/home/runner/webui.html"

os.makedirs(OUTPUTS_DIR, exist_ok=True)
app.mount("/outputs", StaticFiles(directory=OUTPUTS_DIR), name="outputs")

# Memory store for active jobs
jobs_db = {}

def load_history():
    if os.path.exists(HISTORY_FILE):
        try:
            with open(HISTORY_FILE, "r") as f:
                return json.load(f)
        except Exception:
            return []
    return []

def save_history(entry):
    history = load_history()
    history.insert(0, entry)
    # keep last 200 images
    history = history[:200]
    with open(HISTORY_FILE, "w") as f:
        json.dump(history, f, indent=2)

class GenerateRequest(BaseModel):
    prompt: str
    negative_prompt: str = ""
    width: int = 512
    height: int = 512
    steps: int = 8
    cfg: float = 6.0
    seed: int = -1
    transparent: bool = False

async def monitor_job(job_id: str, meta: dict):
    """Background task to poll sd-server until completion, saving image to disk even if client disconnects."""
    client = httpx.AsyncClient(timeout=10.0)
    try:
        while True:
            await asyncio.sleep(2)
            try:
                resp = await client.get(f"{SD_SERVER_URL}/sdcpp/v1/jobs/{job_id}")
                if resp.status_code == 200:
                    data = resp.json()
                    status = data.get("status")
                    jobs_db[job_id]["status"] = status
                    
                    if status == "completed":
                        result = data.get("result", {})
                        images = result.get("images", [])
                        if images and "b64_json" in images[0]:
                            b64 = images[0]["b64_json"]
                            img_bytes = base64.b64decode(b64)
                            filename = f"qwen_{int(time.time())}_{meta['seed']}.png"
                            filepath = os.path.join(OUTPUTS_DIR, filename)
                            with open(filepath, "wb") as f:
                                f.write(img_bytes)
                            
                            entry = {
                                "id": job_id,
                                "filename": filename,
                                "url": f"/outputs/{filename}",
                                "prompt": meta["original_prompt"],
                                "width": meta["width"],
                                "height": meta["height"],
                                "steps": meta["steps"],
                                "cfg": meta["cfg"],
                                "seed": meta["seed"],
                                "transparent": meta["transparent"],
                                "timestamp": int(time.time()),
                            }
                            save_history(entry)
                            jobs_db[job_id]["entry"] = entry
                            jobs_db[job_id]["b64_json"] = b64
                        break
                    elif status in ("failed", "cancelled", "expired"):
                        jobs_db[job_id]["error"] = data.get("error")
                        break
            except Exception as e:
                print(f"Error polling job {job_id}: {e}")
    finally:
        await client.aclose()

@app.get("/", response_class=HTMLResponse)
async def get_index():
    if os.path.exists(WEBUI_PATH):
        with open(WEBUI_PATH, "r", encoding="utf-8") as f:
            return f.read()
    return "<h1>Web UI not found</h1>"

@app.post("/api/generate")
async def generate_image(req: GenerateRequest):
    prompt_text = req.prompt.strip()
    if not prompt_text:
        raise HTTPException(status_code=400, detail="Prompt is required")

    if req.seed < 0:
        import random
        req.seed = random.randint(1, 2147483647)

    actual_prompt = prompt_text
    if req.transparent:
        actual_prompt = f"This is an RGBA image with transparency. {prompt_text}. The image has alpha channel and the background is transparent."

    payload = {
        "prompt": actual_prompt,
        "negative_prompt": req.negative_prompt,
        "width": req.width,
        "height": req.height,
        "seed": req.seed,
        "sample_params": {
            "sample_steps": req.steps,
            "sample_method": "euler",
            "guidance": {
                "txt_cfg": req.cfg
            }
        },
        "output_format": "png",
        "output_compression": 100
    }

    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            resp = await client.post(f"{SD_SERVER_URL}/sdcpp/v1/img_gen", json=payload)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Failed to reach sd-server: {str(e)}")

    if resp.status_code != 202:
        raise HTTPException(status_code=resp.status_code, detail=resp.text)

    job_info = resp.json()
    job_id = job_info.get("id")

    meta = {
        "original_prompt": req.prompt,
        "width": req.width,
        "height": req.height,
        "steps": req.steps,
        "cfg": req.cfg,
        "seed": req.seed,
        "transparent": req.transparent,
        "started_at": time.time(),
    }

    jobs_db[job_id] = {
        "id": job_id,
        "status": "queued",
        "meta": meta,
        "entry": None
    }

    # Start background polling task
    asyncio.create_task(monitor_job(job_id, meta))

    return {"id": job_id, "status": "queued", "seed": req.seed}

@app.get("/api/jobs/{job_id}")
async def get_job_status(job_id: str):
    if job_id not in jobs_db:
        # Check if already completed and in history
        history = load_history()
        for item in history:
            if item.get("id") == job_id:
                return {"id": job_id, "status": "completed", "entry": item}
        raise HTTPException(status_code=404, detail="Job not found")

    job = jobs_db[job_id]
    return {
        "id": job_id,
        "status": job.get("status", "unknown"),
        "entry": job.get("entry"),
        "error": job.get("error")
    }

@app.get("/api/history")
async def get_history():
    return load_history()

# OpenAI compatible endpoints proxy
@app.post("/v1/images/generations")
async def openai_generations(request: Request):
    body = await request.body()
    async with httpx.AsyncClient(timeout=300.0) as client:
        resp = await client.post(
            f"{SD_SERVER_URL}/v1/images/generations",
            content=body,
            headers={"Content-Type": "application/json"}
        )
        return JSONResponse(status_code=resp.status_code, content=resp.json())

@app.get("/v1/models")
async def openai_models():
    return {
        "data": [
            {
                "id": "qwen-image-2.1",
                "object": "model",
                "owned_by": "alibaba-qwen"
            }
        ]
    }
