"""
tts_server.py
FastAPI server for multiple TTS engines:
1. Qwen3-TTS (Local, 0.6B/1.7B)
2. MeloTTS (Local, CPU-optimized)
3. Edge-TTS (Cloud, High Quality)

Runs on port 8002.
"""

import io
import os
import sys
import logging
import tempfile
import time
import threading
import asyncio
from pathlib import Path
from typing import Optional, List, Dict, Any

import uvicorn
from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("tts_server")

app = FastAPI(title="Multi-Engine TTS Server", version="3.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Qwen3-TTS Config ─────────────────────────────────────────────────────────
MODEL_CUSTOM_VOICE = "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice"
MODEL_BASE         = "Qwen/Qwen3-TTS-12Hz-0.6B-Base"
MODEL_DESIGN       = "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign"

_lock = threading.Lock()

class _ModelEntry:
    def __init__(self, model_id: str):
        self.model_id = model_id
        self.model = None
        self.loading = False
        self.error: Optional[str] = None

    def is_ready(self) -> bool:
        return self.model is not None

_qwen_models: dict[str, _ModelEntry] = {
    "custom_voice": _ModelEntry(MODEL_CUSTOM_VOICE),
    "base":         _ModelEntry(MODEL_BASE),
    "design":       _ModelEntry(MODEL_DESIGN),
}

def _load_qwen_model(key: str) -> None:
    entry = _qwen_models[key]
    if entry.is_ready() or entry.loading:
        return
    entry.loading = True
    try:
        import torch
        from qwen_tts import Qwen3TTSModel
        logger.info(f"Loading Qwen {entry.model_id} …")
        device = "cuda:0" if _has_cuda() else "cpu"
        kwargs = dict(device_map=device, dtype=torch.bfloat16)
        if _has_cuda():
            kwargs["attn_implementation"] = "flash_attention_2"
        entry.model = Qwen3TTSModel.from_pretrained(entry.model_id, **kwargs)
        entry.error = None
        logger.info(f"✅ Qwen {entry.model_id} loaded")
    except Exception as e:
        entry.error = str(e)
        logger.error(f"❌ Failed to load Qwen {entry.model_id}: {e}")
    finally:
        entry.loading = False

def _has_cuda() -> bool:
    try:
        import torch
        return torch.cuda.is_available()
    except Exception:
        return False

def _ensure_qwen(key: str):
    entry = _qwen_models[key]
    if entry.is_ready(): return entry.model
    if entry.error: raise HTTPException(503, f"Qwen model error: {entry.error}")
    if not entry.loading:
        threading.Thread(target=_load_qwen_model, args=(key,), daemon=True).start()
    raise HTTPException(503, "Qwen model is loading")

# ── MeloTTS Config ───────────────────────────────────────────────────────────
_melo_models: Dict[str, Any] = {}

def _ensure_melo(lang: str = "EN"):
    lang = lang.upper()
    if lang not in _melo_models:
        try:
            from melo.api import TTS
            logger.info(f"Loading MeloTTS {lang} …")
            device = "cuda:0" if _has_cuda() else "cpu"
            _melo_models[lang] = TTS(language=lang, device=device)
            logger.info(f"✅ MeloTTS {lang} loaded")
        except Exception as e:
            logger.error(f"❌ MeloTTS load error: {e}")
            raise HTTPException(500, f"MeloTTS load failed: {e}")
    return _melo_models[lang]

# ── Helpers ──────────────────────────────────────────────────────────────────
def _wav_to_bytes(wav_array, sr: int) -> bytes:
    import soundfile as sf
    buf = io.BytesIO()
    sf.write(buf, wav_array, sr, format="WAV")
    buf.seek(0)
    return buf.read()

def _audio_response(wav_bytes: bytes, prefix: str) -> Response:
    return Response(
        content=wav_bytes,
        media_type="audio/wav",
        headers={"Content-Disposition": f'attachment; filename="{prefix}_{int(time.time())}.wav"'},
    )

# ── Built-in Voices ───────────────────────────────────────────────────────────
QWEN_SPEAKERS = [
    {"id": "Vivian", "label": "Qwen: Vivian (CN)", "engine": "qwen", "gender": "female", "tone": "Emotional"},
    {"id": "Ryan",   "label": "Qwen: Ryan (EN)",   "engine": "qwen", "gender": "male",   "tone": "Clear"},
    {"id": "Sophia", "label": "Qwen: Sophia (EN)", "engine": "qwen", "gender": "female", "tone": "Professional"},
]

MELO_SPEAKERS = [
    {"id": "EN-Default", "label": "Melo: English (Default)", "engine": "melo", "gender": "female", "tone": "Fast, Natural"},
    {"id": "EN-US",      "label": "Melo: English (US)",      "engine": "melo", "gender": "female", "tone": "American accent"},
    {"id": "EN-BR",      "label": "Melo: English (British)", "engine": "melo", "gender": "male",   "tone": "British accent"},
]

EDGE_SPEAKERS = [
    {"id": "en-US-AriaNeural",    "label": "Edge: Aria (US)",    "engine": "edge", "gender": "female", "tone": "Smooth Cloud"},
    {"id": "en-US-GuyNeural",     "label": "Edge: Guy (US)",     "engine": "edge", "gender": "male",   "tone": "Deep Cloud"},
    {"id": "en-GB-SoniaNeural",   "label": "Edge: Sonia (UK)",   "engine": "edge", "gender": "female", "tone": "British Cloud"},
    {"id": "zh-CN-XiaoxiaoNeural","label": "Edge: Xiaoxiao (CN)","engine": "edge", "gender": "female", "tone": "Natural Chinese"},
]

# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {
        "status": "ok",
        "engines": ["qwen", "melo", "edge"],
        "qwen_loaded": any(e.is_ready() for e in _qwen_models.values()),
        "melo_loaded": list(_melo_models.keys()),
    }

