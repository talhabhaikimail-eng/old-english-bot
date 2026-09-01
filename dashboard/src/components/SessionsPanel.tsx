import React, { useState } from 'react';
import { api, BASE, authFetch, SessionResult } from '../api';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

interface SessionCardProps {
  icon: string;
  title: string;
  description: string;
  action: () => Promise<SessionResult>;
}

function SessionCard({ icon, title, description, action }: SessionCardProps) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SessionResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const launch = async () => {
    setLoading(true); setError(null); setResult(null);
    try { setResult(await action()); }
    catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  };

  return (
    <Card className="flex flex-col justify-between border border-border bg-card p-4 sm:p-5 transition-all">
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 border border-border bg-secondary flex items-center justify-center text-lg">
            {icon}
          </div>
          <div>
            <h3 className="font-bold font-mono uppercase tracking-wider text-foreground text-xs sm:text-sm">{title}</h3>
            <p className="text-xs text-muted-foreground">{description}</p>
          </div>
        </div>

        {error && (
          <div className="text-xs text-foreground bg-secondary border border-border px-3 py-2 font-mono">
            [ERROR] {error}
          </div>
        )}

        {result && !result.error && (
          <div className="bg-secondary border border-border p-3 space-y-2 text-xs font-mono">
            <a href={result.url} target="_blank" rel="noopener noreferrer"
              className="text-foreground underline break-all block font-bold">
              🔗 {result.url}
            </a>
            {result.username && <p className="text-muted-foreground">USER: <span className="text-foreground">{result.username}</span></p>}
            {result.password && <p className="text-muted-foreground">PASS: <span className="text-foreground">{result.password}</span></p>}
          </div>
        )}
      </div>

      <Button
        onClick={launch}
        disabled={loading}
        variant="outline"
        size="sm"
        className="w-full mt-4 font-mono text-xs font-bold uppercase tracking-wider"
      >
        {loading ? 'LAUNCHING...' : `LAUNCH ${title.toUpperCase()}`}
      </Button>
    </Card>
  );
}

export default function SessionsPanel() {
  const [sshResult, setSshResult] = useState<any>(null);
  const [sshLoading, setSshLoading] = useState(false);
  const [sshError, setSshError] = useState<string | null>(null);

  const launchSSH = async () => {
    setSshLoading(true);
    setSshError(null);
    setSshResult(null);
    try {
      const res = await authFetch(`${BASE}/api/sessions/ssh`, { method: 'POST' });
      const data = await res.json();
      if (data.error) {
        setSshError(data.error);
      } else {
        setSshResult(data);
      }
    } catch (e) {
      setSshError((e as Error).message);
    } finally {
      setSshLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="border-b border-border pb-2">
        <p className="text-muted-foreground text-xs font-mono">
          Launch new isolated sessions. Each call establishes a fresh Cloudflare secure tunnel.
        </p>
      </div>
      
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        <SessionCard
          icon="💻" title="Web Terminal"
          description="ttyd web terminal with sudo access"
          action={api.startTerminal}
        />
        <SessionCard
          icon="🔵" title="VSCode"
          description="code-server with password auth"
          action={api.startVSCode}
        />
        <SessionCard
          icon="🌐" title="Browser"
          description="Chromium in a Docker container"
          action={api.startBrowser}
        />

        {/* SSH Terminal Card */}
        <Card className="flex flex-col justify-between border border-border bg-card p-4 sm:p-5 transition-all">
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 border border-border bg-secondary flex items-center justify-center text-lg">
                🔐
              </div>
              <div>
                <h3 className="font-bold font-mono uppercase tracking-wider text-foreground text-xs sm:text-sm">SSH Terminal</h3>
                <p className="text-xs text-muted-foreground">Isolated container with SSH port access</p>
              </div>
            </div>

            {sshError && (
              <div className="text-xs text-foreground bg-secondary border border-border px-3 py-2 font-mono">
                [ERROR] {sshError}
              </div>
            )}

            {sshResult && !sshResult.error && (
              <div className="bg-secondary border border-border p-3 space-y-2 text-xs font-mono">
                <p className="text-muted-foreground">PORT: <span className="text-foreground">{sshResult.port}</span></p>
                <p className="text-muted-foreground">USER: <span className="text-foreground">{sshResult.username}</span></p>
                <p className="text-muted-foreground">PASS: <span className="text-foreground">{sshResult.password}</span></p>
                <div className="pt-2 border-t border-border">
                  <p className="text-muted-foreground text-[10px] uppercase font-bold mb-1">Command:</p>
                  <code className="text-foreground text-[11px] bg-background border border-border p-1.5 block break-all font-mono">
                    {sshResult.sshCommand}
                  </code>
                </div>
              </div>
            )}
          </div>

          <Button
            onClick={launchSSH}
            disabled={sshLoading}
            variant="outline"
            size="sm"
            className="w-full mt-4 font-mono text-xs font-bold uppercase tracking-wider"
          >
            {sshLoading ? 'LAUNCHING...' : 'LAUNCH SSH TERMINAL'}
          </Button>
        </Card>
      </div>
    </div>
  );
}
