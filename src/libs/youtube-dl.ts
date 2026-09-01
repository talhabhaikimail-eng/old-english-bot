/**
 * @file youtube-dl.ts
 * @description YouTube downloader using `youtube-dl-exec` with quality selection,
 *              audio-only mode, real download progress tracking, and YouTube search via `yt-search`.
 *
 *  Flow:
 *   1. searchYouTube(query)      → top N results (title, url, duration, views, author, thumbnail)
 *   2. getYouTubeInfo(url)       → video metadata + available quality options
 *   3. downloadYouTube(url, fmt) → DownloadResult with progress callbacks
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const youtubedl = require('youtube-dl-exec') as ((
  url: string,
  opts: Record<string, unknown>
) => Promise<YtDlpInfo>) & {
  exec: (url: string, flags: Record<string, unknown>, opts?: any) => any;
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const yts = require('yt-search') as (query: string) => Promise<YtsResult>;

import * as https from 'https';
import * as http from 'http';
import { IncomingMessage } from 'http';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { getYouTubeCookiesPath } from './browser';

// ---------------------------------------------------------------------------
// yt-search types
// ---------------------------------------------------------------------------

interface YtsVideo {
  videoId: string;
  url: string;
  title: string;
  description: string;
  thumbnail: string;
  seconds: number;
  timestamp: string;
  views: number;
  ago: string;
  author: { name: string; url: string };
}

interface YtsResult {
  videos: YtsVideo[];
}

// ---------------------------------------------------------------------------
// youtube-dl-exec types (subset we care about)
// ---------------------------------------------------------------------------

export interface YtDlpFormat {
  format_id: string;
  format_note?: string;
  ext: string;
  height?: number | null;
  width?: number | null;
  fps?: number | null;
  vcodec?: string;
  acodec?: string;
  tbr?: number | null;
  abr?: number | null;
  vbr?: number | null;
  filesize?: number | null;
  filesize_approx?: number | null;
  resolution?: string;
  /** Direct download URL (DASH streams and direct formats) */
  url?: string;
  protocol?: string;
  audio_ext?: string;
  video_ext?: string;
  dynamic_range?: string;
}

