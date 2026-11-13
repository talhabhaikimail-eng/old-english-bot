import React, { useCallback, useEffect, useRef, useState } from 'react';
import { marked } from 'marked';
import { api, YtSearchResult, YtQuality, YtJob, YtStorage, YtpInfo, YtpApiKey, YtpPlaylist } from '../api';
import { Button } from '@/components/ui/button';
import { Card, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  ArrowLeft, BookOpen, Check, Copy, Download, ExternalLink, Eye, EyeOff, HardDriveDownload, KeyRound, ListVideo, Loader2, Music,
  Radio, Search, ShieldCheck, ShieldAlert, Trash2, Video, X,
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

const YT_LIST = /[?&]list=([\w-]+)/;
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
function JobRow({ job, compact = false, onRemove }: { job: YtJob; compact?: boolean; onRemove?: (job: YtJob) => void }) {
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
          {compact ? '' : `${job.label || job.qualityKey} · `}{!compact && job.playlistTitle ? `${job.playlistTitle} · ` : ''}{job.sizeBytes ? `${fmtSize(job.sizeBytes)} · ` : ''}{job.message}
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
      {onRemove && (running
        ? <Button size="sm" variant="outline" onClick={() => onRemove(job)} title="Cancel this download" className="text-destructive"><X /> Cancel</Button>
        : <Button size="sm" variant="ghost" onClick={() => onRemove(job)} title="Remove from the list and delete the file" className="text-muted-foreground"><Trash2 /></Button>)}
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
  // The playlist being looked at.
  const [playlist, setPlaylist] = useState<YtpPlaylist | null>(null);
  const [playlistUrl, setPlaylistUrl] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [listChoice, setListChoice] = useState('1080');
  const [listStarting, setListStarting] = useState(false);
  const [listNote, setListNote] = useState<string | null>(null);
  const [docs, setDocs] = useState<string | null>(null);
  const [liveMinutes, setLiveMinutes] = useState(10);
  const [liveHeight, setLiveHeight] = useState(720);

  // Downloads.
  const [jobs, setJobs] = useState<YtJob[]>([]);
  const [storage, setStorage] = useState<YtStorage | null>(null);
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
      const { jobs: list, storage: room } = await api.ytJobs();
      setJobs(list);
      if (room) setStorage(room);
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
    api.ytpDocs().then(async md => setDocs(await marked.parse(md, { gfm: true }))).catch(() => setDocs(null));
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

  const openPlaylist = async (url: string) => {
    setPlaylistUrl(url); setPlaylist(null); setWatchUrl(null); setInfo(null); setError(null); setListNote(null);
    setLoadingList(true); setTab('browse');
    try { setPlaylist(await api.ytpPlaylist(url)); }
    catch (e) { setError((e as Error).message); }
    finally { setLoadingList(false); }
  };

  const downloadPlaylist = async () => {
    if (!playlistUrl || !playlist) return;
    setListStarting(true); setError(null); setListNote(null);
    try {
      const what: Record<string, string | number> =
        listChoice === 'm4a' ? { audio: 1 } : listChoice === 'opus' ? { audio: 1, ext: 'webm' } : { height: Number(listChoice) };
      const { playlist: started } = await api.ytpStartPlaylist(playlistUrl, what);
      setListNote(started.queued < started.count
        ? `Queued ${started.queued} of ${started.count} videos; the rest did not fit on the disk.`
        : `Queued all ${started.queued} videos. Two download at a time.`);
      await refreshJobs();
      setTab('downloads');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setListStarting(false);
    }
  };

  const submit = async () => {
    const text = query.trim();
    if (!text) return;
    // A playlist link; a video that sits in a playlist opens as the video.
    if (YT_LIST.test(text) && (!YT_URL.test(text) || /\/playlist\?/.test(text))) { openPlaylist(text); return; }
    if (YT_URL.test(text)) { setPlaylistUrl(YT_LIST.test(text) ? text : null); setPlaylist(null); open(text); return; }
    setSearching(true); setError(null); setWatchUrl(null); setInfo(null); setPlaylist(null); setPlaylistUrl(null); setTab('browse');
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

  /** Cancel a running download, or remove a finished one and its file. */
  const removeJob = async (job: YtJob) => {
    try {
      await api.ytRemoveJob(job.id);
      await refreshJobs();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const cancelAll = async () => {
    const waiting = jobs.filter(j => j.status === 'pending' || j.status === 'downloading');
    // Those still waiting first, so none of them starts when a running one stops.
    waiting.sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1));
    for (const j of waiting) { try { await api.ytRemoveJob(j.id); } catch { /* the list shows what is left */ } }
    await refreshJobs();
  };

  const clearFinished = async () => {
    for (const j of jobs.filter(x => x.status !== 'pending' && x.status !== 'downloading')) {
      try { await api.ytRemoveJob(j.id); } catch { /* the list shows what is left */ }
    }
    await refreshJobs();
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
  /** The address that sends this quality straight to the browser, with nothing kept on the server. */
  const directHref = (quality: YtQuality) => {
    const what = quality.key === 'audio-opus' ? 'audio=1&ext=webm'
      : quality.audioOnly ? 'audio=1'
      : `height=${/^(\d+)p/.exec(quality.key)?.[1] || '1080'}`;
    return `/api/ytp/download?url=${encodeURIComponent(watchUrl || '')}&${what}`;
  };
  const rowButton = (quality: YtQuality) => {
    const job = running(quality.key);
    return (
      <div className="flex items-center gap-1.5">
        <a href={directHref(quality)} download title="Download now: streamed straight to this browser, nothing is kept on the server">
          <Button size="sm"><Download /></Button>
        </a>
        {job
          ? <Button size="sm" variant="outline" disabled className="tabular-nums"><Loader2 className="animate-spin" /> {job.progress}%</Button>
          : <Button size="sm" variant="outline" onClick={() => start(quality)} title="Prepare on the server first: exact size, can be resumed, kept for three hours"><HardDriveDownload /></Button>}
      </div>
    );
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
          {!watchUrl && !playlistUrl && results.length === 0 && !searching && (
            <Card className="border border-dashed border-border bg-card p-8 text-center text-muted-foreground">
              Search for something, or paste a video or playlist link, to watch it here and download it in any quality up to 4K, as music, a whole playlist at once, or record a live stream.
            </Card>
          )}

          {/* Playlist */}
          {!watchUrl && playlistUrl && (
            <div className="space-y-3">
              <Button onClick={() => { setPlaylistUrl(null); setPlaylist(null); setError(null); }} variant="ghost" size="sm">
                <ArrowLeft /> {results.length ? 'Back to results' : 'Close'}
              </Button>
              {loadingList && <p className="text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="size-3.5 animate-spin" /> Reading the playlist…</p>}
              {playlist && (
                <>
                  <Card className="border border-border bg-card p-4 space-y-3">
                    <div className="flex items-start gap-3">
                      <ListVideo className="size-5 text-muted-foreground mt-0.5" />
                      <div className="flex-1 min-w-0">
                        <h2 className="text-base font-semibold text-foreground leading-snug">{playlist.title || 'Playlist'}</h2>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {playlist.count} videos · {fmtDuration(playlist.videos.reduce((n, v) => n + v.duration, 0))} in total
                        </p>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {[['2160', '4K'], ['1440', '1440p'], ['1080', '1080p'], ['720', '720p'], ['480', '480p'], ['360', '360p'], ['m4a', 'Music · M4A'], ['opus', 'Music · Opus']].map(([value, label]) => (
                        <Button key={value} size="sm" variant="outline" onClick={() => setListChoice(value)}
                          className={listChoice === value ? 'bg-primary/10 text-primary border-primary/40' : 'text-muted-foreground'}>
                          {label}
                        </Button>
                      ))}
                    </div>
                    <Button onClick={downloadPlaylist} disabled={listStarting} className="w-full sm:w-auto">
                      {listStarting ? <><Loader2 className="animate-spin" /> Queuing…</> : <><Download /> Download all {playlist.count}</>}
                    </Button>
                    <p className="text-[11px] text-muted-foreground">
                      Each video becomes its own download, two at a time. A video without the chosen height gets the best one below it. Files are kept for three hours and the oldest are removed when the disk share is full, so save them as they finish.
                    </p>
                    {listNote && <p className="text-xs text-primary">{listNote}</p>}
                  </Card>
                  <div className="border border-border rounded-lg divide-y divide-border overflow-hidden bg-card">
                    {playlist.videos.map((v, i) => (
                      <button key={v.id} type="button" onClick={() => open(v.url)} className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-secondary/50">
                        <span className="w-7 text-xs text-muted-foreground tabular-nums text-right">{i + 1}</span>
                        <img src={v.thumbnail} alt="" loading="lazy" className="w-24 aspect-video object-cover rounded border border-border bg-secondary flex-shrink-0" />
                        <span className="flex-1 min-w-0">
                          <span className="block text-sm text-foreground truncate">{v.title}</span>
                          <span className="block text-xs text-muted-foreground truncate">{v.author}</span>
                        </span>
                        <span className="text-xs text-muted-foreground tabular-nums">{fmtDuration(v.duration)}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Results grid */}
          {!watchUrl && !playlistUrl && results.length > 0 && (
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
                <ArrowLeft /> {playlist ? 'Back to the playlist' : results.length ? 'Back to results' : 'Close'}
              </Button>
              {playlistUrl && !playlist && (
                <Button onClick={() => openPlaylist(playlistUrl)} variant="outline" size="sm" className="ml-2">
                  <ListVideo /> This video is in a playlist: open it
                </Button>
              )}
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
                      {here.map(j => <JobRow key={j.id} job={j} compact onRemove={removeJob} />)}
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
                        <Download className="inline size-3" /> downloads now, streamed straight from YouTube through the server: nothing is stored there, but for video the browser cannot show the total size or resume.{' '}
                        <HardDriveDownload className="inline size-3" /> prepares the file on the server first (exact size, resumable, kept three hours).
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
          {storage && storage.budget > 0 && (
            <Card className="border border-border bg-card p-3 space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-foreground font-medium">Storage for downloads</span>
                <span className="text-muted-foreground tabular-nums">{fmtSize(storage.used) || '0 MB'} of {fmtSize(storage.budget)} used · {fmtSize(storage.free)} free on the disk</span>
              </div>
              <div className="w-full bg-secondary h-1.5 rounded-full overflow-hidden">
                <div className="h-full bg-primary rounded-full" style={{ width: `${Math.min(100, (storage.used / storage.budget) * 100)}%` }} />
              </div>
              <p className="text-[11px] text-muted-foreground">Downloads may use half of the free disk space. When a new one needs room, the oldest files are deleted first.</p>
            </Card>
          )}
          {jobs.length === 0 && (
            <Card className="border border-dashed border-border bg-card p-8 text-center text-muted-foreground">
              Nothing downloaded yet. Finished files stay here for three hours.
            </Card>
          )}
          {jobs.length > 0 && (
            <div className="flex justify-end gap-2">
              {active > 0 && <Button size="sm" variant="outline" onClick={cancelAll} className="text-destructive"><X /> Cancel all running ({active})</Button>}
              {jobs.length > active && <Button size="sm" variant="outline" onClick={clearFinished}><Trash2 /> Clear finished</Button>}
            </div>
          )}
          {jobs.map(j => <JobRow key={j.id} job={j} onRemove={removeJob} />)}
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
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <CardTitle className="flex items-center gap-2"><BookOpen className="size-4 text-muted-foreground" /> Documentation</CardTitle>
              <div className="flex gap-2">
                <CopyButton text={`${origin}/api/ytp/docs?key=${sampleKey}`} label="Copy docs link" />
              </div>
            </div>
            <CardDescription className="text-xs text-muted-foreground">
              The same text is served at <code>{origin}/api/ytp/docs</code> (Markdown), so a program or an AI assistant can read it with a key.
            </CardDescription>
            {docs === null
              ? <p className="text-xs text-muted-foreground">The documentation could not be loaded.</p>
              : (
                <div
                  className="text-[13px] leading-relaxed text-foreground space-y-3 break-words
                    [&_h1]:text-lg [&_h1]:font-semibold [&_h1]:mt-2
                    [&_h2]:text-base [&_h2]:font-semibold [&_h2]:mt-6 [&_h2]:pt-4 [&_h2]:border-t [&_h2]:border-border
                    [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:mt-4
                    [&_p]:text-muted-foreground [&_li]:text-muted-foreground [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-1
                    [&_strong]:text-foreground
                    [&_code]:font-mono [&_code]:text-[12px] [&_code]:bg-secondary [&_code]:rounded [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-foreground
                    [&_pre]:bg-secondary [&_pre]:rounded-md [&_pre]:p-3 [&_pre]:overflow-x-auto [&_pre_code]:bg-transparent [&_pre_code]:p-0
                    [&_table]:w-full [&_table]:text-xs [&_table]:border [&_table]:border-border [&_table]:rounded-md
                    [&_th]:text-left [&_th]:font-medium [&_th]:px-2 [&_th]:py-1.5 [&_th]:border-b [&_th]:border-border [&_th]:text-foreground
                    [&_td]:px-2 [&_td]:py-1.5 [&_td]:border-b [&_td]:border-border [&_td]:align-top [&_td]:text-muted-foreground"
                  dangerouslySetInnerHTML={{ __html: docs.replace(/YOUR_KEY/g, sampleKey) }}
                />
              )}
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
