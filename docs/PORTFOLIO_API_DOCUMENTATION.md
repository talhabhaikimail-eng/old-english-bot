# 🚀 Portfolio API & Cloud Sandbox Integration Guide

Unified, production-ready API documentation for embedding backend tools, cloud sandboxes, distributed web scrapers, and AI generation into your portfolio frontend at **[`talhacodes.site`](https://talhacodes.site)**.

---

## 📑 Table of Contents
1. [System Architecture](#system-architecture)
2. [Authentication & Security](#authentication--security)
3. [Interactive Tool Catalog](#interactive-tool-catalog)
4. [Endpoint Reference & Request/Response Schemas](#endpoint-reference)
   - [1. Tool Discovery & Suggestions](#1-tool-discovery--suggestions)
   - [2. Universal Media Downloader](#2-universal-media-downloader)
   - [3. YouTube Metadata Extractor](#3-youtube-metadata-extractor)
   - [4. Headless DuckDuckGo Search](#4-headless-duckduckgo-search)
   - [5. Google Places Leads Stream (SSE) & Batch](#5-google-places-leads-stream--batch)
   - [6. High-Throughput Go Contact Scraper](#6-high-throughput-go-contact-scraper)
   - [7. Go ATS Resume / CV PDF Builder](#7-go-ats-resume--cv-pdf-builder)
   - [8. Gemini AI Technical Blog Generator](#8-gemini-ai-technical-blog-generator)
   - [9. Sandboxed Polyglot Code Runner](#9-sandboxed-polyglot-code-runner)
   - [10. Browser Network CDP & Screencast](#10-browser-network-cdp--screencast)
   - [11. 5-Minute Container Sandbox (talhacodes.site)](#11-5-minute-container-sandbox)
5. [Frontend Integration Examples (React / TypeScript)](#frontend-integration-examples)
6. [Security & VPS Isolation Guarantees](#security--vps-isolation-guarantees)

---

## 🏗 System Architecture

```mermaid
graph TD
    Client["Portfolio Frontend (talhacodes.site)"] -->|HTTPS / WSS| Gateway["Node.js API Gateway (:4000)"]
    
    subgraph Core Services
        Gateway -->|Route /api/portfolio/*| PortAPI["Portfolio API Handler"]
        Gateway -->|Proxy :18080| GoManager["Go Container Engine"]
        Gateway -->|Proxy :8081| GoScraper["Go Contact Scraper"]
        Gateway -->|Proxy :8082| GoCV["Go CV Generator"]
        Gateway -->|CDP Session| BrowserPool["Distributed Browser Pool"]
    end
    
    subgraph Cloud Infrastructure
        GoManager -->|Spawns (5-min TTL)| Docker["Isolated Docker Sandboxes (VSCode / Terminal / Chromium)"]
        Docker -->|Tunnel & CNAME| CF["Cloudflare Named Tunnels (*.talhacodes.site)"]
        GoManager -->|State Backup| R2["Cloudflare R2 Bucket"]
    end
```

---

## 🔐 Authentication & Security

You can configure an optional API Key to protect portfolio action endpoints from abuse or unmetered external traffic.

### Configuration (`.env`)
```bash
# General system domain for permanent custom subdomains (e.g. sub-xxxx.ufone-claim.site)
MAIN_DOMAIN=ufone-claim.site

# Portfolio domain for 5-minute isolated demo sandboxes (e.g. demo-xxxx.talhacodes.site)
PORTFOLIO_DOMAIN=talhacodes.site

# Optional API Key protecting /api/portfolio/* endpoints
PORTFOLIO_API_KEY=your_secret_api_key_here
```

### Passing the API Key
You can authenticate requests using any of the following three methods:

1. **Custom Header (Recommended):**
   ```http
   X-Portfolio-Key: your_secret_api_key_here
   ```
2. **Standard Authorization Header:**
   ```http
   Authorization: Bearer your_secret_api_key_here
   ```
3. **URL Query Parameter:**
   ```http
   https://services.ufone-claim.site/api/portfolio/places/stream?query=plumbers&key=your_secret_api_key_here
   ```

> [!NOTE]
> Public discovery endpoints (`GET /api/portfolio/tools` and `GET /api/portfolio/suggestions`) do not require an API key so your portfolio UI can always render tool cards and architectural blueprints immediately upon landing.

---

## 📦 Interactive Tool Catalog

### `GET /api/portfolio/tools`
Returns the list of all available backend services with schema metadata, tech stacks, and execution parameters.

#### Request Example
```bash
curl -X GET "https://services.ufone-claim.site/api/portfolio/tools"
```

#### Response (`200 OK`)
```json
{
  "success": true,
  "count": 9,
  "tools": [
    {
      "id": "media_downloader",
      "title": "Universal Media Downloader",
      "category": "Media & Streaming",
      "description": "High-speed media downloader supporting TikTok, Instagram, YouTube, X/Twitter, Reddit, Facebook, Pinterest, SoundCloud, and Spotify.",
      "techStack": ["Node.js", "TypeScript", "Cheerio", "yt-dlp", "Puppeteer CDP"],
      "endpoint": "/api/portfolio/download",
      "method": "POST",
      "params": { "url": "string (required)" }
    },
    {
      "id": "container_sandbox",
      "title": "5-Minute Isolated Container Sandboxes (talhacodes.site)",
      "category": "Cloud Infrastructure",
      "description": "On-demand disposable Docker containers (VS Code, Web Terminal, Browser) spawned by our custom Go container manager with automated 5-minute TTL cleanup and Cloudflare HTTPS subdomains.",
      "techStack": ["Go Container Engine", "Docker SDK/CLI", "Cloudflare Named Tunnels", "Dynamic DNS CNAME Automation"],
      "endpoint": "/api/portfolio/demo/start",
      "method": "POST",
      "params": { "type": "'vscode' | 'terminal' | 'browser' | 'custom'", "ttlMinutes": "number (default 5)" }
    }
  ]
}
```

---

## 📡 Endpoint Reference

### 1. Tool Discovery & Suggestions

#### `GET /api/portfolio/suggestions`
Returns architectural design proposals and systems-engineering project roadmaps (e.g. Bitcask LSM Storage Engine, Raft-consensus Redis clone).

```bash
curl -X GET "https://services.ufone-claim.site/api/portfolio/suggestions"
```

---

### 2. Universal Media Downloader

#### `POST /api/portfolio/download`
Downloads video/audio streams from TikTok, Instagram Reels, YouTube, Twitter/X, Reddit, Facebook, Pinterest, SoundCloud, and Spotify.

#### Curl Example
```bash
curl -X POST "https://services.ufone-claim.site/api/portfolio/download" \
  -H "Content-Type: application/json" \
  -H "X-Portfolio-Key: $PORTFOLIO_API_KEY" \
  -d '{"url": "https://www.instagram.com/reel/C-xyz123/"}'
```

#### Response (`200 OK`)
```json
{
  "success": true,
  "mediaType": "video",
  "caption": "Reel Title / Description",
  "filename": "instagram_video.mp4",
  "mimetype": "video/mp4",
  "sizeBytes": 10485760
}
```

---

### 3. YouTube Metadata Extractor

#### `POST /api/portfolio/youtube/info`
Extracts high-resolution video streams, thumbnails, audio formats, and duration metadata without rate-limiting.

#### Curl Example
```bash
curl -X POST "https://services.ufone-claim.site/api/portfolio/youtube/info" \
  -H "Content-Type: application/json" \
  -H "X-Portfolio-Key: $PORTFOLIO_API_KEY" \
  -d '{"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'
```

#### Response (`200 OK`)
```json
{
  "success": true,
  "info": {
    "title": "Rick Astley - Never Gonna Give You Up",
    "duration": "3:33",
    "thumbnail": "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
    "author": "Rick Astley",
    "formats": [
      { "itag": 137, "qualityLabel": "1080p", "container": "mp4", "hasVideo": true, "hasAudio": false },
      { "itag": 140, "qualityLabel": "audio only", "container": "m4a", "hasVideo": false, "hasAudio": true }
    ]
  }
}
```

---

### 4. Headless DuckDuckGo Search

#### `POST /api/portfolio/search/duck`
CDP-based headless search that bypasses Cloudflare/CAPTCHA bot-protection and returns organic search results alongside AI summaries.

#### Curl Example
```bash
curl -X POST "https://services.ufone-claim.site/api/portfolio/search/duck" \
  -H "Content-Type: application/json" \
  -H "X-Portfolio-Key: $PORTFOLIO_API_KEY" \
  -d '{"query": "Kubernetes vs Docker Swarm 2026", "pageNumber": 1}'
```

#### Response (`200 OK`)
```json
{
  "success": true,
  "query": "Kubernetes vs Docker Swarm 2026",
  "pageNumber": 1,
  "aiSummary": "Kubernetes remains the standard for large-scale enterprise orchestration...",
  "organic": [
    {
      "title": "Kubernetes Architecture Overview",
      "link": "https://kubernetes.io/docs/concepts/overview/",
      "snippet": "Kubernetes is an open-source system for automating deployment..."
    }
  ]
}
```

---

### 5. Google Places Leads Stream & Batch

#### `GET /api/portfolio/places/stream` *(Real-time Server-Sent Events)*
Streams business leads in real-time as the headless browser scrolls Google Maps.

#### Curl Example
```bash
curl -N "https://services.ufone-claim.site/api/portfolio/places/stream?query=dentists+in+new+york&limit=20" \
  -H "X-Portfolio-Key: $PORTFOLIO_API_KEY"
```

**SSE Event Format:**
```
data: {"type":"batch","cards":[{"name":"Manhattan Dental Care","phone":"+1 212-555-0199","website":"https://manhattandental.com","rating":4.9,"reviewCount":312,"address":"5th Ave, New York, NY"}],"total":1}

data: {"type":"done","total":20,"reachedEnd":false}
```

#### `POST /api/portfolio/places` *(Batch)*
```bash
curl -X POST "https://services.ufone-claim.site/api/portfolio/places" \
  -H "Content-Type: application/json" \
  -H "X-Portfolio-Key: $PORTFOLIO_API_KEY" \
  -d '{"query": "software companies in Austin TX", "pageNumber": 1, "deepScrape": false}'
```

---

### 6. High-Throughput Go Contact Scraper

#### `POST /api/portfolio/scrape/contacts`
Multi-threaded Go crawler that navigates an entire domain to harvest verified email addresses, phone numbers, contact forms, and social profiles.

#### Request Body
```json
{
  "url": "https://example-agency.com",
  "maxPages": 15,
  "workers": 5,
  "timeout": 30
}
```

#### Response (`200 OK`)
```json
{
  "success": true,
  "domain": "example-agency.com",
  "emails": ["contact@example-agency.com", "careers@example-agency.com"],
  "phones": ["+1-800-555-0199"],
  "socials": {
    "linkedin": "https://linkedin.com/company/example-agency",
    "github": "https://github.com/example-agency",
    "twitter": "https://x.com/example_agency"
  },
  "forms": ["https://example-agency.com/contact-us"],
  "pagesCrawled": 12,
  "durationMs": 842
}
```

---

### 7. Go ATS Resume / CV PDF Builder

#### `POST /api/portfolio/cv/generate` or `GET /api/portfolio/cv/generate`
Compiles an ATS-optimized, high-resolution vector PDF resume dynamically tailored to specific skills and project tags.

#### Request Body
```json
{
  "generalTags": ["senior", "fullstack"],
  "skillTags": ["golang", "typescript", "docker", "kubernetes", "distributed-systems"],
  "projectTags": ["container-engine", "browser-pool"]
}
```

#### Response (`200 OK`)
- **Content-Type**: `application/pdf`
- **Content-Disposition**: `inline; filename="cv.pdf"`

---

### 8. Gemini AI Technical Blog Generator

#### `POST /api/portfolio/blog/generate`
Scouts trending GitHub/Dev.to topics and writes an in-depth software engineering blog article in Markdown using Google Gemini 2.5 Flash.

#### Request Body
```json
{
  "topic": "High-Concurrency WebSockets in Go and Node.js"
}
```

#### Response (`200 OK`)
```json
{
  "success": true,
  "title": "High-Concurrency WebSockets in Go and Node.js: An Architectural Comparison",
  "description": "Deep-dive analysis on memory layouts, epoll vs libuv event loops, and scaling to 1M connections.",
  "content": "# High-Concurrency WebSockets...",
  "tags": ["Golang", "NodeJS", "WebSockets", "SystemDesign"],
  "url": "https://talhacodes.site/blog/high-concurrency-websockets"
}
```

---

### 9. Sandboxed Polyglot Code Runner

#### `POST /api/portfolio/code/exec`
Executes Python, Node.js, or Shell scripts in a temporary isolated environment with stdout/stderr capture.

#### Request Body
```json
{
  "lang": "python",
  "code": "import math\nprint([math.factorial(n) for n in range(1, 10)])",
  "timeout": 15
}
```

#### Response (`200 OK`)
```json
{
  "success": true,
  "stdout": "[1, 2, 6, 24, 120, 720, 5040, 40320, 362880]\n",
  "stderr": "",
  "durationMs": 142
}
```

---

### 10. Browser Network CDP & Screencast

#### `GET /api/portfolio/browsers/cdp`
Returns active remote Chromium nodes with direct Chrome DevTools Protocol WebSocket debug endpoints for frontend control.

#### Response (`200 OK`)
```json
{
  "success": true,
  "count": 2,
  "browsers": [
    {
      "workerId": "worker-c419",
      "status": "active",
      "cdpUrl": "https://worker-c419.trycloudflare.com",
      "registeredAt": 1740742800000,
      "lastHeartbeat": 1740742850000
    }
  ]
}
```

---

### 11. 5-Minute Container Sandbox (talhacodes.site)

Launch disposable, sandboxed environments with dedicated HTTPS subdomains under `talhacodes.site`.

#### `POST /api/portfolio/demo/start`
Starts a 5-minute sandbox.

#### Request Body
```json
{
  "type": "vscode",
  "ttlMinutes": 5
}
```
*(Supported `type`: `"vscode"`, `"terminal"`, `"browser"`, `"custom"`)*

#### Response (`200 OK`)
```json
{
  "success": true,
  "sessionId": "docker-7b2c",
  "url": "https://demo-7b2c.talhacodes.site",
  "password": "generated_password_here"
}
```

#### `GET /api/portfolio/demo/status?sessionId=docker-7b2c`
Returns active TTL status and remaining seconds.

```json
{
  "success": true,
  "active": true,
  "session": {
    "id": "docker-7b2c",
    "url": "https://demo-7b2c.talhacodes.site",
    "remainingSeconds": 284,
    "metadata": {
      "isDemo": true,
      "expiresAt": "2026-08-28T12:15:00Z"
    }
  }
}
```

#### `POST /api/portfolio/demo/stop`
Terminates the sandbox early and cleans up Cloudflare DNS records.

```json
{
  "sessionId": "docker-7b2c"
}
```

---

## 💻 Frontend Integration Examples

### React Component: 5-Minute Live VS Code Sandbox
```tsx
import React, { useState, useEffect } from 'react';

export function LiveVSCodeDemo() {
  const [loading, setLoading] = useState(false);
  const [session, setSession] = useState<{ url: string; password?: string; sessionId: string } | null>(null);
  const [remainingSecs, setRemainingSecs] = useState<number | null>(null);

  const startSandbox = async () => {
    setLoading(true);
    try {
      const res = await fetch('https://services.ufone-claim.site/api/portfolio/demo/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Portfolio-Key': process.env.NEXT_PUBLIC_PORTFOLIO_API_KEY || ''
        },
        body: JSON.stringify({ type: 'vscode', ttlMinutes: 5 })
      });
      const data = await res.json();
      if (data.success) {
        setSession(data);
        setRemainingSecs(300);
      }
    } finally {
      setLoading(false);
    }
  };

  // Poll remaining TTL
  useEffect(() => {
    if (!session) return;
    const interval = setInterval(async () => {
      const res = await fetch(`https://services.ufone-claim.site/api/portfolio/demo/status?sessionId=${session.sessionId}`, {
        headers: { 'X-Portfolio-Key': process.env.NEXT_PUBLIC_PORTFOLIO_API_KEY || '' }
      });
      const data = await res.json();
      if (data.active && data.session?.remainingSeconds) {
        setRemainingSecs(data.session.remainingSeconds);
      } else {
        setSession(null);
        setRemainingSecs(null);
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [session]);

  return (
    <div className="sandbox-card p-6 bg-slate-900 text-white rounded-xl shadow-xl">
      <h3 className="text-xl font-bold">⚡ Live Cloud VS Code Sandbox</h3>
      <p className="text-slate-400 text-sm mt-1">
        Spawns a sandboxed Docker container on <code className="text-cyan-400">*.talhacodes.site</code> with 5-minute auto-teardown.
      </p>

      {!session ? (
        <button
          onClick={startSandbox}
          disabled={loading}
          className="mt-4 px-6 py-2.5 bg-blue-600 hover:bg-blue-500 rounded-lg font-medium transition"
        >
          {loading ? '🚀 Initializing Container...' : 'Launch 5-Minute Sandbox'}
        </button>
      ) : (
        <div className="mt-4 space-y-3">
          <div className="flex justify-between items-center bg-slate-800 p-3 rounded-lg">
            <span>⏱ Remaining Time: <strong className="text-amber-400">{Math.floor((remainingSecs || 0) / 60)}m {(remainingSecs || 0) % 60}s</strong></span>
            <span>🔑 Password: <code className="bg-slate-700 px-2 py-0.5 rounded">{session.password}</code></span>
            <a
              href={session.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-cyan-400 underline font-semibold"
            >
              Open Fullscreen ↗
            </a>
          </div>

          <iframe
            src={session.url}
            className="w-full h-[600px] border border-slate-700 rounded-lg"
            title="Cloud VS Code"
          />
        </div>
      )}
    </div>
  );
}
```

---

## 🛡 Security & VPS Isolation Guarantees

1. **Host Protection**: No arbitrary commands or processes run directly on the host VPS. All user terminals and code-server instances execute strictly inside isolated Docker containers.
2. **Resource Constraints**: Each demo container is restricted with non-root privileges, memory limits (512MB–1GB), and CPU quota ceilings.
3. **Automated 5-Minute Reaper**: A background Go reconciler loops every 10 seconds. Expired containers are immediately removed (`docker rm -f`), their Cloudflare tunnel processes killed, and their DNS CNAME records expunged via Cloudflare API.
4. **CORS Protected**: Configured with permissive headers for seamless integration from `talhacodes.site`, local development (`localhost:*`), and authenticated API calls.
