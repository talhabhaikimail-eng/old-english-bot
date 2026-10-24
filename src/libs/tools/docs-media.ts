/**
 * @file tools/docs-media.ts
 * @description ffmpeg-backed audio / video converters: video-to-mp3, audio-convert, audio-cut,
 * video-convert, video-to-gif. Progress comes from `-progress pipe:1` against the ffprobe duration;
 * cancellation kills ffmpeg through the job's AbortSignal.
 */

import { promises as fs } from 'fs';
import { extname, join } from 'path';
import { requireBinary, runProcess } from './binaries';
import { withExt, type ConverterSpec, type JobInput, type JobOutput, type JobRunCtx } from './jobs';

export const VIDEO_EXT = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'flv', 'wmv', 'mpg', 'mpeg', '3gp', 'ts', 'mts', 'm2ts', 'ogv'];
export const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'oga', 'opus', 'flac', 'm4a', 'aac', 'wma', 'aiff', 'aif', 'amr', 'ac3', 'mka', 'weba', 'caf'];

// ---------- helpers ----------

export interface ProbeInfo {
  duration: number;
  size: number;
  formatName: string;
  bitrate: number;
  hasAudio: boolean;
  hasVideo: boolean;
  width: number;
  height: number;
  fps: number;
  vcodec: string;
  acodec: string;
  audioBitrate: number;
  sampleRate: number;
  channels: number;
}

export async function probe(path: string, signal?: AbortSignal): Promise<ProbeInfo> {
  const ffprobe = await requireBinary('ffprobe');
  let data: any;
  try {
    const { stdout } = await runProcess(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path], { timeoutMs: 60_000, signal });
    data = JSON.parse(stdout);
  } catch (e) {
    if (signal?.aborted) throw new Error('Cancelled');
    throw new Error(`Not a readable media file (${(e as Error).message.split('\n').pop()})`);
  }
  const streams: any[] = data.streams ?? [];
  // Cover art in audio files shows up as a video stream with attached_pic.
  const v = streams.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const a = streams.find(s => s.codec_type === 'audio');
  const rate = (r?: string) => {
    if (!r) return 0;
    const [n, d] = r.split('/').map(Number);
    return d ? n / d : n || 0;
  };
  let duration = Number(data.format?.duration) || 0;
  if (!duration) duration = Math.max(0, ...streams.map(s => Number(s.duration) || 0));
  return {
    duration,
    size: Number(data.format?.size) || 0,
    formatName: data.format?.format_name || '',
    bitrate: Number(data.format?.bit_rate) || 0,
    hasAudio: !!a,
    hasVideo: !!v,
    width: v?.width ?? 0,
    height: v?.height ?? 0,
    fps: v ? rate(v.avg_frame_rate) || rate(v.r_frame_rate) : 0,
    vcodec: v?.codec_name ?? '',
    acodec: a?.codec_name ?? '',
    audioBitrate: Number(a?.bit_rate) || 0,
    sampleRate: Number(a?.sample_rate) || 0,
    channels: Number(a?.channels) || 0,
  };
}

let encodersPromise: Promise<Set<string>> | null = null;
export function ffmpegEncoders(): Promise<Set<string>> {
  if (!encodersPromise) {
    encodersPromise = (async () => {
      const ffmpeg = await requireBinary('ffmpeg');
      const { stdout } = await runProcess(ffmpeg, ['-hide_banner', '-encoders'], { timeoutMs: 30_000 });
      const set = new Set<string>();
      for (const line of stdout.split(/\r?\n/)) {
        const m = /^\s*[VAS][.A-Z]{5}\s+(\S+)/.exec(line);
        if (m) set.add(m[1]);
      }
      return set;
    })().catch(e => { encodersPromise = null; throw e; });
  }
  return encodersPromise;
}

