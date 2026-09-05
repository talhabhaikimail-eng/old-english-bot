import React, { useState, useEffect } from 'react';
import { api, BrowserPoolPayload } from '../api';
import { Button } from '@/components/ui/button';
import { Card, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

function copyText(text: string) {
  navigator.clipboard.writeText(text).catch(() => {});
}

export default function PoolPanel() {
  const [data, setData] = useState<BrowserPoolPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [restartMsg, setRestartMsg] = useState('');
  const [showPasswordMap, setShowPasswordMap] = useState<Record<string, boolean>>({});
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  const fetchPool = async () => {
    try {
      const res = await api.getBrowserPool();
      setData(res);
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch browser pool status');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPool();
    const interval = setInterval(fetchPool, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleRestart = async () => {
    if (window.confirm('Trigger fleet restart? This will dispatch a GHA run to spawn fresh workers.')) {
      setRestarting(true);
      setRestartMsg('');
      try {
        const res = await api.restartBrowsers();
        setRestartMsg(res.message || 'Restart command sent successfully!');
        setTimeout(() => setRestartMsg(''), 4000);
        await fetchPool();
      } catch (err: any) {
        setRestartMsg(`[ERROR] ${err.message}`);
      } finally {
        setRestarting(false);
      }
    }
  };

  const handleCopy = (text: string, key: string, label = 'Copied to clipboard!') => {
    copyText(text);
    setCopiedKey(key);
    setToastMsg(label);
    setTimeout(() => {
      setCopiedKey(null);
      setToastMsg(null);
    }, 2500);
  };

  const togglePassword = (workerId: string) => {
    setShowPasswordMap(prev => ({
      ...prev,
      [workerId]: !prev[workerId]
    }));
  };

  const handleConnectVSCode = (url: string, password?: string) => {
    if (password) {
      copyText(password);
      setToastMsg('🔑 Password copied to clipboard! Launching Web VS Code...');
      setTimeout(() => setToastMsg(null), 3500);
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const formatAge = (registeredAt: string) => {
    const elapsedMs = Date.now() - new Date(registeredAt).getTime();
    const mins = Math.floor(elapsedMs / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    return `${hrs}h ${mins % 60}m ago`;
  };

  if (loading && !data) {
    return (
      <div className="flex flex-col items-center justify-center py-20 space-y-2 font-mono text-xs text-muted-foreground">
        <p>Loading browser worker pool status...</p>
      </div>
    );
  }

  if (error && !data) {
    return (
      <Card className="border border-border bg-card p-6 text-center space-y-3 max-w-md mx-auto font-mono">
        <CardTitle className="text-foreground text-xs uppercase font-bold">Failed to load pool status</CardTitle>
        <CardDescription className="text-muted-foreground text-xs">{error}</CardDescription>
        <Button
          onClick={() => { setLoading(true); fetchPool(); }}
          variant="outline"
          size="sm"
          className="font-mono text-xs uppercase"
        >
          TRY AGAIN
        </Button>
      </Card>
    );
  }

  const browsers = data?.browsers ?? [];
  const cachedCount = browsers.filter(b => b.isCached).length;
  const vscodeCount = browsers.filter(b => b.vscodeUrl).length;
  const agyCount = browsers.filter(b => b.antigravityCli).length;

  return (
    <div className="space-y-4 text-sm font-mono">
      {/* Fleet Stats Overview */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <Card className="border border-border bg-card p-3 flex flex-col justify-between">
          <p className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider">Total Fleet Size</p>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-2xl font-bold text-foreground">{data?.total ?? 0}</span>
            <span className="text-xs text-muted-foreground">workers</span>
          </div>
        </Card>

        <Card className="border border-border bg-card p-3 flex flex-col justify-between">
          <p className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider">Active Workers</p>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-2xl font-bold text-emerald-400">{data?.active ?? 0}</span>
            <span className="text-xs text-muted-foreground">online</span>
          </div>
        </Card>

        <Card className="border border-border bg-card p-3 flex flex-col justify-between">
          <p className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider">Web VS Code</p>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-2xl font-bold text-sky-400">{vscodeCount}</span>
            <span className="text-xs text-muted-foreground">online</span>
          </div>
        </Card>

        <Card className="border border-border bg-card p-3 flex flex-col justify-between">
          <p className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider">Antigravity CLI</p>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-2xl font-bold text-indigo-400">{agyCount}</span>
            <span className="text-xs text-muted-foreground">ready</span>
          </div>
        </Card>

        <Card className="border border-border bg-card p-3 flex flex-col justify-between">
          <p className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider">Pre-warmed CDP</p>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-2xl font-bold text-foreground">{cachedCount}</span>
            <span className="text-xs text-muted-foreground">cached</span>
          </div>
        </Card>
      </div>

      {/* Control Actions & Notifications */}
      <Card className="flex flex-col sm:flex-row items-start sm:items-center justify-between bg-card border border-border p-3 gap-3">
        <div>
          <CardTitle className="text-xs uppercase font-bold tracking-wider text-foreground">Browser Fleet Orchestrator</CardTitle>
          <CardDescription className="text-xs text-muted-foreground mt-0.5">
            Manage live distributed worker instances with Web VS Code, Antigravity CLI, and CDP tunnels.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          {toastMsg && (
            <div className="px-3 py-1 text-xs border border-sky-600 bg-sky-950/70 text-sky-200 font-mono animate-in fade-in">
              {toastMsg}
            </div>
          )}
          {restartMsg && (
            <div className="px-3 py-1 text-xs border border-border bg-secondary text-foreground font-mono">
              {restartMsg}
            </div>
          )}
          <Button
            onClick={handleRestart}
            disabled={restarting}
            variant="outline"
            size="sm"
            className="font-mono text-xs uppercase font-bold"
          >
            ⚡ {restarting ? 'TRIGGERING...' : 'RESTART FLEET'}
          </Button>
        </div>
      </Card>

      {/* Worker List */}
      <Card className="border border-border bg-card overflow-hidden">
        {browsers.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground text-xs font-mono">
            No remote browser workers registered. Ensure worker workflows are running.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs font-mono">
              <thead>
                <tr className="border-b border-border bg-secondary">
                  <th className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground px-4 py-2.5">Worker ID</th>
                  <th className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground px-4 py-2.5">Web VS Code & IDE</th>
                  <th className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground px-4 py-2.5">CDP Endpoints</th>
                  <th className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground px-4 py-2.5">Status</th>
                  <th className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground px-4 py-2.5">Heartbeat</th>
                  <th className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground px-4 py-2.5">Age</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {browsers.map(b => {
                  const isPwShown = !!showPasswordMap[b.workerId];
                  return (
                    <tr key={b.workerId} className="hover:bg-secondary/40 transition-colors">
                      {/* Worker ID */}
                      <td className="px-4 py-3 align-top font-bold text-foreground select-all cursor-pointer"
                          onClick={() => handleCopy(b.workerId, `id-${b.workerId}`, 'Worker ID copied!')}
                          title="Click to copy Worker ID">
                        <div className="flex items-center gap-1.5">
                          <span>{b.workerId}</span>
                          {copiedKey === `id-${b.workerId}` && (
                            <span className="text-[9px] text-emerald-400 font-normal">✓</span>
                          )}
                        </div>
                      </td>

                      {/* Web VS Code & Environment */}
                      <td className="px-4 py-3 align-top min-w-[280px] max-w-sm space-y-2">
                        {b.vscodeUrl ? (
                          <div className="bg-card border border-sky-500/30 p-2.5 rounded-sm space-y-2">
                            {/* Header / Title */}
                            <div className="flex items-center justify-between gap-1">
                              <span className="text-[10px] font-bold uppercase text-sky-400 flex items-center gap-1">
                                🔵 Web VS Code
                              </span>
                              {b.antigravityCli ? (
                                <Badge className="text-[9px] bg-emerald-950/60 text-emerald-400 border border-emerald-800 px-1.5 py-0">
                                  ⚡ AGY CLI Ready
                                </Badge>
                              ) : (
                                <Badge variant="outline" className="text-[9px] text-muted-foreground px-1.5 py-0">
                                  AGY CLI
                                </Badge>
                              )}
                            </div>

                            {/* URL Link */}
                            <div className="flex items-center gap-1.5 bg-secondary/80 border border-border px-2 py-1">
                              <span className="text-[9px] font-bold text-muted-foreground">URL:</span>
                              <a
                                href={b.vscodeUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex-1 text-sky-300 hover:text-sky-200 underline text-xs truncate select-all"
                                title="Open Web VS Code URL"
                              >
                                {b.vscodeUrl}
                              </a>
                              <Button
                                variant="ghost"
                                size="xs"
                                onClick={() => handleCopy(b.vscodeUrl!, `vsc-url-${b.workerId}`, 'VS Code URL copied!')}
                                className="text-[10px] h-auto p-0.5"
                              >
                                {copiedKey === `vsc-url-${b.workerId}` ? 'COPIED' : 'COPY'}
                              </Button>
                            </div>

                            {/* Password Box */}
                            {b.vscodePassword && (
                              <div className="flex items-center gap-1.5 bg-secondary/80 border border-border px-2 py-1">
                                <span className="text-[9px] font-bold text-muted-foreground">PWD:</span>
                                <span className="flex-1 font-mono text-xs select-all text-foreground tracking-wider font-semibold">
                                  {isPwShown ? b.vscodePassword : '••••••••••••••••'}
                                </span>
                                <Button
                                  variant="ghost"
                                  size="xs"
                                  onClick={() => togglePassword(b.workerId)}
                                  className="text-[9px] h-auto p-0.5 text-muted-foreground hover:text-foreground"
                                  title={isPwShown ? 'Hide password' : 'Show password'}
                                >
                                  {isPwShown ? 'HIDE' : 'SHOW'}
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="xs"
                                  onClick={() => handleCopy(b.vscodePassword!, `pwd-${b.workerId}`, 'Password copied!')}
                                  className="text-[10px] h-auto p-0.5"
                                >
                                  {copiedKey === `pwd-${b.workerId}` ? 'COPIED' : 'COPY'}
                                </Button>
                              </div>
                            )}

                            {/* Quick Connect Button */}
                            <Button
                              onClick={() => handleConnectVSCode(b.vscodeUrl!, b.vscodePassword)}
                              size="sm"
                              className="w-full bg-sky-600 hover:bg-sky-500 text-white text-xs font-bold font-mono tracking-wider h-7"
                              title="Copies password and opens Web VS Code in a new tab"
                            >
                              ⚡ CONNECT TO VS CODE ↗
                            </Button>
                          </div>
                        ) : (
                          <div className="flex flex-col gap-1 text-muted-foreground text-xs py-1">
                            <span className="text-[10px] uppercase tracking-wider">VS Code initializing...</span>
                            {b.antigravityCli && (
                              <span className="text-[9px] text-emerald-400">⚡ AGY CLI Ready</span>
                            )}
                          </div>
                        )}
                      </td>

                      {/* CDP Tunnel URLs */}
                      <td className="px-4 py-3 align-top max-w-sm space-y-1.5">
                        {/* Puppeteer CDP */}
                        <div className="flex items-center gap-1.5 bg-secondary border border-border px-2 py-1">
                          <span className="text-[9px] font-bold uppercase text-muted-foreground">
                            PUPPETEER
                          </span>
                          <a href={`${b.cdpUrl}/json/version`} target="_blank" rel="noopener noreferrer"
                             className="flex-1 text-foreground underline text-xs truncate select-all">
                            {b.cdpUrl}
                          </a>
                          <Button variant="ghost" size="xs" onClick={() => handleCopy(b.cdpUrl, `cdp-${b.workerId}`)}
                                  className="text-[10px] h-auto p-0.5">
                            {copiedKey === `cdp-${b.workerId}` ? 'COPIED' : 'COPY'}
                          </Button>
                        </div>

                        {/* SeleniumBase UC CDP */}
                        {(b.sbCdpUrl || b.seleniumCdpUrl) && (
                          <div className="flex items-center gap-1.5 bg-secondary border border-border px-2 py-1">
                            <span className="text-[9px] font-bold uppercase text-muted-foreground">
                              SELENIUM
                            </span>
                            <a href={`${b.sbCdpUrl || b.seleniumCdpUrl}/json/version`} target="_blank" rel="noopener noreferrer"
                               className="flex-1 text-foreground underline text-xs truncate select-all">
                              {b.sbCdpUrl || b.seleniumCdpUrl}
                            </a>
                            <Button variant="ghost" size="xs" onClick={() => handleCopy((b.sbCdpUrl || b.seleniumCdpUrl)!, `sb-${b.workerId}`)}
                                    className="text-[10px] h-auto p-0.5">
                              {copiedKey === `sb-${b.workerId}` ? 'COPIED' : 'COPY'}
                            </Button>
                          </div>
                        )}
                      </td>

                      {/* Status Badge */}
                      <td className="px-4 py-3 align-top">
                        <div className="space-y-1">
                          <Badge variant="outline" className={`text-[9px] uppercase font-bold ${
                            b.status === 'active' ? 'border-emerald-700 text-emerald-400' : 'text-muted-foreground'
                          }`}>
                            {b.status}
                          </Badge>
                          <div>
                            {b.isCached ? (
                              <Badge variant="outline" className="text-[8px] bg-foreground text-background">
                                CACHED
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-[8px] text-muted-foreground">
                                DISCONNECTED
                              </Badge>
                            )}
                          </div>
                        </div>
                      </td>

                      {/* Heartbeat time */}
                      <td className="px-4 py-3 align-top text-muted-foreground">
                        {b.secondsSinceHeartbeat <= 5 ? 'Just now' : `${b.secondsSinceHeartbeat}s ago`}
                      </td>

                      {/* Age */}
                      <td className="px-4 py-3 align-top text-muted-foreground">
                        {formatAge(b.registeredAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
