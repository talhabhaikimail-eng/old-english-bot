import React, { useState, useEffect, useRef, useCallback } from 'react';
import { api, BASE, LLMModelInfo, LLMStatus } from '../api';
import { Button } from '@/components/ui/button';
import { Card, CardTitle, CardDescription } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';

function CustomBadge({ text }: { text: string }) {
  return (
    <Badge variant="outline" className="text-[10px] font-mono border-border bg-secondary">
      {text}
    </Badge>
  );
}

function StatusBar({ status }: { status: LLMStatus | null }) {
  if (!status) return null;
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 border border-border bg-secondary text-xs font-mono">
      <span className="font-bold">
        {!status.server_running
          ? '[SERVER STOPPED]'
          : status.loaded
            ? `[MODEL: ${status.label?.toUpperCase()}] (${status.ctx?.toLocaleString()} CTX)`
            : '[NO MODEL LOADED]'}
      </span>
    </div>
  );
}

function ModelCard({
  model,
  onDownload,
  onLoad,
  onDelete,
  onUnload,
  downloading,
}: {
  model: LLMModelInfo;
  onDownload: (id: string) => void;
  onLoad: (id: string) => void;
  onDelete: (id: string) => void;
  onUnload: () => void;
  downloading: Set<string>;
}) {
  const isDownloading = !model.downloaded && (downloading.has(model.id) || model.download_status === 'downloading');

  return (
    <Card className="relative border border-border bg-card p-4 flex flex-col justify-between gap-3">
      {model.loaded && (
        <Badge variant="outline" className="absolute top-3 right-3 text-[9px] bg-foreground text-background font-bold">
          [ACTIVE]
        </Badge>
      )}

      <div>
        <div className="flex items-start gap-2 pr-16">
          <div className="w-7 h-7 border border-border bg-secondary flex items-center justify-center text-sm flex-shrink-0 font-mono">
            🧠
          </div>
          <div className="min-w-0">
            <CardTitle className="font-bold font-mono text-xs uppercase tracking-wider text-foreground truncate">{model.label}</CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{model.description}</p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 mt-2.5 flex-wrap">
          {model.tags.map(t => <CustomBadge key={t} text={t.toUpperCase()} />)}
          <CustomBadge text={`${model.size_gb}GB`} />
          <CustomBadge text={`${(model.ctx / 1024).toFixed(model.ctx >= 4096 ? 0 : 1)}K CTX`} />
        </div>
      </div>

      {model.download_status === 'error' && model.download_error && (
        <p className="text-[11px] text-foreground bg-secondary border border-border px-2 py-1 font-mono">
          [ERROR] {model.download_error}
        </p>
      )}

      <div className="flex gap-2 mt-auto pt-2 border-t border-border">
        {!model.downloaded && !isDownloading && (
          <Button
            onClick={() => onDownload(model.id)}
            variant="outline"
            size="xs"
            className="flex-1 font-mono text-[10px] uppercase"
          >
            ⬇ DOWNLOAD GGUF
          </Button>
        )}
        {isDownloading && (
          <div className="flex-1 py-1 bg-secondary border border-border text-muted-foreground text-[10px] font-mono text-center font-bold">
            DOWNLOADING...
          </div>
        )}
        {model.downloaded && !model.loaded && !isDownloading && (
          <>
            <Button
              onClick={() => onLoad(model.id)}
              variant="outline"
              size="xs"
              className="flex-1 font-mono text-[10px] uppercase font-bold"
            >
              ▶ LOAD MODEL
            </Button>
            <Button
              onClick={() => onDelete(model.id)}
              variant="outline"
              size="xs"
              className="px-2 font-mono text-[10px]"
              title="Delete model file"
            >
              🗑
            </Button>
          </>
        )}
        {model.loaded && (
          <Button
            onClick={onUnload}
            variant="outline"
            size="xs"
            className="flex-1 font-mono text-[10px] uppercase"
          >
            ⏹ UNLOAD MODEL
          </Button>
        )}
      </div>
    </Card>
  );
}

interface ChatEntry {
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
}

