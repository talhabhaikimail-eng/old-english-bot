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

  return (
    <div className="space-y-4 text-sm font-mono">
      {/* Fleet Stats Overview */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
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
            <span className="text-2xl font-bold text-foreground">{data?.active ?? 0}</span>
            <span className="text-xs text-muted-foreground">online</span>
          </div>
        </Card>

        <Card className="border border-border bg-card p-3 flex flex-col justify-between">
          <p className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider">Pre-warmed CDP</p>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-2xl font-bold text-foreground">{cachedCount}</span>
            <span className="text-xs text-muted-foreground">cached</span>
          </div>
        </Card>

        <Card className="border border-border bg-card p-3 flex flex-col justify-between">
          <p className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider">Pool Efficiency</p>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-2xl font-bold text-foreground">
              {data?.active ? Math.round((cachedCount / data.active) * 100) : 0}%
            </span>
            <span className="text-xs text-muted-foreground">ready</span>
          </div>
        </Card>
      </div>

      {/* Control Actions */}
      <Card className="flex flex-col sm:flex-row items-start sm:items-center justify-between bg-card border border-border p-3 gap-3">
        <div>
          <CardTitle className="text-xs uppercase font-bold tracking-wider text-foreground">Browser Fleet Orchestrator</CardTitle>
          <CardDescription className="text-xs text-muted-foreground mt-0.5">Control, restart, and monitor live distributed worker instances.</CardDescription>
        </div>
        <div className="flex items-center gap-2">
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
                  <th className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground px-4 py-2.5">CDP Endpoints</th>
                  <th className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground px-4 py-2.5">Status</th>
                  <th className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground px-4 py-2.5">Pre-Warm</th>
                  <th className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground px-4 py-2.5">Heartbeat</th>
                  <th className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground px-4 py-2.5">Age</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {browsers.map(b => (
                  <tr key={b.workerId} className="hover:bg-secondary transition-colors">
                    {/* Worker ID */}
                    <td className="px-4 py-3 font-bold text-foreground select-all cursor-pointer"
                        onClick={() => { copyText(b.workerId); }}
                        title="Click to copy Worker ID">
                      {b.workerId}
                    </td>

                    {/* CDP Tunnel URLs */}
                    <td className="px-4 py-3 max-w-sm space-y-1.5">
                      {/* Puppeteer CDP */}
                      <div className="flex items-center gap-1.5 bg-secondary border border-border px-2 py-1">
                        <span className="text-[9px] font-bold uppercase text-muted-foreground">
                          PUPPETEER
                        </span>
                        <a href={`${b.cdpUrl}/json/version`} target="_blank" rel="noopener noreferrer"
                           className="flex-1 text-foreground underline text-xs truncate select-all">
                          {b.cdpUrl}
                        </a>
                        <Button variant="ghost" size="xs" onClick={() => copyText(b.cdpUrl)}
                                className="text-[10px] h-auto p-0.5">COPY</Button>
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
                          <Button variant="ghost" size="xs" onClick={() => copyText((b.sbCdpUrl || b.seleniumCdpUrl)!)}
                                  className="text-[10px] h-auto p-0.5">COPY</Button>
                        </div>
                      )}
                    </td>

                    {/* Status Badge */}
                    <td className="px-4 py-3">
                      <Badge variant="outline" className="text-[9px] uppercase font-bold">
                        {b.status}
                      </Badge>
                    </td>

                    {/* Connection/Cache Status */}
                    <td className="px-4 py-3">
                      {b.isCached ? (
                        <Badge variant="outline" className="text-[9px] bg-foreground text-background">
                          CACHED
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[9px] text-muted-foreground">
                          DISCONNECTED
                        </Badge>
                      )}
                    </td>

                    {/* Heartbeat time */}
                    <td className="px-4 py-3 text-muted-foreground">
                      {b.secondsSinceHeartbeat <= 5 ? 'Just now' : `${b.secondsSinceHeartbeat}s ago`}
                    </td>

                    {/* Age */}
                    <td className="px-4 py-3 text-muted-foreground">
                      {formatAge(b.registeredAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
