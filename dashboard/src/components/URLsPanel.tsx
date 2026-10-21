import React, { useState } from 'react';
import {
  Link2, Monitor, Terminal, Code2, Globe, Zap, ExternalLink, Copy, Check,
} from 'lucide-react';
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

  const ICON: Record<string, React.ComponentType<{ className?: string }>> = {
    dashboard: Monitor,
    terminal: Terminal,
    vscode: Code2,
    browser: Globe,
    novnc: Monitor,
    bypasser: Zap,
  };

  const getIcon = (k: string) => {
    if (k.startsWith('vscode')) return Code2;
    if (k.startsWith('terminal')) return Terminal;
    if (k.startsWith('browser')) return Globe;
    return ICON[k] ?? Link2;
  };

  if (keys.length === 0) {
    return (
      <Card className="p-8 sm:p-12 text-center max-w-2xl mx-auto flex flex-col items-center gap-2">
        <Link2 className="size-6 text-muted-foreground" />
        <p className="font-semibold text-sm tracking-tight text-foreground">No live tunnels connected</p>
        <p className="text-xs text-muted-foreground">Active tunnels automatically register here as sessions launch.</p>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-w-5xl mx-auto text-[13px]">
      {keys.map(key => {
        const t = tools[key];
        const displayLabel = t.label || key;
        const Icon = getIcon(key);
        return (
          <Card
            key={key}
            className="p-4 space-y-3 flex flex-col"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <div className="size-8 rounded-md border border-border bg-secondary flex items-center justify-center text-muted-foreground">
                  <Icon className="size-4" />
                </div>
                <div>
                  <CardTitle className="text-sm font-semibold tracking-tight text-foreground">{displayLabel}</CardTitle>
                  <p className="text-xs text-muted-foreground">
                    {new Date(t.registeredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
              </div>

              <Badge variant="default">
                <span className="size-1.5 rounded-full bg-primary" />
                Online
              </Badge>
            </div>

            {/* Connection link */}
            <div className="flex gap-2 items-center bg-secondary/40 border border-border rounded-md px-3 py-1.5">
              <a
                href={t.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 text-foreground hover:text-primary font-mono text-xs truncate"
              >
                {t.url}
              </a>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => copyText(t.url, `${key}-url`)}
                title="Copy URL"
              >
                {copiedKey === `${key}-url` ? <Check /> : <Copy />}
                {copiedKey === `${key}-url` ? 'Copied' : 'Copy'}
              </Button>
              <a
                href={t.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground hover:text-foreground px-1"
                title="Open URL"
              >
                <ExternalLink className="size-3.5" />
              </a>
            </div>

            {/* Credentials block */}
            {(t.username || t.password) && (
              <div className="grid grid-cols-2 gap-2 mt-auto pt-1">
                {t.username && (
                  <div
                    onClick={() => copyText(t.username!, `${key}-user`)}
                    className="bg-secondary/40 border border-border rounded-md p-2.5 cursor-pointer hover:bg-secondary/70 transition-colors"
                  >
                    <p className="text-xs font-medium text-muted-foreground mb-0.5">User</p>
                    <p className="text-xs font-mono text-foreground truncate">
                      {t.username}
                    </p>
                  </div>
                )}
                {t.password && (
                  <div
                    onClick={() => copyText(t.password!, `${key}-pass`)}
                    className="bg-secondary/40 border border-border rounded-md p-2.5 cursor-pointer hover:bg-secondary/70 transition-colors"
                  >
                    <p className="text-xs font-medium text-muted-foreground mb-0.5">Password</p>
                    <p className="text-xs font-mono text-foreground truncate">
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
