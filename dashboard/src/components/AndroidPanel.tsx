import React, { useState } from 'react';
import { api } from '../api';
import { Button } from '@/components/ui/button';
import { Card, CardTitle, CardDescription } from '@/components/ui/card';

export default function AndroidPanel() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string>('');
  const [status, setStatus] = useState<{
    running: boolean;
    uptime?: string;
    deviceInfo?: string;
    webUrl?: string;
  } | null>(null);

  const startEmulator = async () => {
    setLoading(true);
    setResult('');
    try {
      const res = await api.androidStart();
      if (res.success) {
        setResult(`[SUCCESS] ${res.message}\n\nWEB URL: ${res.webUrl || 'Starting container...'}`);
        setTimeout(checkStatus, 2000);
      } else {
        setResult(`[ERROR] ${res.message}\n${res.error || ''}`);
      }
    } catch (err: any) {
      setResult(`[ERROR] ${err.message || String(err)}`);
    } finally {
      setLoading(false);
    }
  };

  const checkStatus = async () => {
    setLoading(true);
    setResult('');
    try {
      const res = await api.androidStatus();
      setStatus(res);
      if (res.running) {
        setResult(
          `[STATUS: RUNNING]\n\n` +
          `UPTIME: ${res.uptime || 'Unknown'}\n` +
          `DEVICE: ${res.deviceInfo || 'Android 13'}\n` +
          `WEB URL: ${res.webUrl || 'N/A'}`
        );
      } else {
        setResult('[STATUS: STOPPED] No active Android emulator instance detected.');
        setStatus(null);
      }
    } catch (err: any) {
      setResult(`[ERROR] ${err.message || String(err)}`);
    } finally {
      setLoading(false);
    }
  };

  const stopEmulator = async () => {
    setLoading(true);
    setResult('');
    try {
      const res = await api.androidStop();
      if (res.success) {
        setResult(`[SUCCESS] ${res.message}`);
        setStatus(null);
      } else {
        setResult(`[WARN] ${res.message}`);
      }
    } catch (err: any) {
      setResult(`[ERROR] ${err.message || String(err)}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4 text-sm font-mono">
      {/* Info card */}
      <Card className="border border-border bg-card p-4 sm:p-5">
        <div className="flex items-start gap-3 mb-4">
          <div className="w-8 h-8 border border-border bg-secondary flex items-center justify-center text-base flex-shrink-0">
            📱
          </div>
          <div className="flex-1">
            <CardTitle className="text-xs uppercase tracking-wider text-foreground mb-1">Android 13 Virtual Device</CardTitle>
            <CardDescription className="text-xs text-muted-foreground leading-relaxed">
              Cloud-hosted Android system container with full browser Web UI stream.
            </CardDescription>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
          <div className="bg-secondary border border-border p-2.5">
            <div className="text-[10px] text-muted-foreground uppercase font-bold mb-0.5">Version</div>
            <div className="text-foreground font-bold">Android 13 (Tiramisu)</div>
          </div>
          <div className="bg-secondary border border-border p-2.5">
            <div className="text-[10px] text-muted-foreground uppercase font-bold mb-0.5">Profile</div>
            <div className="text-foreground font-bold">Samsung Galaxy S10</div>
          </div>
          <div className="bg-secondary border border-border p-2.5">
            <div className="text-[10px] text-muted-foreground uppercase font-bold mb-0.5">Stream Protocol</div>
            <div className="text-foreground font-bold">WebRTC / noVNC Stream</div>
          </div>
        </div>
      </Card>

      {/* Control buttons */}
      <Card className="border border-border bg-card p-4 sm:p-5">
        <CardTitle className="text-xs uppercase tracking-wider text-foreground mb-3">Instance Controls</CardTitle>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <Button
            onClick={startEmulator}
            disabled={loading}
            variant="outline"
            size="sm"
            className="text-xs uppercase"
          >
            {loading ? 'PROCESSING...' : '▶ START EMULATOR'}
          </Button>

          <Button
            onClick={checkStatus}
            disabled={loading}
            variant="outline"
            size="sm"
            className="text-xs uppercase"
          >
            {loading ? 'PROCESSING...' : '📊 CHECK STATUS'}
          </Button>

          <Button
            onClick={stopEmulator}
            disabled={loading}
            variant="outline"
            size="sm"
            className="text-xs uppercase"
          >
            {loading ? 'PROCESSING...' : '⏹ STOP EMULATOR'}
          </Button>
        </div>
      </Card>

      {/* Result display */}
      {result && (
        <Card className="border border-border bg-card p-4">
          <CardTitle className="text-xs uppercase tracking-wider text-foreground mb-2">Diagnostic Output</CardTitle>
          <pre className="text-xs text-foreground whitespace-pre-wrap bg-secondary border border-border p-3">
            {result}
          </pre>
        </Card>
      )}
    </div>
  );
}