export interface YtDlpInfo {
  id: string;
  title: string;
  description?: string;
  thumbnail?: string;
  duration?: number;
  uploader?: string;
  view_count?: number;
  like_count?: number;
  webpage_url?: string;
  formats: YtDlpFormat[];
  /** Best pre-merged format chosen by yt-dlp */
  url?: string;
  ext?: string;
  format_id?: string;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A simplified search result */
export interface YouTubeSearchResult {
  videoId: string;
  url: string;
  title: string;
  thumbnail: string;
  duration: string; // "4:14"
  durationSeconds: number;
  views: number;
  ago: string;
  author: string;
}

/** A selectable quality option shown to the user */
export interface YouTubeQualityOption {
  /** Stable key used to re-identify this format later, e.g. "1080p", "720p", "audio" */
  key: string;
  /** Human-readable label */
  label: string;
  /** Estimated file size in bytes (may be approximate) */
  sizeBytes: number | null;
  /** Whether this is audio-only */
  audioOnly: boolean;
  /** Internal format_id from yt-dlp */
  formatId: string;
  /** Best audio format_id to merge with (for video-only DASH streams) */
  audioFormatId?: string;
}

/** Video metadata + selectable quality options */
export interface YouTubeVideoInfo {
  videoId: string;
  url: string;
  title: string;
  thumbnail: string;
  durationSeconds: number;
  uploader: string;
  viewCount: number;
  qualities: YouTubeQualityOption[];
}

/** What the bot sends to WhatsApp after a download */
export interface YouTubeDownloadResult {
  buffer: Buffer;
  mediaType: 'video' | 'document';
  mimetype: string;
  caption: string;
  filename: string;
}

/** Progress callback: called with human-readable status strings */
export type YtProgressCallback = (status: string) => Promise<void>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format bytes → human readable string */
function fmtBytes(bytes: number | null | undefined): string {
  if (!bytes) return '?';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Format seconds → mm:ss or hh:mm:ss */
function fmtDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Format large numbers with commas */
function fmtViews(n: number): string {
  return n.toLocaleString('en-US');
}

// ---------------------------------------------------------------------------
// 1. YouTube Search
// ---------------------------------------------------------------------------

/**
 * Search YouTube and return the top N results.
 *
 * @param query   Search query string
 * @param limit   Max results to return (default: 5)
 */
export async function searchYouTube(
  query: string,
  limit = 5,
): Promise<YouTubeSearchResult[]> {
  const result = await yts(query);
  return result.videos.slice(0, limit).map((v) => ({
    videoId:         v.videoId,
    url:             v.url,
    title:           v.title,
    thumbnail:       v.thumbnail,
    duration:        v.timestamp,
    durationSeconds: v.seconds,
    views:           v.views,
    ago:             v.ago,
    author:          v.author.name,
  }));
}

// ---------------------------------------------------------------------------
// 2. Get video info + quality options
// ---------------------------------------------------------------------------

/** Common yt-dlp flags used for all requests */
function buildYtdlpBaseFlags(): Record<string, unknown> {
  const flags: Record<string, unknown> = {
    noCheckCertificates: true,
    noWarnings: true,
  };
  const cookiesPath = getYouTubeCookiesPath();
  if (cookiesPath) {
    flags['cookies'] = cookiesPath;
  }
  return flags;
}

/**
 * Fetches video metadata and builds a list of quality options from yt-dlp.
 *
 * Quality selection rules:
 *  - Video options:  mp4 DASH video-only formats (height 144p–1080p+), deduped by height,
 *                   each paired with the best available m4a audio for merging.
 *  - Audio option:  best m4a audio-only stream (fallback: webm/opus).
 *
 * @param url  YouTube watch URL or youtu.be shortlink
 */
export async function getYouTubeInfo(url: string): Promise<YouTubeVideoInfo> {
  let info: YtDlpInfo;
  const baseFlags = buildYtdlpBaseFlags();
  try {
    info = await youtubedl(url, {
      ...baseFlags,
      dumpSingleJson: true,
      preferFreeFormats: false,
      format: 'all',
    });
  } catch (err: any) {
    if (baseFlags.cookies) {
      console.warn(`[youtube-dl] Fetch metadata with cookies failed: ${err.message || err}. Retrying cookieless...`);
      const noCookieFlags = { ...baseFlags };
      delete noCookieFlags.cookies;
      info = await youtubedl(url, {
        ...noCookieFlags,
        dumpSingleJson: true,
        preferFreeFormats: false,
        format: 'all',
      });
    } else {
      throw err;
    }
  }

  const formats = info.formats ?? [];

  // Find best audio-only format for merging with video-only formats
  const audioOnlyFormats = formats.filter(f => (f.vcodec || 'none') === 'none' && (f.acodec || 'none') !== 'none');
  const bestAudioFormat = [...audioOnlyFormats].sort((a, b) => {
    const aBr = a.tbr ?? a.abr ?? 0;
    const bBr = b.tbr ?? b.abr ?? 0;
    return bBr - aBr;
  })[0];
  const bestAudioId = bestAudioFormat?.format_id || 'bestaudio';

  const standardQualities: YouTubeQualityOption[] = [
    {
      key: 'audio-video',
      label: '🎬 Audio + Video (Best Pre-merged)',
      sizeBytes: null,
      audioOnly: false,
      formatId: 'best[ext=mp4]/best'
    },
    {
      key: 'video-only',
      label: '📹 Video Only (Highest Quality)',
      sizeBytes: null,
      audioOnly: false,
      formatId: 'bestvideo[ext=mp4]/bestvideo'
    },
    {
      key: 'audio-only',
      label: '🎵 Audio Only (m4a)',
      sizeBytes: bestAudioFormat?.filesize ?? bestAudioFormat?.filesize_approx ?? null,
      audioOnly: true,
      formatId: 'bestaudio[ext=m4a]/bestaudio'
    }
  ];

  const specificQualities: YouTubeQualityOption[] = [];

  formats.forEach((f) => {
    if (!f.format_id) return;

    const vcodec = f.vcodec || 'none';
    const acodec = f.acodec || 'none';

    const isAudio = vcodec === 'none' && acodec !== 'none';
    const isVideoOnly = vcodec !== 'none' && acodec === 'none';
    const isPreMerged = vcodec !== 'none' && acodec !== 'none';

    if (!isAudio && !isVideoOnly && !isPreMerged) return;

    let label = '';
    const ext = f.ext || 'unknown';
    const size = f.filesize ?? f.filesize_approx ?? null;
    const sizeStr = size ? ` · ${fmtBytes(size)}` : '';

    if (isAudio) {
      const abr = f.abr ?? f.tbr ?? null;
      const abrStr = abr ? `${abr.toFixed(0)}kbps` : 'unknown bitrate';
      label = `🎵 Audio: ${abrStr} (${ext})${sizeStr} [ID: ${f.format_id}]`;
    } else if (isVideoOnly) {
      const res = f.height ? `${f.height}p` : f.resolution || 'unknown res';
      const fps = f.fps ? ` @ ${f.fps}fps` : '';
      label = `📹 Video: ${res}${fps} (${ext})${sizeStr} [ID: ${f.format_id}]`;
    } else {
      const res = f.height ? `${f.height}p` : f.resolution || 'unknown res';
      const fps = f.fps ? ` @ ${f.fps}fps` : '';
      label = `🎬 Video+Audio: ${res}${fps} (${ext})${sizeStr} [ID: ${f.format_id}]`;
    }

    specificQualities.push({
      key: `format-${f.format_id}`,
      label,
      sizeBytes: size,
      audioOnly: isAudio,
      formatId: f.format_id,
      audioFormatId: isVideoOnly ? bestAudioId : undefined,
    });
  });

  const videoQualities = specificQualities.filter(q => !q.audioOnly);
  const audioQualities = specificQualities.filter(q => q.audioOnly);

  const formatMap = new Map(formats.map(f => [f.format_id, f]));

  videoQualities.sort((a, b) => {
    const fa = formatMap.get(a.formatId);
    const fb = formatMap.get(b.formatId);
    const ha = fa?.height ?? 0;
    const hb = fb?.height ?? 0;
    if (hb !== ha) return hb - ha;
    const fpsa = fa?.fps ?? 0;
    const fpsb = fb?.fps ?? 0;
    if (fpsb !== fpsa) return fpsb - fpsa;
    const sizea = a.sizeBytes ?? 0;
    const sizeb = b.sizeBytes ?? 0;
    return sizeb - sizea;
  });

  audioQualities.sort((a, b) => {
    const fa = formatMap.get(a.formatId);
    const fb = formatMap.get(b.formatId);
    const bra = fa?.abr ?? fa?.tbr ?? 0;
    const brb = fb?.abr ?? fb?.tbr ?? 0;
    if (brb !== bra) return brb - bra;
    const sizea = a.sizeBytes ?? 0;
    const sizeb = b.sizeBytes ?? 0;
    return sizeb - sizea;
  });

  const qualities = [
    ...standardQualities,
    ...videoQualities,
    ...audioQualities,
  ];

  return {
    videoId:         info.id,
    url:             info.webpage_url ?? url,
    title:           info.title,
    thumbnail:       info.thumbnail ?? '',
    durationSeconds: info.duration ?? 0,
    uploader:        info.uploader ?? 'Unknown',
    viewCount:       info.view_count ?? 0,
    qualities,
  };
}

// ---------------------------------------------------------------------------
// 3. Download with progress tracking
// ---------------------------------------------------------------------------

/**
 * Downloads media from a YouTube URL using yt-dlp, streaming the bytes
 * through Node's https to track real progress.
 *
 * For video: downloads the video stream and audio stream separately, then
 * passes format IDs to yt-dlp to let it merge them (requires ffmpeg).
 * Falls back to single-stream download if no audio format provided.
 *
 * If yt-dlp fails entirely, falls back to btch-downloader then ab-downloader.
 *
 * @param url           YouTube URL
 * @param quality       Selected quality option from getYouTubeInfo
 * @param onProgress    Progress callback (called periodically during download)
 */
export async function downloadYouTubeVideo(
  url: string,
  quality: YouTubeQualityOption,
  onProgress?: YtProgressCallback,
): Promise<YouTubeDownloadResult> {
  await onProgress?.(`⚙️ *Starting download: ${quality.label}*`);

  // Build format string: "videoId+audioId" or just "audioId" for audio-only
  const formatStr = quality.audioOnly
    ? quality.formatId
    : quality.audioFormatId
      ? `${quality.formatId}+${quality.audioFormatId}`
      : quality.formatId;

  // Get fresh metadata first using dumpSingleJson
  let info: YtDlpInfo;
  const baseFlags = buildYtdlpBaseFlags();
  let useCookies = !!baseFlags.cookies;

  try {
    info = await youtubedl(url, {
      ...baseFlags,
      dumpSingleJson: true,
      format: formatStr,
    });
  } catch (err: any) {
    if (baseFlags.cookies) {
      console.warn(`[youtube-dl] Download metadata fetch with cookies failed: ${err.message || err}. Retrying cookieless...`);
      useCookies = false;
      const noCookieFlags = { ...baseFlags };
      delete noCookieFlags.cookies;
      info = await youtubedl(url, {
        ...noCookieFlags,
        dumpSingleJson: true,
        format: formatStr,
      });
    } else {
      throw err;
    }
  }

  const tempId = `ytdl_${Math.random().toString(36).substring(2, 15)}`;
  const tmpDir = os.tmpdir();
  const outputPath = path.join(tmpDir, `${tempId}.%(ext)s`);

  await onProgress?.(`📥 *Downloading ${quality.label}*\n_0% total progress..._`);

  const flags: Record<string, unknown> = {
    ...buildYtdlpBaseFlags(),
    format: formatStr,
    output: outputPath,
  };

  if (!useCookies) {
    delete flags.cookies;
  }

  // Run the download process
  const yt = youtubedl.exec(url, flags);

  let lastPercent = 0;
  yt.stdout?.on('data', (data: Buffer) => {
    const text = data.toString();
    const match = text.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
    if (match) {
      const pct = parseFloat(match[1]);
      if (pct > lastPercent) {
        lastPercent = pct;
        const bar = buildProgressBar(pct, 10);
        onProgress?.(
          `📥 *Downloading ${quality.key}*\n${bar} ${pct.toFixed(1)}%\n`
        ).catch(() => {});
      }
    } else if (text.includes('[Merger]')) {
      onProgress?.(`⚙️ *Merging video and audio streams...*`).catch(() => {});
    }
  });

  const stderrChunks: Buffer[] = [];
  yt.stderr?.on('data', (data: Buffer) => {
    stderrChunks.push(data);
  });

  try {
    await yt;
  } catch (err) {
    const stderrMsg = Buffer.concat(stderrChunks).toString().trim();
    const errMsg = stderrMsg || (err as Error).message;
    throw new Error(`yt-dlp failed: ${errMsg}`);
  }

  // Find the actual output file path
  const tempBase = path.join(tmpDir, tempId);
  let finalPath = '';
  for (const extension of ['mp4', 'm4a', 'mkv', 'ts', 'webm']) {
    const candidate = `${tempBase}.${extension}`;
    if (fs.existsSync(candidate)) {
      finalPath = candidate;
      break;
    }
  }

  if (!finalPath) {
    throw new Error(`yt-dlp completed successfully, but the downloaded file could not be found in ${tmpDir}`);
  }

  // Read file into memory buffer
  const buffer = fs.readFileSync(finalPath);

  // Clean up
  try {
    fs.unlinkSync(finalPath);
  } catch (cleanupErr) {
    console.warn(`[youtube-dl] Failed to delete temp file ${finalPath}:`, cleanupErr);
  }

  const ext = quality.audioOnly ? 'm4a' : 'mp4';
  const mimetype = quality.audioOnly ? 'audio/mp4' : 'video/mp4';
  const mediaType: 'video' | 'document' = quality.audioOnly ? 'document' : 'video';

  return {
    buffer,
    mediaType,
    mimetype,
    caption:  `🎬 *${info.title}*\n_${quality.key} · ${fmtDuration(info.duration ?? 0)}_`,
    filename: `${info.title.replace(/[^\w\s-]/g, '').trim() || 'youtube_video'}.${ext}`,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Build a block-style progress bar */
function buildProgressBar(pct: number, width: number): string {
  const filled = Math.round((pct / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}
// ---------------------------------------------------------------------------
// Formatting helpers (exported for use in index.ts)
// ---------------------------------------------------------------------------

/**
 * Builds the WhatsApp search-result message for a single video.
 *
 * Example:
 *   🎬 *Hans Zimmer - Flight (Man of Steel)*
 *   👤 JexMavik  ·  ⏱ 4:14  ·  👀 33M views  ·  📅 12 years ago
 *   🔗 https://youtube.com/watch?v=w4OdIOGBW2Q
 */
export function formatSearchResultMessage(v: YouTubeSearchResult, index: number): string {
  const views = v.views >= 1_000_000
    ? `${(v.views / 1_000_000).toFixed(1)}M`
    : v.views >= 1_000
      ? `${(v.views / 1_000).toFixed(0)}K`
      : String(v.views);

  return (
    `*${index + 1}. ${v.title}*\n` +
    `👤 ${v.author}  ·  ⏱ ${v.duration}  ·  👀 ${views}  ·  📅 ${v.ago}\n` +
    `🔗 ${v.url}`
  );
}

/**
 * Builds the quality-picker message shown after the user selects a video.
 */
export function formatQualityPickerMessage(info: YouTubeVideoInfo): string {
  const lines: string[] = [
    `🎬 *${info.title}*`,
    `👤 ${info.uploader}  ·  ⏱ ${fmtDuration(info.durationSeconds)}  ·  👀 ${fmtViews(info.viewCount)}`,
    '',
    '*Choose a quality:*',
  ];

  info.qualities.forEach((q, i) => {
    lines.push(`  ${i + 1}. ${q.label}`);
  });

  lines.push('\n_Reply with the number to download_');
  lines.push('_e.g. reply *1* for the first option_');

  return lines.join('\n');
}
