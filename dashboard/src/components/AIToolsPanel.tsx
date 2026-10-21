import React, { useState, useRef } from 'react';
import { api } from '../api';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Wand2, ScanText, Mic, Camera, Eraser, Download, type LucideIcon } from 'lucide-react';

function blobUrl(blob: Blob) { return URL.createObjectURL(blob); }

function FileUploadCard({
  icon: Icon, title, accept, onProcess, resultType,
}: {
  icon: LucideIcon; title: string; accept: string;
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
    <Card className="flex flex-col justify-between p-4">
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <Icon className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold tracking-tight text-foreground">{title}</h3>
        </div>
        <input ref={inputRef} type="file" accept={accept} className="hidden"
          onChange={e => e.target.files?.[0] && handle(e.target.files[0])} />

        {error && <p className="text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">{error}</p>}
        {result && resultType === 'image' && (
          <div className="space-y-2">
            <img src={result} alt="result" className="max-h-48 w-full rounded-md object-contain bg-secondary border border-border" />
            <a href={result} download={`result_${Date.now()}.png`}
              className="flex items-center justify-center gap-1.5 text-xs text-primary hover:underline">
              <Download className="size-3.5" />Download processed file
            </a>
          </div>
        )}
        {result && resultType === 'text' && (
          <Textarea readOnly value={result} rows={5}
            className="w-full text-xs font-mono bg-secondary p-3 text-foreground resize-none" />
        )}
      </div>

      <Button
        onClick={() => inputRef.current?.click()} disabled={loading}
        variant="outline"
        size="sm"
        className="w-full mt-4"
      >
        {loading ? 'Processing...' : 'Upload & process'}
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
    <Card className="flex flex-col justify-between p-4">
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <Camera className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold tracking-tight text-foreground">Screenshot URL</h3>
        </div>
        <Input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://example.com"
          className="w-full" />
        <Label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
          <input type="checkbox" checked={fullPage} onChange={e => setFullPage(e.target.checked)} className="accent-primary" />
          Full page capture
        </Label>
        {error && <p className="text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">{error}</p>}
        {imgUrl && (
          <div className="space-y-2">
            <img src={imgUrl} alt="screenshot" className="max-h-64 w-full rounded-md object-contain bg-secondary border border-border" />
            <a href={imgUrl} download={`screenshot_${Date.now()}.png`}
              className="flex items-center justify-center gap-1.5 text-xs text-primary hover:underline">
              <Download className="size-3.5" />Download screenshot
            </a>
          </div>
        )}
      </div>

      <Button onClick={shoot} disabled={loading || !url}
        variant="outline"
        size="sm"
        className="w-full mt-4">
        {loading ? 'Capturing...' : 'Take screenshot'}
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
    <Card className="flex flex-col justify-between p-4">
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <Eraser className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold tracking-tight text-foreground">HTML cleaner</h3>
        </div>
        <Textarea value={html} onChange={e => setHtml(e.target.value)} placeholder="Paste raw HTML here..." rows={4}
          className="w-full text-xs font-mono resize-none" />
        {error && <p className="text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">{error}</p>}
        {result && (
          <Textarea readOnly value={result} rows={5}
            className="w-full text-xs font-mono bg-secondary p-3 text-foreground resize-none mt-2" />
        )}
      </div>

      <Button onClick={clean} disabled={loading || !html.trim()}
        variant="outline"
        size="sm"
        className="w-full mt-4">
        {loading ? 'Cleaning...' : 'Clean HTML'}
      </Button>
    </Card>
  );
}

export default function AIToolsPanel() {
  return (
    <div className="space-y-4 text-sm">
      <div>
        <h2 className="text-sm font-semibold tracking-tight text-foreground">AI tools</h2>
        <p className="text-xs text-muted-foreground">
          AI-powered tools processed by local backend workers in the active session.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <FileUploadCard icon={Wand2} title="Remove Background" accept="image/*" resultType="image"
          onProcess={api.removeBg} />
        <FileUploadCard icon={ScanText} title="OCR Text Extract" accept="image/*" resultType="text"
          onProcess={api.ocr} />
        <FileUploadCard icon={Mic} title="Whisper Audio" accept="audio/*" resultType="text"
          onProcess={api.transcribe} />
        <ScreenshotCard />
        <HtmlCleanerCard />
      </div>
    </div>
  );
}
