"""
extract_server.py — structured web extraction with NuExtract-1.5-tiny.

Pipeline per request (fastest first):
  1. extruct      → JSON-LD / microdata / OpenGraph / RDFa already embedded in the page (no model)
  2. trafilatura  → main content as Markdown (drops nav, ads, scripts; typically 5–20× fewer tokens)
  3. NuExtract    → fills a JSON template from the trimmed text (numind/NuExtract-1.5-tiny, Qwen2.5-0.5B)
  4. validation   → output checked against the template's shape; values checked for presence in the source

The model is not bundled: POST /model/download fetches it from Hugging Face into EXTRACT_HOME and
loads it. Runs in its own venv created by src/libs/extractor (dashboard "Download & set up").

  GET  /health                 liveness
  GET  /status                 model state, download progress, threads
  POST /model/download         download (if needed) + load the model in the background
  POST /model/unload           free RAM
  DELETE /model                unload and delete the downloaded files
  POST /extract                {html, url?, template?, use_model, max_input_tokens, max_new_tokens}
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("extract_server")

MODEL_REPO = os.environ.get("EXTRACT_MODEL", "numind/NuExtract-1.5-tiny")
HOME = Path(os.environ.get("EXTRACT_HOME", Path.home() / ".cache" / "datanodes-extractor"))
MODEL_DIR = HOME / "models" / MODEL_REPO.replace("/", "__")
THREADS = int(os.environ.get("EXTRACT_THREADS", os.cpu_count() or 4))

app = FastAPI(title="Web extractor", version="1.0.0")

# ── Model state ────────────────────────────────────────────────────────────────

_state: Dict[str, Any] = {
    "status": "absent",  # absent | downloading | loading | ready | error
    "error": None,
    "downloaded_bytes": 0,
    "total_bytes": 0,
    "started_at": None,
    "load_seconds": None,
}
_model = None
_tokenizer = None
_model_lock = threading.Lock()  # one generation at a time (CPU-bound anyway)
_state_lock = threading.Lock()


def _set(**kw: Any) -> None:
    with _state_lock:
        _state.update(kw)


def _dir_size(p: Path) -> int:
    if not p.exists():
        return 0
    return sum(f.stat().st_size for f in p.rglob("*") if f.is_file())


def _is_downloaded() -> bool:
    return (MODEL_DIR / ".complete").exists()


def _download_and_load() -> None:
    try:
        if not _is_downloaded():
            from huggingface_hub import HfApi, snapshot_download

            _set(status="downloading", error=None, started_at=time.time(), downloaded_bytes=0)
            info = HfApi().model_info(MODEL_REPO, files_metadata=True)
            # Only what inference needs: weights, config and tokenizer files.
            allow = ["*.json", "*.safetensors", "*.txt", "*.model", "*.tiktoken", "*.py"]
            total = sum((s.size or 0) for s in info.siblings if any(Path(s.rfilename).match(a) for a in allow))
            _set(total_bytes=total)
            MODEL_DIR.mkdir(parents=True, exist_ok=True)

            done = threading.Event()

            def watch() -> None:
                while not done.wait(1.0):
                    # hf_hub writes into .cache/huggingface/download inside local_dir while in flight
                    _set(downloaded_bytes=min(total, _dir_size(MODEL_DIR)))

            threading.Thread(target=watch, daemon=True).start()
            try:
                snapshot_download(MODEL_REPO, local_dir=str(MODEL_DIR), allow_patterns=allow)
            finally:
                done.set()
            (MODEL_DIR / ".complete").write_text(MODEL_REPO)
            _set(downloaded_bytes=total)
            log.info("downloaded %s (%d MB)", MODEL_REPO, total // (1 << 20))
        _load()
    except Exception as e:  # noqa: BLE001 — surfaced to the dashboard
        log.exception("model setup failed")
        _set(status="error", error=str(e))


def _load() -> None:
    global _model, _tokenizer
    _set(status="loading", error=None)
    t0 = time.time()
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    torch.set_num_threads(THREADS)
    tok = AutoTokenizer.from_pretrained(str(MODEL_DIR))
    # float32 on CPU: bfloat16 matmuls are emulated (slow) on most runner CPUs; 0.5B fp32 ≈ 2 GB RAM.
    model = AutoModelForCausalLM.from_pretrained(str(MODEL_DIR), torch_dtype=torch.float32)
    model.eval()
    with _model_lock:
        _model, _tokenizer = model, tok
    _set(status="ready", load_seconds=round(time.time() - t0, 1))
    log.info("model loaded in %.1fs (%d threads)", time.time() - t0, THREADS)


# ── Pre-processing ─────────────────────────────────────────────────────────────


def structured_data(html: str, url: Optional[str]) -> Dict[str, Any]:
    import extruct

    try:
        data = extruct.extract(
            html, base_url=url, syntaxes=["json-ld", "microdata", "opengraph", "rdfa"], uniform=True, errors="ignore"
        )
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)}
    # RDFa output is mostly noise from OpenGraph duplicates; keep it but trim empties.
    return {k: v for k, v in data.items() if v}


def clean_text(html: str, url: Optional[str]) -> str:
    import trafilatura

    text = trafilatura.extract(
        html,
        url=url,
        output_format="markdown",
        include_tables=True,
        include_links=False,
        include_images=False,
        include_comments=False,
        with_metadata=True,
        favor_recall=True,
    )
    if not text:
        # Pages trafilatura can't find a main block in (apps, listings): fall back to all visible text.
        text = trafilatura.html2txt(html) or ""
    return re.sub(r"\n{3,}", "\n\n", text).strip()


# ── Template handling & validation ─────────────────────────────────────────────


def parse_template(t: Any) -> Any:
    if isinstance(t, (dict, list)):
        return t
    if not isinstance(t, str) or not t.strip():
        raise HTTPException(400, "template must be a JSON object, e.g. {\"name\": \"\", \"price\": \"\"}")
    try:
        v = json.loads(t)
    except json.JSONDecodeError as e:
        raise HTTPException(400, f"template is not valid JSON: {e}") from e
    if not isinstance(v, dict):
        raise HTTPException(400, "template must be a JSON object")
    return v


def validate(template: Any, out: Any, path: str = "$") -> List[str]:
    """NuExtract templates are shapes: "" = string, [] = list, [ {...} ] = list of objects, {...} = object."""
    errs: List[str] = []
    if isinstance(template, dict):
        if not isinstance(out, dict):
            return [f"{path}: expected object, got {type(out).__name__}"]
        for k, sub in template.items():
            if k not in out:
                errs.append(f"{path}.{k}: missing")
            else:
                errs += validate(sub, out[k], f"{path}.{k}")
        for k in out:
            if k not in template:
                errs.append(f"{path}.{k}: not in template")
    elif isinstance(template, list):
        if not isinstance(out, list):
            return [f"{path}: expected list, got {type(out).__name__}"]
        if template:
            for i, item in enumerate(out):
                errs += validate(template[0], item, f"{path}[{i}]")
    else:
        if out is not None and not isinstance(out, (str, int, float, bool)):
            errs.append(f"{path}: expected text, got {type(out).__name__}")
    return errs


def grounding(out: Any, source: str, path: str = "$") -> Dict[str, bool]:
    """NuExtract is extractive: every non-empty value should appear in the source text."""
    res: Dict[str, bool] = {}
    norm = re.sub(r"\s+", " ", source).lower()
    if isinstance(out, dict):
        for k, v in out.items():
            res.update(grounding(v, source, f"{path}.{k}"))
    elif isinstance(out, list):
        for i, v in enumerate(out):
            res.update(grounding(v, source, f"{path}[{i}]"))
    elif isinstance(out, str) and out.strip():
        res[path] = re.sub(r"\s+", " ", out).strip().lower() in norm
    return res


# ── NuExtract inference ────────────────────────────────────────────────────────


def nuextract(text: str, template: Any, max_input_tokens: int, max_new_tokens: int) -> Dict[str, Any]:
    import torch

    tok, model = _tokenizer, _model
    tmpl = json.dumps(template, indent=4, ensure_ascii=False)
    ids = tok(text, add_special_tokens=False)["input_ids"]
    truncated = len(ids) > max_input_tokens
    if truncated:
        text = tok.decode(ids[:max_input_tokens])
    # Prompt format from the NuExtract-1.5 model card.
    prompt = f"<|input|>\n### Template:\n{tmpl}\n### Text:\n{text}\n\n<|output|>"
    enc = tok(prompt, return_tensors="pt")
    t0 = time.time()
    with _model_lock, torch.inference_mode():
        gen = model.generate(**enc, max_new_tokens=max_new_tokens, do_sample=False, pad_token_id=tok.eos_token_id)
    new = gen[0][enc["input_ids"].shape[1]:]
    raw = tok.decode(new, skip_special_tokens=True).strip()
    raw = raw.split("<|end-output|>")[0].strip()
    return {
        "raw": raw,
        "input_tokens": int(enc["input_ids"].shape[1]),
        "output_tokens": int(new.shape[0]),
        "hit_limit": int(new.shape[0]) >= max_new_tokens,
        "text_truncated": truncated,
        "seconds": round(time.time() - t0, 2),
    }


def parse_json(raw: str) -> Optional[Any]:
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", raw, re.S)
        if m:
            try:
                return json.loads(m.group(0))
            except json.JSONDecodeError:
                return None
    return None


# ── API ────────────────────────────────────────────────────────────────────────


class ExtractRequest(BaseModel):
    html: str = Field(..., max_length=20_000_000)
    url: Optional[str] = None
    template: Any = None
    use_model: bool = True
    max_input_tokens: int = Field(6000, ge=256, le=30000)
    max_new_tokens: int = Field(1024, ge=32, le=4000)


@app.get("/health")
def health() -> Dict[str, Any]:
    return {"ok": True}


@app.get("/status")
def status() -> Dict[str, Any]:
    with _state_lock:
        s = dict(_state)
    if s["status"] == "absent" and _is_downloaded():
        s["status"] = "downloaded"
    s.update(model=MODEL_REPO, threads=THREADS, model_dir=str(MODEL_DIR), disk_bytes=_dir_size(MODEL_DIR))
    return s


@app.post("/model/download")
def model_download() -> Dict[str, Any]:
    if _state["status"] in ("downloading", "loading"):
        return {"status": _state["status"]}
    if _model is not None:
        return {"status": "ready"}
    threading.Thread(target=_download_and_load, daemon=True).start()
    return {"status": "downloading" if not _is_downloaded() else "loading"}


@app.post("/model/unload")
def model_unload() -> Dict[str, Any]:
    global _model, _tokenizer
    with _model_lock:
        _model = _tokenizer = None
    _set(status="downloaded" if _is_downloaded() else "absent")
    return {"ok": True}


@app.delete("/model")
def model_delete() -> Dict[str, Any]:
    if _state["status"] in ("downloading", "loading"):
        raise HTTPException(409, "model is downloading or loading")
    model_unload()
    shutil.rmtree(MODEL_DIR, ignore_errors=True)
    _set(status="absent", downloaded_bytes=0)
    return {"ok": True}


@app.post("/extract")
def extract(req: ExtractRequest) -> Dict[str, Any]:
    timings: Dict[str, float] = {}
    t = time.time()
    structured = structured_data(req.html, req.url)
    timings["structured_ms"] = round((time.time() - t) * 1000, 1)

    t = time.time()
    text = clean_text(req.html, req.url)
    timings["clean_ms"] = round((time.time() - t) * 1000, 1)

    stats: Dict[str, Any] = {"html_chars": len(req.html), "text_chars": len(text)}
    if _tokenizer is not None:
        stats["html_tokens"] = len(_tokenizer(req.html[:2_000_000], add_special_tokens=False)["input_ids"])
        stats["text_tokens"] = len(_tokenizer(text, add_special_tokens=False)["input_ids"])
    else:  # rough estimate before the tokenizer is available
        stats["html_tokens"] = len(req.html) // 4
        stats["text_tokens"] = len(text) // 4
        stats["estimated"] = True
    stats["reduction"] = round(stats["html_tokens"] / max(1, stats["text_tokens"]), 1)

    result: Dict[str, Any] = {"structured": structured, "text": text, "stats": stats, "timings": timings, "model": None}
    if not req.use_model:
        return result
    if _model is None:
        raise HTTPException(409, f"Model not loaded (status: {_state['status']}). Download it first, or turn off the model step.")
    template = parse_template(req.template)
    if not text.strip():
        result["model"] = {"output": None, "valid": False, "errors": ["no text content found on the page"]}
        return result

    t = time.time()
    run = nuextract(text, template, req.max_input_tokens, req.max_new_tokens)
    out = parse_json(run["raw"])
    retried = False
    # Invalid JSON is almost always a truncated answer: retry once with a larger output budget.
    if out is None and run["hit_limit"] and req.max_new_tokens < 4000:
        retried = True
        run = nuextract(text, template, req.max_input_tokens, min(4000, req.max_new_tokens * 2))
        out = parse_json(run["raw"])
    timings["model_ms"] = round((time.time() - t) * 1000, 1)

    errors = ["model output is not valid JSON"] if out is None else validate(template, out)
    ground = grounding(out, text) if out is not None else {}
    result["model"] = {
        "output": out,
        "raw": run["raw"],
        "valid": out is not None and not errors,
        "errors": errors,
        "grounded": ground,
        "ungrounded": [k for k, v in ground.items() if not v],
        "retried": retried,
        "input_tokens": run["input_tokens"],
        "output_tokens": run["output_tokens"],
        "text_truncated": run["text_truncated"],
        "tokens_per_second": round(run["output_tokens"] / max(0.01, run["seconds"]), 1),
    }
    return result


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("EXTRACT_PORT", 8002))
    log.info("extract server on 127.0.0.1:%d, model %s, home %s", port, MODEL_REPO, HOME)
    if os.environ.get("EXTRACT_AUTOLOAD") == "1" or _is_downloaded():
        threading.Thread(target=_download_and_load, daemon=True).start()
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
