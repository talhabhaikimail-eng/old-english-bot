/**
 * @file llm-manager.ts
 * @description Node.js proxy / helper for the Python LLM inference server
 *              running on port 8001. All heavy lifting (download, load,
 *              inference) lives in src/scripts/llm_server.py.
 */

const LLM_API = 'http://127.0.0.1:8001';

async function llmFetch<T>(
  path: string,
  method: 'GET' | 'POST' | 'DELETE' = 'GET',
  body?: unknown
): Promise<T> {
  const opts: RequestInit = { method };
  if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(`${LLM_API}${path}`, opts);
  if (!resp.ok) {
    let msg = `LLM server HTTP ${resp.status}`;
    try { const j = await resp.json() as { detail?: string }; msg = j.detail ?? msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return resp.json() as Promise<T>;
}

// ── Exported model types (mirror Python schemas) ───────────────────────────────

export interface LLMModelInfo {
  id: string;
  label: string;
  description: string;
  size_gb: number;
  tags: string[];
  ctx: number;
  downloaded: boolean;
  loaded: boolean;
  download_status: string;
  download_error?: string;
}

export interface LLMModelsResponse {
  models: LLMModelInfo[];
  current_model: string | null;
  models_dir: string;
}

export interface LLMStatusResponse {
  loaded: boolean;
  model_id: string | null;
  label: string | null;
  ctx: number | null;
}

export interface LLMChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMChatRequest {
  messages: LLMChatMessage[];
  max_tokens?: number;
  temperature?: number;
}

export interface LLMChatResponse {
  content: string;
  model_id: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

// ── API wrappers ───────────────────────────────────────────────────────────────

export async function llmListModels(): Promise<LLMModelsResponse> {
  return llmFetch<LLMModelsResponse>('/llm/models');
}

export async function llmDownloadModel(model_id: string): Promise<{ message: string; status: string }> {
  return llmFetch('/llm/download', 'POST', { model_id });
}

export async function llmDownloadStatus(model_id: string): Promise<{ status: string; downloaded: boolean; error?: string }> {
  return llmFetch(`/llm/download/status/${model_id}`);
}

export async function llmLoadModel(model_id: string, n_ctx?: number): Promise<{ loaded: boolean; model_id: string; label: string }> {
  return llmFetch('/llm/load', 'POST', { model_id, n_ctx: n_ctx ?? null });
}

export async function llmUnloadModel(): Promise<{ unloaded: boolean; was: string | null }> {
  return llmFetch('/llm/unload', 'POST');
}

export async function llmStatus(): Promise<LLMStatusResponse> {
  return llmFetch<LLMStatusResponse>('/llm/status');
}

export async function llmChat(req: LLMChatRequest): Promise<LLMChatResponse> {
  return llmFetch<LLMChatResponse>('/llm/chat', 'POST', req);
}

export async function llmDeleteModel(model_id: string): Promise<{ deleted: boolean }> {
  return llmFetch<{ deleted: boolean }>(`/llm/models/${model_id}`, 'DELETE');
}

export async function isLLMServerRunning(): Promise<boolean> {
  try {
    const r = await fetch(`${LLM_API}/health`);
    return r.ok;
  } catch {
    return false;
  }
}
