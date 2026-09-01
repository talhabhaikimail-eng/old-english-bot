import React, { useState, useRef } from 'react';
import { api } from '../api';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';

function blobUrl(blob: Blob) { return URL.createObjectURL(blob); }

function FileUploadCard({
  icon, title, accept, onProcess, resultType,
}: {
  icon: string; title: string; accept: string;
  onProcess: (file: File) => Promise<Blob | { text: string }>;
  resultType: 'image' | 'text';
}) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handle = async (file: File) => {
    setLoading(true); setError(null); setResult(null);
    try {
      const res = await onProcess(file);
      if (res instanceof Blob) {
        setResult(blobUrl(res));
      } else {
        setResult(res.text);
      }
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  };

  return (
    <Card className="flex flex-col justify-between border border-border bg-card p-4 sm:p-5">
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <span className="text-xl">{icon}</span>
          <h3 className="font-bold font-mono uppercase tracking-wider text-foreground text-xs sm:text-sm">{title}</h3>
        </div>
        <input ref={inputRef} type="file" accept={accept} className="hidden"
          onChange={e => e.target.files?.[0] && handle(e.target.files[0])} />

        {error && <p className="text-xs text-foreground bg-secondary border border-border px-3 py-2 font-mono">[ERROR] {error}</p>}
        {result && resultType === 'image' && (
          <div className="space-y-2">
            <img src={result} alt="result" className="max-h-48 w-full object-contain bg-secondary border border-border" />
            <a href={result} download={`result_${Date.now()}.png`}
              className="block text-center text-xs font-mono underline hover:text-foreground text-muted-foreground">
              [ DOWNLOAD PROCESSED FILE ]
            </a>
          </div>
        )}
        {result && resultType === 'text' && (
          <Textarea readOnly value={result} rows={5}
            className="w-full text-xs font-mono bg-secondary border border-border p-3 text-foreground resize-none" />
        )}
      </div>

      <Button
        onClick={() => inputRef.current?.click()} disabled={loading}
        variant="outline"
        size="sm"
        className="w-full mt-4 font-mono text-xs font-bold uppercase tracking-wider"
      >
        {loading ? 'PROCESSING...' : 'UPLOAD & PROCESS'}
      </Button>
    </Card>
  );
}

function ScreenshotCard() {
  const [url, setUrl] = useState('');
  const [fullPage, setFullPage] = useState(false);
  const [loading, setLoading] = useState(false);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const shoot = async () => {
    if (!url) return;
    setLoading(true); setError(null); setImgUrl(null);
    try { setImgUrl(blobUrl(await api.screenshot(url, fullPage))); }
    catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  };

  return (
    <Card className="flex flex-col justify-between border border-border bg-card p-4 sm:p-5">
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <span className="text-xl">📸</span>
          <h3 className="font-bold font-mono uppercase tracking-wider text-foreground text-xs sm:text-sm">Screenshot URL</h3>
        </div>
        <Input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://example.com"
          className="w-full" />
        <Label className="flex items-center gap-2 text-xs font-mono text-muted-foreground cursor-pointer">
          <input type="checkbox" checked={fullPage} onChange={e => setFullPage(e.target.checked)} className="accent-foreground" />
          FULL PAGE CAPTURE
        </Label>
        {error && <p className="text-xs text-foreground bg-secondary border border-border px-3 py-2 font-mono">[ERROR] {error}</p>}
        {imgUrl && (
          <div className="space-y-2">
            <img src={imgUrl} alt="screenshot" className="max-h-64 w-full object-contain bg-secondary border border-border" />
            <a href={imgUrl} download={`screenshot_${Date.now()}.png`}
              className="block text-center text-xs font-mono underline hover:text-foreground text-muted-foreground">
              [ DOWNLOAD SCREENSHOT ]
            </a>
          </div>
        )}
      </div>

      <Button onClick={shoot} disabled={loading || !url}
        variant="outline"
        size="sm"
        className="w-full mt-4 font-mono text-xs font-bold uppercase tracking-wider">
        {loading ? 'CAPTURING...' : 'TAKE SCREENSHOT'}
      </Button>
    </Card>
  );
}

function HtmlCleanerCard() {
  const [html, setHtml] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const clean = async () => {
    if (!html.trim()) return;
    setLoading(true); setError(null); setResult(null);
    try {
      const res = await api.extractHtml(html);
      setResult(res.content);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  };

  return (
    <Card className="flex flex-col justify-between border border-border bg-card p-4 sm:p-5">
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <span className="text-xl">🧹</span>
          <h3 className="font-bold font-mono uppercase tracking-wider text-foreground text-xs sm:text-sm">HTML Cleaner</h3>
        </div>
        <Textarea value={html} onChange={e => setHtml(e.target.value)} placeholder="Paste raw HTML here..." rows={4}
          className="w-full text-xs font-mono resize-none" />
        {error && <p className="text-xs text-foreground bg-secondary border border-border px-3 py-2 font-mono">[ERROR] {error}</p>}
        {result && (
          <Textarea readOnly value={result} rows={5}
            className="w-full text-xs font-mono bg-secondary border border-border p-3 text-foreground resize-none mt-2" />
        )}
      </div>

      <Button onClick={clean} disabled={loading || !html.trim()}
        variant="outline"
        size="sm"
        className="w-full mt-4 font-mono text-xs font-bold uppercase tracking-wider">
        {loading ? 'CLEANING...' : 'CLEAN HTML'}
      </Button>
    </Card>
  );
}

export default function AIToolsPanel() {
  return (
    <div className="space-y-4 text-sm">
      <div className="border-b border-border pb-2">
        <p className="text-muted-foreground text-xs font-mono">
          AI-powered tools processed by local backend workers in the active session.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <FileUploadCard icon="🎨" title="Remove Background" accept="image/*" resultType="image"
          onProcess={api.removeBg} />
        <FileUploadCard icon="🔍" title="OCR Text Extract" accept="image/*" resultType="text"
          onProcess={api.ocr} />
        <FileUploadCard icon="🎙️" title="Whisper Audio" accept="audio/*" resultType="text"
          onProcess={api.transcribe} />
        <ScreenshotCard />
        <HtmlCleanerCard />
      </div>
    </div>
  );
}
