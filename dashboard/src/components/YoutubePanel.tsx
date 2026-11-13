import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, YtSearchResult, YtQuality, YtJob, YtpInfo, YtpApiKey } from '../api';
import { Button } from '@/components/ui/button';
import { Card, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  ArrowLeft, Check, Copy, Download, ExternalLink, Eye, EyeOff, KeyRound, Loader2, Music,
  Radio, Search, ShieldCheck, ShieldAlert, Trash2, Video,
} from 'lucide-react';

// ---------------------------------------------------------------- helpers

function fmtViews(n: number) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(n);
}

function fmtSize(bytes?: number | null) {
  if (!bytes) return '';
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(2)} GB`;
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function fmtDuration(seconds: number) {
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/** "2160p" → "4K", and so on, the way YouTube labels them. */
function heightName(h: number) {
  if (h >= 4320) return '8K';
  if (h >= 2160) return '4K';
  if (h >= 1440) return '2K';
  if (h >= 1080) return 'Full HD';
  if (h >= 720) return 'HD';
  return '';
}

function codecName(codec: string) {
  if (codec.startsWith('avc1')) return 'H.264';
  if (codec.startsWith('vp9.2')) return 'VP9 HDR';
  if (codec.startsWith('vp9') || codec.startsWith('vp09')) return 'VP9';
  if (codec.startsWith('av01')) return 'AV1';
  if (codec.startsWith('mp4a')) return 'AAC';
  if (codec === 'opus') return 'Opus';
  return codec;
}

const YT_URL = /(?:youtube\.com\/(?:watch\?.*v=|shorts\/|live\/|embed\/)|youtu\.be\/)([\w-]{11})/;

function videoQuality(height: number, label: string, size: number): YtQuality {
  return {
    key: `${height}p`, label, sizeBytes: size || null, audioOnly: false,
    // Used only if the downloader service is down and yt-dlp has to do it.
    formatId: `bestvideo[height<=${height}][ext=mp4]/bestvideo[height<=${height}]`,
    audioFormatId: 'bestaudio[ext=m4a]/bestaudio',
  };
}

function audioQuality(ext: string, label: string, size: number): YtQuality {
  return ext === 'webm'
    ? { key: 'audio-opus', label, sizeBytes: size || null, audioOnly: true, formatId: 'bestaudio[ext=webm]/bestaudio' }
    : { key: 'audio-only', label, sizeBytes: size || null, audioOnly: true, formatId: 'bestaudio[ext=m4a]/bestaudio' };
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      variant="outline" size="sm"
      onClick={async () => {
        try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* blocked */ }
      }}
    >
      {done ? <Check /> : <Copy />} {done ? 'Copied' : label}
    </Button>
  );
}

/** One download: what it is, how far it has got, and the file once it is ready. */
function JobRow({ job, compact = false }: { job: YtJob; compact?: boolean }) {
  const running = job.status === 'pending' || job.status === 'downloading';
  return (
    <div className={`flex gap-3 items-center ${compact ? '' : 'border border-border bg-card rounded-lg p-3'}`}>
      {!compact && (job.thumbnail
        ? <img src={job.thumbnail} alt="" className="w-24 aspect-video object-cover rounded-md border border-border bg-secondary flex-shrink-0" />
        : <div className="w-24 aspect-video rounded-md border border-border bg-secondary flex-shrink-0" />)}
      <div className="flex-1 min-w-0 space-y-1.5">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-foreground truncate flex-1">{compact ? (job.label || job.qualityKey) : (job.title || job.url)}</p>
          {running && <span className="text-xs tabular-nums text-muted-foreground">{job.progress}%</span>}
          <Badge variant={job.status === 'failed' ? 'destructive' : job.status === 'completed' ? 'default' : 'secondary'}>{job.status}</Badge>
        </div>
        <p className="text-xs text-muted-foreground truncate">
          {compact ? '' : `${job.label || job.qualityKey} · `}{job.sizeBytes ? `${fmtSize(job.sizeBytes)} · ` : ''}{job.message}
        </p>
        {running && (
          <div className="w-full bg-secondary h-1.5 rounded-full overflow-hidden">
            <div className="h-full bg-primary rounded-full transition-all duration-300" style={{ width: `${Math.max(job.progress, 2)}%` }} />
          </div>
        )}
      </div>
      {job.status === 'completed' && job.downloadUrl && (
        <a href={job.downloadUrl} download={job.title || 'download'}>
          <Button size="sm"><Download /> Save</Button>
        </a>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- panel

export default function YoutubePanel() {
  const [tab, setTab] = useState('browse');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<YtSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The video being looked at.
  const [watchUrl, setWatchUrl] = useState<string | null>(null);
  const [hint, setHint] = useState<YtSearchResult | null>(null);
  const [info, setInfo] = useState<YtpInfo | null>(null);
  const [loadingInfo, setLoadingInfo] = useState(false);
  const [liveMinutes, setLiveMinutes] = useState(10);
  const [liveHeight, setLiveHeight] = useState(720);

  // Downloads.
  const [jobs, setJobs] = useState<YtJob[]>([]);
  const mine = useRef<Set<string>>(new Set());
  const saved = useRef<Set<string>>(new Set());

  // Session.
  const [health, setHealth] = useState<{ ok: boolean; cookies: boolean } | null>(null);
  const [cookieExporting, setCookieExporting] = useState(false);
  const [cookieResult, setCookieResult] = useState<{ success: boolean; message: string } | null>(null);
  const [signInStarting, setSignInStarting] = useState(false);
  const [signIn, setSignIn] = useState<{ url?: string; username?: string; password?: string } | null>(null);

  // API keys.
  const [keys, setKeys] = useState<YtpApiKey[]>([]);
  const [keyName, setKeyName] = useState('');
  const [shown, setShown] = useState<Set<string>>(new Set());
  const [keyError, setKeyError] = useState<string | null>(null);

  const checkHealth = useCallback(() => {
    api.ytpHealth().then(setHealth).catch(() => setHealth({ ok: false, cookies: false }));
  }, []);

  const refreshJobs = useCallback(async () => {
    try {
      const { jobs: list } = await api.ytJobs();
      setJobs(list);
      // Save what this tab started as soon as it is ready, once.
      for (const j of list) {
        if (j.status === 'completed' && j.downloadUrl && mine.current.has(j.id) && !saved.current.has(j.id)) {
          saved.current.add(j.id);
          const a = document.createElement('a');
          a.href = j.downloadUrl;
          a.download = j.title || 'download';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        }
      }
    } catch { /* the next tick tries again */ }
  }, []);

  useEffect(() => {
    checkHealth();
    refreshJobs();
    api.ytpKeys().then(r => setKeys(r.keys)).catch(e => setKeyError((e as Error).message));
  }, [checkHealth, refreshJobs]);

  const busy = jobs.some(j => j.status === 'pending' || j.status === 'downloading');
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(refreshJobs, 1200);
    return () => clearInterval(t);
  }, [busy, refreshJobs]);

  // ---- browse

  const open = async (url: string, from?: YtSearchResult) => {
    setWatchUrl(url); setHint(from || null); setInfo(null); setError(null); setLoadingInfo(true); setTab('browse');
    try {
      const got = await api.ytpInfo(url);
      setInfo(got);
      const top = got.video[0]?.height || 720;
      setLiveHeight(Math.min(top, 1080));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingInfo(false);
    }
  };

  const submit = async () => {
    const text = query.trim();
    if (!text) return;
    if (YT_URL.test(text)) { open(text); return; }
    setSearching(true); setError(null); setWatchUrl(null); setInfo(null); setTab('browse');
    try { setResults((await api.ytSearchMany(text, 24)).results); }
    catch (e) { setError((e as Error).message); }
    finally { setSearching(false); }
  };

  const start = async (quality: YtQuality) => {
    if (!watchUrl) return;
    setError(null);
    try {
      const title = info?.title || hint?.title;
      const thumbnail = info?.thumbnail || hint?.thumbnail;
      const { jobId } = await api.ytStartJob(watchUrl, quality, title, thumbnail);
      mine.current.add(jobId);
      setJobs(list => [{
        id: jobId, url: watchUrl, qualityKey: quality.key, status: 'pending', progress: 0,
        message: 'Starting…', label: quality.label, title, thumbnail, createdAt: Date.now(),
      }, ...list.filter(j => j.id !== jobId)]);
      refreshJobs();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // ---- session

  const startSignIn = async () => {
    setSignInStarting(true); setSignIn(null); setCookieResult(null);
    try {
      const result = await api.startYtSignIn();
      if (result.error) setCookieResult({ success: false, message: result.error });
      else setSignIn(result);
    } catch (e) {
      setCookieResult({ success: false, message: (e as Error).message });
    } finally {
      setSignInStarting(false);
    }
  };

  const exportCookies = async () => {
    setCookieExporting(true); setCookieResult(null);
    try {
      const result = await api.exportYtCookies();
      setCookieResult(result);
      if (result.success) setSignIn(null);
    } catch (e) {
      setCookieResult({ success: false, message: (e as Error).message });
    } finally {
      setCookieExporting(false);
      checkHealth();
    }
  };

  // ---- keys

  const createKey = async () => {
    setKeyError(null);
    try {
      const { key } = await api.ytpCreateKey(keyName);
      setKeys(k => [...k, key]);
      setShown(s => new Set(s).add(key.id));
      setKeyName('');
    } catch (e) { setKeyError((e as Error).message); }
  };

  const removeKey = async (k: YtpApiKey) => {
    if (!window.confirm(`Delete the key "${k.name}"? Anything using it stops working.`)) return;
    setKeyError(null);
    try { await api.ytpDeleteKey(k.id); setKeys(list => list.filter(x => x.id !== k.id)); }
    catch (e) { setKeyError((e as Error).message); }
  };

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const sampleKey = keys[0]?.key || 'YOUR_KEY';
  const videoId = watchUrl ? YT_URL.exec(watchUrl)?.[1] || info?.id : undefined;
  const title = info?.title || hint?.title || '';
  const author = info?.author || hint?.author || '';
  const active = jobs.filter(j => j.status === 'pending' || j.status === 'downloading').length;
  const here = jobs.filter(j => j.url === watchUrl);
  /** The running download of this video in this quality, if there is one. */
  const running = (key: string) => here.find(j => j.qualityKey === key && (j.status === 'pending' || j.status === 'downloading'));
  const rowButton = (quality: YtQuality) => {
    const job = running(quality.key);
    return job
      ? <Button size="sm" variant="outline" disabled className="tabular-nums"><Loader2 className="animate-spin" /> {job.progress}%</Button>
      : <Button size="sm" variant="outline" onClick={() => start(quality)} title="Download"><Download /></Button>;
  };
  const signedIn = !!health?.cookies;

  return (
    <div className="space-y-4 text-[13px]">
      {/* Search bar */}
      <Card className="border border-border bg-card p-3">
        <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
          <div className="relative flex-1">
            <Search className="size-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
            <Input
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && submit()}
              placeholder="Search YouTube, or paste a video, Shorts or live link"
              className="pl-9"
            />
          </div>
          <Button onClick={submit} disabled={searching || loadingInfo || !query.trim()} className="sm:px-6">
            {searching ? <><Loader2 className="animate-spin" /> Searching</> : 'Search'}
          </Button>
          <button
            type="button"
            onClick={() => setTab('session')}
            className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md border ${signedIn ? 'border-primary/30 text-primary bg-primary/10' : 'border-destructive/30 text-destructive bg-destructive/10'}`}
            title="YouTube session used by the downloader"
          >
            {signedIn ? <ShieldCheck className="size-3.5" /> : <ShieldAlert className="size-3.5" />}
            {health === null ? 'Checking…' : !health.ok ? 'Downloader offline' : signedIn ? 'Signed in' : 'Not signed in'}
          </button>
        </div>
      </Card>

      {error && <p className="text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-4 py-3 break-words">{error}</p>}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="browse"><Video className="size-3.5" /> Browse</TabsTrigger>
          <TabsTrigger value="downloads"><Download className="size-3.5" /> Downloads{jobs.length ? ` (${active ? `${active} running` : jobs.length})` : ''}</TabsTrigger>
          <TabsTrigger value="api"><KeyRound className="size-3.5" /> API access</TabsTrigger>
          <TabsTrigger value="session"><ShieldCheck className="size-3.5" /> Session</TabsTrigger>
        </TabsList>

        {/* ------------------------------------------------ Browse */}
        <TabsContent value="browse" className="space-y-4 mt-3">
          {!watchUrl && results.length === 0 && !searching && (
            <Card className="border border-dashed border-border bg-card p-8 text-center text-muted-foreground">
              Search for something, or paste a link, to watch it here and download it in any quality up to 4K, as music, or record a live stream.
            </Card>
          )}

          {/* Results grid */}
          {!watchUrl && results.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {results.map(v => (
                <button key={v.videoId} type="button" onClick={() => open(v.url, v)} className="text-left group">
                  <div className="relative aspect-video rounded-lg overflow-hidden bg-secondary border border-border">
                    <img src={v.thumbnail} alt="" loading="lazy" className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform" />
                    {v.duration && <span className="absolute bottom-1.5 right-1.5 text-[11px] font-medium bg-black/80 text-white px-1.5 py-0.5 rounded">{v.duration}</span>}
                  </div>
                  <p className="mt-2 text-sm font-medium text-foreground leading-snug line-clamp-2">{v.title}</p>
                  <p className="text-xs text-muted-foreground mt-0.5 truncate">{v.author}</p>
                  <p className="text-xs text-muted-foreground">{fmtViews(v.views)} views{v.ago ? ` · ${v.ago}` : ''}</p>
                </button>
              ))}
            </div>
          )}

          {/* Watch view */}
          {watchUrl && (
            <div className="space-y-3">
              <Button onClick={() => { setWatchUrl(null); setInfo(null); setError(null); }} variant="ghost" size="sm">
                <ArrowLeft /> {results.length ? 'Back to results' : 'Close'}
              </Button>
              <div className="grid grid-cols-1 xl:grid-cols-5 gap-4">
                {/* Player */}
                <div className="xl:col-span-3 space-y-3">
                  <div className="aspect-video rounded-lg overflow-hidden bg-black border border-border">
                    {videoId && (
                      <iframe
                        key={videoId}
                        src={`https://www.youtube-nocookie.com/embed/${videoId}?rel=0`}
                        title={title}
                        className="w-full h-full"
                        allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
                        allowFullScreen
                      />
                    )}
                  </div>
                  <div>
                    <div className="flex items-start gap-2">
                      <h2 className="text-base font-semibold text-foreground leading-snug flex-1">{title || 'Loading…'}</h2>
                      {info?.live && <Badge variant="destructive" className="gap-1"><Radio className="size-3" /> LIVE</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      {author}
                      {info && !info.live && info.duration ? ` · ${fmtDuration(info.duration)}` : ''}
                      {hint?.views ? ` · ${fmtViews(hint.views)} views` : ''}
                      {hint?.ago ? ` · ${hint.ago}` : ''}
                    </p>
                    <a href={watchUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mt-2">
                      <ExternalLink className="size-3" /> Open on YouTube
                    </a>
                  </div>
                </div>

                {/* Download options */}
                <Card className="xl:col-span-2 border border-border bg-card p-4 space-y-4 self-start">
                  {here.length > 0 && (
                    <div className="space-y-3 border border-primary/30 bg-primary/5 rounded-md p-3">
                      <div className="flex items-center justify-between">
                        <CardTitle className="flex items-center gap-2"><Download className="size-4 text-muted-foreground" /> Downloads of this video</CardTitle>
                        <button type="button" className="text-xs text-muted-foreground hover:text-foreground underline" onClick={() => setTab('downloads')}>All downloads</button>
                      </div>
                      {here.map(j => <JobRow key={j.id} job={j} compact />)}
                    </div>
                  )}
                  {loadingInfo && <p className="text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="size-3.5 animate-spin" /> Reading the available qualities…</p>}

                  {info?.live && (
                    <div className="space-y-3">
                      <CardTitle className="flex items-center gap-2"><Radio className="size-4 text-muted-foreground" /> Record this live stream</CardTitle>
                      <CardDescription className="text-xs">Recording starts now and runs for the time you pick; the file is ready when it ends.</CardDescription>
                      <div className="flex flex-wrap gap-2">
                        {[1, 5, 10, 30, 60, 120].map(m => (
                          <Button key={m} size="sm" variant="outline" onClick={() => setLiveMinutes(m)}
                            className={liveMinutes === m ? 'bg-primary/10 text-primary border-primary/40' : 'text-muted-foreground'}>
                            {m >= 60 ? `${m / 60} h` : `${m} min`}
                          </Button>
                        ))}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {info.video.filter(v => v.height <= 1080).map(v => (
                          <Button key={v.height} size="sm" variant="outline" onClick={() => setLiveHeight(v.height)}
                            className={liveHeight === v.height ? 'bg-primary/10 text-primary border-primary/40' : 'text-muted-foreground'}>
                            {v.height}p
                          </Button>
                        ))}
                      </div>
                      <Button className="w-full" onClick={() => start({
                        key: `live:${liveHeight}:${liveMinutes}`, label: `Live recording · ${liveHeight}p · ${liveMinutes} min`,
                        sizeBytes: null, audioOnly: false, formatId: 'best',
                      })}>
                        <Radio /> Record {liveMinutes >= 60 ? `${liveMinutes / 60} h` : `${liveMinutes} min`} at {liveHeight}p
                      </Button>
                    </div>
                  )}

                  {info && !info.live && (
                    <>
                      <div className="space-y-2">
                        <CardTitle className="flex items-center gap-2"><Video className="size-4 text-muted-foreground" /> Video</CardTitle>
                        {info.video.length === 0 && <p className="text-xs text-muted-foreground">No video streams were offered.</p>}
                        <div className="divide-y divide-border border border-border rounded-md overflow-hidden">
                          {info.video.map(v => {
                            const name = heightName(v.height);
                            const label = `${v.height}p${v.fps > 30 ? v.fps : ''} · ${codecName(v.codec)} · ${v.ext}`;
                            return (
                              <div key={v.height} className="flex items-center gap-3 px-3 py-2 hover:bg-secondary/50">
                                <div className="w-20 font-semibold text-foreground">
                                  {v.height}p{v.fps > 30 ? <span className="text-muted-foreground font-normal">{v.fps}</span> : null}
                                </div>
                                {name && <Badge variant="secondary">{name}</Badge>}
                                <div className="flex-1 text-xs text-muted-foreground truncate">{codecName(v.codec)} · .{v.ext}</div>
                                <div className="text-xs text-muted-foreground tabular-nums">{fmtSize(v.size)}</div>
                                {rowButton(videoQuality(v.height, label, v.size))}
                              </div>
                            );
                          })}
                        </div>
                      </div>

                      <div className="space-y-2">
                        <CardTitle className="flex items-center gap-2"><Music className="size-4 text-muted-foreground" /> Music / audio only</CardTitle>
                        <div className="divide-y divide-border border border-border rounded-md overflow-hidden">
                          {info.audio.map(a => {
                            const label = `${a.ext === 'webm' ? 'Opus' : 'M4A'} · ${a.kbps} kbps`;
                            return (
                              <div key={a.ext} className="flex items-center gap-3 px-3 py-2 hover:bg-secondary/50">
                                <div className="w-20 font-semibold text-foreground">{a.ext === 'webm' ? 'Opus' : 'M4A'}</div>
                                <div className="flex-1 text-xs text-muted-foreground truncate">
                                  {a.kbps} kbps · {a.ext === 'webm' ? 'best quality, .webm' : 'plays everywhere'}
                                </div>
                                <div className="text-xs text-muted-foreground tabular-nums">{fmtSize(a.size)}</div>
                                {rowButton(audioQuality(a.ext, label, a.size))}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        Up to 1080p comes as H.264 in .mp4. Above that YouTube only offers VP9 or AV1, so the file is .webm or .mkv.
                      </p>
                    </>
                  )}
                </Card>
              </div>
            </div>
          )}
        </TabsContent>

        {/* ------------------------------------------------ Downloads */}
        <TabsContent value="downloads" className="space-y-2 mt-3">
          {jobs.length === 0 && (
            <Card className="border border-dashed border-border bg-card p-8 text-center text-muted-foreground">
              Nothing downloaded yet. Finished files stay here for three hours.
            </Card>
          )}
          {jobs.map(j => <JobRow key={j.id} job={j} />)}
        </TabsContent>

        {/* ------------------------------------------------ API access */}
        <TabsContent value="api" className="space-y-4 mt-3">
          <Card className="border border-border bg-card p-4 space-y-3">
            <div>
              <CardTitle className="flex items-center gap-2"><KeyRound className="size-4 text-muted-foreground" /> Secret access keys</CardTitle>
              <CardDescription className="text-xs text-muted-foreground mt-0.5">
                A key lets a program use the downloader API without the dashboard login. Keys are stored in R2, so they keep working after a restart. Treat them like passwords.
              </CardDescription>
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <Input value={keyName} onChange={e => setKeyName(e.target.value)} onKeyDown={e => e.key === 'Enter' && createKey()}
                placeholder="Name for the new key, e.g. my phone app" className="flex-1" />
              <Button onClick={createKey}><KeyRound /> Generate key</Button>
            </div>
            {keyError && <p className="text-xs text-destructive">{keyError}</p>}
            {keys.length === 0 && <p className="text-xs text-muted-foreground">No keys yet.</p>}
            <div className="space-y-2">
              {keys.map(k => (
                <div key={k.id} className="border border-border rounded-md p-3 space-y-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-foreground">{k.name}</span>
                    <span className="text-xs text-muted-foreground">
                      created {new Date(k.createdAt).toLocaleDateString()} · {k.uses ? `${k.uses} requests, last ${new Date(k.lastUsedAt || k.createdAt).toLocaleString()}` : 'never used'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-xs bg-secondary rounded px-2 py-1.5 font-mono truncate">
                      {shown.has(k.id) ? k.key : `${k.key.slice(0, 8)}${'•'.repeat(24)}`}
                    </code>
                    <Button variant="outline" size="sm" onClick={() => setShown(s => { const n = new Set(s); n.has(k.id) ? n.delete(k.id) : n.add(k.id); return n; })}>
                      {shown.has(k.id) ? <EyeOff /> : <Eye />}
                    </Button>
                    <CopyButton text={k.key} />
                    <Button variant="outline" size="sm" onClick={() => removeKey(k)} className="text-destructive"><Trash2 /></Button>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card className="border border-border bg-card p-4 space-y-3">
            <CardTitle>How to call it</CardTitle>
            <CardDescription className="text-xs text-muted-foreground">
              Send the key as <code>Authorization: Bearer KEY</code>, as <code>X-API-Key: KEY</code>, or as <code>?key=KEY</code> in the address.
            </CardDescription>
            {[
              ['Search', `curl -H "Authorization: Bearer ${sampleKey}" "${origin}/api/ytp/search?q=lofi&limit=10"`],
              ['Qualities of a video', `curl -H "Authorization: Bearer ${sampleKey}" "${origin}/api/ytp/info?url=https://youtu.be/VIDEO_ID"`],
              ['Download in 4K (or the best below it)', `curl -L -OJ -H "Authorization: Bearer ${sampleKey}" "${origin}/api/ytp/download?url=https://youtu.be/VIDEO_ID&height=2160"`],
              ['Download as music (m4a)', `curl -L -OJ -H "Authorization: Bearer ${sampleKey}" "${origin}/api/ytp/download?url=https://youtu.be/VIDEO_ID&audio=1"`],
              ['Record 10 minutes of a live stream', `curl -L -OJ -H "Authorization: Bearer ${sampleKey}" "${origin}/api/ytp/record?url=https://youtu.be/VIDEO_ID&minutes=10&height=720"`],
              ['Link that works in a browser', `${origin}/api/ytp/download?url=https://youtu.be/VIDEO_ID&height=1080&key=${sampleKey}`],
            ].map(([what, cmd]) => (
              <div key={what} className="space-y-1">
                <p className="text-xs font-medium text-foreground">{what}</p>
                <div className="flex items-start gap-2">
                  <code className="flex-1 text-[11px] bg-secondary rounded px-2 py-1.5 font-mono break-all">{cmd}</code>
                  <CopyButton text={cmd} />
                </div>
              </div>
            ))}
            <p className="text-[11px] text-muted-foreground">
              Other options: <code>&amp;audio=1&amp;ext=webm</code> for Opus, <code>&amp;f=ITAG</code> for one exact stream (see <code>/api/ytp/resolve</code>), <code>&amp;id=NAME</code> with <code>/api/ytp/progress?id=NAME</code> to follow a download. Errors come back as JSON with an <code>error</code> field.
            </p>
          </Card>
        </TabsContent>

        {/* ------------------------------------------------ Session */}
        <TabsContent value="session" className="mt-3">
          <Card className="border border-border bg-card p-4 space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <CardTitle className="flex items-center gap-2">
                  {signedIn ? <ShieldCheck className="size-4 text-primary" /> : <ShieldAlert className="size-4 text-destructive" />}
                  YouTube session
                </CardTitle>
                <CardDescription className="text-xs text-muted-foreground mt-0.5">
                  {health && !health.ok
                    ? 'The downloader service is not answering.'
                    : signedIn
                      ? 'A session is loaded. It is kept in R2 and restored on every restart.'
                      : 'No session yet. YouTube refuses server addresses without one: sign in below.'}
                </CardDescription>
              </div>
              <div className="flex gap-2">
                <Button onClick={startSignIn} disabled={signInStarting || cookieExporting} variant="outline" size="sm">
                  {signInStarting ? 'Opening browser...' : '1. Sign in to YouTube'}
                </Button>
                <Button onClick={exportCookies} disabled={cookieExporting} variant="outline" size="sm">
                  {cookieExporting ? 'Exporting...' : '2. Export session'}
                </Button>
              </div>
            </div>
            {signIn?.url && (
              <div className="text-xs px-3 py-2 rounded-md border border-border space-y-1">
                <div>
                  Open <a className="underline" href={signIn.url} target="_blank" rel="noreferrer">{signIn.url}</a>
                  {signIn.username ? <> (user <code>{signIn.username}</code>, password <code>{signIn.password}</code>)</> : null}
                  , sign in to Google there and wait until YouTube has loaded. Then press Export session.
                </div>
                <div className="text-muted-foreground">The browser restarts once during the export and ends up signed out; both are expected.</div>
              </div>
            )}
            {cookieResult && (
              <div className={`text-xs px-3 py-2 rounded-md border ${cookieResult.success ? 'bg-primary/10 text-primary border-primary/30' : 'bg-destructive/10 text-destructive border-destructive/30'}`}>
                {cookieResult.message}
              </div>
            )}
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
