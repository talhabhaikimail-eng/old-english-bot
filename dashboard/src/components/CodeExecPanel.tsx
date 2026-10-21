import React, { useState, useEffect } from 'react';
import { api, BrowserPoolPayload, WorkerExecResponse } from '../api';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Terminal, Play, Copy, AlertCircle, Plus } from 'lucide-react';

const PRESETS = {
  node: [
    {
      name: 'Fetch Runner Public IP',
      code: `const fetch = require('node-fetch') || globalThis.fetch;
(async () => {
  const res = await fetch('https://api.ipify.org?format=json');
  const data = await res.json();
  console.log('Worker Runner IP:', data.ip);
  console.log('Timestamp:', new Date().toISOString());
})();`
    },
    {
      name: 'System Platform & Memory',
      code: `const os = require('os');
console.log('OS Platform:', os.platform(), os.release());
console.log('CPU Architecture:', os.arch());
console.log('CPU Cores:', os.cpus().length);
console.log('Total Memory:', Math.round(os.totalmem() / 1024 / 1024), 'MB');
console.log('Free Memory:', Math.round(os.freemem() / 1024 / 1024), 'MB');`
    }
  ],
  python: [
    {
      name: 'Fetch Runner Public IP',
      code: `import urllib.request
import json
import datetime

req = urllib.request.urlopen('https://api.ipify.org?format=json')
data = json.loads(req.read().decode('utf-8'))
print(f"Worker Runner IP: {data['ip']}")
print(f"Timestamp: {datetime.datetime.now(datetime.timezone.utc).isoformat()}")`
    }
  ],
  shell: [
    {
      name: 'Check System Environment',
      code: `uname -a
echo "--- CPU Info ---"
lscpu | grep "Model name\\|CPU(s):" || true
echo "--- Memory ---"
free -h`
    }
  ]
};

