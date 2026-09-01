import { exec, execFile, spawn, ChildProcess } from 'child_process';
import * as util from 'util';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { sessionManager } from './session-manager';
import { signIntoGoogle } from './google-signin';

const execAsync = util.promisify(exec);
const execFileAsync = util.promisify(execFile);

// Environment variables will be read dynamically inside the functions.


// Track all browser instances
const browserInstances = new Map<string, {
  url: string;
  username: string;
  password: string;
  port: number;
  cdpPort: number;
  containerName: string;
  tunnelProcess: ChildProcess;
  targetUrl?: string;
}>();

/**
 * Start a general-purpose browser (no specific URL)
 */
export async function startBrowser(): Promise<{ url?: string; username?: string; password?: string; error?: string }> {
  // Check if general browser already exists
  const existing = Array.from(browserInstances.values()).find(b => !b.targetUrl);
  if (existing) {
    return {
      url: existing.url,
      username: existing.username,
      password: existing.password,
    };
  }

  return startBrowserInstance();
}

export function getGeneralBrowserCdpPort(): number | null {
  const existing = Array.from(browserInstances.values()).find(b => !b.targetUrl);
  return existing ? existing.cdpPort : null;
}

/**
 * Start a browser with a specific URL pre-loaded
 */
export async function startCustomBrowser(targetUrl: string): Promise<{
  sessionId?: string;
  url?: string;
  username?: string;
  password?: string;
  error?: string
}> {
  const sessionId = `browser-${crypto.randomBytes(4).toString('hex')}`;

  const result = await startBrowserInstance(targetUrl);

  if (result.url && !result.error) {
    // Register in session manager
    sessionManager.addSession({
      id: sessionId,
      type: 'custom-browser',
      url: result.url,
      username: result.username,
      password: result.password,
      startedAt: new Date(),
      metadata: {
        targetUrl,
      },
    });

    return { sessionId, ...result };
  }

  return result;
}

/**
 * Internal function to start a browser instance
 */
