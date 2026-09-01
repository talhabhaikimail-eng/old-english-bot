#!/usr/bin/env python3
"""
sb_cdp_worker.py — Persistent SeleniumBase UC Stealth Browser Worker.

Runs a dedicated, stealth Chrome (SeleniumBase UC Mode flags) browser with
Chrome DevTools Protocol (CDP) enabled on port 9223 (default SB_CDP_PORT).

Exposes:
  - CDP HTTP endpoints: http://127.0.0.1:9223/json/version, /json/list, etc.
  - CDP WebSocket endpoint for remote Puppeteer / Playwright / SeleniumBase connections.
"""

import os
import sys
import time
import signal
import subprocess
import urllib.request
import json
import shutil

SB_CDP_PORT = int(os.environ.get("SB_CDP_PORT", "9223"))
SB_CDP_HOST = os.environ.get("SB_CDP_HOST", "0.0.0.0")
USER_DATA_DIR = os.environ.get("SB_USER_DATA_DIR", f"/tmp/sb-chrome-data-{SB_CDP_PORT}")

running = True

def handle_signal(signum, frame):
    global running
    print(f"[SB-CDP] Received signal {signum}, shutting down...")
    running = False

signal.signal(signal.SIGINT, handle_signal)
signal.signal(signal.SIGTERM, handle_signal)

def find_chrome():
    candidates = [
        "google-chrome-stable",
        "google-chrome",
        "chromium-browser",
        "chromium",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium-browser",
        "/usr/bin/chromium",
    ]
    for c in candidates:
        if shutil.which(c):
            return c
    return "google-chrome-stable"

def is_cdp_ready(port=SB_CDP_PORT):
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{port}/json/version", headers={"User-Agent": "HealthCheck"})
        with urllib.request.urlopen(req, timeout=2) as response:
            if response.status == 200:
                data = json.loads(response.read().decode())
                return "webSocketDebuggerUrl" in data or "Browser" in data
    except Exception:
        return False
    return False

def start_chrome_process():
    print(f"[SB-CDP] Starting SeleniumBase UC stealth browser on port {SB_CDP_PORT}...")
    os.makedirs(USER_DATA_DIR, exist_ok=True)
    chrome_bin = find_chrome()

    cmd = [
        chrome_bin,
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        f"--remote-debugging-port={SB_CDP_PORT}",
        f"--remote-debugging-address={SB_CDP_HOST}",
        "--remote-allow-origins=*",
        f"--user-data-dir={USER_DATA_DIR}",
        "--window-size=1400,900",
        "--window-position=10,10",
        "--no-first-run",
        "--no-default-browser-check",
        "--no-service-autorun",
        "--disable-auto-reload",
        "--homepage=about:blank",
        "--no-pings",
        "--enable-unsafe-extension-debugging",
        "--wm-window-animations-disabled",
        "--animation-duration-scale=0",
        "--enable-privacy-sandbox-ads-apis",
        "--safebrowsing-disable-download-protection",
        "--password-store=basic",
        "--deny-permission-prompts",
        "--disable-breakpad",
        "--disable-prompt-on-repost",
        "--disable-application-cache",
        "--disable-password-generation",
        "--disable-save-password-bubble",
        "--disable-single-click-autofill",
        "--disable-ipc-flooding-protection",
        "--disable-background-timer-throttling",
        "--disable-search-engine-choice-screen",
        "--disable-background-networking",
        "--disable-backgrounding-occluded-windows",
        "--disable-client-side-phishing-detection",
        "--disable-device-discovery-notifications",
        "--disable-top-sites",
        "--disable-translate",
        "--dns-prefetch-disable",
        "--disable-renderer-backgrounding",
        "--disable-features=IsolateOrigins,site-per-process,Translate,InsecureDownloadWarnings,DownloadBubble,DownloadBubbleV2,OptimizationTargetPrediction,OptimizationGuideModelDownloading,SidePanelPinning,UserAgentClientHint,PrivacySandboxSettings4,OptimizationHintsFetching,InterestFeedContentSuggestions,ComponentUpdater,NetworkPrediction,DisableLoadExtensionCommandLineSwitch,WebAuthentication,OmniboxUIFeedback,OmniboxPopupShortcut,PasskeyAuth,MediaRouter,DialMediaRouteProvider,WebRtcHideLocalIpsWithMdns",
    ]

    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True if sys.platform != "win32" else False
    )
    return proc

def main():
    global running
    print(f"🚀 [SB-CDP] SeleniumBase UC CDP Worker initializing on port {SB_CDP_PORT}...")

    proc = None
    try:
        proc = start_chrome_process()
        print(f"✅ [SB-CDP] Chrome process launched (PID: {proc.pid}). Waiting for CDP readiness...")

        for attempt in range(30):
            if is_cdp_ready(SB_CDP_PORT):
                print(f"✅ [SB-CDP] Chrome DevTools Protocol is ACTIVE on port {SB_CDP_PORT}!")
                break
            time.sleep(1)
        else:
            print(f"⚠️ [SB-CDP] Warning: CDP did not report ready within 30s.")

        # Keep alive loop with watchdog
        while running:
            time.sleep(5)
            # Check process status
            if proc.poll() is not None or not is_cdp_ready(SB_CDP_PORT):
                print(f"⚠️ [SB-CDP] Process died or CDP unresponsive on port {SB_CDP_PORT}! Restarting Chrome...")
                try:
                    if proc and proc.poll() is None:
                        proc.kill()
                except Exception:
                    pass
                time.sleep(2)
                proc = start_chrome_process()
                time.sleep(2)

    except Exception as e:
        print(f"❌ [SB-CDP] Error in worker: {e}", file=sys.stderr)
        raise
    finally:
        print(f"🧹 [SB-CDP] Cleaning up Chrome process...")
        if proc and proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=3)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
        print(f"👋 [SB-CDP] Worker exited.")

if __name__ == "__main__":
    main()
