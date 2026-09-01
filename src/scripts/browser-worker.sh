#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# browser-worker.sh — Remote browser worker for the distributed browser pool.
#
# Launched inside each GitHub Actions matrix job.  It:
#   1. Starts Chrome headless with CDP on :9222
#   2. Creates a cloudflared quick-tunnel exposing :9222
#   3. Registers the tunnel URL with the main dashboard
#   4. Sends heartbeats every 60 s
#   5. On shutdown sends a deregister event
#
# Required env vars:
#   DASHBOARD_DOMAIN  — domain of the main dashboard (e.g. )
#   WORKER_ID         — unique identifier for this worker (set by the workflow)
#
# Optional:
#   MAX_RUNTIME       — seconds to run (default: 18000 = 5 h)
#   HEARTBEAT_INTERVAL — seconds between heartbeats (default: 60)
# ---------------------------------------------------------------------------

set -euo pipefail

DASHBOARD_DOMAIN="${DASHBOARD_DOMAIN:?DASHBOARD_DOMAIN is required}"
WORKER_ID="${WORKER_ID:?WORKER_ID is required}"
MAX_RUNTIME="${MAX_RUNTIME:-18000}"
HEARTBEAT_INTERVAL="${HEARTBEAT_INTERVAL:-60}"

WEBHOOK_SECRET="${WEBHOOK_SECRET:-${DASHBOARD_PASSWORD:-}}"
WEBHOOK_URL="https://${DASHBOARD_DOMAIN}/api/browsers/webhook?secret=${WEBHOOK_SECRET}"
CDP_PORT=9222
SB_CDP_PORT="${SB_CDP_PORT:-9223}"
TUNNEL_URL=""
TUNNEL_SB_CDP_URL=""
CHROME_PID=""
SB_CDP_PID=""
TUNNEL_PID=""
TUNNEL_SB_CDP_PID=""
TUNNEL_API_URL=""
API_PID=""
TUNNEL_API_PID=""
XVFB_PID=""

