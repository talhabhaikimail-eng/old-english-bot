import React, { useState } from 'react';
import { ToolUrl } from '../api';
import { Card, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

export default function URLsPanel({ tools }: { tools: Record<string, ToolUrl> }) {
  const keys = Object.keys(tools);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const copyText = (text: string, label: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopiedKey(label);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const ICON: Record<string, string> = {
    dashboard: '🖥️',
    terminal: '💻',
    vscode: '🔵',
    browser: '🌐',
    novnc: '🖥️',
    bypasser: '⚡',
  };

  const getIcon = (k: string) => {
    if (k.startsWith('vscode')) return '🔵';
    if (k.startsWith('terminal')) return '💻';
    if (k.startsWith('browser')) return '🌐';
    return ICON[k] ?? '🔗';
  };

  if (keys.length === 0) {
    return (
      <Card className="border border-border bg-card p-8 sm:p-12 text-center max-w-2xl mx-auto space-y-2 font-mono">
        <div className="text-2xl">🔗</div>
        <p className="font-bold text-xs uppercase tracking-wider text-foreground">No Live Tunnels Connected</p>
        <p className="text-xs text-muted-foreground">Active tunnels automatically register here as sessions launch.</p>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-5xl mx-auto text-sm">
      {keys.map(key => {
        const t = tools[key];
        const displayLabel = t.label || key;
        return (
          <Card
            key={key}
            className="border border-border bg-card p-4 sm:p-5 space-y-3 flex flex-col"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 border border-border bg-secondary flex items-center justify-center text-base">
                  {getIcon(key)}
                </div>
                <div>
                  <CardTitle className="font-bold font-mono uppercase text-xs tracking-wider text-foreground">{displayLabel}</CardTitle>
                  <p className="text-[10px] text-muted-foreground font-mono">
                    {new Date(t.registeredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
              </div>
              
              <Badge variant="outline" className="text-[9px] font-mono font-bold">
                [ONLINE]
              </Badge>
            </div>

            {/* Connection link */}
            <div className="flex gap-2 items-center bg-secondary border border-border px-3 py-2">
              <a
                href={t.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 text-foreground underline font-mono text-xs truncate font-bold"
              >
                {t.url}
              </a>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => copyText(t.url, `${key}-url`)}
                className="font-mono text-xs px-1.5"
                title="Copy URL"
              >
                {copiedKey === `${key}-url` ? 'COPIED' : 'COPY'}
              </Button>
              <a
                href={t.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-muted-foreground hover:text-foreground font-mono px-1"
                title="Open URL"
              >
                ↗
              </a>
            </div>

            {/* Credentials block */}
            {(t.username || t.password) && (
              <div className="grid grid-cols-2 gap-2 mt-auto pt-2">
                {t.username && (
                  <div
                    onClick={() => copyText(t.username!, `${key}-user`)}
                    className="bg-secondary border border-border p-2.5 cursor-pointer hover:border-foreground transition-colors font-mono"
                  >
                    <p className="text-[9px] text-muted-foreground uppercase font-bold tracking-wider mb-0.5">USER</p>
                    <p className="text-xs font-mono text-foreground truncate font-bold">
                      {t.username}
                    </p>
                  </div>
                )}
                {t.password && (
                  <div
                    onClick={() => copyText(t.password!, `${key}-pass`)}
                    className="bg-secondary border border-border p-2.5 cursor-pointer hover:border-foreground transition-colors font-mono"
                  >
                    <p className="text-[9px] text-muted-foreground uppercase font-bold tracking-wider mb-0.5">PASS</p>
                    <p className="text-xs font-mono text-foreground truncate font-bold">
                      {t.password}
                    </p>
                  </div>
                )}
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}