function ChatPanel({ modelLabel }: { modelLabel: string }) {
  const [history, setHistory] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [maxTokens, setMaxTokens] = useState(512);
  const [temperature, setTemperature] = useState(0.7);
  const [systemPrompt, setSystemPrompt] = useState('You are a helpful AI assistant.');
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [history]);

  const send = async () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput('');
    setError(null);

    const userMsg: ChatEntry = { role: 'user', content: text };
    const newHistory = [...history, userMsg];
    const withPlaceholder: ChatEntry[] = [...newHistory, { role: 'assistant', content: '', streaming: true }];
    setHistory(withPlaceholder);
    setStreaming(true);

    const messages = [
      { role: 'system' as const, content: systemPrompt },
      ...newHistory.map(h => ({ role: h.role as 'user' | 'assistant', content: h.content })),
    ];

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const resp = await fetch(`${BASE}/api/llm/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, max_tokens: maxTokens, temperature }),
        signal: ctrl.signal,
      });

      if (!resp.ok) {
        const e = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` })) as { error: string };
        throw new Error(e.error || `HTTP ${resp.status}`);
      }

      if (!resp.body) throw new Error('No response body from server');

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buf += decoder.decode(value, { stream: true });

        const lines = buf.split('\n');
        buf = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') { reader.cancel(); break; }
          try {
            const parsed = JSON.parse(data) as { text?: string };
            if (parsed.text) {
              setHistory(prev => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last?.role === 'assistant') {
                  next[next.length - 1] = { ...last, content: last.content + parsed.text };
                }
                return next;
              });
            }
          } catch { /* skip */ }
        }
      }

      setHistory(prev => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last?.role === 'assistant') next[next.length - 1] = { ...last, streaming: false };
        return next;
      });
    } catch (e: unknown) {
      if ((e as Error).name === 'AbortError') {
        setHistory(prev => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last?.role === 'assistant') next[next.length - 1] = { ...last, streaming: false };
          return next;
        });
      } else {
        setError((e as Error).message);
        setHistory(prev => {
          const last = prev[prev.length - 1];
          return last?.role === 'assistant' && !last.content ? prev.slice(0, -1) : prev;
        });
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  };

  const stop = () => { abortRef.current?.abort(); };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  return (
    <div className="flex flex-col gap-3 font-mono">
      {/* Settings row */}
      <div className="flex flex-wrap gap-2 items-center text-xs">
        <div className="flex items-center gap-1.5">
          <label className="text-[10px] text-muted-foreground uppercase font-bold">Max tokens</label>
          <select
            value={maxTokens}
            onChange={e => setMaxTokens(Number(e.target.value))}
            className="border border-border bg-secondary px-2 py-0.5 text-xs text-foreground outline-none"
          >
            {[128, 256, 512, 1024, 2048].map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-1.5">
          <label className="text-[10px] text-muted-foreground uppercase font-bold">Temperature</label>
          <select
            value={temperature}
            onChange={e => setTemperature(Number(e.target.value))}
            className="border border-border bg-secondary px-2 py-0.5 text-xs text-foreground outline-none"
          >
            {[0.1, 0.3, 0.5, 0.7, 0.9, 1.0].map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        <Button
          onClick={() => setHistory([])}
          disabled={streaming}
          variant="outline"
          size="xs"
          className="ml-auto text-[10px] uppercase font-mono"
        >
          CLEAR CHAT
        </Button>
      </div>

      {/* System prompt */}
      <div>
        <label className="text-[10px] text-muted-foreground uppercase font-bold block mb-1">System instructions</label>
        <Textarea
          value={systemPrompt}
          onChange={e => setSystemPrompt(e.target.value)}
          rows={2}
          className="w-full text-xs font-mono resize-none"
        />
      </div>

      {/* Chat history */}
      <div className="bg-secondary border border-border p-3 sm:p-4 min-h-[260px] max-h-[420px] overflow-y-auto space-y-3">
        {history.length === 0 && (
          <p className="text-muted-foreground text-xs text-center mt-8">
            Session ready with {modelLabel}. Type a prompt to begin.
          </p>
        )}
        {history.map((msg, i) => (
          <div key={i} className={`flex gap-2 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] p-3 text-xs border ${
              msg.role === 'user'
                ? 'bg-foreground text-background border-foreground font-medium'
                : 'bg-background text-foreground border-border'
            }`}>
              <div className="text-[9px] uppercase font-bold tracking-wider opacity-60 mb-1">
                {msg.role === 'user' ? 'USER' : modelLabel}
              </div>
              <pre className="whitespace-pre-wrap font-mono text-xs">{msg.content}</pre>
            </div>
          </div>
        ))}
        {error && (
          <p className="text-xs text-foreground bg-secondary border border-border p-2">[ERROR] {error}</p>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input row */}
      <div className="flex gap-2">
        <Textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKey}
          rows={2}
          disabled={streaming}
          placeholder={streaming ? 'Generating response...' : 'Type message... (Enter to send)'}
          className="flex-1 text-xs resize-none"
        />
        {streaming ? (
          <Button
            onClick={stop}
            variant="outline"
            className="font-mono text-xs uppercase"
          >
            ⏹ STOP
          </Button>
        ) : (
          <Button
            onClick={send}
            disabled={!input.trim()}
            className="font-mono text-xs uppercase"
          >
            SEND ▶
          </Button>
        )}
      </div>
    </div>
  );
}

export default function LLMPanel() {
  const [models, setModels] = useState<LLMModelInfo[]>([]);
  const [status, setStatus] = useState<LLMStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<Set<string>>(new Set());
  const [loadingModel, setLoadingModel] = useState<string | null>(null);
  const [tab, setTab] = useState<'models' | 'chat'>('models');

  const flash = (msg: string) => { setActionMsg(msg); setTimeout(() => setActionMsg(null), 4000); };

  const refresh = useCallback(async () => {
    try {
      const [st, ml] = await Promise.all([api.llmStatus(), api.llmModels().catch(() => ({ models: [], current_model: null, models_dir: '' }))]);
      setStatus(st);
      setModels(ml.models);
      setDownloading(prev => {
        if (prev.size === 0) return prev;
        const stillPending = new Set(prev);
        ml.models.forEach(m => { if (m.downloaded) stillPending.delete(m.id); });
        return stillPending.size === prev.size ? prev : stillPending;
      });
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 8000);
    return () => clearInterval(id);
  }, [refresh]);

  const handleDownload = async (id: string) => {
    setDownloading(prev => new Set(prev).add(id));
    try {
      const r = await api.llmDownload(id);
      flash(r.message);
    } catch (e) {
      flash(`[ERROR] ${(e as Error).message}`);
      setDownloading(prev => { const s = new Set(prev); s.delete(id); return s; });
    }
  };

  const handleLoad = async (id: string) => {
    setLoadingModel(id);
    try {
      const r = await api.llmLoad(id);
      flash(`[SUCCESS] ${r.label} loaded!`);
      setTab('chat');
      await refresh();
    } catch (e) {
      flash(`[ERROR] ${(e as Error).message}`);
    } finally {
      setLoadingModel(null);
    }
  };

  const handleUnload = async () => {
    try {
      await api.llmUnload();
      flash('Model unloaded.');
      await refresh();
    } catch (e) {
      flash(`[ERROR] ${(e as Error).message}`);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this model file?')) return;
    try {
      await api.llmDelete(id);
      flash('Model file deleted.');
      await refresh();
    } catch (e) {
      flash(`[ERROR] ${(e as Error).message}`);
    }
  };

  const currentModel = models.find(m => m.id === status?.model_id);
  const downloadedCount = models.filter(m => m.downloaded).length;

  return (
    <div className="space-y-4 text-sm font-mono">
      {/* Header row */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1">
          <p className="text-muted-foreground text-xs">
            Run local LLM GGUF models directly on the isolated runner CPU instance.
          </p>
        </div>
        <StatusBar status={status} />
        <Button onClick={refresh} variant="outline" size="xs" className="font-mono text-xs uppercase">
          REFRESH
        </Button>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[
          { label: 'Available Models', value: models.length.toString(), icon: '📦' },
          { label: 'Downloaded', value: downloadedCount.toString(), icon: '💾' },
          { label: 'Active Model', value: status?.label ?? 'None', icon: '⚡' },
        ].map(stat => (
          <Card key={stat.label} className="border border-border bg-card p-3 flex items-center gap-3">
            <div className="text-lg">{stat.icon}</div>
            <div className="flex-1">
              <CardTitle className="text-foreground font-bold text-base">{stat.value}</CardTitle>
              <CardDescription className="text-muted-foreground text-[10px] uppercase font-bold">{stat.label}</CardDescription>
            </div>
          </Card>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex border border-border bg-secondary p-0.5">
        {(['models', 'chat'] as const).map(t => (
          <Button
            key={t}
            onClick={() => setTab(t)}
            variant="ghost"
            size="sm"
            className={`flex-1 font-mono text-xs uppercase ${
              tab === t
                ? 'bg-foreground text-background font-bold'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {t === 'models' ? '📦 Models Catalogue' : '💬 Interactive Chat'}
          </Button>
        ))}
      </div>

      {actionMsg && (
        <div className="p-2 bg-secondary border border-border text-xs text-foreground font-mono">
          {actionMsg}
        </div>
      )}

      {error && (
        <div className="p-2 bg-secondary border border-border text-xs text-foreground font-mono">
          [ERROR] {error}
        </div>
      )}

      {/* Models grid */}
      {tab === 'models' && (
        <>
          {loading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
              {[...Array(6)].map((_, i) => (
                <Card key={i} className="border border-border bg-card p-4 h-36 animate-pulse" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
              {models.map(m => (
                <ModelCard
                  key={m.id}
                  model={loadingModel === m.id ? { ...m, download_status: 'downloading' } : m}
                  onDownload={handleDownload}
                  onLoad={handleLoad}
                  onDelete={handleDelete}
                  onUnload={handleUnload}
                  downloading={downloading}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* Chat panel */}
      {tab === 'chat' && (
        <Card className="border border-border bg-card p-4">
          {!status?.loaded ? (
            <div className="text-center py-10 space-y-3">
              <div className="text-3xl">🧠</div>
              <p className="text-muted-foreground text-xs">Load a model from the Models tab to start chatting.</p>
              <Button
                onClick={() => setTab('models')}
                variant="outline"
                size="sm"
                className="font-mono text-xs uppercase"
              >
                GO TO MODELS
              </Button>
            </div>
          ) : (
            <ChatPanel modelLabel={currentModel?.label ?? status.label ?? 'Model'} />
          )}
        </Card>
      )}
    </div>
  );
}