/** "1:02.5", "00:01:02.500", "62.5", "62.5s" → seconds. Empty → null. */
export function parseTime(v: unknown, label = 'time'): number | null {
  const s = String(v ?? '').trim().replace(/s$/i, '');
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(s);
  if (!m) throw new Error(`Invalid ${label} "${s}" - use seconds (75.5) or hh:mm:ss.ms (1:15.5)`);
  return (Number(m[1] || 0) * 3600) + Number(m[2]) * 60 + Number(m[3]);
}

const fmtTime = (s: number) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${sec.toFixed(1).padStart(4, '0')}`;
};

/** Run ffmpeg reporting progress (0..1) of `duration` seconds of output. */
export async function runFfmpeg(args: string[], o: { duration: number; signal: AbortSignal; onProgress?: (frac: number) => void; timeoutMs?: number }): Promise<void> {
  const ffmpeg = await requireBinary('ffmpeg');
  try {
    await runProcess(ffmpeg, ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', ...args], {
      signal: o.signal,
      timeoutMs: o.timeoutMs ?? 60 * 60_000,
      onStdoutLine: line => {
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
        if (m && o.duration > 0 && o.onProgress) o.onProgress(Math.min(1, Number(m[1]) / 1e6 / o.duration));
      },
    });
  } catch (e) {
    if (o.signal.aborted) throw new Error('Cancelled');
    const msg = (e as Error).message;
    throw new Error(`ffmpeg failed: ${msg.split('\n').filter(Boolean).slice(-3).join(' | ')}`);
  }
}

/** Run one ffmpeg command per input with progress spread across the batch. */
async function batch(ctx: JobRunCtx, each: (f: JobInput, info: ProbeInfo, report: (frac: number) => void) => Promise<{ out: JobOutput; meta: Record<string, unknown> }>) {
  const outputs: JobOutput[] = [];
  const files: Record<string, unknown>[] = [];
  const n = ctx.inputs.length;
  for (const [i, f] of ctx.inputs.entries()) {
    if (ctx.signal.aborted) throw new Error('Cancelled');
    const label = n > 1 ? `${f.filename} (${i + 1}/${n})` : f.filename;
    ctx.progress(1 + (98 * i) / n, `Reading ${label}`);
    let info: ProbeInfo;
    try {
      info = await probe(f.path, ctx.signal);
    } catch (e) {
      throw new Error(`${f.filename}: ${(e as Error).message}`);
    }
    const r = await each(f, info, frac => ctx.progress(1 + (98 * (i + frac)) / n, `Converting ${label} - ${Math.round(frac * 100)}%`));
    const st = await fs.stat(r.out.path);
    outputs.push(r.out);
    files.push({ file: f.filename, output: r.out.filename, before: f.size, after: st.size, duration: Math.round(info.duration * 10) / 10, ...r.meta });
  }
  return { outputs, meta: { files } };
}

function uniqueName(ctx: JobRunCtx, name: string): string {
  return join(ctx.workDir, name);
}

// ---------- audio codec selection ----------

export const AUDIO_FORMATS = ['mp3', 'wav', 'ogg', 'opus', 'flac', 'm4a', 'aac'] as const;
type AudioFormat = typeof AUDIO_FORMATS[number];

async function audioCodecArgs(fmt: AudioFormat, bitrate: string, info?: ProbeInfo): Promise<string[]> {
  const enc = await ffmpegEncoders();
  const kbps = bitrate && bitrate !== 'auto' ? Number(bitrate) : 0;
  switch (fmt) {
    case 'mp3':
      if (!enc.has('libmp3lame')) throw new Error('This ffmpeg build has no MP3 encoder (libmp3lame)');
      return ['-c:a', 'libmp3lame', ...(kbps ? ['-b:a', `${kbps}k`] : ['-q:a', '2']), '-id3v2_version', '3'];
    case 'wav': return ['-c:a', info && /pcm_s24|pcm_s32|pcm_f32/.test(info.acodec) ? 'pcm_s24le' : 'pcm_s16le'];
    case 'flac': return ['-c:a', 'flac', '-compression_level', '8'];
    case 'ogg':
      if (enc.has('libvorbis')) return ['-c:a', 'libvorbis', ...(kbps ? ['-b:a', `${kbps}k`] : ['-q:a', '5'])];
      return ['-c:a', 'vorbis', '-strict', '-2', '-ac', '2', '-b:a', `${kbps || 160}k`];
    case 'opus':
      if (enc.has('libopus')) return ['-c:a', 'libopus', '-b:a', `${Math.min(kbps || 128, 256)}k`, '-vbr', 'on'];
      return ['-c:a', 'opus', '-strict', '-2', '-ar', '48000', '-b:a', `${Math.min(kbps || 128, 256)}k`];
    case 'm4a':
    case 'aac':
      return ['-c:a', enc.has('libfdk_aac') ? 'libfdk_aac' : 'aac', '-b:a', `${kbps || 192}k`];
  }
}

function containerArgs(fmt: AudioFormat): string[] {
  if (fmt === 'm4a') return ['-f', 'ipod', '-movflags', '+faststart'];
  if (fmt === 'aac') return ['-f', 'adts'];
  if (fmt === 'opus') return ['-f', 'opus'];
  if (fmt === 'ogg') return ['-f', 'ogg'];
  return [];
}

const SAME_AS: Record<string, AudioFormat> = {
  mp3: 'mp3', wav: 'wav', ogg: 'ogg', oga: 'ogg', opus: 'opus', flac: 'flac', m4a: 'm4a', aac: 'aac',
};

const bitrateChoices = [
  { value: 'auto', label: 'Auto (high quality)' },
  ...[64, 96, 128, 160, 192, 256, 320].map(b => ({ value: String(b), label: `${b} kbps` })),
];
const formatChoices = [
  { value: 'mp3', label: 'MP3' }, { value: 'm4a', label: 'M4A (AAC)' }, { value: 'aac', label: 'AAC (raw ADTS)' },
  { value: 'ogg', label: 'OGG (Vorbis)' }, { value: 'opus', label: 'Opus' }, { value: 'flac', label: 'FLAC (lossless)' },
  { value: 'wav', label: 'WAV (uncompressed)' },
];

function trimArgs(info: ProbeInfo, startRaw: unknown, endRaw: unknown): { pre: string[]; post: string[]; duration: number; start: number } {
  const start = parseTime(startRaw, 'start') ?? 0;
  const end = parseTime(endRaw, 'end');
  if (info.duration && start >= info.duration) throw new Error(`Start ${fmtTime(start)} is after the end of the file (${fmtTime(info.duration)})`);
  if (end !== null && end <= start) throw new Error('End must be after start');
  const stop = end === null ? info.duration : Math.min(end, info.duration || end);
  const duration = Math.max(0.05, stop - start);
  return {
    pre: start > 0 ? ['-ss', start.toFixed(3)] : [],
    post: end !== null ? ['-t', duration.toFixed(3)] : [],
    duration,
    start,
  };
}

// ---------- converters ----------

const videoToMp3: ConverterSpec = {
  id: 'video-to-mp3',
  label: 'Extract MP3',
  group: 'audio',
  inputs: [...VIDEO_EXT, ...AUDIO_EXT],
  output: 'mp3',
  maxFiles: 20,
  requires: { binaries: ['ffmpeg', 'ffprobe'] },
  timeoutMs: 60 * 60_000,
  options: [
    { key: 'mode', label: 'Bitrate mode', type: 'select', default: 'cbr', choices: [{ value: 'cbr', label: 'Constant (CBR)' }, { value: 'vbr', label: 'Variable (VBR)' }] },
    { key: 'bitrate', label: 'CBR bitrate', type: 'select', default: '192', choices: [128, 160, 192, 224, 256, 320].map(b => ({ value: String(b), label: `${b} kbps` })) },
    {
      key: 'vbr', label: 'VBR quality', type: 'select', default: '2',
      choices: [
        { value: '0', label: 'V0 (~245 kbps)' }, { value: '1', label: 'V1 (~225 kbps)' }, { value: '2', label: 'V2 (~190 kbps)' },
        { value: '3', label: 'V3 (~175 kbps)' }, { value: '4', label: 'V4 (~165 kbps)' },
      ],
    },
    { key: 'start', label: 'Start (optional)', type: 'text', default: '', placeholder: '0:00' },
    { key: 'end', label: 'End (optional)', type: 'text', default: '', placeholder: 'end of file' },
  ],
  run: ctx => batch(ctx, async (f, info, report) => {
    if (!info.hasAudio) throw new Error(`${f.filename} has no audio track`);
    const enc = await ffmpegEncoders();
    if (!enc.has('libmp3lame')) throw new Error('This ffmpeg build has no MP3 encoder (libmp3lame)');
    const t = trimArgs(info, ctx.options.start, ctx.options.end);
    const name = withExt(f.filename, 'mp3');
    const out = uniqueName(ctx, name);
    const q = ctx.options.mode === 'vbr' ? ['-q:a', String(ctx.options.vbr)] : ['-b:a', `${ctx.options.bitrate}k`];
    await runFfmpeg([...t.pre, '-i', f.path, ...t.post, '-map', '0:a:0', '-vn', '-map_metadata', '0', '-c:a', 'libmp3lame', ...q, '-id3v2_version', '3', out],
      { duration: t.duration, signal: ctx.signal, onProgress: report });
    return { out: { path: out, filename: name }, meta: { seconds: Math.round(t.duration * 10) / 10 } };
  }),
};

const audioConvert: ConverterSpec = {
  id: 'audio-convert',
  label: 'Convert audio',
  group: 'audio',
  inputs: [...AUDIO_EXT, ...VIDEO_EXT],
  output: 'mp3 / m4a / ogg / opus / flac / wav',
  maxFiles: 20,
  requires: { binaries: ['ffmpeg', 'ffprobe'] },
  timeoutMs: 60 * 60_000,
  options: [
    { key: 'format', label: 'Format', type: 'select', default: 'mp3', choices: formatChoices },
    { key: 'bitrate', label: 'Bitrate', type: 'select', default: 'auto', choices: bitrateChoices, help: 'Ignored for FLAC / WAV.' },
    {
      key: 'sampleRate', label: 'Sample rate', type: 'select', default: 'keep',
      choices: [{ value: 'keep', label: 'Keep' }, ...[8000, 16000, 22050, 32000, 44100, 48000].map(r => ({ value: String(r), label: `${r / 1000} kHz` }))],
    },
    { key: 'channels', label: 'Channels', type: 'select', default: 'keep', choices: [{ value: 'keep', label: 'Keep' }, { value: 'mono', label: 'Mono' }, { value: 'stereo', label: 'Stereo' }] },
    { key: 'loudnorm', label: 'Normalize loudness (EBU R128, -16 LUFS)', type: 'boolean', default: false },
  ],
  run: ctx => batch(ctx, async (f, info, report) => {
    if (!info.hasAudio) throw new Error(`${f.filename} has no audio track`);
    const fmt = ctx.options.format as AudioFormat;
    const name = withExt(f.filename, fmt);
    const out = uniqueName(ctx, name);
    const args = ['-i', f.path, '-map', '0:a:0', '-vn', '-map_metadata', '0'];
    const filters: string[] = [];
    if (ctx.options.loudnorm) filters.push('loudnorm=I=-16:TP=-1.5:LRA=11');
    if (filters.length) args.push('-af', filters.join(','));
    let sr = ctx.options.sampleRate === 'keep' ? 0 : Number(ctx.options.sampleRate);
    // loudnorm resamples to 192 kHz internally: pin the output rate back.
    if (!sr && ctx.options.loudnorm) sr = info.sampleRate || 48000;
    if (fmt === 'opus' && sr && ![8000, 12000, 16000, 24000, 48000].includes(sr)) sr = 48000;
    if (fmt === 'mp3' && sr > 48000) sr = 48000;
    if (sr) args.push('-ar', String(sr));
    if (ctx.options.channels === 'mono') args.push('-ac', '1');
    if (ctx.options.channels === 'stereo') args.push('-ac', '2');
    args.push(...await audioCodecArgs(fmt, ctx.options.bitrate, info), ...containerArgs(fmt), out);
    await runFfmpeg(args, { duration: info.duration, signal: ctx.signal, onProgress: report });
    return { out: { path: out, filename: name }, meta: { format: fmt, inputCodec: info.acodec } };
  }),
};

const audioCut: ConverterSpec = {
  id: 'audio-cut',
  label: 'Cut audio',
  group: 'audio',
  inputs: [...AUDIO_EXT, ...VIDEO_EXT],
  output: 'same format / mp3 / …',
  maxFiles: 1,
  requires: { binaries: ['ffmpeg', 'ffprobe'] },
  timeoutMs: 30 * 60_000,
  options: [
    { key: 'start', label: 'Start', type: 'text', default: '0', placeholder: '0:00.0' },
    { key: 'end', label: 'End', type: 'text', default: '', placeholder: 'end of file' },
    { key: 'fadeIn', label: 'Fade in (s)', type: 'number', default: 0, min: 0, max: 30, step: 0.1 },
    { key: 'fadeOut', label: 'Fade out (s)', type: 'number', default: 0, min: 0, max: 30, step: 0.1 },
    { key: 'format', label: 'Format', type: 'select', default: 'same', choices: [{ value: 'same', label: 'Same as input' }, ...formatChoices] },
    { key: 'bitrate', label: 'Bitrate', type: 'select', default: 'auto', choices: bitrateChoices },
  ],
  run: ctx => batch(ctx, async (f, info, report) => {
    if (!info.hasAudio) throw new Error(`${f.filename} has no audio track`);
    const t = trimArgs(info, ctx.options.start, ctx.options.end);
    const inExt = extname(f.filename).slice(1).toLowerCase();
    const fmt: AudioFormat = ctx.options.format === 'same' ? (SAME_AS[inExt] ?? 'mp3') : ctx.options.format;
    let bitrate = String(ctx.options.bitrate);
    if (bitrate === 'auto' && ctx.options.format === 'same' && info.audioBitrate && (fmt === 'mp3' || fmt === 'm4a' || fmt === 'aac' || fmt === 'ogg')) {
      // Match the source bitrate so a cut doesn't change quality.
      const kb = Math.round(info.audioBitrate / 1000);
      bitrate = String([96, 128, 160, 192, 224, 256, 320].reduce((best, b) => (Math.abs(b - kb) < Math.abs(best - kb) ? b : best), 192));
    }
    const fi = Math.min(Number(ctx.options.fadeIn) || 0, t.duration / 2);
    const fo = Math.min(Number(ctx.options.fadeOut) || 0, t.duration / 2);
    const filters: string[] = [];
    if (fi > 0) filters.push(`afade=t=in:st=0:d=${fi.toFixed(3)}`);
    if (fo > 0) filters.push(`afade=t=out:st=${Math.max(0, t.duration - fo).toFixed(3)}:d=${fo.toFixed(3)}`);
    const stem = f.filename.replace(/\.[^.]+$/, '');
    const name = `${stem}_cut.${fmt}`;
    const out = uniqueName(ctx, name);
    // -ss before -i with re-encoding is sample accurate; -t always set so the length is exact.
    await runFfmpeg([
      ...t.pre, '-i', f.path, '-t', t.duration.toFixed(3), '-map', '0:a:0', '-vn', '-map_metadata', '0',
      ...(filters.length ? ['-af', filters.join(',')] : []),
      ...await audioCodecArgs(fmt, bitrate, info), ...containerArgs(fmt), out,
    ], { duration: t.duration, signal: ctx.signal, onProgress: report });
    return { out: { path: out, filename: name }, meta: { start: t.start, seconds: Math.round(t.duration * 1000) / 1000, format: fmt } };
  }),
};

const CRF = {
  x264: { high: 20, medium: 23, low: 28 },
  vp9: { high: 28, medium: 33, low: 40 },
  mpeg4: { high: 3, medium: 5, low: 9 },
} as const;
const X264_PRESET = { fast: 'veryfast', balanced: 'medium', small: 'slow' } as const;
const VP9_SPEED = { fast: '5', balanced: '3', small: '1' } as const;

const videoConvert: ConverterSpec = {
  id: 'video-convert',
  label: 'Convert video',
  group: 'video',
  inputs: [...VIDEO_EXT, 'gif'],
  output: 'mp4 / webm / mov / mkv',
  maxFiles: 5,
  requires: { binaries: ['ffmpeg', 'ffprobe'] },
  timeoutMs: 3 * 60 * 60_000,
  options: [
    {
      key: 'format', label: 'Format', type: 'select', default: 'mp4',
      choices: [{ value: 'mp4', label: 'MP4 (H.264 + AAC)' }, { value: 'webm', label: 'WebM (VP9 + Opus)' }, { value: 'mov', label: 'MOV (H.264 + AAC)' }, { value: 'mkv', label: 'MKV (H.264 + AAC)' }],
    },
    {
      key: 'quality', label: 'Quality', type: 'select', default: 'medium',
      choices: [{ value: 'high', label: 'High (bigger)' }, { value: 'medium', label: 'Balanced' }, { value: 'low', label: 'Small file' }],
    },
    {
      key: 'speed', label: 'Encoder speed', type: 'select', default: 'balanced',
      choices: [{ value: 'fast', label: 'Fast' }, { value: 'balanced', label: 'Balanced' }, { value: 'small', label: 'Slow (smaller)' }],
    },
    {
      key: 'maxHeight', label: 'Max resolution', type: 'select', default: 'keep',
      choices: [{ value: 'keep', label: 'Keep' }, ...[2160, 1440, 1080, 720, 480, 360].map(h => ({ value: String(h), label: `${h}p` }))],
    },
    {
      key: 'fps', label: 'Frame rate', type: 'select', default: 'keep',
      choices: [{ value: 'keep', label: 'Keep' }, ...[60, 30, 25, 24, 15].map(r => ({ value: String(r), label: `${r} fps` }))],
    },
    { key: 'targetSizeMb', label: 'Target size (MB)', type: 'number', default: 0, min: 0, max: 20000, step: 1, help: '0 = use the quality setting instead.' },
    { key: 'audioBitrate', label: 'Audio bitrate', type: 'select', default: '128', choices: [64, 96, 128, 160, 192].map(b => ({ value: String(b), label: `${b} kbps` })) },
    { key: 'stripAudio', label: 'Remove audio', type: 'boolean', default: false },
  ],
  run: ctx => batch(ctx, async (f, info, report) => {
    if (!info.hasVideo) throw new Error(`${f.filename} has no video stream`);
    const o = ctx.options;
    const enc = await ffmpegEncoders();
    const fmt = String(o.format);
    const quality = (o.quality in CRF.x264 ? o.quality : 'medium') as keyof typeof CRF.x264;
    const speed = (o.speed in X264_PRESET ? o.speed : 'balanced') as keyof typeof X264_PRESET;
    const withAudio = info.hasAudio && !o.stripAudio;
    const audioKbps = Number(o.audioBitrate) || 128;

    let targetKbps = 0;
    if (Number(o.targetSizeMb) > 0) {
      if (!info.duration) throw new Error(`${f.filename}: unknown duration, can't aim for a target size`);
      const totalKbps = (Number(o.targetSizeMb) * 8192 * 0.96) / info.duration;
      targetKbps = Math.floor(totalKbps - (withAudio ? audioKbps : 0));
      if (targetKbps < 60) {
        const minMb = Math.ceil(((60 + (withAudio ? audioKbps : 0)) * info.duration) / 8192 / 0.96);
        throw new Error(`${o.targetSizeMb} MB is too small for ${fmtTime(info.duration)} of video - try at least ${minMb} MB${withAudio ? ' or remove audio' : ''}`);
      }
    }

    const vf: string[] = [];
    const maxH = o.maxHeight === 'keep' ? 0 : Number(o.maxHeight);
    if (maxH && info.height > maxH) vf.push(`scale=-2:${maxH}:flags=lanczos`);
    else vf.push('scale=trunc(iw/2)*2:trunc(ih/2)*2');
    const fps = o.fps === 'keep' ? 0 : Number(o.fps);
    if (fps && (!info.fps || info.fps > fps + 0.5)) vf.push(`fps=${fps}`);

    const v: string[] = [];
    let vcodec: string;
    if (fmt === 'webm') {
      if (enc.has('libvpx-vp9')) {
        vcodec = 'vp9';
        v.push('-c:v', 'libvpx-vp9', '-deadline', 'good', '-cpu-used', VP9_SPEED[speed], '-row-mt', '1');
        v.push(...(targetKbps ? ['-b:v', `${targetKbps}k`] : ['-crf', String(CRF.vp9[quality]), '-b:v', '0']));
      } else if (enc.has('libvpx')) {
        vcodec = 'vp8';
        v.push('-c:v', 'libvpx', '-deadline', 'good', '-cpu-used', '4');
        v.push(...(targetKbps ? ['-b:v', `${targetKbps}k`] : ['-crf', String(CRF.vp9[quality] - 18), '-b:v', '4M']));
      } else {
        throw new Error('This ffmpeg build has no VP9/VP8 encoder - choose MP4 instead');
      }
    } else if (enc.has('libx264')) {
      vcodec = 'h264';
      v.push('-c:v', 'libx264', '-preset', X264_PRESET[speed], '-profile:v', 'high');
      v.push(...(targetKbps ? ['-b:v', `${targetKbps}k`, '-maxrate', `${Math.round(targetKbps * 1.5)}k`, '-bufsize', `${targetKbps * 2}k`] : ['-crf', String(CRF.x264[quality])]));
    } else {
      vcodec = 'mpeg4';
      v.push('-c:v', 'mpeg4', ...(targetKbps ? ['-b:v', `${targetKbps}k`] : ['-q:v', String(CRF.mpeg4[quality])]));
    }
    v.push('-pix_fmt', 'yuv420p');

    const a: string[] = [];
    if (withAudio) {
      if (fmt === 'webm') a.push('-c:a', enc.has('libopus') ? 'libopus' : 'libvorbis', '-b:a', `${audioKbps}k`);
      else a.push('-c:a', 'aac', '-b:a', `${audioKbps}k`);
      if (fmt === 'webm' && enc.has('libopus')) a.push('-ar', '48000');
    }

    const name = withExt(f.filename, fmt);
    const out = uniqueName(ctx, name);
    await runFfmpeg([
      '-i', f.path,
      '-map', '0:v:0', ...(withAudio ? ['-map', '0:a:0'] : ['-an']), '-sn', '-dn', '-map_metadata', '0',
      '-vf', vf.join(','), ...v, ...a,
      ...(fmt === 'mp4' || fmt === 'mov' ? ['-movflags', '+faststart'] : []),
      out,
    ], { duration: info.duration, signal: ctx.signal, onProgress: report, timeoutMs: 3 * 60 * 60_000 });
    const after = await probe(out, ctx.signal).catch(() => null);
    return {
      out: { path: out, filename: name },
      meta: {
        vcodec, inputResolution: `${info.width}x${info.height}`,
        outputResolution: after ? `${after.width}x${after.height}` : undefined,
        inputCodec: info.vcodec, targetKbps: targetKbps || undefined,
      },
    };
  }),
};