async function startBrowserInstance(targetUrl?: string): Promise<{
  url?: string;
  username?: string;
  password?: string;
  error?: string
}> {
  const instanceId = targetUrl || 'general';
  if (browserInstances.size >= 6 && !browserInstances.has(instanceId)) {
    return { error: 'Maximum browser limit reached (6). Cannot spawn new browser.' };
  }
  try {
    // Read environment variables dynamically
    const BROWSER_PORT = parseInt(process.env.BROWSER_PORT || '10080', 10);
    const BROWSER_USERNAME = process.env.BROWSER_USERNAME || '';
    const BROWSER_PASSWORD = process.env.BROWSER_PASSWORD || '';
    const BROWSER_TUNNEL_TOKEN = process.env.BROWSER_TUNNEL_TOKEN || '';
    const BROWSER_DOMAIN = process.env.BROWSER_DOMAIN || '';

    // Use hardcoded credentials if available, otherwise generate random ones
    const port = BROWSER_PORT || (10080 + browserInstances.size);
    const cdpPort = 10222 + (port - 10080);
    const username = BROWSER_USERNAME || `dev_${crypto.randomBytes(3).toString('hex')}`;
    const password = BROWSER_PASSWORD || crypto.randomBytes(6).toString('hex');

    // Ensure Docker is available
    try {
      await execAsync('docker --version');
    } catch {
      return { error: 'Docker is not installed or available.' };
    }

    const containerName = `cloud-browser-${port}`;

    // Check if container already exists
    try {
      const { stdout } = await execAsync(`docker ps -a --filter name=${containerName} --format "{{.Names}}"`);
      if (stdout.includes(containerName)) {
        await execAsync(`docker stop ${containerName}`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    } catch {
      // No existing container
    }

    // Build docker command.
    // Chrome inside the container binds CDP to 127.0.0.1:9222 (loopback).
    // We use CHROME_CLI (not CHROMIUM_FLAGS) and map host cdpPort to container 9223.
    // A socat sidecar sharing the container's network bridges 9223→127.0.0.1:9222.
    const dockerCmd = [
      'docker', 'run', '-d', '--rm',
      '--name', containerName,
      '--shm-size=1gb',
      '-p', `${port}:3000`,
      '-p', `${cdpPort}:9223`,
      '-v', `${path.join(process.cwd(), 'browser_data').replace(/\\/g, '/')}:/config`,
      '-e', 'TZ=Etc/UTC',
      '-e', `CUSTOM_USER=${username}`,
      '-e', `PASSWORD=${password}`,
      '-e', `PUID=${process.getuid ? process.getuid() : 1000}`,
      '-e', `PGID=${process.getgid ? process.getgid() : 1000}`,
      '-e', 'CHROME_CLI=--remote-debugging-port=9222 --no-sandbox --disable-dev-shm-usage --remote-allow-origins=*',
    ];

    // Add custom URL if provided
    if (targetUrl) {
      dockerCmd.push('-e', `CUSTOM_URL=${targetUrl}`);
    }

    dockerCmd.push('lscr.io/linuxserver/chromium:latest');

    // Use execFile so args are passed directly to the OS — no shell splitting
    // on spaces inside env values like CHROME_CLI.
    await execFileAsync(dockerCmd[0], dockerCmd.slice(1));

    // Start socat sidecar: shares Chrome container's network namespace
    // and forwards port 9223 → 127.0.0.1:9222 (Chrome CDP loopback).
    const socatName = `${containerName}-cdp-proxy`;
    try {
      // Remove any leftover socat container
      await execAsync(`docker rm -f ${socatName}`).catch(() => { });
      await execFileAsync('docker', [
        'run', '-d', '--rm',
        '--name', socatName,
        '--network', `container:${containerName}`,
        'alpine/socat',
        'tcp-listen:9223,fork,reuseaddr', 'tcp-connect:127.0.0.1:9222',
      ]);
    } catch (e) {
      console.error('⚠️ socat sidecar failed to start (CDP may be unavailable):', e);
    }

    // ── Mode 1b: Multiplexed / exposed through main tunnel ──────────────────────
    if (BROWSER_DOMAIN && !BROWSER_TUNNEL_TOKEN) {
      const cloudflareUrl = `https://${BROWSER_DOMAIN}`;
      const instanceId = targetUrl || 'general';
      browserInstances.set(instanceId, {
        url: cloudflareUrl,
        username,
        password,
        port,
        cdpPort,
        containerName,
        tunnelProcess: null as any,
        targetUrl,
      });

      if (targetUrl) {
        const sessions = sessionManager.getSessionsByType('custom-browser');
        const session = sessions.find(s => s.metadata?.targetUrl === targetUrl);
        if (session) {
          sessionManager.updateSessionMetadata(session.id, { cloudflaredUrl: cloudflareUrl });
        }
      }

      (async () => {
        const signedIn = await signIntoGoogle(cdpPort);
        if (signedIn) {
          const cookieResult = await exportYouTubeCookies();
          console.log(`[Auto] Cookie export: ${cookieResult.message}`);
        }
      })().catch(e => console.error('[Auto] Google/Cookie pipeline error:', e));

      return { url: cloudflareUrl, username, password };
    }

    // ── Mode 1: Named tunnel with fixed custom domain ──────────────────────────
    if (BROWSER_TUNNEL_TOKEN && BROWSER_DOMAIN) {
      return new Promise((resolve) => {

        const tunnelProcess = spawn('cloudflared', [
          'tunnel', '--no-autoupdate', 'run', '--token', BROWSER_TUNNEL_TOKEN,
        ]);

        tunnelProcess.stderr?.on('data', (data: Buffer) => {
        });

        tunnelProcess.on('error', (e) => {
          console.error('❌ Named browser tunnel error:', e);
          execAsync(`docker stop ${containerName}`).catch(() => { });
          resolve({ error: `Named tunnel error: ${e.message}` });
        });

        tunnelProcess.on('close', (code) => {
          const instanceId = targetUrl || 'general';
          browserInstances.delete(instanceId);
        });

        // With named tunnels the URL is known immediately — no need to parse output.
        // Give cloudflared 5s to initialise before resolving.
        setTimeout(() => {
          const cloudflareUrl = `https://${BROWSER_DOMAIN}`;

          // Store instance
          const instanceId = targetUrl || 'general';
          browserInstances.set(instanceId, {
            url: cloudflareUrl,
            username,
            password,
            port,
            cdpPort,
            containerName,
            tunnelProcess,
            targetUrl,
          });

          // Update session with cloudflared URL if this is a custom browser
          if (targetUrl) {
            const sessions = sessionManager.getSessionsByType('custom-browser');
            const session = sessions.find(s => s.metadata?.targetUrl === targetUrl);
            if (session) {
              sessionManager.updateSessionMetadata(session.id, { cloudflaredUrl: cloudflareUrl });
            }
          }

          // Kick off Google sign-in then auto-export YouTube cookies on success
          (async () => {
            const signedIn = await signIntoGoogle(cdpPort);
            if (signedIn) {
              console.log('[Auto] Google sign-in succeeded — exporting YouTube cookies...');
              const cookieResult = await exportYouTubeCookies();
              if (cookieResult.success) {
                console.log(`[Auto] ✅ YouTube cookies exported: ${cookieResult.message}`);
              } else {
                console.warn(`[Auto] ⚠️ Cookie export failed: ${cookieResult.message}`);
              }
            }
          })().catch(e => console.error('[Auto] Google/Cookie pipeline error:', e));

          resolve({ url: cloudflareUrl, username, password });
        }, 5000);
      });
    }

    // ── Mode 2: Quick tunnel (trycloudflare.com) ───────────────────────────────
    const tunnelProcess = spawn('cloudflared', [
      'tunnel',
      '--url', `http://localhost:${port}`
    ]);

    return new Promise((resolve) => {
      let cloudflareUrl = '';

      tunnelProcess.stderr?.on('data', (data) => {
        const output = data.toString();
        const match = output.match(/https:\/\/[-0-9a-z]*\.trycloudflare\.com/);
        if (match && !cloudflareUrl) {
          cloudflareUrl = match[0];
          setTimeout(() => {
            // Store instance
            const instanceId = targetUrl || 'general';
            browserInstances.set(instanceId, {
              url: cloudflareUrl,
              username,
              password,
              port,
              cdpPort,
              containerName,
              tunnelProcess,
              targetUrl,
            });

            // Update session with cloudflared URL if this is a custom browser
            if (targetUrl) {
              const sessions = sessionManager.getSessionsByType('custom-browser');
              const session = sessions.find(s => s.metadata?.targetUrl === targetUrl);
              if (session) {
                sessionManager.updateSessionMetadata(session.id, { cloudflaredUrl: cloudflareUrl });
              }
            }

            // Kick off Google sign-in then auto-export YouTube cookies on success
            (async () => {
              const signedIn = await signIntoGoogle(cdpPort);
              if (signedIn) {
                console.log('[Auto] Google sign-in succeeded — exporting YouTube cookies...');
                const cookieResult = await exportYouTubeCookies();
                if (cookieResult.success) {
                  console.log(`[Auto] ✅ YouTube cookies exported: ${cookieResult.message}`);
                } else {
                  console.warn(`[Auto] ⚠️ Cookie export failed: ${cookieResult.message}`);
                }
              }
            })().catch(e => console.error('[Auto] Google/Cookie pipeline error:', e));

            resolve({ url: cloudflareUrl, username, password });
          }, 5000);
        }
      });

      tunnelProcess.on('close', (code) => {
        const instanceId = targetUrl || 'general';
        browserInstances.delete(instanceId);
      });

      setTimeout(() => {
        if (!cloudflareUrl) {
          execAsync(`docker stop ${containerName}`).catch(() => { });
          resolve({ error: 'Timed out waiting for Cloudflare Tunnel URL.' });
        }
      }, 15000);
    });

  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return { error: `Failed to set up browser: ${errMsg}` };
  }
}

// ---------------------------------------------------------------------------
// Cookie export — CDP via docker exec (pure Python stdlib, no host port needed)
// ---------------------------------------------------------------------------

/**
 * Exports YouTube cookies from the running Chromium container.
 *
 * Chrome binds CDP to 127.0.0.1:9222 inside the container (loopback only).
 * We reach it by running a self-contained Python script via `docker exec`.
 * The script speaks the CDP WebSocket protocol using only stdlib (socket +
 * urllib) so there are zero extra package requirements inside the container.
 *
 * Output is a Netscape-format cookies.txt written to browser_data/ (the
 * bind-mounted /config volume) that yt-dlp can consume via --cookies.
 */
export async function exportYouTubeCookies(
  domain = '.youtube.com',
): Promise<{ success: boolean; message: string; cookiesPath?: string }> {
  const instance =
    Array.from(browserInstances.values()).find(b => !b.targetUrl) ??
    Array.from(browserInstances.values())[0];

  if (!instance) {
    return { success: false, message: 'No browser container is running. Start the browser first.' };
  }

  const { containerName } = instance;
  const cookiesPath = path.join(process.cwd(), 'browser_data', 'youtube-cookies.txt');

  // Inline Python script executed inside the container.
  // Connects to Chrome CDP on 127.0.0.1:9222 (loopback — always reachable from inside).
  // Uses only stdlib: socket for raw WebSocket frames, urllib for the HTTP JSON endpoint.
  const pyScript = [
    'import socket, json, os, sys, time, urllib.request, base64',
    '',
    'def ws_connect(host, port, path):',
    '    s = socket.create_connection((host, port), timeout=10)',
    '    key = base64.b64encode(os.urandom(16)).decode()',
    '    req = (f"GET {path} HTTP/1.1\\r\\nHost: {host}:{port}\\r\\n"',
    '           "Upgrade: websocket\\r\\nConnection: Upgrade\\r\\n"',
    '           f"Sec-WebSocket-Key: {key}\\r\\nSec-WebSocket-Version: 13\\r\\n\\r\\n")',
    '    s.sendall(req.encode())',
    '    buf = b""',
    '    while b"\\r\\n\\r\\n" not in buf:',
    '        buf += s.recv(4096)',
    '    return s',
    '',
    'def ws_send(s, msg):',
    '    data = msg.encode()',
    '    mask = os.urandom(4)',
    '    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))',
    '    length = len(data)',
    '    header = bytes([0x81])',
    '    if length < 126:',
    '        header += bytes([0x80 | length])',
    '    elif length < 65536:',
    '        header += bytes([0xFE]) + length.to_bytes(2, "big")',
    '    else:',
    '        header += bytes([0xFF]) + length.to_bytes(8, "big")',
    '    s.sendall(header + mask + masked)',
    '',
    'def ws_recv(s):',
    '    def recv_exact(n):',
    '        buf = b""',
    '        while len(buf) < n:',
    '            buf += s.recv(n - len(buf))',
    '        return buf',
    '    h = recv_exact(2)',
    '    length = h[1] & 0x7F',
    '    if length == 126: length = int.from_bytes(recv_exact(2), "big")',
    '    elif length == 127: length = int.from_bytes(recv_exact(8), "big")',
    '    return recv_exact(length).decode()',
    '',
    '# Wait for Chrome CDP to be ready (up to 30s)',
    'for i in range(60):',
    '    try:',
    '        targets = json.loads(urllib.request.urlopen("http://127.0.0.1:9222/json", timeout=2).read())',
    '        break',
    '    except Exception:',
    '        time.sleep(0.5)',
    'else:',
    '    sys.exit("cdp-not-ready")',
    '',
    '# Pick first page target (or browser target as fallback)',
    'target = next((t for t in targets if t.get("type") == "page"), targets[0] if targets else None)',
    'if not target: sys.exit("no-target")',
    '',
    'ws_url = target["webSocketDebuggerUrl"]',
    '# ws://127.0.0.1:9222/devtools/page/xxx',
    'rest = ws_url[len("ws://"):]',
    'host_port, ws_path = rest.split("/", 1)',
    'host, port = host_port.split(":")',
    '',
    's = ws_connect(host, int(port), "/" + ws_path)',
    'ws_send(s, json.dumps({"id": 1, "method": "Network.getAllCookies"}))',
    '# Read frames until we get our response (id=1)',
    'cookies = []',
    'for _ in range(20):',
    '    try:',
    '        msg = json.loads(ws_recv(s))',
    '        if msg.get("id") == 1:',
    '            cookies = msg.get("result", {}).get("cookies", [])',
    '            break',
    '    except Exception:',
    '        break',
    's.close()',
    '',
    `DOMAINS = ("${domain}", "${domain.replace(/^\./, '')}", ".google.com", "accounts.google.com")`,
    'lines = ["# Netscape HTTP Cookie File"]',
    'for c in cookies:',
    '    host = c.get("domain", "")',
    '    if not any(host == d or host.endswith(d) for d in DOMAINS): continue',
    '    val = c.get("value", "").replace("\\t", "").replace("\\n", "").replace("\\r", "")',
    '    if not val: continue',
    '    exp = int(c.get("expires", 0))',
    '    if exp < 0: exp = 0',
    '    hf = "TRUE" if host.startswith(".") else "FALSE"',
    '    sf = "TRUE" if c.get("secure") else "FALSE"',
    '    lines.append("\\t".join([host, hf, c.get("path","/"), sf, str(exp), c.get("name",""), val]))',
    '',
    'out = "/config/youtube-cookies.txt"',
    'open(out, "w").write("\\n".join(lines))',
    'os.chmod(out, 0o666)',
    'print(f"{len(lines)-1}")',
  ].join('\n');

  // Write script to the bind-mounted volume so docker exec can read it
  const scriptPath = path.join(process.cwd(), 'browser_data', '_cdp_cookies.py');
  fs.writeFileSync(scriptPath, pyScript, 'utf-8');

  try {
    const { stdout, stderr } = await execAsync(
      `docker exec ${containerName} python3 /config/_cdp_cookies.py`,
    );

    if (stderr?.includes('cdp-not-ready')) {
      return { success: false, message: 'Chrome CDP not ready. Make sure the browser has started and try again.' };
    }
    if (stderr?.includes('no-target')) {
      return { success: false, message: 'No browser page found. Open YouTube in the browser first.' };
    }

    if (!fs.existsSync(cookiesPath)) {
      return { success: false, message: 'Cookies file was not created.' };
    }

    const cookieCount = parseInt(stdout.trim(), 10) || 0;
    return {
      success: true,
      message: `Exported ${cookieCount} YouTube cookies to ${cookiesPath}`,
      cookiesPath,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return { success: false, message: `Cookie export failed: ${errMsg}` };
  }
}

/**
 * Returns the path to the YouTube cookies file if it exists, otherwise undefined.
 */
export function getYouTubeCookiesPath(): string | undefined {
  const dir = path.join(process.cwd(), 'browser_data');
  const p = path.join(dir, 'youtube-cookies.txt');

  if (process.env.YOUTUBE_COOKIES) {
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(p, process.env.YOUTUBE_COOKIES.trim(), 'utf8');
      console.log(`[Cookies] Successfully wrote YOUTUBE_COOKIES from environment variable to: ${p}`);
    } catch (e) {
      console.error('[Cookies] Failed to write YOUTUBE_COOKIES from env:', e);
    }
  }

  return fs.existsSync(p) ? p : undefined;
}


/**
 * Stop a browser instance
 */
export async function stopBrowser(sessionId?: string): Promise<{ success: boolean; message: string }> {
  try {
    if (sessionId) {
      // Stop specific session
      const session = sessionManager.getSession(sessionId);
      if (!session || session.type !== 'custom-browser') {
        return { success: false, message: 'Session not found' };
      }

      const instance = browserInstances.get(session.metadata?.targetUrl || '');
      if (instance) {
        if (instance.tunnelProcess) instance.tunnelProcess.kill();
        await execAsync(`docker rm -f ${instance.containerName}-cdp-proxy`).catch(() => { });
        await execAsync(`docker stop ${instance.containerName}`);
        browserInstances.delete(session.metadata?.targetUrl || '');
      }

      sessionManager.removeSession(sessionId);
      return { success: true, message: 'Browser session stopped' };
    } else {
      // Stop general browser
      const general = Array.from(browserInstances.values()).find(b => !b.targetUrl);
      if (!general) {
        return { success: false, message: 'No general browser running' };
      }

      if (general.tunnelProcess) general.tunnelProcess.kill();
      await execAsync(`docker rm -f ${general.containerName}-cdp-proxy`).catch(() => { });
      await execAsync(`docker stop ${general.containerName}`);
      browserInstances.delete('general');
      return { success: true, message: 'General browser stopped' };
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return { success: false, message: errMsg };
  }
}

/**
 * Get all browser instances
 */
export function getAllBrowsers() {
  return Array.from(browserInstances.entries()).map(([key, instance]) => ({
    id: key,
    url: instance.url,
    username: instance.username,
    password: instance.password,
    targetUrl: instance.targetUrl,
    port: instance.port,
    cdpPort: instance.cdpPort,
  }));
}
