import React, { useState } from 'react';
import { api, BASE, authFetch, SessionResult } from '../api';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Terminal, Code2, Globe, KeyRound, ExternalLink, AlertCircle, type LucideIcon } from 'lucide-react';

interface SessionCardProps {
  icon: LucideIcon;
  title: string;
  description: string;
  action: () => Promise<SessionResult>;
}

function SessionCard({ icon: Icon, title, description, action }: SessionCardProps) {
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
    <Card className="flex flex-col justify-between gap-4 p-4">
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <div className="size-9 rounded-md border border-border bg-secondary flex items-center justify-center text-muted-foreground">
            <Icon className="size-4" />
          </div>
          <div>
            <h3 className="text-sm font-semibold tracking-tight text-foreground">{title}</h3>
            <p className="text-xs text-muted-foreground">{description}</p>
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
<AlertCircle className="size-3.5 mt-0.5 shrink-0" />
<span className="break-words min-w-0">{error}</span>
</div>
        )}

        {result && !result.error && (
          <div className="bg-secondary/40 border border-border rounded-md p-3 space-y-2 text-xs">
            <a href={result.url} target="_blank" rel="noopener noreferrer"
              className="text-primary hover:underline break-all flex items-start gap-1.5 font-mono">
              <ExternalLink className="size-3.5 mt-0.5 shrink-0" />
              <span>{result.url}</span>
            </a>
            {result.username && <p className="text-muted-foreground">User: <span className="text-foreground font-mono">{result.username}</span></p>}
            {result.password && <p className="text-muted-foreground">Password: <span className="text-foreground font-mono">{result.password}</span></p>}
          </div>
        )}
      </div>

      <Button
        onClick={launch}
        disabled={loading}
        variant="outline"
        size="sm"
        className="w-full"
      >
        {loading ? 'Launching...' : `Launch ${title}`}
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
      <div>
        <h2 className="text-sm font-semibold tracking-tight text-foreground">Sessions</h2>
        <p className="text-muted-foreground text-xs mt-0.5">
          Launch new isolated sessions. Each call establishes a fresh Cloudflare secure tunnel.
        </p>
      </div>
      
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        <SessionCard
          icon={Terminal} title="Web terminal"
          description="ttyd web terminal with sudo access"
          action={api.startTerminal}
        />
        <SessionCard
          icon={Code2} title="VS Code"
          description="code-server with password auth"
          action={api.startVSCode}
        />
        <SessionCard
          icon={Globe} title="Browser"
          description="Chromium in a Docker container"
          action={api.startBrowser}
        />

        {/* SSH Terminal Card */}
        <Card className="flex flex-col justify-between gap-4 p-4">
          <div className="space-y-3 px-0">
            <div className="flex items-center gap-3">
              <div className="size-9 rounded-md border border-border bg-secondary flex items-center justify-center text-muted-foreground">
                <KeyRound className="size-4" />
              </div>
              <div>
                <h3 className="text-sm font-semibold tracking-tight text-foreground">SSH terminal</h3>
                <p className="text-xs text-muted-foreground">Isolated container with SSH port access</p>
              </div>
            </div>

            {sshError && (
              <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
<AlertCircle className="size-3.5 mt-0.5 shrink-0" />
<span className="break-words min-w-0">{sshError}</span>
</div>
            )}

            {sshResult && !sshResult.error && (
              <div className="bg-secondary/40 border border-border rounded-md p-3 space-y-2 text-xs">
                <p className="text-muted-foreground">Port: <span className="text-foreground font-mono">{sshResult.port}</span></p>
                <p className="text-muted-foreground">User: <span className="text-foreground font-mono">{sshResult.username}</span></p>
                <p className="text-muted-foreground">Password: <span className="text-foreground font-mono">{sshResult.password}</span></p>
                <div className="pt-2 border-t border-border">
                  <p className="text-muted-foreground text-xs font-medium mb-1">Command</p>
                  <code className="text-foreground text-[11px] bg-background border border-border rounded-md p-2 block break-all font-mono">
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
            className="w-full"
          >
            {sshLoading ? 'Launching...' : 'Launch SSH terminal'}
          </Button>
        </Card>
      </div>
    </div>
  );
}