# ---------------------------------------------------------------------------
# Cleanup handler
# ---------------------------------------------------------------------------
cleanup() {
  EXIT_CODE=$?
  echo "🧹 Cleaning up worker processes (Exit code: $EXIT_CODE)..."

  # Best-effort deregister
  if [ -n "$TUNNEL_URL" ] || [ -n "$TUNNEL_SB_CDP_URL" ]; then
    for attempt in 1 2 3; do
      HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
        -X POST "$WEBHOOK_URL" \
        -H "Content-Type: application/json" \
        -d "{\"event\":\"deregister\",\"workerId\":\"${WORKER_ID}\",\"cdpUrl\":\"${TUNNEL_URL}\",\"sbCdpUrl\":\"${TUNNEL_SB_CDP_URL}\",\"seleniumCdpUrl\":\"${TUNNEL_SB_CDP_URL}\",\"apiUrl\":\"${TUNNEL_API_URL}\",\"runId\":\"${GITHUB_RUN_ID:-}\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" \
        2>/dev/null || echo "000")
      if [ "$HTTP_CODE" = "200" ]; then
        break
      fi
      sleep 3
    done
  fi

  # Kill child processes
  [ -n "$TUNNEL_SB_CDP_PID" ] && kill "$TUNNEL_SB_CDP_PID" 2>/dev/null || true
  [ -n "$SB_CDP_PID" ] && kill "$SB_CDP_PID" 2>/dev/null || true
  [ -n "$TUNNEL_API_PID" ] && kill "$TUNNEL_API_PID" 2>/dev/null || true
  [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null || true
  [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null || true
  [ -n "$CHROME_PID" ] && kill "$CHROME_PID" 2>/dev/null || true
  [ -n "$XVFB_PID" ] && kill "$XVFB_PID" 2>/dev/null || true

  exit $EXIT_CODE
}
trap cleanup EXIT SIGTERM SIGINT

# ---------------------------------------------------------------------------
# 0. Start Xvfb virtual display if on Linux (required for SeleniumBase UC stealth)
# ---------------------------------------------------------------------------
if [ "$(uname -s)" = "Linux" ] && [ -z "${DISPLAY:-}" ]; then
  echo "🖥️ Starting Xvfb virtual display on :99..."
  Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset > /tmp/xvfb.log 2>&1 &
  XVFB_PID=$!
  export DISPLAY=:99
  sleep 1
fi

# ---------------------------------------------------------------------------
# 1. Start Chrome with CDP (Puppeteer browser on :9222)
# ---------------------------------------------------------------------------
echo "🚀 Starting Chrome headless with CDP on :${CDP_PORT}..."

mkdir -p /tmp/chrome-user-data

google-chrome-stable \
  --headless=new \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu \
  --remote-debugging-port=${CDP_PORT} \
  --remote-debugging-address=0.0.0.0 \
  --remote-allow-origins=* \
  --user-data-dir=/tmp/chrome-user-data \
  --disable-background-networking \
  --disable-extensions \
  --disable-sync \
  --no-first-run \
  --disable-default-apps \
  &

CHROME_PID=$!
echo "Chrome started (PID: $CHROME_PID)"

# Wait for CDP to become available
echo "⏳ Waiting for Puppeteer CDP (:9222) to be ready..."
for i in $(seq 1 30); do
  if curl -s "http://127.0.0.1:${CDP_PORT}/json/version" > /dev/null 2>&1; then
    echo "✅ Puppeteer CDP is ready!"
    break
  fi
  if [ $i -eq 30 ]; then
    echo "❌ Puppeteer CDP failed to start within 30 seconds"
    exit 1
  fi
  sleep 1
done

start_sb_chrome() {
  mkdir -p /tmp/sb-chrome-data
  google-chrome-stable \
    --no-sandbox \
    --disable-setuid-sandbox \
    --disable-dev-shm-usage \
    --remote-debugging-port=${SB_CDP_PORT} \
    --remote-debugging-address=0.0.0.0 \
    --remote-allow-origins=* \
    --user-data-dir=/tmp/sb-chrome-data \
    --window-size=1400,900 \
    --window-position=10,10 \
    --no-first-run \
    --no-default-browser-check \
    --no-service-autorun \
    --disable-auto-reload \
    --homepage=about:blank \
    --no-pings \
    --enable-unsafe-extension-debugging \
    --wm-window-animations-disabled \
    --animation-duration-scale=0 \
    --enable-privacy-sandbox-ads-apis \
    --safebrowsing-disable-download-protection \
    --password-store=basic \
    --deny-permission-prompts \
    --disable-breakpad \
    --disable-prompt-on-repost \
    --disable-application-cache \
    --disable-password-generation \
    --disable-save-password-bubble \
    --disable-single-click-autofill \
    --disable-ipc-flooding-protection \
    --disable-background-timer-throttling \
    --disable-search-engine-choice-screen \
    --disable-background-networking \
    --disable-backgrounding-occluded-windows \
    --disable-client-side-phishing-detection \
    --disable-device-discovery-notifications \
    --disable-top-sites \
    --disable-translate \
    --dns-prefetch-disable \
    --disable-renderer-backgrounding \
    --disable-features=IsolateOrigins,site-per-process,Translate,InsecureDownloadWarnings,DownloadBubble,DownloadBubbleV2,OptimizationTargetPrediction,OptimizationGuideModelDownloading,SidePanelPinning,UserAgentClientHint,PrivacySandboxSettings4,OptimizationHintsFetching,InterestFeedContentSuggestions,ComponentUpdater,NetworkPrediction,DisableLoadExtensionCommandLineSwitch,WebAuthentication,OmniboxUIFeedback,OmniboxPopupShortcut,PasskeyAuth,MediaRouter,DialMediaRouteProvider,WebRtcHideLocalIpsWithMdns \
    > /tmp/sb_chrome.log 2>&1 &
  SB_CDP_PID=$!
}

# ---------------------------------------------------------------------------
# 1b. Start SeleniumBase UC CDP Worker (Stealth browser on :9223)
# ---------------------------------------------------------------------------
echo "🚀 Starting SeleniumBase UC stealth browser on :${SB_CDP_PORT}..."
start_sb_chrome

echo "⏳ Waiting for SeleniumBase CDP (:${SB_CDP_PORT}) to be ready..."
for i in $(seq 1 30); do
  if curl -s "http://127.0.0.1:${SB_CDP_PORT}/json/version" > /dev/null 2>&1; then
    echo "✅ SeleniumBase CDP is ready!"
    break
  fi
  if [ $i -eq 30 ]; then
    echo "❌ SeleniumBase CDP failed to start within 30 seconds:"
    cat /tmp/sb_chrome.log 2>/dev/null || true
    exit 1
  fi
  sleep 1
done

# ---------------------------------------------------------------------------
# 1c. Start FastAPI server (:8000)
# ---------------------------------------------------------------------------
echo "🚀 Starting Python FastAPI server on :8000..."
python3 worker_browser/worker_api.py > /tmp/worker_api.log 2>&1 &
API_PID=$!

echo "⏳ Waiting for FastAPI to be ready..."
for i in $(seq 1 30); do
  if curl -s "http://127.0.0.1:8000/health" > /dev/null 2>&1; then
    echo "✅ FastAPI is ready!"
    break
  fi
  if [ $i -eq 30 ]; then
    echo "❌ FastAPI failed to start within 30 seconds:"
    cat /tmp/worker_api.log 2>/dev/null || true
    exit 1
  fi
  sleep 1
done

# ---------------------------------------------------------------------------
# 2. Start cloudflared tunnels
# ---------------------------------------------------------------------------
echo "🌐 Starting cloudflared tunnel for Puppeteer CDP port ${CDP_PORT}..."

TUNNEL_LOG="/tmp/cloudflared-tunnel.log"
cloudflared tunnel --url "http://127.0.0.1:${CDP_PORT}" --http-host-header "localhost" > "$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!

# Wait for tunnel URL to appear in logs
for i in $(seq 1 30); do
  TUNNEL_URL=$(grep -oP 'https://[-0-9a-z]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1 || true)
  if [ -n "$TUNNEL_URL" ]; then
    echo "✅ Puppeteer CDP Tunnel URL: $TUNNEL_URL"
    break
  fi
  if [ $i -eq 30 ]; then
    echo "❌ Puppeteer CDP tunnel failed to start within 30 seconds:"
    cat "$TUNNEL_LOG" 2>/dev/null || true
    exit 1
  fi
  sleep 1
done

echo "🌐 Starting cloudflared tunnel for SeleniumBase CDP port ${SB_CDP_PORT}..."
TUNNEL_SB_CDP_LOG="/tmp/cloudflared-sb-cdp-tunnel.log"
cloudflared tunnel --url "http://127.0.0.1:${SB_CDP_PORT}" --http-host-header "localhost" > "$TUNNEL_SB_CDP_LOG" 2>&1 &
TUNNEL_SB_CDP_PID=$!

for i in $(seq 1 30); do
  TUNNEL_SB_CDP_URL=$(grep -oP 'https://[-0-9a-z]+\.trycloudflare\.com' "$TUNNEL_SB_CDP_LOG" 2>/dev/null | head -1 || true)
  if [ -n "$TUNNEL_SB_CDP_URL" ]; then
    echo "✅ SeleniumBase CDP Tunnel URL: $TUNNEL_SB_CDP_URL"
    break
  fi
  if [ $i -eq 30 ]; then
    echo "❌ SeleniumBase CDP tunnel failed to start within 30 seconds:"
    cat "$TUNNEL_SB_CDP_LOG" 2>/dev/null || true
    exit 1
  fi
  sleep 1
done

echo "🌐 Starting cloudflared tunnel for FastAPI port 8000..."
TUNNEL_API_LOG="/tmp/cloudflared-api-tunnel.log"
cloudflared tunnel --url "http://127.0.0.1:8000" > "$TUNNEL_API_LOG" 2>&1 &
TUNNEL_API_PID=$!

# Wait for tunnel URL to appear in logs
for i in $(seq 1 30); do
  TUNNEL_API_URL=$(grep -oP 'https://[-0-9a-z]+\.trycloudflare\.com' "$TUNNEL_API_LOG" 2>/dev/null | head -1 || true)
  if [ -n "$TUNNEL_API_URL" ]; then
    break
  fi
  if [ $i -eq 30 ]; then
    echo "❌ FastAPI tunnel failed to start within 30 seconds:"
    cat "$TUNNEL_API_LOG" 2>/dev/null || true
    exit 1
  fi
  sleep 1
done

# Pre-warm: open about:blank tab so CDP is ready
echo "🔥 Pre-warming browser tabs..."
curl -s "http://127.0.0.1:${CDP_PORT}/json/new?about:blank" > /dev/null || true
curl -s "http://127.0.0.1:${SB_CDP_PORT}/json/new?about:blank" > /dev/null || true

# ---------------------------------------------------------------------------
# 3. Register with main dashboard
# ---------------------------------------------------------------------------
echo "📡 Registering with dashboard at ${WEBHOOK_URL}..."

REGISTERED=false
HTTP_CODE="000"
for attempt in $(seq 1 20); do
  HTTP_CODE=$(curl -s -o /tmp/register-resp.txt -w "%{http_code}" --max-time 15 \
    -X POST "$WEBHOOK_URL" \
    -H "Content-Type: application/json" \
    -d "{\"event\":\"register\",\"workerId\":\"${WORKER_ID}\",\"cdpUrl\":\"${TUNNEL_URL}\",\"sbCdpUrl\":\"${TUNNEL_SB_CDP_URL}\",\"seleniumCdpUrl\":\"${TUNNEL_SB_CDP_URL}\",\"apiUrl\":\"${TUNNEL_API_URL}\",\"runId\":\"${GITHUB_RUN_ID:-}\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" \
    2>/dev/null || echo "000")

  if [ "$HTTP_CODE" = "200" ]; then
    REGISTERED=true
    echo "✅ Successfully registered worker ${WORKER_ID} with dashboard!"
    break
  fi

  echo "⚠️ Registration attempt ${attempt} failed with status code ${HTTP_CODE}. Retrying..."
  BACKOFF=$(( 5 * (2 ** (attempt - 1)) ))
  [ $BACKOFF -gt 60 ] && BACKOFF=60
  sleep "$BACKOFF"
done

if [ "$REGISTERED" != "true" ]; then
  echo "❌ Registration failed with status code: ${HTTP_CODE}"
  cat /tmp/register-resp.txt 2>/dev/null || true
  exit 1
fi

# ---------------------------------------------------------------------------
# 4. Heartbeat loop (with process watchdog & auto-recovery)
# ---------------------------------------------------------------------------
echo "💓 Starting heartbeat loop (every ${HEARTBEAT_INTERVAL}s, max runtime ${MAX_RUNTIME}s)..."

START_TIME=$(date +%s)
CONSECUTIVE_FAILURES=0
MAX_CONSECUTIVE_FAILURES=10

while true; do
  ELAPSED=$(( $(date +%s) - START_TIME ))
  if [ $ELAPSED -ge $MAX_RUNTIME ]; then
    echo "⏰ Max runtime (${MAX_RUNTIME}s) reached. Exiting gracefully."
    break
  fi

  # ── Watchdog 1: Chrome (Puppeteer) ──────────────────────────────────────
  if ! kill -0 "$CHROME_PID" 2>/dev/null; then
    echo "⚠️ Chrome process PID $CHROME_PID died! Restarting Chrome..."
    google-chrome-stable \
      --headless=new \
      --no-sandbox \
      --disable-dev-shm-usage \
      --disable-gpu \
      --remote-debugging-port=${CDP_PORT} \
      --remote-debugging-address=0.0.0.0 \
      --remote-allow-origins=* \
      --user-data-dir=/tmp/chrome-user-data \
      --disable-background-networking \
      --disable-extensions \
      --disable-sync \
      --no-first-run \
      --disable-default-apps \
      &
    CHROME_PID=$!
  fi

  # ── Watchdog 1b: SeleniumBase UC CDP ────────────────────────────────────
  if ! kill -0 "$SB_CDP_PID" 2>/dev/null; then
    echo "⚠️ SeleniumBase Chrome process PID $SB_CDP_PID died! Restarting SeleniumBase Chrome..."
    start_sb_chrome
  fi

  # ── Watchdog 2: FastAPI ─────────────────────────────────────────────────
  if ! kill -0 "$API_PID" 2>/dev/null; then
    echo "⚠️ FastAPI server PID $API_PID died! Restarting FastAPI..."
    python3 worker_browser/worker_api.py > /tmp/worker_api.log 2>&1 &
    API_PID=$!
  fi

  # ── Watchdog 3: CDP Tunnel ──────────────────────────────────────────────
  NEED_REREGISTER=false
  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    echo "⚠️ CDP Tunnel PID $TUNNEL_PID died! Restarting CDP tunnel..."
    cloudflared tunnel --url "http://127.0.0.1:${CDP_PORT}" --http-host-header "localhost" > "$TUNNEL_LOG" 2>&1 &
    TUNNEL_PID=$!
    for i in $(seq 1 15); do
      NEW_URL=$(grep -oP 'https://[-0-9a-z]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1 || true)
      if [ -n "$NEW_URL" ]; then
        TUNNEL_URL="$NEW_URL"
        echo "✅ New CDP Tunnel URL: $TUNNEL_URL"
        NEED_REREGISTER=true
        break
      fi
      sleep 1
    done
  fi

  # ── Watchdog 3b: SeleniumBase CDP Tunnel ─────────────────────────────────
  if ! kill -0 "$TUNNEL_SB_CDP_PID" 2>/dev/null; then
    echo "⚠️ SeleniumBase CDP Tunnel PID $TUNNEL_SB_CDP_PID died! Restarting SB CDP tunnel..."
    cloudflared tunnel --url "http://127.0.0.1:${SB_CDP_PORT}" --http-host-header "localhost" > "$TUNNEL_SB_CDP_LOG" 2>&1 &
    TUNNEL_SB_CDP_PID=$!
    for i in $(seq 1 15); do
      NEW_SB_URL=$(grep -oP 'https://[-0-9a-z]+\.trycloudflare\.com' "$TUNNEL_SB_CDP_LOG" 2>/dev/null | head -1 || true)
      if [ -n "$NEW_SB_URL" ]; then
        TUNNEL_SB_CDP_URL="$NEW_SB_URL"
        echo "✅ New SeleniumBase CDP Tunnel URL: $TUNNEL_SB_CDP_URL"
        NEED_REREGISTER=true
        break
      fi
      sleep 1
    done
  fi

  # ── Watchdog 4: FastAPI Tunnel ──────────────────────────────────────────
  if ! kill -0 "$TUNNEL_API_PID" 2>/dev/null; then
    echo "⚠️ FastAPI Tunnel PID $TUNNEL_API_PID died! Restarting FastAPI tunnel..."
    cloudflared tunnel --url "http://127.0.0.1:8000" > "$TUNNEL_API_LOG" 2>&1 &
    TUNNEL_API_PID=$!
    for i in $(seq 1 15); do
      NEW_API_URL=$(grep -oP 'https://[-0-9a-z]+\.trycloudflare\.com' "$TUNNEL_API_LOG" 2>/dev/null | head -1 || true)
      if [ -n "$NEW_API_URL" ]; then
        TUNNEL_API_URL="$NEW_API_URL"
        echo "✅ New FastAPI Tunnel URL: $TUNNEL_API_URL"
        NEED_REREGISTER=true
        break
      fi
      sleep 1
    done
  fi

  if [ "$NEED_REREGISTER" = "true" ]; then
    echo "📡 Re-registering worker with updated tunnel URLs..."
    curl -s -o /dev/null --max-time 15 \
      -X POST "$WEBHOOK_URL" \
      -H "Content-Type: application/json" \
      -d "{\"event\":\"register\",\"workerId\":\"${WORKER_ID}\",\"cdpUrl\":\"${TUNNEL_URL}\",\"sbCdpUrl\":\"${TUNNEL_SB_CDP_URL}\",\"seleniumCdpUrl\":\"${TUNNEL_SB_CDP_URL}\",\"apiUrl\":\"${TUNNEL_API_URL}\",\"runId\":\"${GITHUB_RUN_ID:-}\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" \
      2>/dev/null || true
  fi

  sleep "$HEARTBEAT_INTERVAL"

  # Send heartbeat
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 \
    -X POST "$WEBHOOK_URL" \
    -H "Content-Type: application/json" \
    -d "{\"event\":\"heartbeat\",\"workerId\":\"${WORKER_ID}\",\"cdpUrl\":\"${TUNNEL_URL}\",\"sbCdpUrl\":\"${TUNNEL_SB_CDP_URL}\",\"seleniumCdpUrl\":\"${TUNNEL_SB_CDP_URL}\",\"apiUrl\":\"${TUNNEL_API_URL}\",\"runId\":\"${GITHUB_RUN_ID:-}\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" \
    2>/dev/null || echo "000")

  if [ "$HTTP_CODE" = "200" ]; then
    CONSECUTIVE_FAILURES=0
  elif [ "$HTTP_CODE" = "404" ]; then
    # Dashboard doesn't know us — re-register
    echo "⚠️ Dashboard returned 404 for heartbeat. Re-registering worker..."
    curl -s -o /dev/null --max-time 15 \
      -X POST "$WEBHOOK_URL" \
      -H "Content-Type: application/json" \
      -d "{\"event\":\"register\",\"workerId\":\"${WORKER_ID}\",\"cdpUrl\":\"${TUNNEL_URL}\",\"sbCdpUrl\":\"${TUNNEL_SB_CDP_URL}\",\"seleniumCdpUrl\":\"${TUNNEL_SB_CDP_URL}\",\"apiUrl\":\"${TUNNEL_API_URL}\",\"runId\":\"${GITHUB_RUN_ID:-}\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" \
      2>/dev/null || true
    CONSECUTIVE_FAILURES=0
  else
    CONSECUTIVE_FAILURES=$(( CONSECUTIVE_FAILURES + 1 ))
    echo "⚠️ Heartbeat failed with status code ${HTTP_CODE} (attempt ${CONSECUTIVE_FAILURES}/${MAX_CONSECUTIVE_FAILURES})."
    if [ $CONSECUTIVE_FAILURES -ge $MAX_CONSECUTIVE_FAILURES ]; then
      echo "❌ Too many consecutive heartbeat failures. Exiting loop."
      break
    fi
  fi
done

# Cleanup is handled by the trap
