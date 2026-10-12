#!/usr/bin/env bash
set -e

MODELS_DIR="/models"
OUTPUTS_DIR="/outputs"
mkdir -p "$MODELS_DIR" "$OUTPUTS_DIR"

VAE_FILE="$MODELS_DIR/qwen_image_2.1_vae_bf16.safetensors"
DIFF_FILE="$MODELS_DIR/qwen_image_2.1-Q4_K.gguf"
TEXT_FILE="$MODELS_DIR/Qwen3VL-8B-Instruct-Q4_K_M.gguf"

# 1. Download models if not already in mounted volume
if [ ! -f "$VAE_FILE" ]; then
    echo "Downloading VAE..."
    aria2c -x 16 -s 16 -d "$MODELS_DIR" -o "qwen_image_2.1_vae_bf16.safetensors" \
      "https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/vae/qwen_image_2.1_vae_bf16.safetensors"
fi

if [ ! -f "$DIFF_FILE" ]; then
    echo "Downloading Diffusion model (Q4_K)..."
    aria2c -x 16 -s 16 -d "$MODELS_DIR" -o "qwen_image_2.1-Q4_K.gguf" \
      "https://huggingface.co/leejet/Qwen-Image-2.1-GGUF/resolve/main/qwen_image_2.1-Q4_K.gguf"
fi

if [ ! -f "$TEXT_FILE" ]; then
    echo "Downloading Text Encoder (Qwen3-VL 8B Q4_K_M)..."
    aria2c -x 16 -s 16 -d "$MODELS_DIR" -o "Qwen3VL-8B-Instruct-Q4_K_M.gguf" \
      "https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct-GGUF/resolve/main/Qwen3VL-8B-Instruct-Q4_K_M.gguf"
fi

# 2. Start sd-server on 8081
echo "Starting backend sd-server on port 8081..."
/app/sd-cpp/sd-server \
  --listen-ip 127.0.0.1 \
  --listen-port 8081 \
  --diffusion-model "$DIFF_FILE" \
  --vae "$VAE_FILE" \
  --llm "$TEXT_FILE" \
  -t "${THREADS:-4}" \
  --sampling-method euler \
  > /var/log/sd-server.log 2>&1 &

echo "Waiting for sd-server to start..."
for i in {1..60}; do
  if curl -s "http://127.0.0.1:8081/sdcpp/v1/capabilities" > /dev/null; then
    echo "sd-server is ready!"
    break
  fi
  sleep 1
done

# 3. Start Cloudflare Tunnel if configured
if [ -n "$CLOUDFLARE_TUNNEL_TOKEN" ]; then
    echo "Starting Cloudflare Tunnel..."
    cloudflared tunnel run --token "$CLOUDFLARE_TUNNEL_TOKEN" &
elif [ "$USE_TRYCLOUDFLARE" = "true" ]; then
    echo "Starting TryCloudflare quick tunnel..."
    cloudflared tunnel --url "http://127.0.0.1:8080" &
fi

# 4. Start FastAPI Gateway on port 8080 (foreground)
echo "Starting Gateway & Gallery UI on port 8080..."
cd /app
exec python3 -m uvicorn gateway:app --host 0.0.0.0 --port 8080