export default function CodeExecPanel() {
  const [pool, setPool] = useState<BrowserPoolPayload | null>(null);
  const [selectedWorker, setSelectedWorker] = useState<string>('');
  const [lang, setLang] = useState<'node' | 'python' | 'shell'>('node');
  const [code, setCode] = useState<string>(PRESETS.node[0].code);
  const [timeout, setTimeoutSec] = useState<number>(30);
  const [executing, setExecuting] = useState<boolean>(false);
  const [result, setResult] = useState<WorkerExecResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'stdout' | 'stderr'>('stdout');

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

  const handleLangChange = (newLang: 'node' | 'python' | 'shell') => {
    setLang(newLang);
    setCode(PRESETS[newLang][0].code);
    setResult(null);
    setError(null);
  };

  const handleRun = async () => {
    if (!code.trim()) return;
    setExecuting(true);
    setResult(null);
    setError(null);

    try {
      const res = await api.execCodeOnWorker({
        workerId: selectedWorker || undefined,
        lang,
        code,
        timeout
      });
      setResult(res);
      if (res.stderr && !res.stdout) {
        setActiveTab('stderr');
      } else {
        setActiveTab('stdout');
      }
    } catch (err: any) {
      setError(err.message || 'Execution failed');
    } finally {
      setExecuting(false);
    }
  };

  const copyText = (txt: string) => {
    navigator.clipboard.writeText(txt).catch(() => {});
  };

  const activeWorkers = (pool?.browsers ?? []).filter(b => b.status === 'active');

  return (
    <div className="space-y-4 text-sm">
      {/* Header Banner */}
      <Card className="p-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="size-8 rounded-md border border-border bg-secondary flex items-center justify-center text-muted-foreground">
              <Terminal className="size-4" />
            </div>
            <div>
              <CardTitle className="text-sm font-semibold tracking-tight text-foreground">Code execution</CardTitle>
              <CardDescription className="text-xs text-muted-foreground mt-0.5">
                Run Node.js, Python, or Shell snippets on remote worker containers.
              </CardDescription>
            </div>
          </div>
          <Badge variant="outline" className="self-start sm:self-center">
            {activeWorkers.length} runners
          </Badge>
        </div>
      </Card>

      {/* Control Panel Settings */}
      <Card className="p-4 gap-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {/* Target Worker Selector */}
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">
              Target instance
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

          {/* Language Selector */}
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">
              Runtime language
            </label>
            <div className="grid grid-cols-3 gap-0.5 rounded-md border border-border bg-secondary/40 p-0.5 h-8">
              {(['node', 'python', 'shell'] as const).map((l) => (
                <button
                  key={l}
                  onClick={() => handleLangChange(l)}
                  className={`rounded text-xs font-medium transition-colors ${
                    lang === l
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {l === 'node' ? 'Node' : l === 'python' ? 'Python' : 'Shell'}
                </button>
              ))}
            </div>
          </div>

          {/* Execution Timeout */}
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">
              Timeout
            </label>
            <select
              value={timeout}
              onChange={(e) => setTimeoutSec(Number(e.target.value))}
              className="h-8 w-full rounded-md border border-input bg-card px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/25"
            >
              <option value={10}>10 seconds</option>
              <option value={30}>30 seconds (default)</option>
              <option value={60}>60 seconds</option>
              <option value={120}>120 seconds</option>
            </select>
          </div>
        </div>

        {/* Preset Snippets */}
        <div>
          <span className="text-xs font-medium text-muted-foreground mr-2">
            Presets
          </span>
          <div className="inline-flex flex-wrap gap-1.5 mt-1">
            {PRESETS[lang].map((p) => (
              <button
                key={p.name}
                onClick={() => setCode(p.code)}
                className="inline-flex items-center gap-1 h-6 px-2 rounded-md border border-border bg-transparent text-xs text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
              >
                <Plus className="size-3" />{p.name}
              </button>
            ))}
          </div>
        </div>

        {/* Code Editor */}
        <div className="rounded-md border border-border bg-background overflow-hidden">
          <div className="bg-secondary/40 px-3 py-1.5 flex items-center justify-between border-b border-border">
            <span className="text-xs font-mono text-muted-foreground">
              {lang === 'node' ? 'main.js' : lang === 'python' ? 'main.py' : 'main.sh'}
            </span>
            <button
              onClick={() => setCode('')}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>
          </div>
          <textarea
            value={code}
            onChange={(e) => setCode(e.target.value)}
            rows={10}
            className="w-full bg-transparent p-3 font-mono text-xs text-foreground outline-none resize-y"
            placeholder={`Enter ${lang} code...`}
            spellCheck={false}
          />
        </div>

        {/* Action Controls */}
        <div className="flex items-center justify-between pt-1">
          <span className="text-xs text-muted-foreground">
            {selectedWorker ? `Target: ${selectedWorker}` : 'Target: round-robin worker pool'}
          </span>
          <Button
            onClick={handleRun}
            disabled={executing || !code.trim()}
          >
            <Play />
            {executing ? 'Executing...' : 'Execute on runner'}
          </Button>
        </div>
      </Card>

      {/* Execution Results Output Console */}
      {(result || error) && (
        <Card className="gap-0 py-0">
          <div className="bg-secondary/40 border-b border-border px-4 py-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold tracking-tight text-foreground">Output</span>
              {result && (
                <>
                  <Badge variant={result.exit_code === 0 ? 'default' : 'destructive'}>
                    Exit {result.exit_code}
                  </Badge>
                  <Badge variant="outline">
                    {result.execution_time_ms} ms
                  </Badge>
                  <Badge variant="outline">
                    {result.workerId}
                  </Badge>
                </>
              )}
            </div>

            <div className="flex items-center gap-2">
              {result && (
                <div className="flex rounded-md border border-border bg-background p-0.5">
                  <button
                    onClick={() => setActiveTab('stdout')}
                    className={`px-2 py-0.5 rounded text-xs font-medium ${
                      activeTab === 'stdout' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    stdout ({result.stdout.length})
                  </button>
                  <button
                    onClick={() => setActiveTab('stderr')}
                    className={`px-2 py-0.5 rounded text-xs font-medium ${
                      activeTab === 'stderr' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    stderr ({result.stderr.length})
                  </button>
                </div>
              )}

              <Button
                variant="ghost"
                size="xs"
                onClick={() => copyText(result ? (activeTab === 'stdout' ? result.stdout : result.stderr) : error || '')}
                className="text-xs"
              >
                <Copy />
                Copy
              </Button>
            </div>
          </div>

          <div className="p-4 bg-background font-mono text-xs overflow-x-auto min-h-[140px] max-h-[360px]">
            {error ? (
              <div className="flex items-start gap-2 text-destructive font-sans text-sm"><AlertCircle className="size-4 mt-0.5 shrink-0" /><span>{error}</span></div>
            ) : result ? (
              <pre className="text-foreground">
                {activeTab === 'stdout'
                  ? result.stdout || '(no output produced on stdout)'
                  : result.stderr || '(no errors reported on stderr)'}
              </pre>
            ) : null}
          </div>
        </Card>
      )}
    </div>
  );
}
