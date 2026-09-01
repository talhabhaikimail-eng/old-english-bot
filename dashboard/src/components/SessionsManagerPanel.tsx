import React, { useState, useEffect } from 'react';
import { BASE, authFetch } from '../api';
import { CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Copy,
  ExternalLink,
  Search,
  Globe,
  Terminal,
  Smartphone,
  Edit3,
  Trash2,
  Check,
  X,
  Zap,
  Play,
  Layers,
  Container,
  Cpu,
  Clock,
  ShieldCheck,
  RefreshCw
} from 'lucide-react';

interface Session {
  id: string;
  type: string;
  url: string;
  username?: string;
  password?: string;
  startedAt: string;
  metadata?: {
    targetUrl?: string;
    port?: number;
    hostPort?: number;
    containerName?: string;
    cloudflaredUrl?: string;
    webhookSecret?: string;
    image?: string;
    env?: Record<string, string>;
    domainMode?: 'quick' | 'custom';
    customDomain?: string;
    tunnelToken?: string;
  };
}

type TabType = 'all' | 'docker' | 'browser' | 'terminal' | 'vscode' | 'android';
type SearchMode = 'all' | 'name' | 'url';

function parseUrlParts(urlStr: string) {
  if (!urlStr) return { fullUrl: '', protocol: '', hostname: '', port: '', pathAndQuery: '', isValid: false };
  try {
    const hasProtocol = urlStr.includes('://');
    const fullUrl = hasProtocol ? urlStr : `https://${urlStr}`;
    const parsed = new URL(fullUrl);

    const protocol = hasProtocol ? parsed.protocol + '//' : '';
    const hostname = parsed.hostname;
    const port = parsed.port ? `:${parsed.port}` : '';
    const pathAndQuery = (parsed.pathname !== '/' ? parsed.pathname : '') + parsed.search + parsed.hash;

    return {
      fullUrl,
      protocol,
      hostname,
      port,
      pathAndQuery,
      isValid: true
    };
  } catch {
    return {
      fullUrl: urlStr,
      protocol: '',
      hostname: urlStr,
      port: '',
      pathAndQuery: '',
      isValid: false
    };
  }
}

function ReadableUrlLink({ url, onCopy }: { url: string; onCopy?: (text: string) => void }) {
  const [copied, setCopied] = useState(false);
  const parsed = parseUrlParts(url);

  if (!url) return null;

  const handleOpenLink = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    window.open(parsed.fullUrl, '_blank', 'noopener,noreferrer');
  };

  const handleCopy = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    navigator.clipboard.writeText(parsed.fullUrl);
    if (onCopy) onCopy(parsed.fullUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex flex-wrap sm:flex-nowrap items-center gap-2 my-2 w-full">
      <div
        onClick={handleOpenLink}
        title={`Open in new tab: ${parsed.fullUrl}`}
        className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-slate-100 dark:bg-slate-900/90 border border-slate-200 dark:border-slate-800 hover:border-sky-500/60 transition-all cursor-pointer group flex-1 min-w-0 shadow-xs"
      >
        <Globe className="w-4 h-4 text-sky-500 dark:text-sky-400 shrink-0" />
        <div className="font-mono text-xs truncate flex-1 min-w-0 flex items-center">
          {parsed.protocol && (
            <span className="text-slate-400 dark:text-slate-500 select-none mr-0.5">{parsed.protocol}</span>
          )}
          <span className="text-slate-900 dark:text-sky-300 font-semibold tracking-wide hover:underline">
            {parsed.hostname}
          </span>
          {parsed.port && (
            <span className="text-violet-600 dark:text-violet-400 font-semibold ml-0.5">{parsed.port}</span>
          )}
          {parsed.pathAndQuery && (
            <span className="text-slate-500 dark:text-slate-400">{parsed.pathAndQuery}</span>
          )}
        </div>
        <ExternalLink className="w-3.5 h-3.5 text-slate-400 group-hover:text-sky-500 transition-colors shrink-0 ml-1" />
      </div>

      <button
        onClick={handleCopy}
        type="button"
        className={`px-3 py-2 rounded-lg text-xs font-medium font-mono flex items-center gap-1.5 transition-all shrink-0 border ${
          copied
            ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30 font-semibold'
            : 'bg-white hover:bg-slate-100 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-700 shadow-xs'
        }`}
      >
        {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
        <span>{copied ? 'Copied' : 'Copy'}</span>
      </button>
    </div>
  );
}

