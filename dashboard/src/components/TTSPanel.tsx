import React, { useState, useEffect, useCallback } from 'react';
import { api, TTSVoice, TTSStatus } from '../api';
import { Button } from '@/components/ui/button';
import { Card, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';

function blobToUrl(blob: Blob): string {
  return URL.createObjectURL(blob);
}

function downloadBlob(blob: Blob, filename: string) {
  const url = blobToUrl(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function StatusBar({ status }: { status: TTSStatus | null }) {
  if (!status) return null;
  const label = !status.running
    ? '[SERVER OFFLINE]'
    : status.model_loaded
      ? '[QWEN3-TTS READY]'
      : status.loading
        ? '[LOADING MODEL...]'
        : '[MODEL IDLE]';

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 border border-border bg-secondary text-xs font-mono">
      <span className="font-bold">{label}</span>
      {status.error && !status.running && (
        <span className="opacity-70 truncate max-w-[220px]" title={status.error}>— {status.error}</span>
      )}
    </div>
  );
}

function AudioResult({ blob, filename }: { blob: Blob; filename: string }) {
  const [src, setSrc] = useState('');

  useEffect(() => {
    const url = blobToUrl(blob);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [blob]);

  return (
    <Card className="flex flex-col gap-2 p-3 border border-border bg-secondary font-mono">
      <div className="flex items-center gap-2 text-xs text-foreground font-bold">
        <span>🎵</span>
        <span>{filename}</span>
      </div>
      <audio controls src={src} className="w-full h-8" />
      <div className="flex gap-2 mt-1">
        <Button
          onClick={() => downloadBlob(blob, filename)}
          variant="outline"
          size="xs"
          className="font-mono text-xs uppercase"
        >
          ⬇ DOWNLOAD WAV
        </Button>
      </div>
    </Card>
  );
}

function VoiceCard({ voice, selected, onClick }: { voice: TTSVoice; selected: boolean; onClick(): void }) {
  const genderIcon = voice.gender === 'female' ? '👩' : voice.gender === 'male' ? '👨' : '🧑';
  return (
    <Button
      onClick={onClick}
      variant="outline"
      size="sm"
      className={`relative flex flex-col items-start gap-1 p-2.5 border text-left transition-all h-auto font-mono ${selected
        ? 'bg-foreground text-background border-foreground font-bold'
        : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
      }`}
    >
      <Badge variant="outline" className="absolute top-1.5 right-1.5 text-[8px] px-1 py-0">
        {voice.engine.toUpperCase()}
      </Badge>
      <div className="flex items-center gap-1.5">
        <span>{genderIcon}</span>
        <span className="text-xs font-bold truncate">{voice.label}</span>
      </div>
      <p className="text-[10px] opacity-80 whitespace-normal font-normal">{voice.tone}</p>
    </Button>
  );
}

function GenerateTab({ voices, serverReady }: { voices: TTSVoice[]; serverReady: boolean }) {
  const [text, setText] = useState('');
  const [voice, setVoice] = useState('Vivian');
  const [language, setLanguage] = useState('Auto');
  const [instruct, setInstruct] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ blob: Blob; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const generate = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const selectedVoice = voices.find(v => v.id === voice);
      const engine = selectedVoice?.engine || 'qwen';
      const blob = await api.ttsGenerate(text, voice, language, instruct, engine);
      setResult({ blob, name: `tts_${Date.now()}.wav` });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const charCount = text.length;
  const charLimit = 2000;

  return (
    <div className="space-y-4 font-mono">
      <p className="text-muted-foreground text-xs">
        Convert text to speech using neural voices and optional expressive style instructions.
      </p>

      {/* Text input */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-[10px] text-muted-foreground font-bold uppercase">Text payload</label>
          <span className="text-[10px] text-muted-foreground">
            {charCount}/{charLimit}
          </span>
        </div>
        <Textarea
          value={text}
          onChange={e => setText(e.target.value)}
          rows={4}
          placeholder="Enter text to synthesize into speech..."
          className="w-full text-xs resize-none"
        />
      </div>

      {/* Voice grid */}
      {voices.length > 0 && (
        <div>
          <label className="text-[10px] text-muted-foreground font-bold uppercase block mb-1.5">Voice Profile</label>
          <div className="grid grid-cols-1 xs:grid-cols-2 sm:grid-cols-3 gap-2">
            {voices.map(v => (
              <VoiceCard key={v.id} voice={v} selected={voice === v.id} onClick={() => setVoice(v.id)} />
            ))}
          </div>
        </div>
      )}

      {/* Options row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="text-[10px] text-muted-foreground font-bold uppercase block mb-1">Language</label>
          <select
            value={language}
            onChange={e => setLanguage(e.target.value)}
            className="w-full border border-border bg-secondary px-3 py-1.5 text-xs text-foreground outline-none"
          >
            <option value="Auto">Auto Detect</option>
            {['Chinese', 'English', 'Japanese', 'Korean', 'German', 'French', 'Russian', 'Portuguese', 'Spanish', 'Italian'].map(l => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-[10px] text-muted-foreground font-bold uppercase block mb-1">Instruction (Optional)</label>
          <Input
            type="text"
            value={instruct}
            onChange={e => setInstruct(e.target.value)}
            placeholder="e.g. Energetic, whisper, cheerful..."
            className="w-full"
          />
        </div>
      </div>

      <Button
        onClick={generate}
        disabled={!text.trim() || busy || !serverReady || charCount > charLimit}
        className="w-full py-2.5 font-mono text-xs uppercase font-bold"
      >
        {busy ? 'SYNTHESIZING SPEECH...' : 'GENERATE SYNTHESIS'}
      </Button>

      {error && (
        <div className="p-3 bg-secondary border border-border text-xs text-foreground">
          [ERROR] {error}
        </div>
      )}
      {result && <AudioResult blob={result.blob} filename={result.name} />}
    </div>
  );
}

const STYLE_EXAMPLES = [
  'Cheerful young woman with bright, energetic tone',
  'Deep male narrator, calm and authoritative',
  'Whispery, mysterious female voice with clear diction',
  'Elderly professor, gentle and thoughtful pace',
  'Fast-paced news announcer, confident cadence',
];

function DesignTab({ serverReady }: { serverReady: boolean }) {
  const [text, setText] = useState('');
  const [style, setStyle] = useState('');
  const [language, setLanguage] = useState('Auto');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ blob: Blob; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const design = async () => {
    if (!text.trim() || !style.trim() || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const blob = await api.ttsDesign(text, style, language);
      setResult({ blob, name: `design_${Date.now()}.wav` });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 font-mono">
      <p className="text-muted-foreground text-xs">
        Synthesize speech with descriptive English voice prompts.
      </p>

      {/* Style input */}
      <div>
        <label className="text-[10px] text-muted-foreground font-bold uppercase block mb-1">Voice Style Prompt</label>
        <Textarea
          value={style}
          onChange={e => setStyle(e.target.value)}
          rows={2}
          placeholder="e.g. Deep, warm male voice with calm delivery"
          className="w-full text-xs resize-none"
        />

        {/* Quick examples */}
        <div className="mt-1.5 flex flex-wrap gap-1">
          {STYLE_EXAMPLES.map(ex => (
            <Button
              key={ex}
              onClick={() => setStyle(ex)}
              variant="outline"
              size="xs"
              className="text-[10px] font-mono text-muted-foreground"
            >
              + {ex}
            </Button>
          ))}
        </div>
      </div>

      {/* Text input */}
      <div>
        <label className="text-[10px] text-muted-foreground font-bold uppercase block mb-1">Text to speak</label>
        <Textarea
          value={text}
          onChange={e => setText(e.target.value)}
          rows={3}
          placeholder="Enter text to speak..."
          className="w-full text-xs resize-none"
        />
      </div>

      {/* Language */}
      <div>
        <label className="text-[10px] text-muted-foreground font-bold uppercase block mb-1">Language</label>
        <select
          value={language}
          onChange={e => setLanguage(e.target.value)}
          className="w-full border border-border bg-secondary px-3 py-1.5 text-xs text-foreground outline-none"
        >
          <option value="Auto">Auto Detect</option>
          {['Chinese', 'English', 'Japanese', 'Korean', 'German', 'French', 'Russian', 'Portuguese', 'Spanish', 'Italian'].map(l => (
            <option key={l} value={l}>{l}</option>
          ))}
        </select>
      </div>

      <Button
        onClick={design}
        disabled={!text.trim() || !style.trim() || busy || !serverReady}
        className="w-full py-2.5 font-mono text-xs uppercase font-bold"
      >
        {busy ? 'DESIGNING VOICE...' : 'SYNTHESIZE DESIGNED VOICE'}
      </Button>

      {error && (
        <div className="p-3 bg-secondary border border-border text-xs text-foreground">
          [ERROR] {error}
        </div>
      )}
      {result && <AudioResult blob={result.blob} filename={result.name} />}
    </div>
  );
}

type TTSTab = 'generate' | 'design';

export default function TTSPanel() {
  const [tab, setTab] = useState<TTSTab>('generate');
  const [status, setStatus] = useState<TTSStatus | null>(null);
  const [voices, setVoices] = useState<TTSVoice[]>([]);

  const refresh = useCallback(async () => {
    try {
      const s = await api.ttsStatus();
      setStatus(s);
      if (s.running && voices.length === 0) {
        const v = await api.ttsVoices().catch(() => ({ voices: [] }));
        setVoices(v.voices);
      }
    } catch {
      setStatus({ running: false, model_loaded: false, loading: false, error: 'Unreachable' });
    }
  }, [voices.length]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 10000);
    return () => clearInterval(id);
  }, [refresh]);

  const serverReady = Boolean(status?.running && status?.model_loaded);

  return (
    <div className="space-y-4 text-sm font-mono">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1">
          <p className="text-muted-foreground text-xs">
            Open-source neural TTS model engine for instant text-to-speech rendering.
          </p>
        </div>
        <StatusBar status={status} />
        <Button
          onClick={refresh}
          variant="outline"
          size="xs"
          className="font-mono text-xs uppercase"
        >
          REFRESH
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[
          { label: 'Model', value: 'Qwen3-TTS', icon: '🤖' },
          { label: 'Server', value: status?.running ? 'Online' : 'Offline', icon: '⚡' },
          { label: 'Status', value: status?.model_loaded ? 'Ready' : status?.loading ? 'Loading…' : 'Idle', icon: '🎙️' },
        ].map(s => (
          <Card key={s.label} className="border border-border bg-card p-3 flex items-center gap-3">
            <div className="text-lg">{s.icon}</div>
            <div className="flex-1">
              <CardTitle className="text-foreground font-bold text-sm truncate">{s.value}</CardTitle>
              <CardDescription className="text-muted-foreground text-[10px] uppercase font-bold">{s.label}</CardDescription>
            </div>
          </Card>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex border border-border bg-secondary p-0.5">
        {(['generate', 'design'] as const).map(t => (
          <Button
            key={t}
            onClick={() => setTab(t)}
            variant="ghost"
            size="sm"
            className={`flex-1 font-mono text-xs uppercase ${tab === t
              ? 'bg-foreground text-background font-bold'
              : 'text-muted-foreground hover:text-foreground'
              }`}
          >
            {t === 'generate' ? '🎙️ Voice Presets' : '🎨 Voice Design'}
          </Button>
        ))}
      </div>

      {/* Tab content */}
      <Card className="border border-border bg-card p-4">
        {tab === 'generate' && <GenerateTab voices={voices} serverReady={serverReady} />}
        {tab === 'design' && <DesignTab serverReady={serverReady} />}
      </Card>
    </div>
  );
}
