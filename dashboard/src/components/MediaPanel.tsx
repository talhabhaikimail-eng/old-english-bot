import React, { useState } from 'react';
import { Download, Save, AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { api } from '../api';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

const PLATFORMS = [
  'Instagram', 'TikTok', 'Facebook', 'Twitter/X', 'YouTube',
  'Pinterest', 'MediaFire', 'CapCut', 'Spotify', 'SoundCloud', 'Threads', 'Google Drive'
];

export default function MediaPanel() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const download = async () => {
    if (!url) return;
    setLoading(true);
    setError(null);
    setBlobUrl(null);
    try {
      const blob = await api.downloadMedia(url);
      setBlobUrl(URL.createObjectURL(blob));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4 max-w-4xl mx-auto text-[13px]">
      <div className="space-y-3">
        <p className="text-muted-foreground text-xs">
          Paste any supported media URL. The system automatically extracts audio/video streams.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {PLATFORMS.map(p => (
            <Badge key={p} variant="secondary">
              {p}
            </Badge>
          ))}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold tracking-tight">Download media asset</CardTitle>
          <CardDescription className="text-xs">Enter a direct or public URL to download the asset stream.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground block">Media URL</label>
            <Input
              value={url}
              onChange={e => setUrl(e.target.value)}
              placeholder="Paste Instagram post, TikTok video, YouTube link..."
              className="w-full"
            />
          </div>

          <Button
            onClick={download}
            disabled={loading || !url.trim()}
            className="w-full"
          >
            {loading ? <Loader2 className="animate-spin" /> : <Download />}
            {loading ? 'Downloading asset...' : 'Download media asset'}
          </Button>

          {error && (
            <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2.5">
              <AlertCircle className="size-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {blobUrl && (
            <div className="bg-secondary/40 border border-border rounded-lg p-4 space-y-3">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="size-4 text-primary" />
                <p className="text-xs text-muted-foreground">Media stream fetched and ready for local save.</p>
              </div>
              <a
                href={blobUrl}
                download={`media_${Date.now()}`}
                className="w-full inline-flex h-8 items-center justify-center gap-2 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 text-xs font-medium transition-colors"
              >
                <Save className="size-3.5" />
                <span>Save file to local storage</span>
              </a>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
