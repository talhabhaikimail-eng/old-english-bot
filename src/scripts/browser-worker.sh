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
VSCODE_PORT="${VSCODE_PORT:-8088}"
SSH_PORT="${SSH_PORT:-2222}"
SSH_USER="${SSH_USER:-$(whoami 2>/dev/null || echo "runner")}"
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
VSCODE_PID=""
TUNNEL_VSCODE_PID=""
TUNNEL_VSCODE_URL=""
VSCODE_PASSWORD=""
SSH_PID=""
TUNNEL_SSH_PID=""
TUNNEL_SSH_URL=""
SSH_PASSWORD=""
SSH_COMMAND=""

# ---------------------------------------------------------------------------
# Webhook Helper Function
# ---------------------------------------------------------------------------
send_webhook() {
  local event="$1"
  local max_time="${2:-15}"
  local is_agy=false
  command -v agy >/dev/null 2>&1 && is_agy=true

  local shell_ws_url=""
  if [ -n "$TUNNEL_API_URL" ]; then
    shell_ws_url="$(echo "$TUNNEL_API_URL" | sed 's|^http|ws|')/ws/shell"
  fi

  local has_agy_auth=false
  if [ -s "$HOME/.gemini/antigravity-cli/antigravity-oauth-token" ] || [ -n "${ANTIGRAVITY_CLI_OAUTH_JSON:-}" ]; then
    has_agy_auth=true
  fi

  local json_data
  json_data=$(cat <<EOF
{
  "event": "${event}",
  "workerId": "${WORKER_ID}",
  "cdpUrl": "${TUNNEL_URL}",
  "sbCdpUrl": "${TUNNEL_SB_CDP_URL}",
  "seleniumCdpUrl": "${TUNNEL_SB_CDP_URL}",
  "apiUrl": "${TUNNEL_API_URL}",
  "shellWsUrl": "${shell_ws_url}",
  "vscodeUrl": "${TUNNEL_VSCODE_URL}",
  "vscodePassword": "${VSCODE_PASSWORD}",
  "sshUrl": "${TUNNEL_SSH_URL}",
  "sshPort": ${SSH_PORT},
  "sshUser": "${SSH_USER}",
  "sshPassword": "${SSH_PASSWORD}",
  "sshCommand": "${SSH_COMMAND}",
  "antigravityCli": ${is_agy},
  "antigravityAuth": ${has_agy_auth},
  "courseWorkerUrl": "${TUNNEL_COURSE_WORKER_URL:-}",
  "runId": "${GITHUB_RUN_ID:-}",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
)
  curl -s -o /tmp/webhook-resp.txt -w "%{http_code}" --max-time "$max_time" \
    -X POST "$WEBHOOK_URL" \
    -H "Content-Type: application/json" \
    -d "$json_data" 2>/dev/null || echo "000"
}

# ---------------------------------------------------------------------------
# Cleanup handler
# ---------------------------------------------------------------------------
cleanup() {
  EXIT_CODE=$?
  echo "🧹 Cleaning up worker processes (Exit code: $EXIT_CODE)..."

  # Best-effort deregister
  if [ -n "$TUNNEL_URL" ] || [ -n "$TUNNEL_SB_CDP_URL" ] || [ -n "$TUNNEL_VSCODE_URL" ]; then
    for attempt in 1 2 3; do
      HTTP_CODE=$(send_webhook "deregister" 10)
      if [ "$HTTP_CODE" = "200" ]; then
        break
      fi
      sleep 3
    done
  fi

  # Kill child processes
  [ -n "$TUNNEL_SSH_PID" ] && kill "$TUNNEL_SSH_PID" 2>/dev/null || true
  [ -n "$SSH_PID" ] && kill "$SSH_PID" 2>/dev/null || true
  [ -n "$TUNNEL_VSCODE_PID" ] && kill "$TUNNEL_VSCODE_PID" 2>/dev/null || true
  [ -n "$VSCODE_PID" ] && kill "$VSCODE_PID" 2>/dev/null || true
  [ -n "$TUNNEL_CW_PID" ] && kill "$TUNNEL_CW_PID" 2>/dev/null || true
  [ -n "$CW_PID" ] && kill "$CW_PID" 2>/dev/null || true
  [ -n "$TUNNEL_SB_CDP_PID" ] && kill "$TUNNEL_SB_CDP_PID" 2>/dev/null || true
  [ -n "$SB_CDP_PID" ] && kill "$SB_CDP_PID" 2>/dev/null || true
  [ -n "$TUNNEL_API_PID" ] && kill "$TUNNEL_API_PID" 2>/dev/null || true
  [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null || true
  [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null || true
  [ -n "$CHROME_PID" ] && kill "$CHROME_PID" 2>/dev/null || true
  [ -n "$XVFB_PID" ] && kill "$XVFB_PID" 2>/dev/null || true
  rm -f /tmp/vscode-info.json /tmp/vscode_url /tmp/vscode_password 2>/dev/null || true
  rm -f /tmp/ssh-info.json /tmp/ssh_info.json /tmp/ssh_url /tmp/ssh_password 2>/dev/null || true
  rm -rf /tmp/course_jobs /tmp/jobs 2>/dev/null || true

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
# 0b. Verify/Install Web VS Code (code-server) & Antigravity CLI
# ---------------------------------------------------------------------------
if ! command -v code-server >/dev/null 2>&1; then
  echo "📦 Installing code-server (Web VS Code)..."
  curl -fsSL https://code-server.dev/install.sh | sh 2>/dev/null || npm install -g code-server 2>/dev/null || true
fi

if ! command -v agy >/dev/null 2>&1; then
  echo "📦 Installing Antigravity CLI..."
  curl -fsSL https://antigravity.google/cli/install.sh | bash 2>/dev/null || true
  for p in "$HOME/.local/bin" "$HOME/.antigravity/bin" "/usr/local/bin"; do
    if [ -d "$p" ] && [[ ":$PATH:" != *":$p:"* ]]; then
      export PATH="$p:$PATH"
    fi
  done
fi

# ---------------------------------------------------------------------------
# 0c. Configure Antigravity CLI (agy) Authentication Token
# ---------------------------------------------------------------------------
setup_antigravity_auth() {
  echo "🔑 Checking Antigravity CLI authentication configuration..."

  # If not in env, attempt to read from local .env
  if [ -z "${ANTIGRAVITY_CLI_OAUTH_JSON:-}" ] && [ -f ".env" ]; then
    ANTIGRAVITY_CLI_OAUTH_JSON="$(grep -E '^ANTIGRAVITY_CLI_OAUTH_JSON=' .env 2>/dev/null | head -1 | sed -E "s/^ANTIGRAVITY_CLI_OAUTH_JSON=['\"]?//" | sed -E "s/['\"]?$//" || true)"
    export ANTIGRAVITY_CLI_OAUTH_JSON
  fi

  if [ -z "${ANTIGRAVITY_CLI_OAUTH_JSON:-}" ]; then
    echo "ℹ️ No ANTIGRAVITY_CLI_OAUTH_JSON defined in environment or .env; skipping token setup."
    return 0
  fi

  local auth_json="$ANTIGRAVITY_CLI_OAUTH_JSON"

  # Target locations for user homes across runner VM users
  local target_homes=("$HOME")
  [ -d "/home/runner" ] && [ "/home/runner" != "$HOME" ] && target_homes+=("/home/runner")
  [ -d "/root" ] && [ "/root" != "$HOME" ] && target_homes+=("/root")

  for h in "${target_homes[@]}"; do
    local agy_dir="$h/.gemini/antigravity-cli"
    mkdir -p "$agy_dir" 2>/dev/null || sudo mkdir -p "$agy_dir" 2>/dev/null || true
    echo "$auth_json" > "$agy_dir/antigravity-oauth-token" 2>/dev/null || sudo bash -c "echo '$auth_json' > '$agy_dir/antigravity-oauth-token'" 2>/dev/null || true
    chmod 600 "$agy_dir/antigravity-oauth-token" 2>/dev/null || sudo chmod 600 "$agy_dir/antigravity-oauth-token" 2>/dev/null || true
    if [ -d "/home/runner" ] && [ "$h" = "/home/runner" ]; then
      sudo chown -R runner:runner "$h/.gemini" 2>/dev/null || true
    fi
  done

  # Export globally and persist to shell profiles for all future sessions & SSH
  export ANTIGRAVITY_CLI_OAUTH_JSON="$auth_json"

  if [ -f "$HOME/.bashrc" ]; then
    grep -q "ANTIGRAVITY_CLI_OAUTH_JSON" "$HOME/.bashrc" 2>/dev/null || echo "export ANTIGRAVITY_CLI_OAUTH_JSON='$auth_json'" >> "$HOME/.bashrc"
  fi

  if [ -d "/home/runner" ] && [ -f "/home/runner/.bashrc" ]; then
    grep -q "ANTIGRAVITY_CLI_OAUTH_JSON" "/home/runner/.bashrc" 2>/dev/null || echo "export ANTIGRAVITY_CLI_OAUTH_JSON='$auth_json'" >> "/home/runner/.bashrc" 2>/dev/null || true
  fi

  if [ -d "/etc/profile.d" ]; then
    sudo bash -c "echo 'export ANTIGRAVITY_CLI_OAUTH_JSON=\"$auth_json\"' > /etc/profile.d/antigravity.sh" 2>/dev/null || true
  fi

  echo "✅ Antigravity CLI auth token successfully configured from .env in ~/.gemini/antigravity-cli/antigravity-oauth-token"
}

setup_antigravity_auth


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
# 1d. Start Web VS Code (code-server on :${VSCODE_PORT})
# ---------------------------------------------------------------------------
write_vscode_state() {
  local url="${1:-${TUNNEL_VSCODE_URL:-}}"
  local pwd="${2:-${VSCODE_PASSWORD:-}}"
  local port="${3:-${VSCODE_PORT:-8088}}"

  [ -n "$pwd" ] && echo "$pwd" > /tmp/vscode_password
  [ -n "$url" ] && echo "$url" > /tmp/vscode_url
  cat <<EOF > /tmp/vscode-info.json
{
  "url": "${url}",
  "password": "${pwd}",
  "port": ${port},
  "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
}

if [ -z "${VSCODE_PASSWORD:-}" ]; then
  VSCODE_PASSWORD="$(head -c 8 /dev/urandom 2>/dev/null | xxd -p 2>/dev/null || openssl rand -hex 8 2>/dev/null || python3 -c 'import secrets; print(secrets.token_hex(8))' 2>/dev/null || echo "vsc-$(date +%s)")"
fi
export VSCODE_PASSWORD
write_vscode_state "" "$VSCODE_PASSWORD" "$VSCODE_PORT"

start_vscode() {
  mkdir -p /tmp/vscode-data
  PASSWORD="${VSCODE_PASSWORD}" code-server \
    --bind-addr 0.0.0.0:${VSCODE_PORT} \
    --auth password \
    --user-data-dir /tmp/vscode-data \
    --disable-telemetry \
    --disable-update-check \
    "${PWD}" > /tmp/vscode.log 2>&1 &
  VSCODE_PID=$!
}

if command -v code-server >/dev/null 2>&1; then
  echo "🚀 Starting Web VS Code (code-server) on :${VSCODE_PORT}..."
  start_vscode
  echo "Web VS Code started (PID: $VSCODE_PID)"

  echo "⏳ Waiting for Web VS Code to be ready..."
  for i in $(seq 1 30); do
    if curl -s "http://127.0.0.1:${VSCODE_PORT}/healthz" > /dev/null 2>&1 || curl -s "http://127.0.0.1:${VSCODE_PORT}" > /dev/null 2>&1; then
      echo "✅ Web VS Code is ready!"
      break
    fi
    if [ $i -eq 30 ]; then
      echo "⚠️ Web VS Code failed to respond on port ${VSCODE_PORT} within 30 seconds"
      cat /tmp/vscode.log 2>/dev/null || true
    fi
    sleep 1
  done
else
  echo "⚠️ code-server command not found; skipping Web VS Code launch."
fi

# ---------------------------------------------------------------------------
# 1e. Start Go Course Worker server (:8085)
# ---------------------------------------------------------------------------
CW_BIN="./bin/course-worker"
if [ ! -f "$CW_BIN" ]; then
  CW_BIN="$(command -v course-worker 2>/dev/null || echo "")"
fi

if [ -n "$CW_BIN" ] && [ -x "$CW_BIN" ]; then
  echo "🧹 Wiping stale course worker jobs directory for clean slate..."
  rm -rf /tmp/course_jobs /tmp/jobs 2>/dev/null || true
  mkdir -p /tmp/course_jobs

  echo "🚀 Starting Go Course Worker server on :8085..."
  $CW_BIN serve --port 8085 --concurrency "${MAX_CONCURRENT_COURSES:-2}" > /tmp/course-worker.log 2>&1 &
  CW_PID=$!
  echo "Go Course Worker started (PID: $CW_PID)"

  echo "⏳ Waiting for Go Course Worker to be ready..."
  for i in $(seq 1 15); do
    if curl -s "http://127.0.0.1:8085/worker/status" > /dev/null 2>&1; then
      echo "✅ Go Course Worker is ready!"
      break
    fi
    sleep 1
  done
else
  echo "⚠️ Go Course Worker binary not found at $CW_BIN; skipping Course Worker launch."
fi

# ---------------------------------------------------------------------------
# 1f. Configure and start OpenSSH Server (:2222)
# ---------------------------------------------------------------------------
write_ssh_state() {
  local url="${1:-${TUNNEL_SSH_URL:-}}"
  local pwd="${2:-${SSH_PASSWORD:-}}"
  local port="${3:-${SSH_PORT:-2222}}"
  local user="${4:-${SSH_USER:-runner}}"
  local cmd="${5:-${SSH_COMMAND:-}}"

  [ -n "$pwd" ] && echo "$pwd" > /tmp/ssh_password
  [ -n "$url" ] && echo "$url" > /tmp/ssh_url
  cat <<EOF > /tmp/ssh-info.json
{
  "url": "${url}",
  "password": "${pwd}",
  "port": ${port},
  "user": "${user}",
  "command": "${cmd}",
  "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
  cp /tmp/ssh-info.json /tmp/ssh_info.json 2>/dev/null || true
}

if [ -z "${SSH_PASSWORD:-}" ]; then
  SSH_PASSWORD="$(head -c 8 /dev/urandom 2>/dev/null | xxd -p 2>/dev/null || openssl rand -hex 8 2>/dev/null || echo "ssh-$(date +%s)")"
fi
export SSH_PASSWORD
SSH_COMMAND="ssh -p ${SSH_PORT} ${SSH_USER}@localhost"
write_ssh_state "" "$SSH_PASSWORD" "$SSH_PORT" "$SSH_USER" "$SSH_COMMAND"

start_sshd() {
  if [ "$(uname -s)" = "Linux" ]; then
    if ! command -v sshd >/dev/null 2>&1; then
      echo "📦 Installing OpenSSH server..."
      sudo apt-get update -y && sudo apt-get install -y openssh-server 2>/dev/null || true
    fi

    if command -v sshd >/dev/null 2>&1; then
      echo "🚀 Configuring OpenSSH server on port ${SSH_PORT}..."
      sudo mkdir -p /var/run/sshd /etc/ssh
      echo "${SSH_USER}:${SSH_PASSWORD}" | sudo chpasswd 2>/dev/null || true
      sudo ssh-keygen -A 2>/dev/null || true

      sudo /usr/sbin/sshd -p "${SSH_PORT}" \
        -o "PasswordAuthentication=yes" \
        -o "PermitRootLogin=yes" \
        -o "ChallengeResponseAuthentication=no" \
        -o "UsePAM=yes" \
        > /tmp/sshd.log 2>&1 &
      SSH_PID=$!
      echo "OpenSSH server started (PID: $SSH_PID)"
    fi
  fi
}
start_sshd

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
    echo "✅ Puppeteer CDP Tunnel established."
    break
  fi
  if [ $i -eq 30 ]; then
    echo "❌ Puppeteer CDP tunnel failed to start within 30 seconds."
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
    echo "✅ SeleniumBase CDP Tunnel established."
    break
  fi
  if [ $i -eq 30 ]; then
    echo "❌ SeleniumBase CDP tunnel failed to start within 30 seconds."
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
    echo "✅ FastAPI Tunnel established."
    break
  fi
  if [ $i -eq 30 ]; then
    echo "❌ FastAPI tunnel failed to start within 30 seconds."
    exit 1
  fi
  sleep 1
done

if [ -n "$VSCODE_PID" ]; then
  echo "🌐 Starting cloudflared tunnel for Web VS Code port ${VSCODE_PORT}..."
  TUNNEL_VSCODE_LOG="/tmp/cloudflared-vscode-tunnel.log"
  cloudflared tunnel --url "http://127.0.0.1:${VSCODE_PORT}" > "$TUNNEL_VSCODE_LOG" 2>&1 &
  TUNNEL_VSCODE_PID=$!

  for i in $(seq 1 30); do
    TUNNEL_VSCODE_URL=$(grep -oP 'https://[-0-9a-z]+\.trycloudflare\.com' "$TUNNEL_VSCODE_LOG" 2>/dev/null | head -1 || true)
    if [ -n "$TUNNEL_VSCODE_URL" ]; then
      echo "✅ Web VS Code Tunnel established."
      break
    fi
    if [ $i -eq 30 ]; then
      echo "⚠️ Web VS Code tunnel took longer than 30 seconds to initialize."
    fi
    sleep 1
  done
  export VSCODE_URL="$TUNNEL_VSCODE_URL"
  write_vscode_state "$TUNNEL_VSCODE_URL" "$VSCODE_PASSWORD" "$VSCODE_PORT"
fi

if [ -n "$CW_PID" ]; then
  echo "🌐 Starting cloudflared tunnel for Go Course Worker port 8085..."
  TUNNEL_CW_LOG="/tmp/cloudflared-course-worker-tunnel.log"
  cloudflared tunnel --url "http://127.0.0.1:8085" > "$TUNNEL_CW_LOG" 2>&1 &
  TUNNEL_CW_PID=$!

  for i in $(seq 1 30); do
    TUNNEL_COURSE_WORKER_URL=$(grep -oP 'https://[-0-9a-z]+\.trycloudflare\.com' "$TUNNEL_CW_LOG" 2>/dev/null | head -1 || true)
    if [ -n "$TUNNEL_COURSE_WORKER_URL" ]; then
      echo "✅ Go Course Worker Tunnel established."
      break
    fi
    if [ $i -eq 30 ]; then
      echo "⚠️ Go Course Worker tunnel took longer than 30 seconds to initialize."
    fi
    sleep 1
  done
  export COURSE_WORKER_URL="$TUNNEL_COURSE_WORKER_URL"
fi

if [ -n "$SSH_PID" ] || command -v sshd >/dev/null 2>&1; then
  echo "🌐 Starting cloudflared tunnel for SSH port ${SSH_PORT}..."
  TUNNEL_SSH_LOG="/tmp/cloudflared-ssh-tunnel.log"
  cloudflared tunnel --url "tcp://127.0.0.1:${SSH_PORT}" > "$TUNNEL_SSH_LOG" 2>&1 &
  TUNNEL_SSH_PID=$!

  for i in $(seq 1 30); do
    TUNNEL_SSH_URL=$(grep -oP 'tcp://[-0-9a-z]+\.trycloudflare\.com:[0-9]+|https://[-0-9a-z]+\.trycloudflare\.com' "$TUNNEL_SSH_LOG" 2>/dev/null | head -1 || true)
    if [ -n "$TUNNEL_SSH_URL" ]; then
      echo "✅ SSH Tunnel established."
      clean_host="${TUNNEL_SSH_URL#*://}"
      if [[ "$clean_host" == *":"* ]]; then
        SSH_HOST="${clean_host%%:*}"
        SSH_REMOTE_PORT="${clean_host##*:}"
        SSH_COMMAND="ssh -p ${SSH_REMOTE_PORT} ${SSH_USER}@${SSH_HOST}"
      else
        SSH_COMMAND="cloudflared access ssh --hostname ${clean_host}"
      fi
      break
    fi
    sleep 1
  done
  write_ssh_state "$TUNNEL_SSH_URL" "$SSH_PASSWORD" "$SSH_PORT" "$SSH_USER" "$SSH_COMMAND"
fi

# Pre-warm: open about:blank tab so CDP is ready
echo "🔥 Pre-warming browser tabs..."
curl -s "http://127.0.0.1:${CDP_PORT}/json/new?about:blank" > /dev/null || true
curl -s "http://127.0.0.1:${SB_CDP_PORT}/json/new?about:blank" > /dev/null || true

# ---------------------------------------------------------------------------
# 3. Register with main dashboard
# ---------------------------------------------------------------------------
echo "📡 Registering worker ${WORKER_ID} with dashboard..."

REGISTERED=false
HTTP_CODE="000"
for attempt in $(seq 1 20); do
  HTTP_CODE=$(send_webhook "register" 15)

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
  cat /tmp/webhook-resp.txt 2>/dev/null || true
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

  # ── Watchdog 2b: Web VS Code (code-server) ──────────────────────────────
  if [ -n "$VSCODE_PID" ] && ! kill -0 "$VSCODE_PID" 2>/dev/null; then
    echo "⚠️ Web VS Code process PID $VSCODE_PID died! Restarting code-server..."
    start_vscode
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
        echo "✅ CDP Tunnel refreshed."
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
        echo "✅ SeleniumBase CDP Tunnel refreshed."
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
        echo "✅ FastAPI Tunnel refreshed."
        NEED_REREGISTER=true
        break
      fi
      sleep 1
    done
  fi

  # ── Watchdog 4b: Web VS Code Tunnel ─────────────────────────────────────
  if [ -n "$TUNNEL_VSCODE_PID" ] && ! kill -0 "$TUNNEL_VSCODE_PID" 2>/dev/null; then
    echo "⚠️ Web VS Code Tunnel PID $TUNNEL_VSCODE_PID died! Restarting VS Code tunnel..."
    cloudflared tunnel --url "http://127.0.0.1:${VSCODE_PORT}" > "$TUNNEL_VSCODE_LOG" 2>&1 &
    TUNNEL_VSCODE_PID=$!
    for i in $(seq 1 15); do
      NEW_VSCODE_URL=$(grep -oP 'https://[-0-9a-z]+\.trycloudflare\.com' "$TUNNEL_VSCODE_LOG" 2>/dev/null | head -1 || true)
      if [ -n "$NEW_VSCODE_URL" ]; then
        TUNNEL_VSCODE_URL="$NEW_VSCODE_URL"
        export VSCODE_URL="$TUNNEL_VSCODE_URL"
        write_vscode_state "$TUNNEL_VSCODE_URL" "$VSCODE_PASSWORD" "$VSCODE_PORT"
        echo "✅ Web VS Code Tunnel refreshed."
        NEED_REREGISTER=true
        break
      fi
      sleep 1
    done
  fi

  # ── Watchdog 4c: SSH Server & Tunnel ─────────────────────────────────────
  if [ -n "$SSH_PID" ] && ! kill -0 "$SSH_PID" 2>/dev/null; then
    echo "⚠️ OpenSSH server PID $SSH_PID died! Restarting sshd..."
    start_sshd
  fi

  if [ -n "$TUNNEL_SSH_PID" ] && ! kill -0 "$TUNNEL_SSH_PID" 2>/dev/null; then
    echo "⚠️ SSH Tunnel PID $TUNNEL_SSH_PID died! Restarting SSH tunnel..."
    cloudflared tunnel --url "tcp://127.0.0.1:${SSH_PORT}" > "$TUNNEL_SSH_LOG" 2>&1 &
    TUNNEL_SSH_PID=$!
    for i in $(seq 1 15); do
      NEW_SSH_URL=$(grep -oP 'tcp://[-0-9a-z]+\.trycloudflare\.com:[0-9]+|https://[-0-9a-z]+\.trycloudflare\.com' "$TUNNEL_SSH_LOG" 2>/dev/null | head -1 || true)
      if [ -n "$NEW_SSH_URL" ]; then
        TUNNEL_SSH_URL="$NEW_SSH_URL"
        clean_host="${TUNNEL_SSH_URL#*://}"
        if [[ "$clean_host" == *":"* ]]; then
          SSH_HOST="${clean_host%%:*}"
          SSH_REMOTE_PORT="${clean_host##*:}"
          SSH_COMMAND="ssh -p ${SSH_REMOTE_PORT} ${SSH_USER}@${SSH_HOST}"
        else
          SSH_COMMAND="cloudflared access ssh --hostname ${clean_host}"
        fi
        write_ssh_state "$TUNNEL_SSH_URL" "$SSH_PASSWORD" "$SSH_PORT" "$SSH_USER" "$SSH_COMMAND"
        echo "✅ SSH Tunnel refreshed."
        NEED_REREGISTER=true
        break
      fi
      sleep 1
    done
  fi

  if [ "$NEED_REREGISTER" = "true" ]; then
    echo "📡 Re-registering worker with updated tunnel URLs..."
    send_webhook "register" 15 > /dev/null || true
  fi

  sleep "$HEARTBEAT_INTERVAL"

  # Send heartbeat
  HTTP_CODE=$(send_webhook "heartbeat" 15)

  if [ "$HTTP_CODE" = "200" ]; then
    CONSECUTIVE_FAILURES=0
  elif [ "$HTTP_CODE" = "404" ]; then
    # Dashboard doesn't know us — re-register
    echo "⚠️ Dashboard returned 404 for heartbeat. Re-registering worker..."
    send_webhook "register" 15 > /dev/null || true
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
