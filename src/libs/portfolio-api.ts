/**
 * @file portfolio-api.ts
 * @description Unified, public-facing Portfolio API Layer.
 * Exposes production-grade tools, interactive 5-minute isolated demo sandboxes on talhacodes.site,
 * headless search/scrapers, and AI services for integration into the portfolio frontend.
 */

import { IncomingMessage, ServerResponse } from 'http';
import { URL } from 'url';
import { detectAndDownload } from './downloader';
import { getYouTubeInfo, searchYouTube } from './youtube-dl';
import { searchDuckViaPool, browserPool } from './browser-pool';
import { searchPlacesViaPool, searchPlacesStream } from './google-places-search';
import { generateAndPostBlog, generateCommunityBlog } from './blog-generator-service';
import { startVSCode, stopVSCode } from './vscode';
import { startTerminal, stopTerminal } from './terminal';
import { sessionManager } from './session-manager';

const GO_MANAGER_URL = 'http://127.0.0.1:18080';
const GO_CONTACT_SCRAPER_URL = 'http://127.0.0.1:8081';
const GO_CV_GENERATOR_URL = 'http://127.0.0.1:8082';

function json(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Dashboard-Token, X-Portfolio-Key, x-portfolio-key',
  });
  res.end(body);
}

function err(res: ServerResponse, message: string, status = 500): void {
  json(res, { error: message, success: false }, status);
}

function isAuthorized(req: IncomingMessage, parsedUrl: URL): boolean {
  const requiredKey = process.env.PORTFOLIO_API_KEY;
  // If no PORTFOLIO_API_KEY is configured in .env, allow requests
  if (!requiredKey || requiredKey.trim() === '') {
    return true;
  }

  // 1. Check X-Portfolio-Key header
  const headerKey = req.headers['x-portfolio-key'] || req.headers['X-Portfolio-Key'];
  if (typeof headerKey === 'string' && headerKey.trim() === requiredKey.trim()) {
    return true;
  }

  // 2. Check Authorization header: Bearer <key>
  const authHeader = req.headers['authorization'];
  if (typeof authHeader === 'string') {
    const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7).trim() : authHeader.trim();
    if (token === requiredKey.trim()) return true;
  }

  // 3. Check query param: ?key=<key> or ?apiKey=<key>
  const queryKey = parsedUrl.searchParams.get('key') || parsedUrl.searchParams.get('apiKey');
  if (queryKey && queryKey.trim() === requiredKey.trim()) {
    return true;
  }

  return false;
}