@app.get("/tts/voices")
def list_voices():
    return {"voices": QWEN_SPEAKERS + MELO_SPEAKERS + EDGE_SPEAKERS}

class TTSRequest(BaseModel):
    text: str
    speaker: str = "Vivian"
    language: str = "Auto"
    instruct: str = ""
    engine: str = "qwen" # qwen, melo, edge

@app.post("/tts/generate")
async def tts_generate(req: TTSRequest):
    if not req.text.strip(): raise HTTPException(400, "Empty text")

    # 1. Edge-TTS Engine
    if req.engine == "edge":
        import edge_tts
        try:
            communicate = edge_tts.Communicate(req.text, req.speaker)
            with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
                await communicate.save(tmp.name)
                tmp_path = tmp.name
            with open(tmp_path, "rb") as f:
                data = f.read()
            os.unlink(tmp_path)
            return Response(content=data, media_type="audio/mpeg")
        except Exception as e:
            raise HTTPException(500, f"Edge-TTS error: {e}")

    # 2. MeloTTS Engine
    if req.engine == "melo":
        model = _ensure_melo("EN" if "EN" in req.speaker else "ZH")
        try:
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                tmp_path = tmp.name
            # speaker_id lookup
            spk_id = model.hps.data.spk2id.get(req.speaker, model.hps.data.spk2id.get('EN-Default', 0))
            model.tts_to_file(req.text, spk_id, tmp_path, speed=1.0)
            with open(tmp_path, "rb") as f:
                data = f.read()
            os.unlink(tmp_path)
            return Response(content=data, media_type="audio/wav")
        except Exception as e:
            raise HTTPException(500, f"MeloTTS error: {e}")

    # 3. Qwen Engine (Default)
    model = _ensure_qwen("custom_voice")
    try:
        with _lock:
            wavs, sr = model.generate_custom_voice(
                text=req.text,
                language=req.language,
                speaker=req.speaker,
                instruct=req.instruct if req.instruct.strip() else None,
                max_new_tokens=2048,
            )
        return _audio_response(_wav_to_bytes(wavs[0], sr), "qwen")
    except Exception as e:
        raise HTTPException(500, str(e))

@app.post("/tts/clone")
async def tts_clone(
    text: str = Form(...),
    ref_text: str = Form(...),
    language: str = Form("Auto"),
    reference_audio: UploadFile = File(...),
):
    # Cloning currently only supported by Qwen Base
    model = _ensure_qwen("base")
    ref_bytes = await reference_audio.read()
    suffix = Path(reference_audio.filename or "ref.wav").suffix or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(ref_bytes)
        tmp_path = tmp.name
    try:
        with _lock:
            wavs, sr = model.generate_voice_clone(
                text=text, language=language, ref_audio=tmp_path, ref_text=ref_text, max_new_tokens=2048
            )
        return _audio_response(_wav_to_bytes(wavs[0], sr), "clone")
    except Exception as e:
        raise HTTPException(500, str(e))
    finally:
        try: os.unlink(tmp_path)
        except: pass

@app.post("/tts/design")
async def tts_design(text: str = Form(...), style: str = Form(...), language: str = Form("Auto")):
    model = _ensure_qwen("design")
    try:
        with _lock:
            wavs, sr = model.generate_voice_design(
                text=text, language=language, instruct=style, max_new_tokens=2048
            )
        return _audio_response(_wav_to_bytes(wavs[0], sr), "design")
    except Exception as e:
        raise HTTPException(500, str(e))

if __name__ == "__main__":
    port = int(os.environ.get("TTS_SERVER_PORT", 8002))
    logger.info(f"🚀 Multi-Engine TTS Server starting on port {port}")
    # Pre-download NLTK data for MeloTTS
    try:
        import nltk
        nltk.download('averaged_perceptron_tagger_eng')
        nltk.download('universal_tagset')
    except: pass
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
