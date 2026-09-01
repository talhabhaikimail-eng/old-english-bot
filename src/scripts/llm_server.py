"""
llm_server.py
FastAPI server for local LLM inference using llama-cpp-python.
Runs on port 8001. Supports model download (huggingface_hub),
loading into llama.cpp, and streaming/non-streaming chat completion.
"""

import os
import sys
import asyncio
import logging
import threading
from pathlib import Path
from typing import Optional, List, Dict, Any

# pyrefly: ignore [missing-import]
from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("llm_server")

app = FastAPI(title="Local LLM Server", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Model registry ─────────────────────────────────────────────────────────────

MODELS_DIR = Path(os.environ.get("LLM_MODELS_DIR", os.path.expanduser("~/.llm_models")))
MODELS_DIR.mkdir(parents=True, exist_ok=True)

# fmt: off
MODEL_CATALOG: Dict[str, Dict[str, Any]] = {
    # ── Ultra-light / Edge ────────────────────────────────────────────────────
    "gemma-2-2b": {
        "label": "Gemma 2 2B",
        "description": "Google's efficient 2B model — great reasoning for its size",
        "repo": "bartowski/gemma-2-2b-it-GGUF",
        "filename": "gemma-2-2b-it-Q4_K_M.gguf",
        "size_gb": 1.6,
        "ctx": 4096,
        "chat_format": "gemma",
        "tags": ["google", "fast", "balanced"],
    },
    "llama-3.2-1b": {
        "label": "Llama 3.2 1B",
        "description": "Meta's ultra-lightweight edge model",
        "repo": "bartowski/Llama-3.2-1B-Instruct-GGUF",
        "filename": "Llama-3.2-1B-Instruct-Q4_K_M.gguf",
        "size_gb": 0.7,
        "ctx": 4096,
        "chat_format": "llama-3",
        "tags": ["fast", "edge", "tiny"],
    },
    "smollm2-1.7b": {
        "label": "SmolLM2 1.7B",
        "description": "HuggingFace's state-of-the-art small model on high-quality data",
        "repo": "bartowski/SmolLM2-1.7B-Instruct-GGUF",
        "filename": "SmolLM2-1.7B-Instruct-Q4_K_M.gguf",
        "size_gb": 1.1,
        "ctx": 4096,
        "chat_format": "chatml",
        "tags": ["small", "quality", "HuggingFace"],
    },
    "deepseek-r1-1.5b": {
        "label": "DeepSeek R1 Distill 1.5B",
        "description": "DeepSeek's reasoning-focused distillation on Qwen 1.5B base",
        "repo": "bartowski/DeepSeek-R1-Distill-Qwen-1.5B-GGUF",
        "filename": "DeepSeek-R1-Distill-Qwen-1.5B-Q4_K_M.gguf",
        "size_gb": 1.0,
        "ctx": 4096,
        "chat_format": "chatml",
        "tags": ["reasoning", "fast", "deepseek"],
    },
    "qwen2.5-1.5b": {
        "label": "Qwen 2.5 1.5B",
        "description": "Alibaba's compact multilingual & coding model",
        "repo": "Qwen/Qwen2.5-1.5B-Instruct-GGUF",
        "filename": "qwen2.5-1.5b-instruct-q4_k_m.gguf",
        "size_gb": 1.0,
        "ctx": 4096,
        "chat_format": "chatml",
        "tags": ["multilingual", "code", "fast"],
    },
    # ── Small (2–4 GB) ────────────────────────────────────────────────────────
    "llama-3.2-3b": {
        "label": "Llama 3.2 3B",
        "description": "Meta's edge-optimised 3B model for laptops",
        "repo": "bartowski/Llama-3.2-3B-Instruct-GGUF",
        "filename": "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
        "size_gb": 2.0,
        "ctx": 4096,
        "chat_format": "llama-3",
        "tags": ["fast", "edge", "capable"],
    },
    "ministral-3b": {
        "label": "Ministral 3B (Dec 2025)",
        "description": "Mistral's latest edge-optimised 3B multimodal model",
        "repo": "bartowski/mistralai_Ministral-3-3B-Instruct-2512-GGUF",
        "filename": "mistralai_Ministral-3-3B-Instruct-2512-Q4_K_M.gguf",
        "size_gb": 2.0,
        "ctx": 4096,
        "chat_format": "mistral-instruct",
        "tags": ["mistral", "edge", "multimodal"],
    },
    "phi-3.5-mini-3.8b": {
        "label": "Phi-3.5 Mini 3.8B",
        "description": "Microsoft's top-tier open model — reasoning, logic & code",
        "repo": "bartowski/Phi-3.5-mini-instruct-GGUF",
        "filename": "Phi-3.5-mini-instruct-Q4_K_M.gguf",
        "size_gb": 2.4,
        "ctx": 4096,
        "chat_format": "chatml",
        "tags": ["reasoning", "code", "microsoft"],
    },
    "deepseek-r1-7b": {
        "label": "DeepSeek R1 Distill 7B",
        "description": "DeepSeek's powerful chain-of-thought distillation on Qwen 7B",
        "repo": "bartowski/DeepSeek-R1-Distill-Qwen-7B-GGUF",
        "filename": "DeepSeek-R1-Distill-Qwen-7B-Q4_K_M.gguf",
        "size_gb": 4.7,
        "ctx": 4096,
        "chat_format": "chatml",
        "tags": ["reasoning", "deepseek", "capable"],
    },
    "qwen2.5-coder-7b": {
        "label": "Qwen 2.5 Coder 7B",
        "description": "Alibaba's specialised code generation model",
        "repo": "bartowski/Qwen2.5-Coder-7B-Instruct-GGUF",
        "filename": "Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf",
        "size_gb": 4.7,
        "ctx": 4096,
        "chat_format": "chatml",
        "tags": ["code", "multilingual", "capable"],
    },
    "qwen2.5-7b": {
        "label": "Qwen 2.5 7B",
        "description": "Alibaba's strong multilingual & general-purpose model",
        "repo": "Qwen/Qwen2.5-7B-Instruct-GGUF",
        "filename": "qwen2.5-7b-instruct-q4_k_m.gguf",
        "size_gb": 4.5,
        "ctx": 4096,
        "chat_format": "chatml",
        "tags": ["multilingual", "code", "capable"],
    },
    "mistral-7b-v0.3": {
        "label": "Mistral 7B v0.3",
        "description": "Mistral's reliable, widely-compatible 7B instruct model",
        "repo": "bartowski/Mistral-7B-Instruct-v0.3-GGUF",
        "filename": "Mistral-7B-Instruct-v0.3-Q4_K_M.gguf",
        "size_gb": 4.4,
        "ctx": 4096,
        "chat_format": "mistral-instruct",
        "tags": ["mistral", "reliable", "capable"],
    },
    "llama-3-8b-webparser": {
        "label": "Llama 3 8B WebParser",
        "description": "Llama 3 8B fine-tuned for web parsing and navigation",
        "repo": "QuantFactory/Llama-3-8B-Web-GGUF",
        "filename": "Llama-3-8B-Web.Q4_K_M.gguf",
        "size_gb": 4.9,
        "ctx": 8192,
        "chat_format": "llama-3",
        "tags": ["web", "capable", "llama-3"],
    },
}
# fmt: on

# ── State ──────────────────────────────────────────────────────────────────────

_lock = threading.Lock()
_current_model_id: Optional[str] = None
_llm = None  # llama_cpp.Llama instance
_download_status: Dict[str, Any] = {}  # model_id → {status, progress, error}


def _model_path(model_id: str) -> Path:
    info = MODEL_CATALOG[model_id]
    return MODELS_DIR / info["filename"]


def _is_downloaded(model_id: str) -> bool:
    return _model_path(model_id).exists()


# ── Pydantic schemas ───────────────────────────────────────────────────────────


class ChatMessage(BaseModel):
    role: str  # "system" | "user" | "assistant"
    content: str


class ChatRequest(BaseModel):
    messages: List[ChatMessage]
    max_tokens: int = 512
    temperature: float = 0.7
    stream: bool = False


class LoadModelRequest(BaseModel):
    model_id: str
    n_ctx: Optional[int] = None  # override context window


class DownloadRequest(BaseModel):
    model_id: str


# ── Background download ────────────────────────────────────────────────────────


def _download_model(model_id: str) -> None:
    from huggingface_hub import hf_hub_download

    info = MODEL_CATALOG[model_id]
    dest = _model_path(model_id)

    _download_status[model_id] = {"status": "downloading", "progress": 0, "error": None}
    logger.info(f"Downloading {info['label']} from {info['repo']}...")

    try:
        hf_hub_download(
            repo_id=info["repo"],
            filename=info["filename"],
            local_dir=str(MODELS_DIR),
            local_dir_use_symlinks=False,
        )
        _download_status[model_id] = {"status": "ready", "progress": 100, "error": None}
        logger.info(f"✅ {info['label']} downloaded to {dest}")
    except Exception as e:
        _download_status[model_id] = {"status": "error", "progress": 0, "error": str(e)}
        logger.error(f"❌ Download failed for {model_id}: {e}")


# ── Routes ─────────────────────────────────────────────────────────────────────


@app.get("/health")
def health():
    return {"ok": True, "service": "llm_server"}


@app.get("/llm/models")
def list_models():
    models = []
    for mid, info in MODEL_CATALOG.items():
        downloaded = _is_downloaded(mid)
        dl_status = _download_status.get(mid, {})
        models.append({
            "id": mid,
            "label": info["label"],
            "description": info["description"],
            "size_gb": info["size_gb"],
            "tags": info["tags"],
            "ctx": info["ctx"],
            "downloaded": downloaded,
            "loaded": mid == _current_model_id,
            "download_status": dl_status.get("status", "ready" if downloaded else "not_downloaded"),
            "download_error": dl_status.get("error"),
        })
    return {
        "models": models,
        "current_model": _current_model_id,
        "models_dir": str(MODELS_DIR),
    }


@app.post("/llm/download")
def download_model(req: DownloadRequest, background_tasks: BackgroundTasks):
    model_id = req.model_id
    if model_id not in MODEL_CATALOG:
        raise HTTPException(404, f"Unknown model: {model_id}")
    if _is_downloaded(model_id):
        return {"message": f"{MODEL_CATALOG[model_id]['label']} already downloaded", "status": "ready"}
    if _download_status.get(model_id, {}).get("status") == "downloading":
        return {"message": "Download already in progress", "status": "downloading"}

    background_tasks.add_task(_download_model, model_id)
    return {"message": f"Download started for {MODEL_CATALOG[model_id]['label']}", "status": "downloading"}


@app.get("/llm/download/status/{model_id}")
def download_status(model_id: str):
    if model_id not in MODEL_CATALOG:
        raise HTTPException(404, f"Unknown model: {model_id}")
    downloaded = _is_downloaded(model_id)
    ds = _download_status.get(model_id, {})
    return {
        "model_id": model_id,
        "downloaded": downloaded,
        "status": ds.get("status", "ready" if downloaded else "not_downloaded"),
        "error": ds.get("error"),
    }


@app.post("/llm/load")
def load_model(req: LoadModelRequest):
    global _llm, _current_model_id

    model_id = req.model_id
    if model_id not in MODEL_CATALOG:
        raise HTTPException(404, f"Unknown model: {model_id}")
    if not _is_downloaded(model_id):
        raise HTTPException(400, f"Model not downloaded yet. Call /llm/download first.")

    if _current_model_id == model_id:
        return {"message": f"{MODEL_CATALOG[model_id]['label']} is already loaded", "loaded": True}

    try:
        from llama_cpp import Llama

        info = MODEL_CATALOG[model_id]
        n_ctx = req.n_ctx or info["ctx"]

        logger.info(f"Loading {info['label']} (ctx={n_ctx})...")
        with _lock:
            _llm = Llama(
                model_path=str(_model_path(model_id)),
                n_ctx=n_ctx,
                n_threads=4,  # 4 CPU cores
                n_gpu_layers=0,  # CPU only
                verbose=False,
            )
            _current_model_id = model_id
        logger.info(f"✅ {info['label']} loaded")
        return {"loaded": True, "model_id": model_id, "label": info["label"]}
    except Exception as e:
        logger.error(f"Load failed: {e}")
        raise HTTPException(500, str(e))


@app.post("/llm/unload")
def unload_model():
    global _llm, _current_model_id
    with _lock:
        _llm = None
        prev = _current_model_id
        _current_model_id = None
    return {"unloaded": True, "was": prev}


@app.get("/llm/status")
def llm_status():
    info = MODEL_CATALOG.get(_current_model_id, {}) if _current_model_id else {}
    return {
        "loaded": _current_model_id is not None,
        "model_id": _current_model_id,
        "label": info.get("label"),
        "ctx": info.get("ctx"),
    }


@app.post("/llm/chat")
async def chat(req: ChatRequest):
    if _llm is None:
        raise HTTPException(400, "No model loaded. Call /llm/load first.")

    messages = [{"role": m.role, "content": m.content} for m in req.messages]
    info = MODEL_CATALOG.get(_current_model_id, {})
    chat_format = info.get("chat_format", "chatml")

    if req.stream:
        import json as _json

        async def stream_generate():
            # Run the blocking llama-cpp call in a thread so the event loop
            # stays free to serve /llm/status and /llm/models concurrently.
            loop = asyncio.get_event_loop()

            def _make_stream():
                with _lock:
                    return list(_llm.create_chat_completion(  # type: ignore[union-attr]
                        messages=messages,
                        max_tokens=req.max_tokens,
                        temperature=req.temperature,
                        stream=True,
                    ))

            # Note: llama-cpp streaming generator is lazy — materialising it
            # in a thread is the only safe way to avoid blocking the event loop.
            # For very large max_tokens this buffers in the thread; for typical
            # chat sizes (≤2048 tokens) this is fine and keeps concurrency intact.
            chunks = await loop.run_in_executor(None, _make_stream)
            for chunk in chunks:
                delta = chunk["choices"][0]["delta"]
                text = delta.get("content", "")
                if text:
                    yield f"data: {_json.dumps({'text': text})}\n\n"
                    # Yield control back to the event loop between tokens
                    await asyncio.sleep(0)
            yield "data: [DONE]\n\n"

        return StreamingResponse(stream_generate(), media_type="text/event-stream")


    with _lock:
        result = _llm.create_chat_completion(  # type: ignore[union-attr]
            messages=messages,
            max_tokens=req.max_tokens,
            temperature=req.temperature,
        )

    content = result["choices"][0]["message"]["content"]
    usage = result.get("usage", {})
    return {
        "content": content,
        "model_id": _current_model_id,
        "usage": usage,
    }


@app.delete("/llm/models/{model_id}")
def delete_model(model_id: str):
    if model_id not in MODEL_CATALOG:
        raise HTTPException(404, f"Unknown model: {model_id}")
    path = _model_path(model_id)
    if not path.exists():
        raise HTTPException(400, "Model file not found")
    if _current_model_id == model_id:
        raise HTTPException(400, "Cannot delete the currently loaded model. Unload first.")
    path.unlink()
    _download_status.pop(model_id, None)
    return {"deleted": True, "model_id": model_id}


# ── Entry point ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("LLM_SERVER_PORT", 8001))
    logger.info(f"🚀 LLM Server starting on port {port}")
    logger.info(f"📁 Models directory: {MODELS_DIR}")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
