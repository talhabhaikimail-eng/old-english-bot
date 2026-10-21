import React, { useState, useEffect } from 'react';
import { api, BrowserPoolPayload, WorkerProxyResponse } from '../api';
import { Button } from '@/components/ui/button';
import { Card, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Globe, Send, Plus, X, Copy, AlertCircle } from 'lucide-react';

interface HeaderPair {
  key: string;
  value: string;
}

export default function ProxyPanel() {
  const [pool, setPool] = useState<BrowserPoolPayload | null>(null);
  const [selectedWorker, setSelectedWorker] = useState<string>('');
  const [url, setUrl] = useState<string>('https://api.ipify.org?format=json');
  const [method, setMethod] = useState<string>('GET');
  const [headers, setHeaders] = useState<HeaderPair[]>([
    { key: 'Accept', value: 'application/json' }
  ]);
  const [body, setBody] = useState<string>('');
  const [timeout, setTimeoutSec] = useState<number>(15);
  const [sending, setSending] = useState<boolean>(false);
  const [response, setResponse] = useState<WorkerProxyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showHeaders, setShowHeaders] = useState<boolean>(false);

  const fetchPool = async () => {
    try {
      const data = await api.getBrowserPool();
      setPool(data);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    fetchPool();
    const interval = setInterval(fetchPool, 8000);
    return () => clearInterval(interval);
  }, []);

  const handleAddHeader = () => {
    setHeaders([...headers, { key: '', value: '' }]);
  };

  const handleHeaderChange = (index: number, field: 'key' | 'value', val: string) => {
    const next = [...headers];
    next[index][field] = val;
    setHeaders(next);
  };

  const handleRemoveHeader = (index: number) => {
    setHeaders(headers.filter((_, i) => i !== index));
  };

  const handleSend = async () => {
    if (!url.trim()) return;
    setSending(true);
    setResponse(null);
    setError(null);

    const headerDict: Record<string, string> = {};
    for (const h of headers) {
      if (h.key.trim()) {
        headerDict[h.key.trim()] = h.value.trim();
      }
    }

    try {
      const res = await api.proxyRequestViaWorker({
        workerId: selectedWorker || undefined,
        url: url.trim(),
        method,
        headers: headerDict,
        body: body.trim() || undefined,
        timeout
      });
      setResponse(res);
    } catch (err: any) {
      setError(err.message || 'Proxy request failed');
    } finally {
      setSending(false);
    }
  };

  const copyText = (txt: string) => {
    navigator.clipboard.writeText(txt).catch(() => {});
  };

  const generateCurl = () => {
    let curl = `curl -X ${method} "${url}"`;
    for (const h of headers) {
      if (h.key.trim()) {
        curl += ` \\\n  -H "${h.key.trim()}: ${h.value.trim()}"`;
      }
    }
    if (['POST', 'PUT', 'PATCH'].includes(method) && body.trim()) {
      curl += ` \\\n  -d '${body.trim()}'`;
    }
    return curl;
  };

  const activeWorkers = (pool?.browsers ?? []).filter(b => b.status === 'active');

  let prettyResponseBody = response?.body ?? '';
  try {
    if (response?.body) {
      const parsed = JSON.parse(response.body);
      prettyResponseBody = JSON.stringify(parsed, null, 2);
    }
  } catch {
    // fallback
  }

  return (
    <div className="space-y-4 text-sm">
      {/* Header Banner */}
      <Card className="p-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="size-8 rounded-md border border-border bg-secondary flex items-center justify-center text-muted-foreground">
              <Globe className="size-4" />
            </div>
            <div>
              <CardTitle className="text-sm font-semibold tracking-tight text-foreground">HTTP relay proxy</CardTitle>
              <CardDescription className="text-xs text-muted-foreground mt-0.5">
                Route HTTP API requests through distributed runner IP addresses.
              </CardDescription>
            </div>
          </div>
          <Badge variant="outline" className="self-start sm:self-center">
            {activeWorkers.length} relays
          </Badge>
        </div>
      </Card>

      {/* Main Request Form */}
      <Card className="p-4 gap-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">
              Relay worker node
            </label>
            <select
              value={selectedWorker}
              onChange={(e) => setSelectedWorker(e.target.value)}
              className="h-8 w-full rounded-md border border-input bg-card px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/25"
            >
              <option value="">Auto (round-robin worker)</option>
              {activeWorkers.map((w) => (
                <option key={w.workerId} value={w.workerId}>
                  {w.workerId} ({w.secondsSinceHeartbeat}s ago)
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">
              Timeout
            </label>
            <select
              value={timeout}
              onChange={(e) => setTimeoutSec(Number(e.target.value))}
              className="h-8 w-full rounded-md border border-input bg-card px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/25"
            >
              <option value={5}>5 seconds</option>
              <option value={15}>15 seconds (Default)</option>
              <option value={30}>30 seconds</option>
              <option value={60}>60 seconds</option>
            </select>
          </div>
        </div>

        {/* Method & URL Row */}
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1.5">
            Request method and URL
          </label>
          <div className="flex flex-col sm:flex-row gap-2">
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value)}
              className="h-8 rounded-md border border-input bg-card px-2.5 text-sm font-medium text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/25"
            >
              {['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'].map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            <Input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/api/v1/endpoint"
              className="flex-1 font-mono"
            />
            <Button
              onClick={handleSend}
              disabled={sending || !url.trim()}
            >
              <Send />
              {sending ? 'Relaying...' : 'Send request'}
            </Button>
          </div>
        </div>

        {/* Headers Editor */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              HTTP headers ({headers.length})
            </span>
            <Button
              variant="ghost"
              size="xs"
              onClick={handleAddHeader}
              className="text-xs"
            >
              <Plus />
              Add header
            </Button>
          </div>

          <div className="space-y-1.5">
            {headers.map((h, idx) => (
              <div key={idx} className="flex gap-2 items-center">
                <Input
                  type="text"
                  placeholder="Header name"
                  value={h.key}
                  onChange={(e) => handleHeaderChange(idx, 'key', e.target.value)}
                  className="w-1/3 font-mono text-xs"
                />
                <Input
                  type="text"
                  placeholder="Header value"
                  value={h.value}
                  onChange={(e) => handleHeaderChange(idx, 'value', e.target.value)}
                  className="flex-1 font-mono text-xs"
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => handleRemoveHeader(idx)}
                  title="Remove header"
                >
                  <X />
                </Button>
              </div>
            ))}
          </div>
        </div>

        {/* Request Body */}
        {['POST', 'PUT', 'PATCH'].includes(method) && (
          <div className="space-y-1">
            <label className="block text-xs font-medium text-muted-foreground">
              Request payload (JSON / raw)
            </label>
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={4}
              placeholder='{"key": "value"}'
              className="w-full font-mono text-xs resize-y"
            />
          </div>
        )}
      </Card>

      {/* Response Display Section */}
      {(response || error) && (
        <Card className="gap-0 py-0">
          <div className="bg-secondary/40 border-b border-border px-4 py-2 flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold tracking-tight text-foreground">Response</span>
              {response && (
                <>
                  <Badge variant={response.status_code >= 400 ? 'destructive' : response.status_code >= 200 && response.status_code < 300 ? 'default' : 'secondary'}>
                    HTTP {response.status_code}
                  </Badge>
                  <Badge variant="outline">
                    {response.execution_time_ms} ms
                  </Badge>
                  <Badge variant="outline">
                    {response.workerId}
                  </Badge>
                </>
              )}
            </div>

            <div className="flex items-center gap-2">
              {response && (
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => setShowHeaders(!showHeaders)}
                  className="text-xs"
                >
                  {showHeaders ? 'Hide headers' : 'Show headers'}
                </Button>
              )}
              <Button
                variant="ghost"
                size="xs"
                onClick={() => copyText(response ? response.body : error || '')}
                className="text-xs"
              >
                <Copy />
                Copy body
              </Button>
            </div>
          </div>

          {/* Response Headers Table */}
          {response && showHeaders && (
            <div className="bg-secondary/40 border-b border-border p-3 text-xs font-mono max-h-[160px] overflow-y-auto space-y-1">
              {Object.entries(response.headers).map(([k, v]) => (
                <div key={k} className="flex gap-2">
                  <span className="text-foreground font-medium">{k}:</span>
                  <span className="text-muted-foreground truncate">{v}</span>
                </div>
              ))}
            </div>
          )}

          {/* Response Body Console */}
          <div className="p-4 bg-background font-mono text-xs overflow-x-auto min-h-[140px] max-h-[380px]">
            {error ? (
              <div className="flex items-start gap-2 text-destructive font-sans text-sm"><AlertCircle className="size-4 mt-0.5 shrink-0" /><span>{error}</span></div>
            ) : response ? (
              <pre className="text-foreground leading-relaxed">{prettyResponseBody || '(empty response body)'}</pre>
            ) : null}
          </div>

          {/* Equivalent cURL Exporter */}
          <div className="bg-secondary/40 border-t border-border px-4 py-3 flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">cURL command</span>
            <Button
              variant="outline"
              size="xs"
              onClick={() => copyText(generateCurl())}
              className="text-xs"
            >
              <Copy />
              Copy cURL command
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
