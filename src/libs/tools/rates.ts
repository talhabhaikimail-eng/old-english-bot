/**
 * @file tools/rates.ts
 * @description Currency exchange rates for the Currency Converter tool.
 *   GET /api/tools/rates?base=USD → { base, rates, updatedAt, source, cached, stale, names }
 * Rates come from open.er-api.com (≈160 currencies, daily) with frankfurter.app (ECB, ~30
 * currencies) as a fallback. Results are cached in memory per base for 6 hours; when both
 * upstreams fail a stale cached copy is served if one exists.
 */

import { HttpError, sendJson, type ToolRoute } from './http';
import type { ConverterSpec } from './jobs';

const TTL_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 10_000;
/** Keep stale entries around for a while so an upstream outage doesn't break the tool. */
const STALE_MAX_MS = 7 * 24 * 60 * 60 * 1000;

export interface RatesPayload {
  base: string;
  rates: Record<string, number>;
  /** ISO time the provider last updated the rates. */
  updatedAt: string;
  source: string;
}

interface CacheEntry { data: RatesPayload; fetchedAt: number }

const cache = new Map<string, CacheEntry>();
/** De-duplicates concurrent fetches for the same base. */
const inflight = new Map<string, Promise<RatesPayload>>();

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { Accept: 'application/json', 'User-Agent': 'devtools-rates/1.0' },
  });
  if (!res.ok) throw new Error(`${new URL(url).host} responded HTTP ${res.status}`);
  return res.json();
}

function cleanRates(raw: unknown, base: string): Record<string, number> {
  const out: Record<string, number> = {};
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (/^[A-Z]{3}$/.test(k) && typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v;
    }
  }
  out[base] = 1;
  return out;
}

async function fromOpenEr(base: string): Promise<RatesPayload> {
  const j = await fetchJson(`https://open.er-api.com/v6/latest/${base}`);
  if (j?.result !== 'success') throw new Error(`open.er-api: ${j?.['error-type'] || 'unexpected response'}`);
  const rates = cleanRates(j.rates, base);
  if (Object.keys(rates).length < 2) throw new Error('open.er-api: no rates');
  const t = typeof j.time_last_update_unix === 'number' ? new Date(j.time_last_update_unix * 1000) : new Date();
  return { base, rates, updatedAt: t.toISOString(), source: 'open.er-api.com' };
}

async function fromFrankfurter(base: string): Promise<RatesPayload> {
  const j = await fetchJson(`https://api.frankfurter.app/latest?from=${base}`);
  const rates = cleanRates(j?.rates, base);
  if (Object.keys(rates).length < 2) throw new Error('frankfurter: no rates');
  const t = typeof j.date === 'string' ? new Date(`${j.date}T16:00:00Z`) : new Date(); // ECB publishes ~16:00 CET
  return { base, rates, updatedAt: t.toISOString(), source: 'frankfurter.app (ECB)' };
}

async function fetchRates(base: string): Promise<RatesPayload> {
  const errors: string[] = [];
  for (const provider of [fromOpenEr, fromFrankfurter]) {
    try {
      return await provider(base);
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  throw new Error(errors.join('; '));
}

let displayNames: Intl.DisplayNames | null = null;
function currencyNames(codes: string[]): Record<string, string> {
  try {
    displayNames ??= new Intl.DisplayNames(['en'], { type: 'currency' });
    const out: Record<string, string> = {};
    for (const c of codes) {
      const n = displayNames.of(c);
      if (n && n !== c) out[c] = n;
    }
    return out;
  } catch {
    return {};
  }
}

/** Exported for tests / other modules. */
export async function getRates(base: string): Promise<RatesPayload & { cached: boolean; stale: boolean }> {
  const hit = cache.get(base);
  if (hit && Date.now() - hit.fetchedAt < TTL_MS) return { ...hit.data, cached: true, stale: false };

  let p = inflight.get(base);
  if (!p) {
    p = fetchRates(base).finally(() => inflight.delete(base));
    inflight.set(base, p);
  }
  try {
    const data = await p;
    cache.set(base, { data, fetchedAt: Date.now() });
    return { ...data, cached: false, stale: false };
  } catch (e) {
    if (hit && Date.now() - hit.fetchedAt < STALE_MAX_MS) return { ...hit.data, cached: true, stale: true };
    throw new HttpError(502, `Could not fetch exchange rates: ${(e as Error).message}`);
  }
}

export const routes: ToolRoute[] = [
  {
    method: 'GET',
    path: '/api/tools/rates',
    handler: async ({ res, query }) => {
      const base = (query.get('base') || 'USD').trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(base)) throw new HttpError(400, 'base must be a 3-letter ISO 4217 currency code');
      const data = await getRates(base);
      sendJson(res, { ...data, names: currencyNames(Object.keys(data.rates)) });
    },
  },
];

export const converters: ConverterSpec[] = [];