const videoToGif: ConverterSpec = {
  id: 'video-to-gif',
  label: 'Make GIF',
  group: 'video',
  inputs: [...VIDEO_EXT, 'gif'],
  output: 'gif / webp / mp4',
  maxFiles: 1,
  requires: { binaries: ['ffmpeg', 'ffprobe'] },
  timeoutMs: 15 * 60_000,
  options: [
    { key: 'start', label: 'Start', type: 'text', default: '0', placeholder: '0:00' },
    { key: 'duration', label: 'Duration (s)', type: 'number', default: 5, min: 0.2, max: 30, step: 0.1 },
    { key: 'fps', label: 'FPS', type: 'number', default: 12, min: 1, max: 30 },
    { key: 'width', label: 'Width (px)', type: 'number', default: 480, min: 64, max: 1280, step: 2 },
    {
      key: 'dither', label: 'Dithering', type: 'select', default: 'sierra2_4a',
      choices: [
        { value: 'sierra2_4a', label: 'Sierra (smooth, default)' }, { value: 'floyd_steinberg', label: 'Floyd-Steinberg' },
        { value: 'bayer', label: 'Bayer (smaller files)' }, { value: 'none', label: 'None (banding, smallest)' },
      ],
    },
    { key: 'loop', label: 'Loop', type: 'select', default: '0', choices: [{ value: '0', label: 'Forever' }, { value: '-1', label: 'Play once' }] },
    { key: 'format', label: 'Output', type: 'select', default: 'gif', choices: [{ value: 'gif', label: 'GIF' }, { value: 'webp', label: 'Animated WebP (smaller)' }, { value: 'mp4', label: 'MP4 clip (smallest)' }] },
  ],
  run: ctx => batch(ctx, async (f, info, report) => {
    if (!info.hasVideo) throw new Error(`${f.filename} has no video stream`);
    const o = ctx.options;
    const start = parseTime(o.start, 'start') ?? 0;
    if (info.duration && start >= info.duration) throw new Error(`Start ${fmtTime(start)} is after the end of the video (${fmtTime(info.duration)})`);
    const duration = Math.min(30, Number(o.duration) || 5, info.duration ? info.duration - start : 30);
    const fps = Math.max(1, Math.min(30, Number(o.fps) || 12));
    const width = Math.max(64, Math.min(1280, Math.round((Number(o.width) || 480) / 2) * 2));
    const scale = `scale=${width}:-2:flags=lanczos`;
    const fmt = String(o.format);
    const stem = f.filename.replace(/\.[^.]+$/, '');
    const name = `${stem}.${fmt}`;
    const out = uniqueName(ctx, name);
    const pre = [...(start > 0 ? ['-ss', start.toFixed(3)] : []), '-t', duration.toFixed(3), '-i', f.path];
    let args: string[];
    if (fmt === 'gif') {
      const dither = o.dither === 'bayer' ? 'bayer:bayer_scale=3' : String(o.dither);
      args = [...pre, '-filter_complex',
        `[0:v]fps=${fps},${scale},split[a][b];[a]palettegen=stats_mode=diff:max_colors=256[p];[b][p]paletteuse=dither=${dither}:diff_mode=rectangle`,
        '-loop', String(o.loop), out];
    } else if (fmt === 'webp') {
      const enc = await ffmpegEncoders();
      const codec = enc.has('libwebp_anim') ? 'libwebp_anim' : enc.has('libwebp') ? 'libwebp' : '';
      if (!codec) throw new Error('This ffmpeg build has no WebP encoder - choose GIF or MP4');
      args = [...pre, '-vf', `fps=${fps},${scale}`, '-c:v', codec, '-quality', '75', '-compression_level', '5', '-loop', o.loop === '-1' ? '1' : '0', '-an', out];
    } else {
      const enc = await ffmpegEncoders();
      const v = enc.has('libx264') ? ['-c:v', 'libx264', '-crf', '24', '-preset', 'medium'] : ['-c:v', 'mpeg4', '-q:v', '4'];
      args = [...pre, '-vf', `fps=${fps},${scale}`, ...v, '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', out];
    }
    await runFfmpeg(args, { duration, signal: ctx.signal, onProgress: report });
    return { out: { path: out, filename: name }, meta: { start, seconds: Math.round(duration * 10) / 10, fps, width, format: fmt } };
  }),
};

export const mediaConverters: ConverterSpec[] = [videoToMp3, audioConvert, audioCut, videoConvert, videoToGif];