async function parseJsonBody(req: IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        const str = Buffer.concat(chunks).toString('utf-8');
        resolve(str ? JSON.parse(str) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

/** Tool catalog describing live capabilities */
export const PORTFOLIO_TOOLS_CATALOG = [
  {
    id: 'media_downloader',
    title: 'Universal Media Downloader',
    category: 'Media & Streaming',
    description: 'High-speed media downloader supporting TikTok, Instagram, YouTube, X/Twitter, Reddit, Facebook, Pinterest, SoundCloud, and Spotify.',
    techStack: ['Node.js', 'TypeScript', 'Cheerio', 'yt-dlp', 'Puppeteer CDP'],
    endpoint: '/api/portfolio/download',
    method: 'POST',
    params: { url: 'string (required)' }
  },
  {
    id: 'duckduckgo_search',
    title: 'Headless DuckDuckGo Search Engine',
    category: 'Search & Intelligence',
    description: 'Fast, bot-resistant DuckDuckGo search querying organic search results, snippets, and AI-synthesized summaries via remote CDP browser pool.',
    techStack: ['Puppeteer Core', 'Chrome DevTools Protocol (CDP)', 'Distributed Worker Pool'],
    endpoint: '/api/portfolio/search/duck',
    method: 'POST',
    params: { query: 'string (required)', pageNumber: 'number (optional, default 1)' }
  },
  {
    id: 'google_places_stream',
    title: 'Google Places Lead Streamer (SSE)',
    category: 'Search & Intelligence',
    description: 'Real-time Server-Sent Events stream for Google Places business and lead extraction with phone numbers, websites, ratings, and coordinates.',
    techStack: ['Server-Sent Events (SSE)', 'Infinite Scroll Parsing', 'CDP Stream', 'TypeScript'],
    endpoint: '/api/portfolio/places/stream',
    method: 'GET',
    params: { query: 'string (required)', location: 'string (optional)', limit: 'number (optional, default 20)' }
  },
  {
    id: 'contact_scraper',
    title: 'High-Throughput Go Contact & Social Scraper',
    category: 'Web Scraping & Data Mining',
    description: 'Blazing-fast multi-threaded crawler written in Go that extracts emails, phone numbers, contact forms, and social media handles from any website.',
    techStack: ['Go (Golang)', 'net/http', 'HTML Tokenizer', 'Regex Pipelines', 'Worker Pool'],
    endpoint: '/api/portfolio/scrape/contacts',
    method: 'POST',
    params: { url: 'string (required)', maxPages: 'number (optional)', workers: 'number (optional)' }
  },
  {
    id: 'cv_generator',
    title: 'Automated ATS Resume & CV Builder',
    category: 'Document Generation',
    description: 'Go-based resume generator creating pixel-perfect, ATS-optimized PDF CVs based on targeted job skills, keywords, and HTML templates.',
    techStack: ['Go (Golang)', 'wkhtmltopdf', 'HTML5/CSS3 Templates', 'PDF Generation'],
    endpoint: '/api/portfolio/cv/generate',
    method: 'POST',
    params: { generalTags: 'string[]', skillTags: 'string[]', projectTags: 'string[]' }
  },
  {
    id: 'ai_blog_writer',
    title: 'Gemini AI Technical Blog Generator',
    category: 'Generative AI',
    description: 'Automated tech blog generation engine that scouts trending topics and generates deep-dive software engineering articles in Markdown.',
    techStack: ['Google Gemini 2.5 Flash', '@google/genai', 'Markdown Formatter', 'Automated Research'],
    endpoint: '/api/portfolio/blog/generate',
    method: 'POST',
    params: { topic: 'string (optional, auto-discovers if empty)', category: 'string (optional)' }
  },
  {
    id: 'virtual_code_runner',
    title: 'Sandboxed Polyglot Code Runner',
    category: 'Developer Tools',
    description: 'Remote execution runtime capable of running Python, Node.js, and Shell scripts with captured stdout, stderr, and execution duration.',
    techStack: ['Node.js', 'Python 3', 'Isolated Subprocesses', 'CDP Worker Network'],
    endpoint: '/api/portfolio/code/exec',
    method: 'POST',
    params: { lang: "'node' | 'python' | 'shell'", code: 'string (required)', timeout: 'number (optional)' }
  },
  {
    id: 'cloud_browser_cdp',
    title: 'Virtual Browser Network & CDP WebSocket',
    category: 'Infrastructure',
    description: 'Distributed network of headless Chromium browsers providing live CDP WebSocket debug URLs and WebRTC/VNC screencasting for interactive frontend control.',
    techStack: ['Chrome DevTools Protocol', 'WebSockets', 'KasmVNC', 'Chromium'],
    endpoint: '/api/portfolio/browsers/cdp',
    method: 'GET',
    params: {}
  },
  {
    id: 'container_sandbox',
    title: '5-Minute Isolated Container Sandboxes (talhacodes.site)',
    category: 'Cloud Infrastructure',
    description: 'On-demand disposable Docker containers (VS Code, Web Terminal, Browser) spawned by our custom Go container manager with automated 5-minute TTL cleanup and Cloudflare HTTPS subdomains.',
    techStack: ['Go Container Engine', 'Docker SDK/CLI', 'Cloudflare Named Tunnels', 'Dynamic DNS CNAME Automation'],
    endpoint: '/api/portfolio/demo/start',
    method: 'POST',
    params: { type: "'vscode' | 'terminal' | 'browser' | 'custom'", ttlMinutes: 'number (default 5)' }
  }
];

/** Architecture suggestions & future engineering expansions */
export const PORTFOLIO_SUGGESTIONS = [
  {
    title: 'Log-Structured Storage Engine (Bitcask / LSM-Tree)',
    category: 'Systems & Databases',
    overview: 'High-performance local key-value storage engine implementing Write-Ahead Logging (WAL), crash recovery, append-only logs, and active compaction.',
    keySkills: ['Disk I/O', 'Memory Mapping (mmap)', 'Binary Serialization', 'Compaction Algorithms']
  },
  {
    title: 'Distributed Redis Clone with Raft Consensus',
    category: 'Distributed Systems',
    overview: 'In-memory RESP-compatible data store with multi-node replication, leader election, and split-brain recovery via Raft consensus.',
    keySkills: ['Distributed Consensus', 'Network Partitions', 'RESP Parser', 'Concurrent TCP Networking']
  },
  {
    title: 'Application-Layer Reverse Proxy & Load Balancer',
    category: 'Networking & Infrastructure',
    overview: 'High-concurrency reverse proxy featuring Round-Robin & Least-Connections load balancing, active health checks, Token Bucket rate limiting, and TLS termination.',
    keySkills: ['HTTP/TCP Socket Programming', 'Connection Pooling', 'Rate Limiting Algorithms', 'Zero-Downtime Reloads']
  },
  {
    title: 'Real-Time Message Broker & Gateway with DLQ',
    category: 'Real-Time & Distributed Systems',
    overview: 'High-throughput webhook & event gateway with memory-efficient ring buffers, disk-persisted Dead Letter Queues (DLQ), and backpressure control.',
    keySkills: ['Event Streaming', 'Backpressure Handling', 'Dead Letter Queues', 'At-Least-Once Delivery']
  }
];

/**
 * Main HTTP request dispatcher for /api/portfolio/*
 */
export async function handlePortfolioRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = req.url ?? '/';
  const parsedUrl = new URL(url, 'http://localhost');
  const pathname = parsedUrl.pathname;
  const method = req.method?.toUpperCase() ?? 'GET';

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Dashboard-Token, X-Portfolio-Key, x-portfolio-key',
    });
    res.end();
    return true;
  }

  if (!pathname.startsWith('/api/portfolio')) {
    return false;
  }

  try {
    // ── 1. GET /api/portfolio/tools (Public Discovery) ───────────────────────
    if (method === 'GET' && (pathname === '/api/portfolio/tools' || pathname === '/api/portfolio/tools/')) {
      json(res, {
        success: true,
        count: PORTFOLIO_TOOLS_CATALOG.length,
        tools: PORTFOLIO_TOOLS_CATALOG
      });
      return true;
    }

    // ── 2. GET /api/portfolio/suggestions (Public Roadmap) ───────────────────
    if (method === 'GET' && (pathname === '/api/portfolio/suggestions' || pathname === '/api/portfolio/suggestions/')) {
      json(res, {
        success: true,
        count: PORTFOLIO_SUGGESTIONS.length,
        suggestions: PORTFOLIO_SUGGESTIONS
      });
      return true;
    }

    // ── Enforce API Key Authentication for Action Endpoints ──────────────────
    if (!isAuthorized(req, parsedUrl)) {
      err(res, 'Unauthorized: Missing or invalid Portfolio API Key. Provide via X-Portfolio-Key header, Bearer token, or ?key=<key> query parameter.', 401);
      return true;
    }

    // ── 3. POST /api/portfolio/download ──────────────────────────────────────
    if (method === 'POST' && pathname === '/api/portfolio/download') {
      const body = await parseJsonBody(req);
      const targetUrl = body.url as string;
      if (!targetUrl) return err(res, 'url is required', 400), true;

      console.log(`[Portfolio API] Initiating download for URL: ${targetUrl}`);
      const downloadResult = await detectAndDownload(targetUrl);
      if (!downloadResult) {
        return err(res, 'Failed to extract media from the provided URL.', 422), true;
      }

      json(res, {
        success: true,
        mediaType: downloadResult.mediaType,
        caption: downloadResult.caption,
        filename: downloadResult.filename,
        mimetype: downloadResult.mimetype,
        sizeBytes: downloadResult.buffer ? downloadResult.buffer.length : undefined
      });
      return true;
    }

    // ── 4. POST /api/portfolio/youtube/info ──────────────────────────────────
    if (method === 'POST' && pathname === '/api/portfolio/youtube/info') {
      const body = await parseJsonBody(req);
      const targetUrl = body.url as string;
      if (!targetUrl) return err(res, 'url is required', 400), true;

      const info = await getYouTubeInfo(targetUrl);
      if (!info) {
        return err(res, 'Failed to retrieve YouTube video details', 422), true;
      }

      json(res, { success: true, info });
      return true;
    }

    // ── 5. POST /api/portfolio/search/duck ───────────────────────────────────
    if (method === 'POST' && pathname === '/api/portfolio/search/duck') {
      const body = await parseJsonBody(req);
      const query = (body.query || body.text || '') as string;
      const pageNumber = Number(body.pageNumber) || 1;
      if (!query) return err(res, 'query is required', 400), true;

      console.log(`[Portfolio API] Performing DuckDuckGo search: "${query}" (page ${pageNumber})`);
      const results = await searchDuckViaPool(query, pageNumber);
      if (!results) {
        return err(res, 'DuckDuckGo search failed or no workers available', 503), true;
      }

      json(res, { success: true, query, pageNumber, ...results });
      return true;
    }

    // ── 6. GET /api/portfolio/places/stream ──────────────────────────────────
    if (method === 'GET' && pathname === '/api/portfolio/places/stream') {
      const query = parsedUrl.searchParams.get('query') || parsedUrl.searchParams.get('text') || '';
      if (!query) return err(res, 'query parameter is required', 400), true;

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      const keepAlive = setInterval(() => {
        if (!res.writableEnded) res.write(': ping\n\n');
      }, 15_000);

      const send = (event: object) => {
        if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
      };

      req.on('close', () => clearInterval(keepAlive));

      try {
        await searchPlacesStream(query, send);
      } catch (e: any) {
        send({ type: 'error', message: e.message });
      } finally {
        clearInterval(keepAlive);
        if (!res.writableEnded) res.end();
      }
      return true;
    }

    // ── 7. POST /api/portfolio/places ────────────────────────────────────────
    if (method === 'POST' && pathname === '/api/portfolio/places') {
      const body = await parseJsonBody(req);
      const query = (body.query || body.text || '') as string;
      const pageNumber = Number(body.pageNumber) || 1;
      const deepScrape = Boolean(body.deepScrape);

      if (!query) return err(res, 'query is required', 400), true;

      const placesResult = await searchPlacesViaPool(query, pageNumber, deepScrape);
      json(res, { success: true, query, ...placesResult });
      return true;
    }

    // ── 8. POST /api/portfolio/scrape/contacts ───────────────────────────────
    if (method === 'POST' && pathname === '/api/portfolio/scrape/contacts') {
      const body = await parseJsonBody(req);
      const targetUrl = (body.url || '') as string;
      const maxPages = Number(body.maxPages) || 10;
      const workers = Number(body.workers) || 5;
      const timeout = Number(body.timeout) || 30;

      if (!targetUrl) return err(res, 'url is required', 400), true;

      console.log(`[Portfolio API] Proxying contact scraper request for: ${targetUrl}`);
      const scraperUrl = `${GO_CONTACT_SCRAPER_URL}/api/scrape?url=${encodeURIComponent(targetUrl)}&max-pages=${maxPages}&workers=${workers}&timeout=${timeout}`;

      const scraperRes = await fetch(scraperUrl).catch((e) => null);
      if (!scraperRes || !scraperRes.ok) {
        return err(res, 'Go contact scraper is offline or returned an error', 502), true;
      }

      const scraperData = await scraperRes.json();
      json(res, { success: true, ...scraperData });
      return true;
    }

    // ── 9. POST/GET /api/portfolio/cv/generate ───────────────────────────────
    if ((method === 'POST' || method === 'GET') && pathname === '/api/portfolio/cv/generate') {
      let queryParams = parsedUrl.search;
      let postBody: any = null;

      if (method === 'POST') {
        postBody = await parseJsonBody(req);
      }

      const cvUrl = `${GO_CV_GENERATOR_URL}/generate${queryParams}`;
      const fetchOpts: RequestInit = {
        method: postBody ? 'POST' : 'GET',
        headers: postBody ? { 'Content-Type': 'application/json' } : undefined,
        body: postBody ? JSON.stringify(postBody) : undefined
      };

      const cvRes = await fetch(cvUrl, fetchOpts).catch(() => null);
      if (!cvRes || !cvRes.ok) {
        return err(res, 'Go CV generator server is offline or returned an error', 502), true;
      }

      const pdfBuffer = Buffer.from(await cvRes.arrayBuffer());
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'inline; filename="cv.pdf"',
        'Content-Length': pdfBuffer.length.toString(),
        'Access-Control-Allow-Origin': '*'
      });
      res.end(pdfBuffer);
      return true;
    }

    // ── 10. POST /api/portfolio/blog/generate ────────────────────────────────
    if (method === 'POST' && pathname === '/api/portfolio/blog/generate') {
      const body = await parseJsonBody(req);
      const topic = body.topic as string | undefined;

      console.log(`[Portfolio API] Generating AI blog post on topic: ${topic || 'auto-select'}`);
      const blogResult = topic ? await generateAndPostBlog(topic) : await generateCommunityBlog();

      json(res, blogResult);
      return true;
    }

    // ── 11. POST /api/portfolio/code/exec ────────────────────────────────────
    if (method === 'POST' && pathname === '/api/portfolio/code/exec') {
      const body = await parseJsonBody(req);
      const workerId = body.workerId as string | undefined;
      const lang = (body.lang || 'node') as 'node' | 'python' | 'shell';
      const code = body.code as string;
      const timeout = Number(body.timeout) || 20;

      if (!code) return err(res, 'code is required', 400), true;

      const execResult = await browserPool.executeCode(workerId, lang, code, timeout);
      json(res, { success: true, ...execResult });
      return true;
    }

    // ── 12. GET /api/portfolio/browsers/cdp ──────────────────────────────────
    if (method === 'GET' && pathname === '/api/portfolio/browsers/cdp') {
      const active = browserPool.getActive();
      const sanitized = active.map(b => ({
        workerId: b.workerId,
        status: b.status,
        cdpUrl: b.cdpUrl || null,
        apiUrl: b.apiUrl || null,
        registeredAt: b.registeredAt,
        lastHeartbeat: b.lastHeartbeat,
      }));

      json(res, {
        success: true,
        count: sanitized.length,
        browsers: sanitized
      });
      return true;
    }

    // ── 13. POST /api/portfolio/demo/start ───────────────────────────────────
    if (method === 'POST' && pathname === '/api/portfolio/demo/start') {
      const body = await parseJsonBody(req);
      const type = (body.type || 'terminal') as 'vscode' | 'terminal' | 'browser' | 'custom';
      const ttlMinutes = Math.min(Math.max(Number(body.ttlMinutes) || 5, 1), 30); // 1-30 min, default 5
      const customDomain = body.customDomain as string | undefined;

      console.log(`[Portfolio API] Launching demo container in 1 synchronous API call: type=${type}, ttl=${ttlMinutes}m`);

      // Delegate directly to Go container manager demo endpoint (synchronous execution)
      const goDemoRes = await fetch(`${GO_MANAGER_URL}/api/go/containers/demo/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          image: body.image,
          port: body.port,
          command: body.command ? (Array.isArray(body.command) ? body.command : [body.command]) : undefined,
          env: body.env,
          customDomain,
          ttlMinutes,
          sync: true
        })
      }).catch((e) => {
        console.error('[Portfolio API] Go manager error:', e);
        return null;
      });

      if (!goDemoRes) {
        return err(res, 'Go Container Manager is offline or unreachable', 502), true;
      }

      const goDemoData = await goDemoRes.json() as any;
      if (!goDemoRes.ok || !goDemoData.success) {
        return err(res, goDemoData.error || 'Failed to initialize demo container', goDemoRes.status >= 400 ? goDemoRes.status : 500), true;
      }

      json(res, goDemoData);
      return true;
    }

    // ── 14. GET /api/portfolio/demo/status ───────────────────────────────────
    if (method === 'GET' && pathname === '/api/portfolio/demo/status') {
      const sessionId = parsedUrl.searchParams.get('sessionId') || '';
      if (!sessionId) return err(res, 'sessionId is required', 400), true;

      const cleanId = sessionId.startsWith('docker-') ? sessionId : `docker-${sessionId}`;
      const sessRes = await fetch(`${GO_MANAGER_URL}/api/go/containers/sessions`).catch(() => null);
      if (!sessRes || !sessRes.ok) {
        return err(res, 'Go Container Manager is offline', 502), true;
      }

      const sessions = await sessRes.json() as any[];
      const found = sessions.find(s => s.id === cleanId || s.id === sessionId);

      if (!found) {
        return json(res, {
          success: true,
          active: false,
          message: 'Demo session has expired or been terminated'
        }), true;
      }

      json(res, {
        success: true,
        active: true,
        session: found
      });
      return true;
    }

    // ── 15. POST /api/portfolio/demo/stop ────────────────────────────────────
    if (method === 'POST' && pathname === '/api/portfolio/demo/stop') {
      const body = await parseJsonBody(req);
      const sessionId = (body.sessionId || '') as string;
      if (!sessionId) return err(res, 'sessionId is required', 400), true;

      if (sessionId.includes('vscode')) {
        const resVsc = await stopVSCode(sessionId);
        json(res, resVsc);
        return true;
      }

      if (sessionId.includes('terminal')) {
        const resTerm = await stopTerminal(sessionId);
        json(res, resTerm);
        return true;
      }

      const cleanId = sessionId.startsWith('docker-') ? sessionId : `docker-${sessionId}`;
      const stopRes = await fetch(`${GO_MANAGER_URL}/api/go/containers/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: cleanId, force: true })
      }).catch(() => null);

      if (!stopRes || !stopRes.ok) {
        return err(res, 'Failed to stop container on Go manager', 502), true;
      }

      json(res, { success: true, message: `Session ${sessionId} stopped successfully` });
      return true;
    }

    return false;
  } catch (error: any) {
    console.error('[Portfolio API Error]:', error);
    err(res, error.message || 'Internal error in portfolio API', 500);
    return true;
  }
}
