import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api, BrowserPoolItem, BrowserPoolPayload } from '../api';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

interface WorkerShellPanelProps {
  initialWorkerId?: string;
}

export default function WorkerShellPanel({ initialWorkerId }: WorkerShellPanelProps) {
  const [pool, setPool] = useState<BrowserPoolPayload | null>(null);
  const [selectedWorkerId, setSelectedWorkerId] = useState<string>(initialWorkerId || '');
  const [connStatus, setConnStatus] = useState<'connecting' | 'connected' | 'disconnected' | 'error'>('disconnected');
  const [connError, setConnError] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'terminal' | 'agents' | 'ssh'>('terminal');

  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fullScreenContainerRef = useRef<HTMLDivElement>(null);
  const poolRef = useRef<BrowserPoolPayload | null>(null);
  const selectedWorkerIdRef = useRef<string>(initialWorkerId || '');
  const connectedWorkerIdRef = useRef<string | null>(null);
  const connectedUrlRef = useRef<string | null>(null);
  const pingTimerRef = useRef<any>(null);

  // Sync refs with state
  useEffect(() => {
    selectedWorkerIdRef.current = selectedWorkerId;
  }, [selectedWorkerId]);

  useEffect(() => {
    poolRef.current = pool;
  }, [pool]);

  // Copy helper
  const handleCopy = (text: string, key: string, label = 'Copied to clipboard!') => {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopiedKey(key);
    setToastMsg(label);
    setTimeout(() => {
      setCopiedKey(null);
      setToastMsg(null);
    }, 2500);
  };

  // Current selected worker object
  const currentWorker: BrowserPoolItem | undefined = pool?.browsers.find(b => b.workerId === selectedWorkerId);

  // Connect WebSocket to worker shell
  const connectShell = useCallback((force = false) => {
    const targetWorkerId = selectedWorkerIdRef.current;
    const worker = poolRef.current?.browsers.find(b => b.workerId === targetWorkerId);
    if (!worker) return;

    // Determine target WebSocket URL:
    const directWsUrl = worker.shellWsUrl || (worker.apiUrl ? worker.apiUrl.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:') + '/ws/shell' : undefined);
    const proxyWsUrl = api.getWorkerShellWsUrl(worker.workerId);
    const targetUrl = directWsUrl || proxyWsUrl;

    if (!targetUrl) return;

    // GUARD: If already connected to this worker with the same target URL, do not reconnect unless forced!
    if (
      !force &&
      wsRef.current &&
      (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING) &&
      connectedWorkerIdRef.current === targetWorkerId &&
      connectedUrlRef.current === targetUrl
    ) {
      return;
    }

    // Teardown existing ping timer and websocket
    if (pingTimerRef.current) {
      clearInterval(pingTimerRef.current);
      pingTimerRef.current = null;
    }

    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      wsRef.current.onmessage = null;
      try { wsRef.current.close(); } catch {}
      wsRef.current = null;
    }

    connectedWorkerIdRef.current = targetWorkerId;
    connectedUrlRef.current = targetUrl;
    setConnStatus('connecting');
    setConnError(null);

    const term = terminalRef.current;
    if (term) {
      term.writeln(`\r\n\x1b[33mConnecting to worker [${worker.workerId}] shell...\x1b[0m`);
    }

    let ws: WebSocket;
    try {
      ws = new WebSocket(targetUrl);
    } catch (e: any) {
      setConnStatus('error');
      setConnError(`WebSocket instantiation failed: ${e.message}`);
      connectedWorkerIdRef.current = null;
      connectedUrlRef.current = null;
      return;
    }

    wsRef.current = ws;

    ws.onopen = () => {
      setConnStatus('connected');
      setConnError(null);
      if (term) {
        term.writeln(`\x1b[32m✔ Connected to interactive PTY shell!\x1b[0m\r\n`);
        // Send initial resize
        const fitAddon = fitAddonRef.current;
        if (fitAddon) {
          fitAddon.fit();
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      }

      // Heartbeat ping every 25 seconds to keep Cloudflare quick tunnels alive without dropping
      if (pingTimerRef.current) clearInterval(pingTimerRef.current);
      pingTimerRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({ type: 'ping' }));
          } catch {}
        }
      }, 25000);
    };

    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        // Filter out pong heartbeat responses so they don't print to terminal
        if (event.data.includes('"type":"pong"') || event.data.includes('"type": "pong"')) {
          return;
        }
        term?.write(event.data);
      } else if (event.data instanceof Blob) {
        event.data.text().then(text => {
          if (text.includes('"type":"pong"') || text.includes('"type": "pong"')) return;
          term?.write(text);
        });
      } else if (event.data instanceof ArrayBuffer) {
        const decoded = new TextDecoder('utf-8').decode(event.data);
        if (decoded.includes('"type":"pong"') || decoded.includes('"type": "pong"')) return;
        term?.write(decoded);
      }
    };

    ws.onerror = (err) => {
      console.warn('[Shell WS] WebSocket error:', err);
      // If direct tunnel failed, try dashboard proxy
      if (targetUrl === directWsUrl && proxyWsUrl && directWsUrl !== proxyWsUrl) {
        if (term) {
          term.writeln(`\r\n\x1b[33mDirect connection failed. Falling back to dashboard WebSocket proxy...\x1b[0m`);
        }
        try {
          connectedUrlRef.current = proxyWsUrl;
          const fallbackWs = new WebSocket(proxyWsUrl);
          wsRef.current = fallbackWs;
          fallbackWs.onopen = ws.onopen;
          fallbackWs.onmessage = ws.onmessage;
          fallbackWs.onerror = () => {
            if (wsRef.current === fallbackWs) {
              setConnStatus('error');
              setConnError('Unable to connect via direct tunnel or dashboard proxy');
              connectedWorkerIdRef.current = null;
              connectedUrlRef.current = null;
            }
          };
          fallbackWs.onclose = ws.onclose;
          return;
        } catch {
          // ignore
        }
      }
      if (wsRef.current === ws) {
        setConnStatus('error');
        setConnError('WebSocket connection error. Remote worker may still be initializing.');
        connectedWorkerIdRef.current = null;
        connectedUrlRef.current = null;
      }
    };

    ws.onclose = (event) => {
      if (pingTimerRef.current) {
        clearInterval(pingTimerRef.current);
        pingTimerRef.current = null;
      }
      if (wsRef.current === ws) {
        setConnStatus('disconnected');
        connectedWorkerIdRef.current = null;
        connectedUrlRef.current = null;
        if (term) {
          term.writeln(`\r\n\x1b[31mShell connection closed (${event.code}${event.reason ? `: ${event.reason}` : ''}).\x1b[0m`);
        }
      }
    };
  }, []);

  // Fetch pool (polls in background to update node tabs and stats)
  const fetchPool = async () => {
    try {
      const data = await api.getBrowserPool();
      setPool(data);
      poolRef.current = data;

      let targetId = selectedWorkerIdRef.current;
      if (!targetId && data.browsers.length > 0) {
        // Look for URL param first
        const searchParams = new URLSearchParams(window.location.search);
        const paramWorkerId = searchParams.get('workerId') || window.location.hash.split('workerId=')[1];
        const match = data.browsers.find(b => b.workerId === paramWorkerId);
        if (match) {
          targetId = match.workerId;
        } else {
          // Default to first active worker with apiUrl or any worker
          const activeWorker = data.browsers.find(b => b.status === 'active' && b.apiUrl) || data.browsers[0];
          targetId = activeWorker.workerId;
        }
        selectedWorkerIdRef.current = targetId;
        setSelectedWorkerId(targetId);
      }

      // Check if target worker is available and needs initial connection or if tunnel URL updated
      if (targetId) {
        const targetWorker = data.browsers.find(b => b.workerId === targetId);
        if (targetWorker) {
          const directWsUrl = targetWorker.shellWsUrl || (targetWorker.apiUrl ? targetWorker.apiUrl.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:') + '/ws/shell' : undefined);
          const proxyWsUrl = api.getWorkerShellWsUrl(targetWorker.workerId);
          const targetUrl = directWsUrl || proxyWsUrl;

          if (!connectedWorkerIdRef.current || !wsRef.current || wsRef.current.readyState === WebSocket.CLOSED) {
            connectShell(false);
          } else if (connectedWorkerIdRef.current === targetId && connectedUrlRef.current && targetUrl && connectedUrlRef.current !== targetUrl) {
            // Worker tunnel URL changed, reconnect to updated URL
            console.log('[Shell] Tunnel URL updated for worker, reconnecting...');
            connectShell(true);
          }
        }
      }
    } catch (e: any) {
      console.warn('Failed to load browser pool for shell:', e.message);
    }
  };

  // Poll pool data every 8s (updating worker badges and vitals without interrupting shell)
  useEffect(() => {
    fetchPool();
    const interval = setInterval(fetchPool, 8000);
    return () => clearInterval(interval);
  }, []);

  // Initialize Terminal ONCE on mount
  useEffect(() => {
    if (!terminalContainerRef.current) return;

    if (terminalRef.current) {
      terminalRef.current.dispose();
      terminalRef.current = null;
    }

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: 13,
      fontFamily: 'JetBrains Mono, Menlo, Consolas, "Courier New", monospace',
      lineHeight: 1.25,
      theme: {
        background: '#0a0e17',
        foreground: '#e2e8f0',
        cursor: '#38bdf8',
        cursorAccent: '#0a0e17',
        selectionBackground: '#0284c7',
        selectionForeground: '#ffffff',
        black: '#1e293b',
        red: '#f43f5e',
        green: '#10b981',
        yellow: '#fbbf24',
        blue: '#38bdf8',
        magenta: '#c084fc',
        cyan: '#2dd4bf',
        white: '#f8fafc',
        brightBlack: '#475569',
        brightRed: '#fb7185',
        brightGreen: '#34d399',
        brightYellow: '#fde047',
        brightBlue: '#60a5fa',
        brightMagenta: '#e879f9',
        brightCyan: '#5eead4',
        brightWhite: '#ffffff',
      },
      scrollback: 5000,
      allowTransparency: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    term.open(terminalContainerRef.current);
    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    // Send keystrokes to WebSocket
    term.onData((data: string) => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(data);
      }
    });

    // Resize listener
    const handleResize = () => {
      try {
        fitAddon.fit();
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({
            type: 'resize',
            cols: term.cols,
            rows: term.rows
          }));
        }
      } catch {}
    };

    window.addEventListener('resize', handleResize);
    setTimeout(handleResize, 100);

    return () => {
      window.removeEventListener('resize', handleResize);
      if (pingTimerRef.current) {
        clearInterval(pingTimerRef.current);
        pingTimerRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.onerror = null;
        wsRef.current.onmessage = null;
        try { wsRef.current.close(); } catch {}
        wsRef.current = null;
      }
      connectedWorkerIdRef.current = null;
      connectedUrlRef.current = null;
      term.dispose();
      terminalRef.current = null;
    };
  }, []);

  // Fit terminal when fullscreen toggles without resetting terminal
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        fitAddonRef.current?.fit();
        if (terminalRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({
            type: 'resize',
            cols: terminalRef.current.cols,
            rows: terminalRef.current.rows
          }));
        }
      } catch {}
    }, 120);
    return () => clearTimeout(timer);
  }, [isFullscreen]);

  // Connect whenever selected worker changes (e.g. user clicks another worker tab)
  useEffect(() => {
    if (selectedWorkerId && poolRef.current) {
      terminalRef.current?.clear();
      connectShell(false);
    }
  }, [selectedWorkerId, connectShell]);

  // Quick Command Injection
  const injectCommand = (cmd: string) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(cmd + '\n');
      terminalRef.current?.focus();
    } else {
      setToastMsg('⚠️ Terminal not connected. Please reconnect first.');
      setTimeout(() => setToastMsg(null), 3000);
    }
  };

  // Reset persistent shell session on worker
  const resetSession = async () => {
    if (!currentWorker) return;
    if (!window.confirm(`Reset background persistent shell session for ${currentWorker.workerId}? Any currently running background jobs in this shell will be terminated.`)) return;

    try {
      if (currentWorker.apiUrl) {
        await fetch(`${currentWorker.apiUrl}/api/shell/sessions/default/kill`, { method: 'POST' }).catch(() => {});
      }
      setToastMsg('🔄 Background session reset. Spawning fresh shell...');
      setTimeout(() => {
        connectShell(true);
      }, 400);
    } catch (e: any) {
      setToastMsg(`Failed to reset: ${e.message}`);
    }
  };

  // Fullscreen toggle
  const toggleFullscreen = () => {
    setIsFullscreen(prev => !prev);
    setTimeout(() => {
      fitAddonRef.current?.fit();
      if (terminalRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'resize',
          cols: terminalRef.current.cols,
          rows: terminalRef.current.rows
        }));
      }
    }, 150);
  };

  const browsers = pool?.browsers || [];

  return (
    <div
      ref={fullScreenContainerRef}
      className={`space-y-4 font-mono text-sm transition-all ${
        isFullscreen
          ? 'fixed inset-0 z-50 bg-[#060911] p-4 flex flex-col h-screen w-screen overflow-hidden'
          : 'relative'
      }`}
    >
      {/* Top Header Card */}
      <Card className="border border-border bg-card p-3 shadow-md">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xl">💻</span>
              <CardTitle className="text-sm uppercase font-bold tracking-wider text-foreground">
                Distributed Worker Shell Console (WebSSH & PTY)
              </CardTitle>
              <Badge
                variant="outline"
                className={`text-[10px] uppercase font-bold ${
                  connStatus === 'connected'
                    ? 'border-emerald-600 bg-emerald-950/60 text-emerald-400'
                    : connStatus === 'connecting'
                    ? 'border-yellow-600 bg-yellow-950/60 text-yellow-400'
                    : 'border-rose-600 bg-rose-950/60 text-rose-400'
                }`}
              >
                ● {connStatus.toUpperCase()}
              </Badge>
              <Badge
                variant="outline"
                className="text-[10px] font-bold border-indigo-500/40 bg-indigo-950/40 text-indigo-300 hidden md:inline-flex"
                title="This shell runs in the background. Closing this page will not stop your tasks."
              >
                ⚡ PERSISTENT (BACKGROUND)
              </Badge>
            </div>
            <CardDescription className="text-xs text-muted-foreground mt-0.5">
              Direct bidirectional PTY shell running continuously in worker background. Closing this tab will NOT terminate your background commands or agents.
            </CardDescription>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {toastMsg && (
              <div className="px-3 py-1 text-xs border border-sky-600 bg-sky-950/80 text-sky-200 font-mono animate-in fade-in">
                {toastMsg}
              </div>
            )}

            <Button
              variant="outline"
              size="sm"
              onClick={() => connectShell(true)}
              disabled={!currentWorker}
              className="font-mono text-xs uppercase font-bold text-sky-400 border-sky-800 hover:bg-sky-950/50"
              title="Reconnect to existing background persistent session"
            >
              🔄 REATTACH
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={resetSession}
              disabled={!currentWorker}
              className="font-mono text-xs uppercase font-bold text-rose-400 border-rose-900/60 hover:bg-rose-950/50"
              title="Kill and restart this worker's background shell session"
            >
              ⚠️ RESET
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={() => terminalRef.current?.clear()}
              className="font-mono text-xs uppercase font-bold text-muted-foreground hover:text-foreground"
              title="Clear terminal screen"
            >
              🧹 CLEAR
            </Button>

            <Button
              variant={isFullscreen ? 'default' : 'outline'}
              size="sm"
              onClick={toggleFullscreen}
              className="font-mono text-xs uppercase font-bold"
              title={isFullscreen ? 'Exit Full Screen' : 'Open Full Page / Full Screen'}
            >
              {isFullscreen ? '✕ EXIT FULLSCREEN' : '⛶ FULLSCREEN'}
            </Button>
          </div>
        </div>

        {/* Worker Switcher Tabs */}
        <div className="mt-3 pt-3 border-t border-border flex items-center gap-2 overflow-x-auto pb-1">
          <span className="text-[10px] uppercase font-bold text-muted-foreground whitespace-nowrap">
            WORKER NODE:
          </span>
          {browsers.length === 0 ? (
            <span className="text-xs text-muted-foreground italic">No workers currently registered in pool</span>
          ) : (
            browsers.map(b => {
              const isSelected = b.workerId === selectedWorkerId;
              return (
                <button
                  key={b.workerId}
                  onClick={() => setSelectedWorkerId(b.workerId)}
                  className={`flex items-center gap-1.5 px-3 py-1 text-xs border rounded-sm transition-all whitespace-nowrap ${
                    isSelected
                      ? 'border-sky-500 bg-sky-950/60 text-sky-200 font-bold shadow-sm'
                      : 'border-border bg-secondary/50 text-muted-foreground hover:text-foreground hover:bg-secondary'
                  }`}
                >
                  <span
                    className={`w-2 h-2 rounded-full ${
                      b.status === 'active' ? 'bg-emerald-400' : 'bg-yellow-400'
                    }`}
                  />
                  <span>{b.workerId}</span>
                  {b.antigravityCli && (
                    <span className={`text-[9px] px-1 rounded border ${
                      b.antigravityAuth
                        ? 'bg-emerald-950/80 text-emerald-300 border-emerald-700 font-bold'
                        : 'bg-indigo-950 text-indigo-300 border-indigo-800'
                    }`}>
                      {b.antigravityAuth ? 'AGY ⚡ (Auth)' : 'AGY'}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
      </Card>

      {/* Main Terminal and Agent Controls */}
      <div className={`grid grid-cols-1 ${isFullscreen ? 'flex-1 min-h-0' : ''} gap-3`}>
        {/* Terminal Window */}
        <Card className={`border border-border bg-[#0a0e17] overflow-hidden flex flex-col ${
          isFullscreen ? 'flex-1 min-h-0' : 'h-[540px]'
        }`}>
          {/* Terminal Title Bar */}
          <div className="bg-secondary/90 border-b border-border px-3 py-1.5 flex items-center justify-between text-xs">
            <div className="flex items-center gap-2">
              <span className="flex gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-rose-500/80 inline-block" />
                <span className="w-2.5 h-2.5 rounded-full bg-yellow-500/80 inline-block" />
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-500/80 inline-block" />
              </span>
              <span className="text-muted-foreground text-[11px]">
                bash — {currentWorker ? currentWorker.workerId : 'No worker selected'}
              </span>
            </div>

            <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
              {currentWorker?.sshPort && (
                <span>SSH Port: <strong className="text-foreground">{currentWorker.sshPort}</strong></span>
              )}
              {currentWorker?.apiUrl && (
                <span className="hidden sm:inline">API: <strong className="text-sky-400">{currentWorker.apiUrl.replace(/^https?:\/\//, '')}</strong></span>
              )}
            </div>
          </div>

          {/* Terminal Screen Canvas */}
          <div
            ref={terminalContainerRef}
            className="flex-1 w-full p-2 overflow-hidden select-text cursor-text"
          />
        </Card>

        {/* Quick Agent Actions Bar & SSH Credentials */}
        {!isFullscreen && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            {/* Agent Actions Column */}
            <Card className="lg:col-span-2 border border-border bg-card p-3">
              <CardTitle className="text-xs uppercase font-bold tracking-wider text-foreground flex items-center gap-1.5">
                <span>⚡</span> Agent Shortcuts & Command Presets
              </CardTitle>
              <CardDescription className="text-xs text-muted-foreground mt-0.5">
                Execute autonomous agent workflows and inspect diagnostics directly inside the live shell.
              </CardDescription>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => injectCommand('agy --version && agy --help')}
                  className="font-mono text-xs justify-start border-indigo-500/30 hover:bg-indigo-950/40 text-indigo-300"
                >
                  ⚡ Antigravity CLI (agy)
                </Button>

                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => injectCommand('ps aux | grep -E "agy|chrome|course|python|node"')}
                  className="font-mono text-xs justify-start border-emerald-500/30 hover:bg-emerald-950/40 text-emerald-300"
                >
                  📊 Inspect Running Agents
                </Button>

                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => injectCommand('df -h && free -h && uptime')}
                  className="font-mono text-xs justify-start border-sky-500/30 hover:bg-sky-950/40 text-sky-300"
                >
                  💾 System Vitals (Disk/RAM)
                </Button>

                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => injectCommand('curl -s http://127.0.0.1:8085/worker/status | jq . || curl -s http://127.0.0.1:8085/worker/status')}
                  className="font-mono text-xs justify-start border-emerald-500/30 hover:bg-emerald-950/40 text-emerald-300"
                >
                  🎓 Course Worker Status
                </Button>

                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => injectCommand('tail -n 25 /tmp/worker_api.log')}
                  className="font-mono text-xs justify-start border-amber-500/30 hover:bg-amber-950/40 text-amber-300"
                >
                  📋 Worker API Logs
                </Button>

                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => injectCommand('curl -s https://api.ipify.org && echo ""')}
                  className="font-mono text-xs justify-start border-border hover:bg-secondary text-foreground"
                >
                  🌐 Check Runner Public IP
                </Button>
              </div>
            </Card>

            {/* Direct SSH Details Card */}
            <Card className="border border-border bg-card p-3 flex flex-col justify-between">
              <div>
                <CardTitle className="text-xs uppercase font-bold tracking-wider text-foreground flex items-center justify-between">
                  <span>🔑 OpenSSH Access</span>
                  <Badge variant="outline" className="text-[9px] text-muted-foreground font-mono">
                    PORT {currentWorker?.sshPort || 2222}
                  </Badge>
                </CardTitle>
                <CardDescription className="text-xs text-muted-foreground mt-0.5">
                  Direct SSH terminal command & credentials.
                </CardDescription>

                <div className="space-y-2 mt-3 text-xs">
                  {/* SSH Command */}
                  <div className="bg-secondary/70 border border-border p-1.5 rounded-sm">
                    <div className="text-[9px] uppercase font-bold text-muted-foreground flex justify-between">
                      <span>SSH Command:</span>
                      <button
                        onClick={() => handleCopy(currentWorker?.sshCommand || `ssh -p ${currentWorker?.sshPort || 2222} ${currentWorker?.sshUser || 'runner'}@localhost`, 'ssh-cmd')}
                        className="text-sky-400 hover:underline"
                      >
                        {copiedKey === 'ssh-cmd' ? 'COPIED!' : 'COPY'}
                      </button>
                    </div>
                    <code className="text-[11px] text-foreground block truncate mt-0.5 select-all font-mono">
                      {currentWorker?.sshCommand || `ssh -p ${currentWorker?.sshPort || 2222} ${currentWorker?.sshUser || 'runner'}@localhost`}
                    </code>
                  </div>

                  {/* Password */}
                  {currentWorker?.sshPassword && (
                    <div className="bg-secondary/70 border border-border p-1.5 rounded-sm">
                      <div className="text-[9px] uppercase font-bold text-muted-foreground flex justify-between">
                        <span>Password:</span>
                        <div className="flex gap-2">
                          <button
                            onClick={() => setShowPassword(p => !p)}
                            className="text-muted-foreground hover:text-foreground"
                          >
                            {showPassword ? 'HIDE' : 'SHOW'}
                          </button>
                          <button
                            onClick={() => handleCopy(currentWorker.sshPassword!, 'ssh-pwd')}
                            className="text-sky-400 hover:underline"
                          >
                            {copiedKey === 'ssh-pwd' ? 'COPIED!' : 'COPY'}
                          </button>
                        </div>
                      </div>
                      <code className="text-[11px] text-foreground block mt-0.5 select-all font-mono">
                        {showPassword ? currentWorker.sshPassword : '••••••••••••••••'}
                      </code>
                    </div>
                  )}
                </div>
              </div>

              {currentWorker?.vscodeUrl && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => window.open(currentWorker.vscodeUrl, '_blank')}
                  className="w-full mt-2 font-mono text-xs text-sky-400 border-sky-800 hover:bg-sky-950/40"
                >
                  🔵 OPEN WEB VS CODE ↗
                </Button>
              )}
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
