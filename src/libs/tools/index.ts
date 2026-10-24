/**
 * @file tools/index.ts
 * @description Router for /api/tools/* — the backend half of the dashboard's Dev Tools panel.
 * Each area module exports `routes` (plain request/response endpoints) and `converters`
 * (file jobs run through the queue in jobs.ts). Authentication happens in dashboard-server
 * before requests reach here.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { compilePath, HttpError, sendError, type ToolCtx, type ToolRoute } from './http';
import { jobRoutes, registerConverters } from './jobs';
import type { ConverterSpec } from './jobs';

/**
 * Area modules are loaded independently so one broken module (e.g. a missing optional
 * dependency) only disables its own tools. TOOLS_ONLY=image,docs limits loading (dev/tests).
 */
const MODULE_NAMES = ['rates', 'image', 'text', 'dev', 'net', 'seo', 'crypto', 'docs'] as const;
const only = (process.env.TOOLS_ONLY || '').split(',').map(s => s.trim()).filter(Boolean);

const MODULES: { routes: ToolRoute[]; converters: ConverterSpec[] }[] = [];
for (const name of MODULE_NAMES) {
  if (only.length && !only.includes(name)) continue;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    MODULES.push(require(`./${name}`));
  } catch (e) {
    console.error(`[tools] failed to load module "${name}":`, (e as Error).message);
  }
}

registerConverters(MODULES.flatMap(m => m.converters));

const ROUTES: (ToolRoute & { match: ReturnType<typeof compilePath> })[] = [
  ...jobRoutes,
  ...MODULES.flatMap(m => m.routes),
].map(r => ({ ...r, match: compilePath(r.path) }));

/** Returns false when the path isn't a tools route so the caller can keep dispatching. */
export async function handleToolsRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url || '/', 'http://localhost');
  if (!url.pathname.startsWith('/api/tools/')) return false;
  const method = (req.method || 'GET').toUpperCase();

  let pathMatched = false;
  for (const route of ROUTES) {
    const params = route.match(url.pathname);
    if (!params) continue;
    pathMatched = true;
    if (route.method !== method) continue;
    const ctx: ToolCtx = { req, res, method, pathname: url.pathname, query: url.searchParams, params };
    try {
      await route.handler(ctx);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(`[tools] ${method} ${url.pathname}:`, e);
      if (!res.headersSent) sendError(res, (e as Error).message || 'Internal error', status);
      else res.end();
    }
    return true;
  }
  sendError(res, pathMatched ? 'Method not allowed' : 'Unknown tools endpoint', pathMatched ? 405 : 404);
  return true;
}
