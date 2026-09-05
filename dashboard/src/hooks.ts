import { useState, useEffect, useCallback } from 'react';
import { api, UrlsPayload } from './api';

export function useUrls(enabled = true, intervalMs = 15000) {
  const [data, setData] = useState<UrlsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try { setData(await api.getUrls()); setError(null); }
    catch (e) { setError((e as Error).message); }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    refresh();
    const id = setInterval(refresh, intervalMs);
    return () => clearInterval(id);
  }, [refresh, enabled, intervalMs]);

  return { data, error, refresh };
}

export function useCountdown(remainingSeconds: number) {
  const [rem, setRem] = useState(remainingSeconds);
  useEffect(() => { setRem(remainingSeconds); }, [remainingSeconds]);
  useEffect(() => {
    const id = setInterval(() => setRem(r => Math.max(0, r - 1)), 1000);
    return () => clearInterval(id);
  }, []);
  const h = Math.floor(rem / 3600);
  const m = Math.floor((rem % 3600) / 60);
  const s = rem % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return { rem, display: `${pad(h)}:${pad(m)}:${pad(s)}`, pct: (rem / (5 * 3600)) * 100, urgent: rem < 1800 };
}

export type NavSection = 'sessions' | 'manager' | 'courses' | 'android' | 'ai-tools' | 'media' | 'youtube' | 'movies' | 'urls' | 'llm' | 'search' | 'tts' | 'places' | 'google' | 'web-proxy' | 'pool' | 'go-containers' | 'indeed' | 'contacts' | 'blog-gen' | 'code-exec' | 'proxy-net';

