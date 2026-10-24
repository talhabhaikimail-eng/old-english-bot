/**
 * @file tools/http.ts
 * @description Request/response helpers shared by every /api/tools/* module.
 */

import type { IncomingMessage, ServerResponse } from 'http';

export interface ToolCtx {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  pathname: string;
  query: URLSearchParams;
  /** Values captured from `:name` segments in the route path. */
  params: Record<string, string>;
}

export interface ToolRoute {
  method: 'GET' | 'POST' | 'DELETE';
  /** Full path, e.g. `/api/tools/net/dns` or `/api/tools/jobs/:id`. */
  path: string;
  handler: (ctx: ToolCtx) => Promise<void> | void;
}

export interface UploadedFile {
  field: string;
  filename: string;
  mimeType: string;
  buffer: Buffer;
}

/** Thrown from handlers to produce a JSON error with a specific status. */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const MAX_JSON_BYTES = 10 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = Number(process.env.TOOLS_MAX_UPLOAD_MB || 500) * 1024 * 1024;

export function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

export function sendError(res: ServerResponse, message: string, status = 400): void {
  sendJson(res, { error: message }, status);
}

export function sendFile(res: ServerResponse, buffer: Buffer, mimeType: string, filename: string): void {
  res.writeHead(200, {
    'Content-Type': mimeType,
    'Content-Length': buffer.length,
    'Content-Disposition': `attachment; filename="${filename.replace(/["\\\r\n]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Cache-Control': 'no-store',
  });
  res.end(buffer);
}

export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, `Request body exceeds ${Math.round(limit / 1024 / 1024)} MB`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJson<T = Record<string, any>>(req: IncomingMessage, limit = MAX_JSON_BYTES): Promise<T> {
  const buf = await readBody(req, limit);
  if (!buf.length) return {} as T;
  try {
    return JSON.parse(buf.toString('utf-8')) as T;
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON');
  }
}

/**
 * multipart/form-data parser that keeps every file (several files may share a field name).
 */
export async function readMultipart(req: IncomingMessage, limit = MAX_UPLOAD_BYTES): Promise<{
  fields: Record<string, string>;
  files: UploadedFile[];
}> {
  const contentType = req.headers['content-type'] || '';
  const m = /boundary=(?:"([^"]+)"|([^\s;]+))/i.exec(contentType);
  if (!m) throw new HttpError(400, 'Expected multipart/form-data');
  const boundary = Buffer.from('--' + (m[1] || m[2]));
  const body = await readBody(req, limit);

  const fields: Record<string, string> = {};
  const files: UploadedFile[] = [];
  const delimiter = Buffer.concat([Buffer.from('\r\n'), boundary]);

  let pos = body.indexOf(boundary);
  if (pos < 0) return { fields, files };
  pos += boundary.length;

  while (pos < body.length) {
    // "--" right after a boundary marks the end of the body.
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break;
    pos += 2; // CRLF after boundary
    const next = body.indexOf(delimiter, pos);
    if (next < 0) break;
    const part = body.subarray(pos, next);
    pos = next + delimiter.length;

    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;
    const headers = part.subarray(0, headerEnd).toString('utf-8');
    const content = part.subarray(headerEnd + 4);
    const name = /name="([^"]*)"/i.exec(headers)?.[1];
    if (!name) continue;
    const filename = /filename\*?="([^"]*)"/i.exec(headers)?.[1];
    if (filename !== undefined) {
      if (!filename && content.length === 0) continue; // empty <input type=file>
      files.push({
        field: name,
        filename: filename || 'upload',
        mimeType: /Content-Type:\s*([^\r\n]+)/i.exec(headers)?.[1].trim() || 'application/octet-stream',
        buffer: Buffer.from(content),
      });
    } else {
      fields[name] = content.toString('utf-8');
    }
  }
  return { fields, files };
}

/** Compile `/api/tools/jobs/:id` into a matcher. */
export function compilePath(path: string): (pathname: string) => Record<string, string> | null {
  const keys: string[] = [];
  const re = new RegExp(
    '^' + path.replace(/\/:([A-Za-z_]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$',
  );
  return pathname => {
    const m = re.exec(pathname);
    if (!m) return null;
    return Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
  };
}

export function str(v: unknown, name: string, { required = true, max = 100_000 } = {}): string {
  if (v === undefined || v === null || v === '') {
    if (required) throw new HttpError(400, `Missing "${name}"`);
    return '';
  }
  const s = String(v);
  if (s.length > max) throw new HttpError(400, `"${name}" is too long`);
  return s;
}
