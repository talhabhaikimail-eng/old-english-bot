# Qwen Image 2.1 — Dockerized CPU Inference Service

Self-contained, production-ready Docker deployment of **Qwen Image 2.1** with:
- `stable-diffusion.cpp` engine optimized with AVX-512 for Zen 4 / modern x86_64 CPUs.
- Asynchronous Job Queue to completely prevent Cloudflare 524 timeouts.
- Automatic image persistence and built-in Web Gallery.
- Single-page responsive Web UI with native RGBA transparency support.
- Automated Cloudflare Tunnel reverse-proxy integration.

---

## Architecture Overview

```
[ Browser / Client ] 
        │
   (HTTPS :443)
        ▼
[ Cloudflare Tunnel / Edge ]
        │
   (HTTP :8080)
        ▼
[ FastAPI Gateway & Gallery ] ◄── Saves images to ── /outputs/ (Volume)
        │ (Fast internal async polling)
   (HTTP :8081)
        ▼
[ sd-server (stable-diffusion.cpp) ]
        │
   Reads models from: /models/ (Volume)
   - qwen_image_2.1-Q4_K.gguf (Diffusion DiT)
   - Qwen3VL-8B-Instruct-Q4_K_M.gguf (Text Encoder)
   - qwen_image_2.1_vae_bf16.safetensors (VAE)
```

---

## Quick Start (Docker Compose)

### 1. Configure Environment
Set your Cloudflare Tunnel token (optional, if you want public access through a domain):
```bash
export CLOUDFLARE_TUNNEL_TOKEN="your_tunnel_token_here"
```
Or to use a free temporary `*.trycloudflare.com` tunnel, set in `docker-compose.yml`:
```yaml
- USE_TRYCLOUDFLARE=true
```

### 2. Build and Launch
```bash
docker compose up -d --build
```

### 3. Check Logs
```bash
docker compose logs -f
```
On first startup, the container will automatically download all required model weights into `./models` using `aria2c` and cache them for future runs.

---

## Accessing the Service

* **Web UI & Gallery:** Open `http://localhost:8080` (or your configured Cloudflare domain).
* **OpenAI Compatible Endpoint:** `POST http://localhost:8080/v1/images/generations`
* **Gallery API:** `GET http://localhost:8080/api/history`

---

## CPU Recommendations

* **Recommended Preview:** `256x256` or `384x384` with `4`–`8` steps.
* **Full Resolution:** `512x512` with `6`–`10` steps.
* **Guidance (CFG):** `4.0`–`6.0`.
* **Transparency:** Check "Native RGBA Transparency" in the Web UI to generate cutouts and transparent logos.
