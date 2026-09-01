import React, { useState, useEffect, useRef } from 'react';
import { api, YtSearchResult, YtVideoInfo, YtQuality, YtDownloadJob } from '../api';
import { Button } from '@/components/ui/button';
import { Card, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

function fmtViews(n: number) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(n);
}

const standardQualities: YtQuality[] = [
  {
    key: 'audio-video',
    label: '🎬 Audio + Video (Best Merged)',
    sizeBytes: null,
    audioOnly: false,
    formatId: 'best[ext=mp4]/best'
  },
  {
    key: 'video-only',
    label: '📹 Video Only (Highest Res)',
    sizeBytes: null,
    audioOnly: false,
    formatId: 'bestvideo[ext=mp4]/bestvideo'
  },
  {
    key: 'audio-only',
    label: '🎵 Audio Only (m4a)',
    sizeBytes: null,
    audioOnly: true,
    formatId: 'bestaudio[ext=m4a]/bestaudio'
  }
];

export default function YoutubePanel() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<YtSearchResult[]>([]);
  const [info, setInfo] = useState<YtVideoInfo | null>(null);
  const [searching, setSearching] = useState(false);
  const [loadingInfo, setLoadingInfo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [directUrl, setDirectUrl] = useState('');
  const [selectedQuality, setSelectedQuality] = useState<YtQuality>(standardQualities[0]);

  // Job states
  const [activeJob, setActiveJob] = useState<YtDownloadJob | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cookie export state
  const [cookieExporting, setCookieExporting] = useState(false);
  const [cookieResult, setCookieResult] = useState<{ success: boolean; message: string } | null>(null);

  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

  const exportCookies = async () => {
    setCookieExporting(true);
    setCookieResult(null);
    try {
      const result = await api.exportYtCookies();
      setCookieResult(result);
    } catch (e) {
      setCookieResult({ success: false, message: (e as Error).message });
    } finally {
      setCookieExporting(false);
    }
  };

  const search = async () => {
    if (!query) return;
    setSearching(true); setError(null); setResults([]); setInfo(null);
    try { setResults((await api.ytSearch(query)).results); }
    catch (e) { setError((e as Error).message); }
    finally { setSearching(false); }
  };

  const loadInfo = async (url: string) => {
    setLoadingInfo(true); setError(null); setInfo(null);
    try { setInfo(await api.ytInfo(url)); }
    catch (e) { setError((e as Error).message); }
    finally { setLoadingInfo(false); }
  };

  const selectSearchResult = (v: YtSearchResult) => {
    setInfo({
      videoId: v.videoId,
      url: v.url,
      title: v.title,
      thumbnail: v.thumbnail,
      durationSeconds: 0,
      uploader: v.author,
      viewCount: v.views,
      qualities: standardQualities,
    });
    setDirectUrl(v.url);
  };

  const startDownloadJob = async (url: string, quality: YtQuality) => {
    setError(null);
    setActiveJob(null);
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
    }
    try {
      const { jobId } = await api.ytDownloadJob(url, quality);
      setActiveJob({
        id: jobId,
        url,
        qualityKey: quality.key,
        status: 'pending',
        progress: 0,
        message: 'Initializing job...',
      });

      pollIntervalRef.current = setInterval(async () => {
        try {
          const status = await api.ytJobStatus(jobId);
          setActiveJob(status);

          if (status.status === 'completed' || status.status === 'failed') {
            if (pollIntervalRef.current) {
              clearInterval(pollIntervalRef.current);
              pollIntervalRef.current = null;
            }
            if (status.status === 'completed' && status.downloadUrl) {
              const a = document.createElement('a');
              a.href = status.downloadUrl;
              a.download = status.title || `youtube_${Date.now()}.${quality.audioOnly ? 'm4a' : 'mp4'}`;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
            }
          }
        } catch (pollErr) {
          console.error('Error polling job status:', pollErr);
        }
      }, 1000);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="space-y-4 text-sm">
      {/* Cookie Export */}
      <Card className="border border-border bg-card p-4 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <CardTitle className="font-mono text-xs uppercase tracking-wider text-foreground">🍪 Cookie Exporter</CardTitle>
            <CardDescription className="text-xs text-muted-foreground mt-0.5 font-mono">
              Export authenticated browser cookies for yt-dlp to download restricted content.
            </CardDescription>
          </div>
          <Button
            onClick={exportCookies}
            disabled={cookieExporting}
            variant="outline"
            size="sm"
            className="font-mono text-xs uppercase"
          >
            {cookieExporting ? 'EXPORTING...' : 'EXPORT COOKIES'}
          </Button>
        </div>
        {cookieResult && (
          <div className="text-xs px-3 py-2 border border-border bg-secondary font-mono">
            {cookieResult.success ? '[SUCCESS]' : '[ERROR]'} {cookieResult.message}
          </div>
        )}
      </Card>

      {/* Search */}
      <Card className="border border-border bg-card p-4 space-y-3">
        <CardTitle className="font-mono text-xs uppercase tracking-wider text-foreground">🔍 Search YouTube</CardTitle>
        <div className="flex flex-col sm:flex-row gap-2">
          <Input value={query} onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && search()}
            placeholder="Search YouTube query..."
            className="flex-1" />
          <Button onClick={search} disabled={searching || !query}
            className="sm:px-5 font-mono text-xs uppercase">
            {searching ? 'SEARCHING...' : 'SEARCH'}
          </Button>
        </div>
      </Card>

      {/* Direct URL */}
      <Card className="border border-border bg-card p-4 space-y-4">
        <CardTitle className="font-mono text-xs uppercase tracking-wider text-foreground">🔗 Direct Link Download</CardTitle>
        <div className="flex flex-col sm:flex-row gap-2">
          <Input value={directUrl} onChange={e => {
            setDirectUrl(e.target.value);
            setInfo(null);
          }}
            placeholder="https://youtube.com/watch?v=…"
            className="flex-1 font-mono text-xs" />
          <Button onClick={() => loadInfo(directUrl)} disabled={loadingInfo || !directUrl}
            variant="outline"
            className="font-mono text-xs uppercase">
            {loadingInfo ? 'FETCHING...' : 'GET METADATA'}
          </Button>
        </div>

        {directUrl && !info && (
          <div className="space-y-3 border-t border-border pt-3">
            <p className="text-xs font-mono text-muted-foreground uppercase font-bold">Select Quality Profile:</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {standardQualities.map(q => (
                <Button
                  key={q.key}
                  onClick={() => setSelectedQuality(q)}
                  variant="outline"
                  size="sm"
                  className={`font-mono text-xs transition-all text-left justify-start ${selectedQuality.key === q.key
                      ? 'bg-foreground text-background border-foreground font-bold'
                      : 'bg-secondary text-muted-foreground'
                    }`}
                >
                  {q.label}
                </Button>
              ))}
            </div>

            <Button
              onClick={() => startDownloadJob(directUrl, selectedQuality)}
              disabled={!directUrl || activeJob?.status === 'pending' || activeJob?.status === 'downloading'}
              className="w-full py-2.5 font-mono text-xs font-bold uppercase tracking-wider"
            >
              START DOWNLOAD JOB
            </Button>
          </div>
        )}
      </Card>

      {error && <p className="text-xs text-foreground bg-secondary border border-border px-4 py-3 font-mono">[ERROR] {error}</p>}

      {/* Active Job Progress */}
      {activeJob && (
        <Card className="border border-border bg-card p-4 space-y-3 font-mono">
          <div className="flex items-center justify-between">
            <CardTitle className="text-xs uppercase flex items-center gap-2">
              DOWNLOAD JOB: <Badge variant="outline" className="text-[10px]">{activeJob.status.toUpperCase()}</Badge>
            </CardTitle>
          </div>
          <p className="text-xs text-muted-foreground truncate">{activeJob.message || 'Processing stream...'}</p>

          {/* Progress Bar */}
          <div className="w-full bg-secondary h-2 border border-border overflow-hidden">
            <div
              className="h-full bg-foreground transition-all duration-300"
              style={{ width: `${activeJob.progress}%` }}
            />
          </div>
          <div className="flex justify-between items-center text-xs text-muted-foreground">
            <span>PROGRESS: {activeJob.progress}%</span>
            {activeJob.status === 'completed' && activeJob.downloadUrl && (
              <a
                href={activeJob.downloadUrl}
                download={activeJob.title || 'video.mp4'}
                className="text-foreground underline font-bold"
              >
                [ SAVE FILE MANUALLY ]
              </a>
            )}
          </div>
        </Card>
      )}

      {/* Search results */}
      {results.length > 0 && !info && (
        <div className="space-y-2">
          {results.map(v => (
            <Card key={v.videoId} className="border border-border bg-card p-3 flex flex-col sm:flex-row gap-3 cursor-pointer hover:bg-secondary transition-colors" onClick={() => selectSearchResult(v)}>
              <img src={v.thumbnail} alt="" className="w-full sm:w-28 h-20 object-cover flex-shrink-0 bg-secondary border border-border" />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-bold text-foreground font-mono truncate">{v.title}</p>
                <p className="text-[11px] text-muted-foreground mt-1 font-mono">{v.author} · {v.duration} · {fmtViews(v.views)} views · {v.ago}</p>
              </div>
              <Button variant="outline" size="xs" className="self-end sm:self-center font-mono text-[10px] uppercase">Select →</Button>
            </Card>
          ))}
        </div>
      )}

      {/* Quality picker */}
      {info && (() => {
        const standard = info.qualities.filter(q => ['audio-video', 'video-only', 'audio-only'].includes(q.key));
        const specificVideo = info.qualities.filter(q => q.key.startsWith('format-') && !q.audioOnly);
        const specificAudio = info.qualities.filter(q => q.key.startsWith('format-') && q.audioOnly);

        return (
          <Card className="border border-border bg-card p-4 space-y-4">
            <div className="flex gap-3 items-start border-b border-border pb-3">
              <img src={info.thumbnail} alt="" className="w-28 h-20 object-cover bg-secondary flex-shrink-0 border border-border" />
              <div className="min-w-0">
                <CardTitle className="text-xs font-mono font-bold truncate text-foreground">{info.title}</CardTitle>
                <p className="text-xs text-muted-foreground font-mono mt-1">{info.uploader} {info.viewCount ? `· ${fmtViews(info.viewCount)} views` : ''}</p>
              </div>
            </div>

            <div className="space-y-4">
              {standard.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-bold font-mono uppercase text-foreground">Standard Formats</p>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    {standard.map(q => (
                      <Button key={q.key} onClick={() => startDownloadJob(info.url, q)} disabled={activeJob?.status === 'pending' || activeJob?.status === 'downloading'}
                        variant="outline"
                        size="sm"
                        className="font-mono text-xs text-left justify-start">
                        {q.label}
                      </Button>
                    ))}
                  </div>
                </div>
              )}

              {specificVideo.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-bold font-mono uppercase text-muted-foreground">Specific Video Streams</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-60 overflow-y-auto pr-1">
                    {specificVideo.map(q => (
                      <Button key={q.key} onClick={() => startDownloadJob(info.url, q)} disabled={activeJob?.status === 'pending' || activeJob?.status === 'downloading'}
                        variant="outline"
                        size="sm"
                        className="font-mono text-xs text-left truncate justify-start"
                        title={q.label}>
                        {q.label}
                      </Button>
                    ))}
                  </div>
                </div>
              )}

              {specificAudio.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-bold font-mono uppercase text-muted-foreground">Specific Audio Streams</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-48 overflow-y-auto pr-1">
                    {specificAudio.map(q => (
                      <Button key={q.key} onClick={() => startDownloadJob(info.url, q)} disabled={activeJob?.status === 'pending' || activeJob?.status === 'downloading'}
                        variant="outline"
                        size="sm"
                        className="font-mono text-xs text-left truncate justify-start"
                        title={q.label}>
                        {q.label}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="border-t border-border pt-3">
              <Button onClick={() => setInfo(null)} variant="ghost" size="xs" className="font-mono text-xs">[ ← BACK TO RESULTS ]</Button>
            </div>
          </Card>
        );
      })()}
    </div>
  );
}
