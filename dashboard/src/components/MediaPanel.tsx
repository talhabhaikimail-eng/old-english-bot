import React, { useState } from 'react';
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
    <div className="space-y-6 max-w-4xl mx-auto text-sm">
      <div className="space-y-3">
        <p className="text-muted-foreground text-xs font-mono">
          Paste any supported media URL. The system automatically extracts audio/video streams.
        </p>
        <div className="flex flex-wrap gap-1.5 pt-1">
          {PLATFORMS.map(p => (
            <Badge
              key={p}
              variant="outline"
              className="text-[10px] font-mono border-border bg-secondary"
            >
              {p}
            </Badge>
          ))}
        </div>
      </div>

      <Card className="border border-border bg-card">
        <CardHeader>
          <CardTitle>Download Media Asset</CardTitle>
          <CardDescription>Enter a direct or public URL to download the asset stream.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground font-mono block">Media URL</label>
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
            className="w-full py-2.5 font-bold text-xs uppercase tracking-wider font-mono"
          >
            {loading ? 'DOWNLOADING ASSET...' : 'DOWNLOAD MEDIA ASSET'}
          </Button>

          {error && (
            <div className="text-xs text-foreground bg-secondary border border-border px-4 py-3 font-mono">
              [ERROR] {error}
            </div>
          )}

          {blobUrl && (
            <div className="bg-secondary border border-border p-4 space-y-3 font-mono">
              <div className="flex items-center gap-2">
                <span className="text-foreground text-sm font-bold">[SUCCESS]</span>
                <p className="text-xs text-muted-foreground">Media stream fetched and ready for local save.</p>
              </div>
              <a
                href={blobUrl}
                download={`media_${Date.now()}`}
                className="w-full flex items-center justify-center gap-2 py-2 border border-border bg-foreground text-background font-bold text-xs font-mono uppercase"
              >
                <span>💾</span>
                <span>SAVE FILE TO LOCAL STORAGE</span>
              </a>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
