import React, { useState, useEffect } from 'react';
import { api, BrowserPoolPayload } from '../api';
import { Button } from '@/components/ui/button';
import { Card, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Terminal, Zap, Check, ExternalLink, Code2, Server } from 'lucide-react';

function copyText(text: string) {
  navigator.clipboard.writeText(text).catch(() => {});
}

const statLabel = 'text-xs font-medium text-muted-foreground';
const fieldRow = 'flex items-center gap-1.5 bg-secondary/40 border border-border rounded-md px-2 py-1';
const fieldLabel = 'text-[11px] font-medium text-muted-foreground';
const linkCls = 'flex-1 text-foreground hover:text-primary underline-offset-2 hover:underline text-xs font-mono truncate select-all';
const miniBtn = 'text-[11px] h-auto p-0.5';

export default function PoolPanel() {
  const [data, setData] = useState<BrowserPoolPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [restartMsg, setRestartMsg] = useState('');
  const [showPasswordMap, setShowPasswordMap] = useState<Record<string, boolean>>({});
  const [showSshMap, setShowSshMap] = useState<Record<string, boolean>>({});
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  const handleOpenShell = (workerId: string, inNewTab = false) => {
    const targetUrl = `${window.location.pathname}#shell?workerId=${encodeURIComponent(workerId)}`;
    if (inNewTab) {
      window.open(targetUrl, '_blank');
    } else {
      window.location.hash = `#shell?workerId=${encodeURIComponent(workerId)}`;
    }
  };

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
        setRestartMsg(`Error: ${err.message}`);
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
      setToastMsg('Password copied to clipboard! Launching Web VS Code...');
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
      <div className="flex flex-col items-center justify-center py-20 space-y-2 text-xs text-muted-foreground">
        <p>Loading browser worker pool status...</p>
      </div>
    );
  }

  if (error && !data) {
    return (
      <Card className="p-6 text-center items-center gap-3 max-w-md mx-auto">
        <CardTitle>Failed to load pool status</CardTitle>
        <CardDescription>{error}</CardDescription>
        <Button
          onClick={() => { setLoading(true); fetchPool(); }}
          variant="outline"
          size="sm"
        >
          Try again
        </Button>
      </Card>
    );
  }

  const browsers = data?.browsers ?? [];
  const cachedCount = browsers.filter(b => b.isCached).length;
  const vscodeCount = browsers.filter(b => b.vscodeUrl).length;
  const agyCount = browsers.filter(b => b.antigravityCli).length;

  return (
    <div className="space-y-4 text-[13px]">
      {/* Fleet Stats Overview */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <Card className="p-3 gap-1 justify-between">
          <p className={statLabel}>Total fleet size</p>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-semibold text-foreground">{data?.total ?? 0}</span>
            <span className="text-xs text-muted-foreground">workers</span>
          </div>
        </Card>

        <Card className="p-3 gap-1 justify-between">
          <p className={statLabel}>Active workers</p>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-semibold text-primary">{data?.active ?? 0}</span>
            <span className="text-xs text-muted-foreground">online</span>
          </div>
        </Card>

        <Card className="p-3 gap-1 justify-between">
          <p className={statLabel}>Web VS Code</p>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-semibold text-foreground">{vscodeCount}</span>
            <span className="text-xs text-muted-foreground">online</span>
          </div>
        </Card>

        <Card className="p-3 gap-1 justify-between">
          <p className={statLabel}>Antigravity CLI</p>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-semibold text-foreground">{agyCount}</span>
            <span className="text-xs text-muted-foreground">ready</span>
          </div>
        </Card>

        <Card className="p-3 gap-1 justify-between">
          <p className={statLabel}>Pre-warmed CDP</p>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-semibold text-foreground">{cachedCount}</span>
            <span className="text-xs text-muted-foreground">cached</span>
          </div>
        </Card>
      </div>

      {/* Control Actions & Notifications */}
      <Card className="flex flex-col sm:flex-row items-start sm:items-center justify-between p-4 gap-3">
        <div>
          <CardTitle>Browser fleet orchestrator</CardTitle>
          <CardDescription className="mt-0.5">
            Manage live distributed worker instances with Web VS Code, Antigravity CLI, and CDP tunnels.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {toastMsg && (
            <div className="px-3 py-1 text-xs rounded-md border border-primary/30 bg-primary/10 text-primary animate-in fade-in">
              {toastMsg}
            </div>
          )}
          {restartMsg && (
            <div className="px-3 py-1 text-xs rounded-md border border-border bg-secondary text-foreground">
              {restartMsg}
            </div>
          )}
          <Button
            onClick={() => { window.location.hash = '#shell'; }}
            variant="outline"
            size="sm"
            title="Open interactive multi-worker shell console"
          >
            <Terminal className="size-3.5" /> Shell console
          </Button>
          <Button
            onClick={handleRestart}
            disabled={restarting}
            variant="outline"
            size="sm"
          >
            <Zap className="size-3.5" /> {restarting ? 'Triggering...' : 'Restart fleet'}
          </Button>
        </div>
      </Card>

      {/* Worker List */}
      <Card className="overflow-hidden p-0 gap-0">
        {browsers.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground text-xs flex flex-col items-center gap-2">
            <Server className="size-5" />
            No remote browser workers registered. Ensure worker workflows are running.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-secondary/40">
                  <th className="text-xs font-medium text-muted-foreground px-4 py-2.5">Worker ID</th>
                  <th className="text-xs font-medium text-muted-foreground px-4 py-2.5">Web VS Code &amp; IDE</th>
                  <th className="text-xs font-medium text-muted-foreground px-4 py-2.5">CDP endpoints</th>
                  <th className="text-xs font-medium text-muted-foreground px-4 py-2.5">Status</th>
                  <th className="text-xs font-medium text-muted-foreground px-4 py-2.5">Heartbeat</th>
                  <th className="text-xs font-medium text-muted-foreground px-4 py-2.5">Age</th>
                </tr>
              </thead>
              <tbody>
                {browsers.map(b => {
                  const isPwShown = !!showPasswordMap[b.workerId];
                  return (
                    <tr key={b.workerId} className="border-t border-border hover:bg-secondary/50 transition-colors">
                      {/* Worker ID */}
                      <td className="px-4 py-2.5 align-top font-medium font-mono text-foreground select-all cursor-pointer"
                          onClick={() => handleCopy(b.workerId, `id-${b.workerId}`, 'Worker ID copied!')}
                          title="Click to copy Worker ID">
                        <div className="flex items-center gap-1.5">
                          <span>{b.workerId}</span>
                          {copiedKey === `id-${b.workerId}` && (
                            <Check className="size-3 text-primary" />
                          )}
                        </div>
                      </td>

                      {/* Web VS Code & Environment */}
                      <td className="px-4 py-2.5 align-top min-w-[280px] max-w-sm space-y-2">
                        {b.vscodeUrl ? (
                          <div className="bg-card border border-border p-2.5 rounded-md space-y-2">
                            {/* Header / Title */}
                            <div className="flex items-center justify-between gap-1">
                              <span className="text-xs font-medium text-foreground flex items-center gap-1.5">
                                <Code2 className="size-3.5 text-primary" /> Web VS Code
                              </span>
                              {b.antigravityCli ? (
                                <Badge className="gap-1">
                                  <Zap /> AGY CLI ready
                                </Badge>
                              ) : (
                                <Badge variant="outline">
                                  AGY CLI
                                </Badge>
                              )}
                            </div>

                            {/* URL Link */}
                            <div className={fieldRow}>
                              <span className={fieldLabel}>URL:</span>
                              <a
                                href={b.vscodeUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className={linkCls}
                                title="Open Web VS Code URL"
                              >
                                {b.vscodeUrl}
                              </a>
                              <Button
                                variant="ghost"
                                size="xs"
                                onClick={() => handleCopy(b.vscodeUrl!, `vsc-url-${b.workerId}`, 'VS Code URL copied!')}
                                className={miniBtn}
                              >
                                {copiedKey === `vsc-url-${b.workerId}` ? 'Copied' : 'Copy'}
                              </Button>
                            </div>

                            {/* Password Box */}
                            {b.vscodePassword && (
                              <div className={fieldRow}>
                                <span className={fieldLabel}>Password:</span>
                                <span className="flex-1 font-mono text-xs select-all text-foreground">
                                  {isPwShown ? b.vscodePassword : '••••••••••••••••'}
                                </span>
                                <Button
                                  variant="ghost"
                                  size="xs"
                                  onClick={() => togglePassword(b.workerId)}
                                  className={miniBtn}
                                  title={isPwShown ? 'Hide password' : 'Show password'}
                                >
                                  {isPwShown ? 'Hide' : 'Show'}
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="xs"
                                  onClick={() => handleCopy(b.vscodePassword!, `pwd-${b.workerId}`, 'Password copied!')}
                                  className={miniBtn}
                                >
                                  {copiedKey === `pwd-${b.workerId}` ? 'Copied' : 'Copy'}
                                </Button>
                              </div>
                            )}

                            {/* Quick Connect Button */}
                            <Button
                              onClick={() => handleConnectVSCode(b.vscodeUrl!, b.vscodePassword)}
                              size="sm"
                              className="w-full"
                              title="Copies password and opens Web VS Code in a new tab"
                            >
                              Connect to VS Code <ExternalLink className="size-3.5" />
                            </Button>

                            {/* Live WebSocket Shell Button */}
                            <div className="flex gap-1.5">
                              <Button
                                onClick={() => handleOpenShell(b.workerId, false)}
                                size="sm"
                                variant="secondary"
                                className="flex-1"
                                title="Open live interactive WebSocket PTY shell"
                              >
                                <Terminal className="size-3.5" /> Open shell
                              </Button>
                              <Button
                                onClick={() => handleOpenShell(b.workerId, true)}
                                size="sm"
                                variant="outline"
                                title="Open shell in full page new tab"
                              >
                                <ExternalLink className="size-3.5" /> New tab
                              </Button>
                            </div>

                            {/* SSH Connection Box */}
                            {(b.sshCommand || b.sshPort) && (
                              <div className="bg-secondary/40 border border-border p-2 rounded-md space-y-1 text-[11px]">
                                <div className="flex items-center justify-between">
                                  <span className={fieldLabel}>
                                    SSH: {b.sshUser || 'runner'} (:{b.sshPort || 2222})
                                  </span>
                                  <Button
                                    variant="ghost"
                                    size="xs"
                                    onClick={() => handleCopy(b.sshCommand || `ssh -p ${b.sshPort || 2222} ${b.sshUser || 'runner'}@localhost`, `ssh-${b.workerId}`, 'SSH Command copied!')}
                                    className={`${miniBtn} text-primary hover:text-primary`}
                                  >
                                    {copiedKey === `ssh-${b.workerId}` ? 'Copied' : 'Copy command'}
                                  </Button>
                                </div>
                                <code className="block text-[11px] text-foreground font-mono truncate select-all">
                                  {b.sshCommand || `ssh -p ${b.sshPort || 2222} ${b.sshUser || 'runner'}@localhost`}
                                </code>
                                {b.sshPassword && (
                                  <div className="flex items-center justify-between pt-0.5 text-[11px]">
                                    <span className="text-muted-foreground font-mono">
                                      Password: {showSshMap[b.workerId] ? b.sshPassword : '••••••••'}
                                    </span>
                                    <div className="flex gap-2">
                                      <button
                                        onClick={() => setShowSshMap(prev => ({ ...prev, [b.workerId]: !prev[b.workerId] }))}
                                        className="text-[11px] text-muted-foreground hover:text-foreground"
                                      >
                                        {showSshMap[b.workerId] ? 'Hide' : 'Show'}
                                      </button>
                                      <button
                                        onClick={() => handleCopy(b.sshPassword!, `sshpwd-${b.workerId}`, 'SSH Password copied!')}
                                        className="text-[11px] text-primary hover:underline"
                                      >
                                        {copiedKey === `sshpwd-${b.workerId}` ? 'Copied' : 'Copy'}
                                      </button>
                                    </div>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="flex flex-col gap-2 py-1">
                            <div className="flex gap-1.5">
                              <Button
                                onClick={() => handleOpenShell(b.workerId, false)}
                                size="sm"
                                variant="secondary"
                                className="flex-1"
                              >
                                <Terminal className="size-3.5" /> Open shell
                              </Button>
                              <Button
                                onClick={() => handleOpenShell(b.workerId, true)}
                                size="sm"
                                variant="outline"
                                title="Open shell in new tab"
                              >
                                <ExternalLink className="size-3.5" />
                              </Button>
                            </div>
                            <span className="text-xs text-muted-foreground">VS Code initializing...</span>
                            {b.antigravityCli && (
                              <span className="text-[11px] text-primary flex items-center gap-1">
                                <Zap className="size-3" />
                                <span>AGY CLI ready</span>
                                {b.antigravityAuth && (
                                  <Badge className="ml-1 h-4 px-1.5 text-[10px]">
                                    Auth
                                  </Badge>
                                )}
                              </span>
                            )}
                          </div>
                        )}

                        {b.courseWorkerUrl && (
                          <div className="bg-card border border-border p-2.5 rounded-md space-y-1.5 mt-2">
                            <div className="flex items-center justify-between gap-1">
                              <span className="text-xs font-medium text-foreground flex items-center gap-1.5">
                                <Zap className="size-3.5 text-primary" /> Go course worker
                              </span>
                              <Badge>
                                <span className="font-mono">:8085</span> active
                              </Badge>
                            </div>
                            <div className={fieldRow}>
                              <span className={fieldLabel}>URL:</span>
                              <a
                                href={`${b.courseWorkerUrl}/worker/status`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className={linkCls}
                                title="Open Course Worker Status"
                              >
                                {b.courseWorkerUrl}
                              </a>
                              <Button
                                variant="ghost"
                                size="xs"
                                onClick={() => handleCopy(b.courseWorkerUrl!, `cw-url-${b.workerId}`, 'Course Worker URL copied!')}
                                className={miniBtn}
                              >
                                {copiedKey === `cw-url-${b.workerId}` ? 'Copied' : 'Copy'}
                              </Button>
                            </div>
                          </div>
                        )}
                      </td>

                      {/* CDP Tunnel URLs */}
                      <td className="px-4 py-2.5 align-top max-w-sm space-y-1.5">
                        {/* Puppeteer CDP */}
                        <div className={fieldRow}>
                          <span className={fieldLabel}>Puppeteer</span>
                          <a href={`${b.cdpUrl}/json/version`} target="_blank" rel="noopener noreferrer"
                             className={linkCls}>
                            {b.cdpUrl}
                          </a>
                          <Button variant="ghost" size="xs" onClick={() => handleCopy(b.cdpUrl, `cdp-${b.workerId}`)}
                                  className={miniBtn}>
                            {copiedKey === `cdp-${b.workerId}` ? 'Copied' : 'Copy'}
                          </Button>
                        </div>

                        {/* SeleniumBase UC CDP */}
                        {(b.sbCdpUrl || b.seleniumCdpUrl) && (
                          <div className={fieldRow}>
                            <span className={fieldLabel}>Selenium</span>
                            <a href={`${b.sbCdpUrl || b.seleniumCdpUrl}/json/version`} target="_blank" rel="noopener noreferrer"
                               className={linkCls}>
                              {b.sbCdpUrl || b.seleniumCdpUrl}
                            </a>
                            <Button variant="ghost" size="xs" onClick={() => handleCopy((b.sbCdpUrl || b.seleniumCdpUrl)!, `sb-${b.workerId}`)}
                                    className={miniBtn}>
                              {copiedKey === `sb-${b.workerId}` ? 'Copied' : 'Copy'}
                            </Button>
                          </div>
                        )}
                      </td>

                      {/* Status Badge */}
                      <td className="px-4 py-2.5 align-top">
                        <div className="space-y-1">
                          <Badge variant="outline" className={
                            b.status === 'active'
                              ? 'bg-primary/10 border-primary/30 text-primary'
                              : 'bg-secondary border-border text-muted-foreground'
                          }>
                            {b.status}
                          </Badge>
                          <div>
                            {b.isCached ? (
                              <Badge variant="secondary">
                                Cached
                              </Badge>
                            ) : (
                              <Badge variant="outline">
                                Disconnected
                              </Badge>
                            )}
                          </div>
                        </div>
                      </td>

                      {/* Heartbeat time */}
                      <td className="px-4 py-2.5 align-top text-muted-foreground">
                        {b.secondsSinceHeartbeat <= 5 ? 'Just now' : `${b.secondsSinceHeartbeat}s ago`}
                      </td>

                      {/* Age */}
                      <td className="px-4 py-2.5 align-top text-muted-foreground">
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