export default function SessionsManagerPanel() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [browsers, setBrowsers] = useState<any[]>([]);
  const [android, setAndroid] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState('');

  const [activeTab, setActiveTab] = useState<TabType>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMode, setSearchMode] = useState<SearchMode>('all');

  const [customUrl, setCustomUrl] = useState('');

  const [dockerImage, setDockerImage] = useState('');
  const [dockerPort, setDockerPort] = useState('80');
  const [dockerName, setDockerName] = useState('');
  const [dockerEnv, setDockerEnv] = useState('');
  const [domainMode, setDomainMode] = useState<'quick' | 'custom'>('quick');
  const [customDomain, setCustomDomain] = useState('');
  const [hostPort, setHostPort] = useState('15000');
  const [tunnelToken, setTunnelToken] = useState('');

  const [editingSession, setEditingSession] = useState<Session | null>(null);
  const [editImage, setEditImage] = useState('');
  const [editPort, setEditPort] = useState('80');
  const [editHostPort, setEditHostPort] = useState('15000');
  const [editName, setEditName] = useState('');
  const [editDomainMode, setEditDomainMode] = useState<'quick' | 'custom'>('quick');
  const [editCustomDomain, setEditCustomDomain] = useState('');
  const [editTunnelToken, setEditTunnelToken] = useState('');
  const [editEnv, setEditEnv] = useState('');

  const loadSessions = async () => {
    try {
      const res = await authFetch(`${BASE}/api/sessions/all`);
      const data = await res.json();
      setSessions(data.sessions || []);
      setBrowsers(data.browsers || []);
      setAndroid(data.android);
    } catch (err) {
      console.error('Failed to load sessions:', err);
    }
  };

  useEffect(() => {
    loadSessions();
    const interval = setInterval(loadSessions, 5000);
    return () => clearInterval(interval);
  }, []);

  const startEditing = (session: Session) => {
    setEditingSession(session);
    setEditImage(session.metadata?.image || '');
    setEditPort(session.metadata?.port?.toString() || '80');
    setEditHostPort(session.metadata?.hostPort?.toString() || '15000');

    let nameVal = '';
    if (session.metadata?.containerName) {
      const parts = session.metadata.containerName.split('-');
      if (parts.length >= 4) {
        nameVal = parts.slice(2, parts.length - 1).join('-');
      }
    }
    setEditName(nameVal);

    setEditDomainMode(session.metadata?.domainMode || 'quick');
    setEditCustomDomain(session.metadata?.customDomain || '');
    setEditTunnelToken(session.metadata?.tunnelToken || '');

    const envObj = session.metadata?.env || {};
    const envStr = Object.entries(envObj)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    setEditEnv(envStr);
  };

  const saveEditedContainer = async () => {
    if (!editingSession) return;
    if (!editImage) return setResult('[ERROR] Please enter a Docker Image URI');

    const portNum = parseInt(editPort, 10);
    if (isNaN(portNum) || portNum <= 0) return setResult('[ERROR] Invalid container port');

    const hostPortNum = parseInt(editHostPort, 10);
    if (isNaN(hostPortNum) || hostPortNum <= 0) return setResult('[ERROR] Invalid host port');

    setLoading(true);
    setResult('');
    try {
      const envObj: Record<string, string> = {};
      editEnv.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx !== -1) {
          envObj[trimmed.substring(0, eqIdx).trim()] = trimmed.substring(eqIdx + 1).trim();
        }
      });

      const res = await authFetch(`${BASE}/api/sessions/docker/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: editingSession.id,
          image: editImage,
          port: portNum,
          env: envObj,
          name: editName || undefined,
          domainMode: editDomainMode,
          customDomain: editDomainMode === 'custom' ? editCustomDomain : undefined,
          hostPort: hostPortNum,
          tunnelToken: editDomainMode === 'custom' ? (editTunnelToken || undefined) : undefined,
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      setResult(`[SUCCESS] Redeployed container!\nURL: ${data.url}\nContainer: ${data.containerName}`);
      setEditingSession(null);
      await loadSessions();
    } catch (err: any) {
      setResult(`[ERROR] ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const stopSession = async (sessionId: string, type: string) => {
    setLoading(true);
    try {
      const res = await authFetch(`${BASE}/api/sessions/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, type }),
      });
      const data = await res.json();
      setResult(data.success ? `[SUCCESS] ${data.message}` : `[ERROR] ${data.message}`);
      await loadSessions();
    } catch (err: any) {
      setResult(`[ERROR] ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const startCustomBrowser = async () => {
    if (!customUrl) return setResult('[ERROR] Please enter a URL');
    setLoading(true);
    setResult('');
    try {
      const res = await authFetch(`${BASE}/api/browser/custom`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: customUrl }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      setResult(`[SUCCESS] Browser started!\nURL: ${data.url}\nUser: ${data.username} | Pass: ${data.password}`);
      setCustomUrl('');
      await loadSessions();
    } catch (err: any) {
      setResult(`[ERROR] ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const deployCustomContainer = async () => {
    if (!dockerImage) return setResult('[ERROR] Please enter a Docker Image URI');
    const portNum = parseInt(dockerPort, 10);
    if (isNaN(portNum) || portNum <= 0) return setResult('[ERROR] Invalid container port');
    const hostPortNum = parseInt(hostPort, 10);
    if (isNaN(hostPortNum) || hostPortNum <= 0) return setResult('[ERROR] Invalid host port');

    setLoading(true);
    setResult('');
    try {
      const envObj: Record<string, string> = {};
      dockerEnv.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx !== -1) {
          envObj[trimmed.substring(0, eqIdx).trim()] = trimmed.substring(eqIdx + 1).trim();
        }
      });

      const res = await authFetch(`${BASE}/api/sessions/docker`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: dockerImage,
          port: portNum,
          env: envObj,
          name: dockerName || undefined,
          domainMode,
          customDomain: domainMode === 'custom' ? customDomain : undefined,
          hostPort: hostPortNum,
          tunnelToken: domainMode === 'custom' ? (tunnelToken || undefined) : undefined,
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      setResult(`[SUCCESS] Container started!\nURL: ${data.url}\nContainer: ${data.containerName}`);
      setDockerImage(''); setDockerName(''); setDockerEnv(''); setCustomDomain(''); setTunnelToken('');
      await loadSessions();
    } catch (err: any) {
      setResult(`[ERROR] ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setResult(`[COPIED] ${text}`);
    setTimeout(() => setResult(''), 3000);
  };

  const totalSessions = sessions.length + browsers.length + (android ? 1 : 0);
  const dockerSessions = sessions.filter(s => s.type === 'docker-container');
  const customBrowserSessions = sessions.filter(s => s.type === 'custom-browser');
  const terminalSessions = sessions.filter(s => s.type === 'terminal');
  const vscodeSessions = sessions.filter(s => s.type === 'vscode');

  // Search filtering logic
  const matchesSearch = (nameStr: string, urlStr: string, extraStr?: string) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase().trim();
    const nameLower = `${nameStr} ${extraStr || ''}`.toLowerCase();
    const urlLower = urlStr.toLowerCase();

    if (searchMode === 'name') {
      return nameLower.includes(q);
    } else if (searchMode === 'url') {
      return urlLower.includes(q);
    } else {
      return nameLower.includes(q) || urlLower.includes(q);
    }
  };

  return (
    <div className="space-y-6 mx-auto text-sm p-4 sm:p-6 bg-slate-50/50 dark:bg-slate-950 min-h-screen text-slate-800 dark:text-slate-100">
      {/* Header Banner */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 sm:p-6 shadow-xs">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-sky-50 dark:bg-sky-950/60 border border-sky-200 dark:border-sky-800 flex items-center justify-center text-2xl shrink-0 text-sky-600 dark:text-sky-400">
              <ShieldCheck className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center gap-2.5">
                <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
                  Active Workloads Preserved
                </h1>
                <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  Cloudflare Protected
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                {sessions.length} workload(s) running with Cloudflare secure zero-trust tunnels.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => loadSessions()}
              title="Refresh workload sessions"
              className="p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
            <div className="bg-slate-50 dark:bg-slate-800/80 px-4 py-2 rounded-xl border border-slate-200 dark:border-slate-700 text-center min-w-[130px]">
              <span className="text-[10px] font-semibold uppercase tracking-wider block text-slate-500 dark:text-slate-400">
                Total Active
              </span>
              <span className="text-2xl font-bold text-slate-900 dark:text-white">{totalSessions}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Result Status Banner */}
      {result && (
        <div className={`rounded-xl border p-4 flex items-start justify-between gap-3 shadow-xs ${
          result.includes('[ERROR]')
            ? 'bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-800 text-rose-900 dark:text-rose-200'
            : 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-900 dark:text-emerald-200'
        }`}>
          <pre className="text-xs font-mono whitespace-pre-wrap flex-1 m-0">{result}</pre>
          <button
            onClick={() => setResult('')}
            className="p-1 rounded-md hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Responsive Main Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">

        {/* LEFT COLUMN: Controls & Launchers */}
        <div className="lg:col-span-4 space-y-6">

          {/* Workload Counter Stats Grid */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4 shadow-xs">
            <div className="flex justify-between items-center border-b border-slate-100 dark:border-slate-800 pb-3">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300 flex items-center gap-2">
                <Layers className="w-4 h-4 text-sky-500" /> Workload Breakdown
              </span>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /> LIVE
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 rounded-lg bg-emerald-50/50 dark:bg-emerald-950/20 border border-emerald-200/60 dark:border-emerald-900/40">
                <div className="text-2xl font-bold text-emerald-700 dark:text-emerald-400">{dockerSessions.length}</div>
                <div className="text-[11px] font-medium text-emerald-800/80 dark:text-emerald-300 flex items-center gap-1.5 mt-0.5">
                  <Container className="w-3.5 h-3.5" /> Docker
                </div>
              </div>

              <div className="p-3 rounded-lg bg-pink-50/50 dark:bg-pink-950/20 border border-pink-200/60 dark:border-pink-900/40">
                <div className="text-2xl font-bold text-pink-700 dark:text-pink-400">{customBrowserSessions.length + browsers.length}</div>
                <div className="text-[11px] font-medium text-pink-800/80 dark:text-pink-300 flex items-center gap-1.5 mt-0.5">
                  <Globe className="w-3.5 h-3.5" /> Browsers
                </div>
              </div>

              <div className="p-3 rounded-lg bg-sky-50/50 dark:bg-sky-950/20 border border-sky-200/60 dark:border-sky-900/40">
                <div className="text-2xl font-bold text-sky-700 dark:text-sky-400">{terminalSessions.length}</div>
                <div className="text-[11px] font-medium text-sky-800/80 dark:text-sky-300 flex items-center gap-1.5 mt-0.5">
                  <Terminal className="w-3.5 h-3.5" /> Terminals
                </div>
              </div>

              <div className="p-3 rounded-lg bg-violet-50/50 dark:bg-violet-950/20 border border-violet-200/60 dark:border-violet-900/40">
                <div className="text-2xl font-bold text-violet-700 dark:text-violet-400">{vscodeSessions.length}</div>
                <div className="text-[11px] font-medium text-violet-800/80 dark:text-violet-300 flex items-center gap-1.5 mt-0.5">
                  <Cpu className="w-3.5 h-3.5" /> VS Code
                </div>
              </div>
            </div>
          </div>

          {/* Quick Launch Browser Card */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3.5 shadow-xs">
            <div className="flex items-center gap-2 text-slate-800 dark:text-slate-200">
              <Globe className="w-4 h-4 text-sky-500" />
              <CardTitle className="text-xs uppercase font-bold tracking-wider">
                Quick Web Browser
              </CardTitle>
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <Input
                type="url"
                value={customUrl}
                onChange={(e) => setCustomUrl(e.target.value)}
                placeholder="https://example.com"
                className="flex-1 text-xs font-mono rounded-lg border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950"
              />
              <button
                onClick={startCustomBrowser}
                disabled={loading}
                className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-medium text-xs flex items-center justify-center gap-1.5 transition-colors shrink-0 shadow-xs disabled:opacity-50"
              >
                <Play className="w-3.5 h-3.5" /> Launch
              </button>
            </div>
          </div>

          {/* Deploy Container Card */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4 shadow-xs">
            <div className="flex items-center gap-2 border-b border-slate-100 dark:border-slate-800 pb-3 text-slate-800 dark:text-slate-200">
              <Container className="w-4 h-4 text-emerald-500" />
              <CardTitle className="text-xs uppercase font-bold tracking-wider">
                Deploy Container Instance
              </CardTitle>
            </div>

            <div className="space-y-3.5 text-xs">
              <div>
                <label className="text-[11px] font-medium text-slate-600 dark:text-slate-400 block mb-1">
                  Image URI
                </label>
                <Input
                  type="text"
                  value={dockerImage}
                  onChange={(e) => setDockerImage(e.target.value)}
                  placeholder="nginx:latest"
                  className="w-full text-xs font-mono rounded-lg border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950"
                />
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="text-[11px] font-medium text-slate-600 dark:text-slate-400 block mb-1">
                    Container Port
                  </label>
                  <Input
                    type="number"
                    value={dockerPort}
                    onChange={(e) => setDockerPort(e.target.value)}
                    className="w-full text-xs font-mono rounded-lg border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="text-[11px] font-medium text-slate-600 dark:text-slate-400 block mb-1">
                    Host Port
                  </label>
                  <Input
                    type="number"
                    value={hostPort}
                    onChange={(e) => setHostPort(e.target.value)}
                    className="w-full text-xs font-mono rounded-lg border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950"
                  />
                </div>
              </div>

              <div>
                <label className="text-[11px] font-medium text-slate-600 dark:text-slate-400 block mb-1">
                  Network Mode
                </label>
                <select
                  value={domainMode}
                  onChange={(e) => setDomainMode(e.target.value as 'quick' | 'custom')}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-xs font-mono text-slate-900 dark:text-slate-100 outline-none focus:ring-1 focus:ring-sky-500"
                >
                  <option value="quick">Quick Tunnel (trycloudflare)</option>
                  <option value="custom">Custom Subdomain</option>
                </select>
              </div>

              {domainMode === 'custom' && (
                <div>
                  <label className="text-[11px] font-medium text-slate-600 dark:text-slate-400 block mb-1">
                    Custom Subdomain
                  </label>
                  <Input
                    type="text"
                    value={customDomain}
                    onChange={(e) => setCustomDomain(e.target.value)}
                    placeholder="whoami.yourdomain.com"
                    className="w-full text-xs font-mono rounded-lg border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950"
                  />
                </div>
              )}

              <div>
                <label className="text-[11px] font-medium text-slate-600 dark:text-slate-400 block mb-1">
                  Environment Variables
                </label>
                <textarea
                  value={dockerEnv}
                  onChange={(e) => setDockerEnv(e.target.value)}
                  rows={2}
                  placeholder={"KEY=VALUE\nOTHER_KEY=123"}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-2.5 font-mono text-xs text-slate-900 dark:text-slate-100 outline-none resize-y focus:ring-1 focus:ring-sky-500"
                />
              </div>

              <button
                onClick={deployCustomContainer}
                disabled={loading}
                className="w-full py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-xs flex items-center justify-center gap-1.5 transition-colors shadow-xs disabled:opacity-50"
              >
                <Zap className="w-4 h-4" /> {loading ? 'Deploying...' : 'Deploy Container'}
              </button>
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN: Search Controls, Tabs, Workload List */}
        <div className="lg:col-span-8 space-y-4">

          {/* Search & Filter Bar */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5 shadow-xs space-y-2.5">
            <div className="flex flex-col sm:flex-row gap-2.5 items-stretch sm:items-center">
              <div className="relative flex-1">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search workloads by URL, container name, or image..."
                  className="w-full pl-9 pr-8 py-2 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-xs font-mono text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-sky-500"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-500"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              {/* Filter mode options */}
              <div className="flex items-center gap-1 bg-slate-100 dark:bg-slate-800 p-1 rounded-lg border border-slate-200/80 dark:border-slate-700/80 shrink-0">
                <span className="text-[10px] font-semibold uppercase px-1.5 text-slate-500 dark:text-slate-400">Search:</span>
                {(['all', 'name', 'url'] as SearchMode[]).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => setSearchMode(mode)}
                    className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-all uppercase ${
                      searchMode === mode
                        ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs font-semibold'
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                    }`}
                  >
                    {mode === 'all' ? 'All' : mode === 'name' ? 'By Name' : 'By URL'}
                  </button>
                ))}
              </div>
            </div>

            {searchQuery && (
              <div className="text-xs text-slate-500 dark:text-slate-400 flex items-center justify-between px-1">
                <span>Filtering by {searchMode.toUpperCase()}: <span className="font-semibold text-sky-600 dark:text-sky-400">"{searchQuery}"</span></span>
                <button onClick={() => setSearchQuery('')} className="underline hover:text-slate-800 dark:hover:text-slate-200">
                  Clear search
                </button>
              </div>
            )}
          </div>

          {/* Filter Tabs */}
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {(['all', 'docker', 'browser', 'terminal', 'vscode', 'android'] as TabType[]).map((tab) => {
              const active = activeTab === tab;
              const count =
                tab === 'all' ? totalSessions :
                tab === 'docker' ? dockerSessions.length :
                tab === 'browser' ? customBrowserSessions.length + browsers.length :
                tab === 'terminal' ? terminalSessions.length :
                tab === 'vscode' ? vscodeSessions.length :
                tab === 'android' ? (android ? 1 : 0) : 0;

              return (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-3.5 py-2 rounded-lg text-xs font-medium uppercase tracking-wider transition-all flex items-center gap-2 shrink-0 border ${
                    active
                      ? 'bg-slate-900 text-white border-slate-900 dark:bg-sky-600 dark:border-sky-500 dark:text-white shadow-xs font-semibold'
                      : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 border-slate-200 dark:border-slate-800'
                  }`}
                >
                  <span>{tab === 'all' ? 'All Workloads' : tab}</span>
                  <span className={`px-1.5 py-0.2 rounded-full text-[10px] font-bold ${
                    active
                      ? 'bg-white/20 text-white'
                      : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400'
                  }`}>
                    {count}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Workloads Card List Container */}
          <div className="space-y-3.5">
            {(() => {
              const SessionCard = ({
                session,
                icon,
                typeLabel,
                badgeColor
              }: {
                session: Session;
                icon: React.ReactNode;
                typeLabel: string;
                badgeColor: string;
              }) => {
                const mainUrl = session.metadata?.cloudflaredUrl || session.url;
                const webhookUrl = session.metadata?.webhookSecret
                  ? `${window.location.origin}/api/webhook/docker/${session.id}?secret=${session.metadata.webhookSecret}`
                  : null;
                const containerName = session.metadata?.containerName || session.metadata?.targetUrl || `${session.type.toUpperCase()} SESSION`;

                // Check search match
                if (!matchesSearch(containerName, mainUrl, `${session.type} ${webhookUrl || ''}`)) {
                  return null;
                }

                return (
                  <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 sm:p-5 shadow-xs flex flex-col gap-3.5 hover:border-slate-300 dark:hover:border-slate-700 transition-all">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-3 flex-1 min-w-0">
                        <div className="w-10 h-10 rounded-xl bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex items-center justify-center shrink-0 text-slate-700 dark:text-slate-300">
                          {icon}
                        </div>

                        <div className="space-y-1 flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-slate-900 dark:text-white font-bold font-mono text-sm tracking-tight truncate">
                              {containerName}
                            </span>
                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider border ${badgeColor}`}>
                              {typeLabel}
                            </span>
                            <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400 font-medium">
                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> Active
                            </span>
                          </div>

                          {/* Clean, High-Readability URL Link Component */}
                          <ReadableUrlLink url={mainUrl} onCopy={() => setResult(`COPIED LINK: ${mainUrl}`)} />

                          {/* Time & Credentials info */}
                          <div className="flex flex-wrap items-center gap-2 text-xs font-mono pt-0.5 text-slate-500 dark:text-slate-400">
                            <div className="flex items-center gap-1 bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded border border-slate-200 dark:border-slate-700 text-[11px]">
                              <Clock className="w-3 h-3 text-slate-400" />
                              {new Date(session.startedAt).toLocaleTimeString()}
                            </div>
                            {session.username && (
                              <div className="bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded border border-slate-200 dark:border-slate-700 text-[11px]">
                                USER: <span className="font-semibold text-slate-800 dark:text-slate-200">{session.username}</span>
                              </div>
                            )}
                            {session.password && (
                              <div className="bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded border border-slate-200 dark:border-slate-700 text-[11px]">
                                PASS: <span className="font-semibold text-slate-800 dark:text-slate-200">{session.password}</span>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Action buttons */}
                      <div className="flex items-center gap-2 shrink-0 self-start">
                        {session.type === 'docker-container' && (
                          <button
                            onClick={() => startEditing(session)}
                            className="px-2.5 py-1.5 rounded-lg bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 font-medium text-xs border border-slate-200 dark:border-slate-700 transition-all flex items-center gap-1.5 shadow-xs"
                          >
                            <Edit3 className="w-3.5 h-3.5" /> Edit
                          </button>
                        )}
                        <button
                          onClick={() => stopSession(session.id, session.type)}
                          className="px-2.5 py-1.5 rounded-lg bg-rose-50 dark:bg-rose-950/40 hover:bg-rose-100 dark:hover:bg-rose-900/60 text-rose-700 dark:text-rose-300 font-medium text-xs border border-rose-200 dark:border-rose-800 transition-all flex items-center gap-1.5 shadow-xs"
                        >
                          <Trash2 className="w-3.5 h-3.5" /> Stop
                        </button>
                      </div>
                    </div>

                    {/* Webhook Section */}
                    {webhookUrl && (
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-2.5 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200/80 dark:border-slate-800/80 text-xs font-mono">
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          <span className="px-2 py-0.5 rounded text-[10px] font-semibold uppercase bg-pink-500/10 text-pink-600 dark:text-pink-400 border border-pink-500/20 shrink-0">
                            Webhook
                          </span>
                          <span
                            title={webhookUrl}
                            className="text-slate-600 dark:text-slate-400 text-xs truncate select-all"
                          >
                            {webhookUrl}
                          </span>
                        </div>
                        <button
                          onClick={() => copyToClipboard(webhookUrl)}
                          className="px-2.5 py-1 rounded-md text-xs font-mono font-medium text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600 transition-all shrink-0 flex items-center gap-1.5 self-start sm:self-auto shadow-xs"
                        >
                          <Copy className="w-3 h-3" />
                          <span>Copy Webhook</span>
                        </button>
                      </div>
                    )}
                  </div>
                );
              };

              const elements: JSX.Element[] = [];

              if ((activeTab === 'all' || activeTab === 'docker') && dockerSessions.length > 0) {
                dockerSessions.forEach(s => {
                  const card = (
                    <SessionCard
                      key={s.id}
                      session={s}
                      icon={<Container className="w-5 h-5 text-emerald-500" />}
                      typeLabel="Docker"
                      badgeColor="bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800"
                    />
                  );
                  if (card.props.session) {
                    const mainUrl = s.metadata?.cloudflaredUrl || s.url;
                    const name = s.metadata?.containerName || s.metadata?.targetUrl || `${s.type}`;
                    if (matchesSearch(name, mainUrl)) elements.push(card);
                  }
                });
              }

              if ((activeTab === 'all' || activeTab === 'browser') && customBrowserSessions.length > 0) {
                customBrowserSessions.forEach(s => {
                  const mainUrl = s.metadata?.cloudflaredUrl || s.url;
                  const name = s.metadata?.targetUrl || 'Custom Browser Session';
                  if (matchesSearch(name, mainUrl)) {
                    elements.push(
                      <SessionCard
                        key={s.id}
                        session={s}
                        icon={<Globe className="w-5 h-5 text-pink-500" />}
                        typeLabel="Browser"
                        badgeColor="bg-pink-50 dark:bg-pink-950/60 text-pink-700 dark:text-pink-300 border-pink-200 dark:border-pink-800"
                      />
                    );
                  }
                });
              }

              if ((activeTab === 'all' || activeTab === 'browser') && browsers.length > 0) {
                browsers.forEach((b, i) => {
                  if (matchesSearch('General Browser Pool', b.url || '')) {
                    elements.push(
                      <div key={`gb-${i}`} className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 sm:p-5 shadow-xs flex flex-col gap-3">
                        <div className="flex items-start gap-3 flex-1 min-w-0">
                          <div className="w-10 h-10 rounded-xl bg-pink-50 dark:bg-pink-950/60 border border-pink-200 dark:border-pink-800 flex items-center justify-center shrink-0 text-pink-500">
                            <Globe className="w-5 h-5" />
                          </div>
                          <div className="space-y-1 flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-slate-900 dark:text-white">General Browser Pool #{i + 1}</span>
                              <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase bg-pink-50 dark:bg-pink-950/60 text-pink-700 dark:text-pink-300 border border-pink-200 dark:border-pink-800">
                                Pool
                              </span>
                            </div>
                            <ReadableUrlLink url={b.url} onCopy={() => setResult(`COPIED: ${b.url}`)} />
                            <div className="text-slate-500 dark:text-slate-400 text-xs font-mono flex items-center gap-3 pt-1">
                              <span>USER: <span className="font-semibold text-slate-800 dark:text-slate-200">{b.username}</span></span>
                              <span>PASS: <span className="font-semibold text-slate-800 dark:text-slate-200">{b.password}</span></span>
                              <span>PORT: <span className="font-semibold text-slate-800 dark:text-slate-200">{b.port}</span></span>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  }
                });
              }

              if ((activeTab === 'all' || activeTab === 'terminal') && terminalSessions.length > 0) {
                terminalSessions.forEach(s => {
                  const mainUrl = s.metadata?.cloudflaredUrl || s.url;
                  const name = s.metadata?.containerName || 'Terminal Session';
                  if (matchesSearch(name, mainUrl)) {
                    elements.push(
                      <SessionCard
                        key={s.id}
                        session={s}
                        icon={<Terminal className="w-5 h-5 text-sky-500" />}
                        typeLabel="Terminal"
                        badgeColor="bg-sky-50 dark:bg-sky-950/60 text-sky-700 dark:text-sky-300 border-sky-200 dark:border-sky-800"
                      />
                    );
                  }
                });
              }

              if ((activeTab === 'all' || activeTab === 'vscode') && vscodeSessions.length > 0) {
                vscodeSessions.forEach(s => {
                  const mainUrl = s.metadata?.cloudflaredUrl || s.url;
                  const name = s.metadata?.containerName || 'VSCode Session';
                  if (matchesSearch(name, mainUrl)) {
                    elements.push(
                      <SessionCard
                        key={s.id}
                        session={s}
                        icon={<Cpu className="w-5 h-5 text-violet-500" />}
                        typeLabel="VSCode"
                        badgeColor="bg-violet-50 dark:bg-violet-950/60 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-800"
                      />
                    );
                  }
                });
              }

              if ((activeTab === 'all' || activeTab === 'android') && android) {
                if (matchesSearch(android.deviceInfo || 'Android Emulator', android.webUrl || '')) {
                  elements.push(
                    <div key="android" className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 sm:p-5 shadow-xs flex items-start gap-3">
                      <div className="w-10 h-10 rounded-xl bg-amber-50 dark:bg-amber-950/60 border border-amber-200 dark:border-amber-800 flex items-center justify-center shrink-0 text-amber-500">
                        <Smartphone className="w-5 h-5" />
                      </div>
                      <div className="space-y-1 flex-1">
                        <div className="font-bold text-slate-900 dark:text-white">{android.deviceInfo || 'Android Emulator'}</div>
                        {android.webUrl && <ReadableUrlLink url={android.webUrl} onCopy={() => setResult(`COPIED: ${android.webUrl}`)} />}
                        <div className="text-slate-500 dark:text-slate-400 text-xs font-mono">Uptime: {android.uptime || 'Unknown'}</div>
                      </div>
                    </div>
                  );
                }
              }

              if (elements.length === 0) {
                return (
                  <div className="flex flex-col items-center justify-center py-16 px-4 text-center rounded-xl border border-dashed border-slate-200 dark:border-slate-800 bg-white/50 dark:bg-slate-900/50">
                    <div className="w-12 h-12 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-400 mb-3">
                      <Search className="w-5 h-5" />
                    </div>
                    <p className="text-sm font-semibold text-slate-700 dark:text-slate-300">
                      No matching workloads found
                    </p>
                    <p className="text-xs text-slate-400 mt-1 max-w-sm">
                      {searchQuery ? `No results found for "${searchQuery}". Try searching by another keyword or reset the filter.` : 'There are currently no active workloads in this category.'}
                    </p>
                    {searchQuery && (
                      <button
                        onClick={() => setSearchQuery('')}
                        className="mt-4 px-3.5 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-medium transition-colors"
                      >
                        Clear Search Filter
                      </button>
                    )}
                  </div>
                );
              }

              return elements;
            })()}
          </div>
        </div>
      </div>

      {/* Edit Container Pop-up Modal */}
      {editingSession && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div className="w-full max-w-lg rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-5 shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center pb-3 border-b border-slate-100 dark:border-slate-800">
              <CardTitle className="text-sm uppercase font-bold tracking-wider text-slate-900 dark:text-white flex items-center gap-2">
                <Edit3 className="w-4 h-4 text-sky-500" /> Edit Container Configuration
              </CardTitle>
              <button
                onClick={() => setEditingSession(null)}
                className="p-1 rounded-md text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-4 text-xs">
              <div>
                <label className="text-[11px] font-medium text-slate-600 dark:text-slate-400 block mb-1">Docker Image URI</label>
                <Input
                  type="text"
                  value={editImage}
                  onChange={(e) => setEditImage(e.target.value)}
                  className="w-full text-xs font-mono rounded-lg border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] font-medium text-slate-600 dark:text-slate-400 block mb-1">Container Port</label>
                  <Input
                    type="number"
                    value={editPort}
                    onChange={(e) => setEditPort(e.target.value)}
                    className="w-full text-xs font-mono rounded-lg border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="text-[11px] font-medium text-slate-600 dark:text-slate-400 block mb-1">Host Port</label>
                  <Input
                    type="number"
                    value={editHostPort}
                    onChange={(e) => setEditHostPort(e.target.value)}
                    className="w-full text-xs font-mono rounded-lg border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950"
                  />
                </div>
              </div>

              <div>
                <label className="text-[11px] font-medium text-slate-600 dark:text-slate-400 block mb-1">Environment Variables</label>
                <textarea
                  value={editEnv}
                  onChange={(e) => setEditEnv(e.target.value)}
                  rows={4}
                  placeholder="KEY=VALUE"
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-2.5 font-mono text-xs text-slate-900 dark:text-slate-100 outline-none resize-y focus:ring-1 focus:ring-sky-500"
                />
              </div>
            </div>

            <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex justify-end gap-2.5">
              <button
                onClick={() => setEditingSession(null)}
                className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 text-xs font-medium transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={saveEditedContainer}
                disabled={loading}
                className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium transition-colors shadow-xs disabled:opacity-50"
              >
                {loading ? 'Redeploying...' : 'Save & Redeploy'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}