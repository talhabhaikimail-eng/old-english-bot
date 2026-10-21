import React, { useState } from 'react';
import { api } from '../api';
import { Button } from '@/components/ui/button';
import { Card, CardTitle, CardDescription } from '@/components/ui/card';
import { Smartphone, Play, Activity, Square } from 'lucide-react';

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
        setResult(`Success: ${res.message}\n\nWeb URL: ${res.webUrl || 'Starting container...'}`);
        setTimeout(checkStatus, 2000);
      } else {
        setResult(`Error: ${res.message}\n${res.error || ''}`);
      }
    } catch (err: any) {
      setResult(`Error: ${err.message || String(err)}`);
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
          `Status: running\n\n` +
          `Uptime: ${res.uptime || 'Unknown'}\n` +
          `Device: ${res.deviceInfo || 'Android 13'}\n` +
          `Web URL: ${res.webUrl || 'N/A'}`
        );
      } else {
        setResult('Status: stopped. No active Android emulator instance detected.');
        setStatus(null);
      }
    } catch (err: any) {
      setResult(`Error: ${err.message || String(err)}`);
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
        setResult(`Success: ${res.message}`);
        setStatus(null);
      } else {
        setResult(`Warning: ${res.message}`);
      }
    } catch (err: any) {
      setResult(`Error: ${err.message || String(err)}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4 text-sm">
      {/* Info card */}
      <Card className="p-4">
        <div className="flex items-start gap-3 mb-4">
          <div className="size-8 rounded-md border border-border bg-secondary flex items-center justify-center flex-shrink-0 text-muted-foreground">
            <Smartphone className="size-4" />
          </div>
          <div className="flex-1">
            <CardTitle className="text-sm font-semibold tracking-tight text-foreground mb-1">Android 13 Virtual Device</CardTitle>
            <CardDescription className="text-xs text-muted-foreground leading-relaxed">
              Cloud-hosted Android system container with full browser Web UI stream.
            </CardDescription>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
          <div className="bg-secondary/40 rounded-md border border-border p-2.5">
            <div className="text-xs font-medium text-muted-foreground mb-0.5">Version</div>
            <div className="text-foreground font-medium">Android 13 (Tiramisu)</div>
          </div>
          <div className="bg-secondary/40 rounded-md border border-border p-2.5">
            <div className="text-xs font-medium text-muted-foreground mb-0.5">Profile</div>
            <div className="text-foreground font-medium">Samsung Galaxy S10</div>
          </div>
          <div className="bg-secondary/40 rounded-md border border-border p-2.5">
            <div className="text-xs font-medium text-muted-foreground mb-0.5">Stream Protocol</div>
            <div className="text-foreground font-medium">WebRTC / noVNC Stream</div>
          </div>
        </div>
      </Card>

      {/* Control buttons */}
      <Card className="p-4">
        <CardTitle className="text-sm font-semibold tracking-tight text-foreground mb-3">Instance Controls</CardTitle>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <Button
            onClick={startEmulator}
            disabled={loading}
            variant="default"
            size="sm"
          >
            {loading ? 'Processing...' : <><Play /> Start emulator</>}
          </Button>

          <Button
            onClick={checkStatus}
            disabled={loading}
            variant="outline"
            size="sm"
          >
            {loading ? 'Processing...' : <><Activity /> Check status</>}
          </Button>

          <Button
            onClick={stopEmulator}
            disabled={loading}
            variant="destructive"
            size="sm"
          >
            {loading ? 'Processing...' : <><Square /> Stop emulator</>}
          </Button>
        </div>
      </Card>

      {/* Result display */}
      {result && (
        <Card className="p-4">
          <CardTitle className="text-sm font-semibold tracking-tight text-foreground mb-2">Diagnostic output</CardTitle>
          <pre className="text-xs text-foreground whitespace-pre-wrap font-mono bg-secondary/40 rounded-md border border-border p-3">
            {result}
          </pre>
        </Card>
      )}
    </div>
  );
}
