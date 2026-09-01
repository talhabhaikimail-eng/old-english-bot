import { useState, useEffect } from 'react';
import { BASE, authFetch } from '../api';
import { CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Copy,
  ExternalLink,
  Search,
  Globe,
  Terminal,
  Server,
  Smartphone,
  Edit3,
  Trash2,
  Check,
  X,
  Sparkles,
  Zap,
  Play,
  Layers,
  Container,
  Cpu
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

// Vibrant pop-art collage color palette for dynamic subdomain chips
const SUBDOMAIN_COLOR_STYLES = [
  { bg: 'bg-[#FF007A] text-white border-black', shadow: 'shadow-[2px_2px_0px_#000]' },
  { bg: 'bg-[#00F0FF] text-black border-black', shadow: 'shadow-[2px_2px_0px_#000]' },
  { bg: 'bg-[#FFE600] text-black border-black', shadow: 'shadow-[2px_2px_0px_#000]' },
  { bg: 'bg-[#00FF66] text-black border-black', shadow: 'shadow-[2px_2px_0px_#000]' },
  { bg: 'bg-[#9D4EDD] text-white border-black', shadow: 'shadow-[2px_2px_0px_#000]' },
  { bg: 'bg-[#FF5722] text-white border-black', shadow: 'shadow-[2px_2px_0px_#000]' },
  { bg: 'bg-[#3A86EF] text-white border-black', shadow: 'shadow-[2px_2px_0px_#000]' },
  { bg: 'bg-[#06D6A0] text-black border-black', shadow: 'shadow-[2px_2px_0px_#000]' },
  { bg: 'bg-[#FF9F1C] text-black border-black', shadow: 'shadow-[2px_2px_0px_#000]' },
  { bg: 'bg-[#E63946] text-white border-black', shadow: 'shadow-[2px_2px_0px_#000]' },
];

function parseUrlParts(urlStr: string) {
  if (!urlStr) return { fullUrl: '', protocol: '', hostname: '', hostParts: [], port: '', pathAndQuery: '', isValid: false };
  try {
    const hasProtocol = urlStr.includes('://');
    const fullUrl = hasProtocol ? urlStr : `https://${urlStr}`;
    const parsed = new URL(fullUrl);

    const protocol = hasProtocol ? parsed.protocol + '//' : '';
    const hostname = parsed.hostname;
    const port = parsed.port ? `:${parsed.port}` : '';
    const pathAndQuery = (parsed.pathname !== '/' ? parsed.pathname : '') + parsed.search + parsed.hash;

    const hostParts = hostname.split('.').filter(Boolean);

    return {
      fullUrl,
      protocol,
      hostname,
      hostParts,
      port,
      pathAndQuery,
      isValid: true
    };
  } catch (e) {
    return {
      fullUrl: urlStr,
      protocol: '',
      hostname: urlStr,
      hostParts: urlStr.split('.').filter(Boolean),
      port: '',
      pathAndQuery: '',
      isValid: false
    };
  }
}

function ColorizedUrlLink({ url, onCopy }: { url: string; onCopy?: (text: string) => void }) {
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
    <div className="flex flex-wrap items-center gap-2 my-1.5">
      {/* Clickable Main URL block - Opens main link on click */}
      <a
        href={parsed.fullUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={handleOpenLink}
        title={`Click to open main link (${parsed.fullUrl}) in a new tab`}
        className="flex flex-wrap items-center gap-1 p-1.5 bg-[#FFFDF5] dark:bg-slate-900 border-2 border-black shadow-[3px_3px_0px_#000] dark:shadow-[3px_3px_0px_#FFF] hover:shadow-[4px_4px_0px_#FF007A] hover:border-[#FF007A] transition-all cursor-pointer group/link"
      >
        {parsed.protocol && (
          <span className="px-1.5 py-0.5 bg-slate-200 dark:bg-slate-800 text-slate-900 dark:text-slate-100 font-mono text-[10px] font-bold border border-black/40">
            {parsed.protocol}
          </span>
        )}

        <span className="flex flex-wrap items-center gap-0.5 font-mono text-xs font-black">
          {parsed.hostParts.map((part, idx) => {
            // Dynamic color selection per subdomain part
            const hashVal = part.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
            const styleIdx = Math.abs(hashVal + idx * 3) % SUBDOMAIN_COLOR_STYLES.length;
            const style = SUBDOMAIN_COLOR_STYLES[styleIdx];
            return (
              <span key={idx} className="flex items-center">
                <span className={`px-1.5 py-0.5 border ${style.bg} ${style.shadow} uppercase tracking-wider text-[11px] font-black`}>
                  {part}
                </span>
                {idx < parsed.hostParts.length - 1 && (
                  <span className="px-0.5 text-black dark:text-white font-extrabold text-sm">.</span>
                )}
              </span>
            );
          })}
        </span>

        {parsed.port && (
          <span className="px-1.5 py-0.5 bg-[#9D4EDD] text-white font-mono text-[10px] font-extrabold border border-black shadow-[1px_1px_0px_#000]">
            {parsed.port}
          </span>
        )}

        {parsed.pathAndQuery && (
          <span className="px-1.5 py-0.5 bg-[#FFE600] text-black font-mono text-[10px] font-bold border border-black max-w-[140px] truncate">
            {parsed.pathAndQuery}
          </span>
        )}

        <ExternalLink className="w-3.5 h-3.5 ml-1 text-slate-800 dark:text-slate-200 group-hover/link:text-[#FF007A] transition-colors shrink-0" />
      </a>

      {/* Main Link Copy Button */}
      <button
        onClick={handleCopy}
        type="button"
        className={`px-2.5 py-1 text-[11px] font-mono font-black uppercase tracking-wider border-2 border-black flex items-center gap-1.5 transition-all ${
          copied
            ? 'bg-[#00FF66] text-black shadow-[2px_2px_0px_#000]'
            : 'bg-[#FFE600] hover:bg-[#FF007A] text-black hover:text-white shadow-[2px_2px_0px_#000] hover:shadow-[3px_3px_0px_#000] active:translate-x-0.5 active:translate-y-0.5'
        }`}
      >
        {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
        {copied ? 'COPIED!' : 'COPY LINK'}
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
    <div className="space-y-6 mx-auto text-sm font-mono p-2 sm:p-4 bg-[#F4F1EA] dark:bg-[#0B0C10] min-h-screen border-4 border-black shadow-[8px_8px_0px_#000]">
      {/* Collage Banner Header */}
      <div className="relative border-4 border-black bg-[#FFE600] text-black p-4 sm:p-5 shadow-[6px_6px_0px_#000] rotate-[-0.5deg]">
        <div className="absolute -top-3 left-4 bg-[#FF007A] text-white text-[10px] font-black uppercase px-3 py-0.5 border-2 border-black rotate-[-2deg] shadow-[2px_2px_0px_#000]">
          SESSION MANAGER // BRIDGE PANEL
        </div>
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pt-1">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-white border-2 border-black text-2xl shadow-[3px_3px_0px_#000] shrink-0 rotate-3">
              💾
            </div>
            <div>
              <h2 className="text-xl sm:text-2xl font-black uppercase tracking-tight flex items-center gap-2">
                ACTIVE WORKLOADS PRESERVED
                <Sparkles className="w-5 h-5 text-[#FF007A]" />
              </h2>
              <p className="text-xs font-bold text-slate-800 mt-0.5">
                {sessions.length} workload(s) running with Cloudflare secure tunnels.
              </p>
            </div>
          </div>
          <div className="bg-white px-4 py-2 border-2 border-black shadow-[3px_3px_0px_#000] shrink-0 text-center rotate-1">
            <span className="text-[10px] font-black uppercase block text-slate-500">TOTAL ACTIVE WORKLOADS</span>
            <span className="text-2xl font-black text-[#FF007A]">{totalSessions}</span>
          </div>
        </div>
      </div>

      {/* Result Status Banner */}
      {result && (
        <div className="border-3 border-black bg-[#00FF66] text-black p-3.5 shadow-[4px_4px_0px_#000] flex items-start justify-between gap-2">
          <pre className="text-xs font-mono font-bold whitespace-pre-wrap m-0 flex-1">{result}</pre>
          <button
            onClick={() => setResult('')}
            className="px-2 py-0.5 bg-black text-white text-xs font-bold border border-black hover:bg-[#FF007A]"
          >
            ✕
          </button>
        </div>
      )}

      {/* Responsive Main Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">

        {/* LEFT COLUMN: Controls & Launchers */}
        <div className="lg:col-span-4 space-y-6">

          {/* Collage Stats Grid */}
          <div className="border-3 border-black bg-[#FFFDF5] dark:bg-[#151620] p-4 space-y-3 shadow-[5px_5px_0px_#000] dark:shadow-[5px_5px_0px_#FFF]">
            <div className="flex justify-between items-center border-b-2 border-black pb-2">
              <span className="text-xs font-black uppercase tracking-wider text-black dark:text-white flex items-center gap-1.5">
                <Layers className="w-4 h-4 text-[#FF007A]" /> WORKLOAD COUNTER
              </span>
              <span className="px-2 py-0.5 bg-[#FFE600] text-black text-xs font-black border border-black shadow-[1px_1px_0px_#000]">
                LIVE
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div className="p-2.5 bg-[#00FF66] text-black border-2 border-black shadow-[2px_2px_0px_#000]">
                <div className="text-xl font-black">{dockerSessions.length}</div>
                <div className="text-[10px] font-black uppercase tracking-wider flex items-center gap-1">
                  <Container className="w-3 h-3" /> DOCKER
                </div>
              </div>

              <div className="p-2.5 bg-[#FF007A] text-white border-2 border-black shadow-[2px_2px_0px_#000]">
                <div className="text-xl font-black">{customBrowserSessions.length + browsers.length}</div>
                <div className="text-[10px] font-black uppercase tracking-wider flex items-center gap-1">
                  <Globe className="w-3 h-3" /> BROWSERS
                </div>
              </div>

              <div className="p-2.5 bg-[#00F0FF] text-black border-2 border-black shadow-[2px_2px_0px_#000]">
                <div className="text-xl font-black">{terminalSessions.length}</div>
                <div className="text-[10px] font-black uppercase tracking-wider flex items-center gap-1">
                  <Terminal className="w-3 h-3" /> TERMINALS
                </div>
              </div>

              <div className="p-2.5 bg-[#9D4EDD] text-white border-2 border-black shadow-[2px_2px_0px_#000]">
                <div className="text-xl font-black">{vscodeSessions.length}</div>
                <div className="text-[10px] font-black uppercase tracking-wider flex items-center gap-1">
                  <Cpu className="w-3 h-3" /> VSCODE
                </div>
              </div>
            </div>
          </div>

          {/* Quick Launch Browser Card */}
          <div className="border-3 border-black bg-[#FFFDF5] dark:bg-[#151620] p-4 space-y-3 shadow-[5px_5px_0px_#000] dark:shadow-[5px_5px_0px_#FFF]">
            <div className="flex items-center gap-2">
              <span className="p-1 bg-[#FFE600] text-black border border-black">🌐</span>
              <CardTitle className="text-xs uppercase font-black tracking-wider text-black dark:text-white">
                QUICK WEB BROWSER
              </CardTitle>
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <Input
                type="url"
                value={customUrl}
                onChange={(e) => setCustomUrl(e.target.value)}
                placeholder="https://example.com"
                className="flex-1 text-xs border-2 border-black bg-white text-black font-mono focus:ring-2 focus:ring-[#FF007A]"
              />
              <button
                onClick={startCustomBrowser}
                disabled={loading}
                className="px-4 py-2 bg-[#FF007A] hover:bg-[#FFE600] text-white hover:text-black font-mono text-xs font-black uppercase border-2 border-black shadow-[3px_3px_0px_#000] active:translate-x-0.5 active:translate-y-0.5 transition-all shrink-0 flex items-center justify-center gap-1"
              >
                <Play className="w-3.5 h-3.5" /> LAUNCH
              </button>
            </div>
          </div>

          {/* Deploy Container Card */}
          <div className="border-3 border-black bg-[#FFFDF5] dark:bg-[#151620] p-4 space-y-3 shadow-[5px_5px_0px_#000] dark:shadow-[5px_5px_0px_#FFF]">
            <div className="flex items-center gap-2 border-b-2 border-black pb-2">
              <span className="p-1 bg-[#00F0FF] text-black border border-black">🐋</span>
              <CardTitle className="text-xs uppercase font-black tracking-wider text-black dark:text-white">
                DEPLOY CONTAINER INSTANCE
              </CardTitle>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label className="text-[10px] text-black dark:text-slate-300 font-black uppercase block mb-1">
                  IMAGE URI
                </label>
                <Input
                  type="text"
                  value={dockerImage}
                  onChange={(e) => setDockerImage(e.target.value)}
                  placeholder="nginx:latest"
                  className="w-full text-xs border-2 border-black bg-white text-black font-mono"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] text-black dark:text-slate-300 font-black uppercase block mb-1">
                    CONTAINER PORT
                  </label>
                  <Input
                    type="number"
                    value={dockerPort}
                    onChange={(e) => setDockerPort(e.target.value)}
                    className="w-full text-xs border-2 border-black bg-white text-black font-mono"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-black dark:text-slate-300 font-black uppercase block mb-1">
                    HOST PORT
                  </label>
                  <Input
                    type="number"
                    value={hostPort}
                    onChange={(e) => setHostPort(e.target.value)}
                    className="w-full text-xs border-2 border-black bg-white text-black font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="text-[10px] text-black dark:text-slate-300 font-black uppercase block mb-1">
                  NETWORK MODE
                </label>
                <select
                  value={domainMode}
                  onChange={(e) => setDomainMode(e.target.value as 'quick' | 'custom')}
                  className="w-full border-2 border-black bg-[#FFE600] px-2.5 py-1.5 text-xs text-black font-mono font-bold outline-none shadow-[2px_2px_0px_#000]"
                >
                  <option value="quick">Quick Tunnel (trycloudflare)</option>
                  <option value="custom">Custom Subdomain</option>
                </select>
              </div>

              {domainMode === 'custom' && (
                <div>
                  <label className="text-[10px] text-black dark:text-slate-300 font-black uppercase block mb-1">
                    CUSTOM SUBDOMAIN
                  </label>
                  <Input
                    type="text"
                    value={customDomain}
                    onChange={(e) => setCustomDomain(e.target.value)}
                    placeholder="whoami.yourdomain.com"
                    className="w-full text-xs border-2 border-black bg-white text-black font-mono"
                  />
                </div>
              )}

              <div>
                <label className="text-[10px] text-black dark:text-slate-300 font-black uppercase block mb-1">
                  ENVIRONMENT VARIABLES
                </label>
                <textarea
                  value={dockerEnv}
                  onChange={(e) => setDockerEnv(e.target.value)}
                  rows={2}
                  placeholder={"KEY=VALUE\nOTHER_KEY=123"}
                  className="w-full border-2 border-black bg-white dark:bg-black p-2 font-mono text-xs text-black dark:text-white outline-none resize-y"
                />
              </div>

              <button
                onClick={deployCustomContainer}
                disabled={loading}
                className="w-full py-2.5 bg-[#00FF66] hover:bg-[#FFE600] text-black font-mono text-xs font-black uppercase border-2 border-black shadow-[4px_4px_0px_#000] active:translate-x-0.5 active:translate-y-0.5 transition-all flex items-center justify-center gap-1.5"
              >
                <Zap className="w-4 h-4" /> {loading ? 'DEPLOYING...' : 'DEPLOY CONTAINER'}
              </button>
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN: Search Controls, Tabs, Workload List */}
        <div className="lg:col-span-8 space-y-4">

          {/* Search & Filter Options Bar (Search by URL and by Name) */}
          <div className="border-3 border-black bg-[#FFFDF5] dark:bg-[#151620] p-3.5 shadow-[5px_5px_0px_#000] dark:shadow-[5px_5px_0px_#FFF] space-y-2.5">
            <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-center">
              <div className="relative flex-1">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-700 dark:text-slate-300" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search workloads by URL or Name..."
                  className="w-full pl-9 pr-8 py-2 bg-white dark:bg-black border-2 border-black text-xs font-mono font-bold text-black dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#FF007A] shadow-[2px_2px_0px_#000]"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 bg-black text-white hover:bg-[#FF007A]"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              {/* Filter mode options */}
              <div className="flex items-center gap-1 bg-slate-200 dark:bg-slate-800 p-1 border-2 border-black shrink-0">
                <span className="text-[10px] font-mono font-black uppercase px-1 text-slate-700 dark:text-slate-300">SEARCH:</span>
                <button
                  onClick={() => setSearchMode('all')}
                  className={`px-2 py-1 text-[10px] font-mono font-black uppercase border border-black transition-all ${
                    searchMode === 'all' ? 'bg-[#FFE600] text-black shadow-[1px_1px_0px_#000]' : 'bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200'
                  }`}
                >
                  ALL
                </button>
                <button
                  onClick={() => setSearchMode('name')}
                  className={`px-2 py-1 text-[10px] font-mono font-black uppercase border border-black transition-all ${
                    searchMode === 'name' ? 'bg-[#FF007A] text-white shadow-[1px_1px_0px_#000]' : 'bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200'
                  }`}
                >
                  BY NAME
                </button>
                <button
                  onClick={() => setSearchMode('url')}
                  className={`px-2 py-1 text-[10px] font-mono font-black uppercase border border-black transition-all ${
                    searchMode === 'url' ? 'bg-[#00F0FF] text-black shadow-[1px_1px_0px_#000]' : 'bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200'
                  }`}
                >
                  BY URL
                </button>
              </div>
            </div>

            {searchQuery && (
              <div className="text-[11px] font-mono font-bold text-[#FF007A] flex items-center justify-between">
                <span>Filtering by {searchMode.toUpperCase()}: "{searchQuery}"</span>
                <button onClick={() => setSearchQuery('')} className="underline hover:text-black">Clear search</button>
              </div>
            )}
          </div>

          {/* Collage Filter Tabs */}
          <div className="border-3 border-black bg-[#FFE600] dark:bg-slate-900 p-2 shadow-[5px_5px_0px_#000] flex gap-2 overflow-x-auto">
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
                  className={`px-3 py-1.5 font-mono text-xs font-black uppercase border-2 border-black transition-all flex items-center gap-1.5 shrink-0 ${
                    active
                      ? 'bg-[#FF007A] text-white shadow-[3px_3px_0px_#000] -rotate-1 scale-[1.02]'
                      : 'bg-white dark:bg-slate-800 text-black dark:text-white hover:bg-[#00F0FF] hover:text-black shadow-[2px_2px_0px_#000]'
                  }`}
                >
                  <span>{tab === 'all' ? '⚡ ALL WORKLOADS' : tab}</span>
                  <span className={`px-1.5 py-0.2 text-[10px] font-extrabold border border-black ${
                    active ? 'bg-white text-black' : 'bg-slate-200 dark:bg-slate-700 text-black dark:text-white'
                  }`}>
                    {count}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Workloads Card List Container */}
          <div className="p-3 bg-[#F4F1EA] dark:bg-[#12131C] border-3 border-black shadow-[5px_5px_0px_#000] min-h-[450px] space-y-3 overflow-y-auto max-h-[700px]">
            {(() => {
              const SessionCard = ({ session, icon, categoryBg }: { session: Session; icon: string; categoryBg: string }) => {
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
                  <div className="bg-[#FFFDF5] dark:bg-[#181926] p-4 border-3 border-black shadow-[4px_4px_0px_#000] dark:shadow-[4px_4px_0px_#FFF] flex flex-col gap-3 group relative overflow-hidden">
                    {/* Corner Sticker Tag */}
                    <div className="absolute -top-1 -right-4 bg-[#FFE600] text-black text-[9px] font-mono font-black uppercase px-4 py-0.5 border border-black rotate-6 shadow-sm">
                      {session.type.replace('-container', '').toUpperCase()}
                    </div>

                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-3 flex-1 min-w-0">
                        <div className={`p-2.5 border-2 border-black text-xl shrink-0 ${categoryBg} shadow-[2px_2px_0px_#000]`}>
                          {icon}
                        </div>

                        <div className="space-y-1 flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-black dark:text-white font-mono font-black text-sm tracking-tight truncate">
                              {containerName}
                            </span>
                            <span className="px-1.5 py-0.5 bg-[#00F0FF] text-black text-[9px] font-mono font-black border border-black uppercase shadow-[1px_1px_0px_#000]">
                              {session.type.replace('-container', '')}
                            </span>
                          </div>

                          {/* DYNAMIC COLORIZED URL LINK WITH MAIN COPY BUTTON & CLICK TO OPEN MAIN LINK */}
                          <ColorizedUrlLink url={mainUrl} onCopy={() => setResult(`COPIED LINK: ${mainUrl}`)} />

                          {/* Time & Credentials info */}
                          <div className="flex flex-wrap items-center gap-2 text-xs font-mono pt-1">
                            <div className="bg-slate-100 dark:bg-slate-800 px-2 py-0.5 border border-black text-slate-800 dark:text-slate-200 font-bold text-[11px] flex items-center gap-1">
                              ⏱ {new Date(session.startedAt).toLocaleTimeString()}
                            </div>
                            {session.username && (
                              <div className="bg-emerald-100 dark:bg-emerald-950 px-2 py-0.5 border border-black text-emerald-900 dark:text-emerald-200 text-[11px]">
                                USER: <span className="font-black">{session.username}</span>
                              </div>
                            )}
                            {session.password && (
                              <div className="bg-purple-100 dark:bg-purple-950 px-2 py-0.5 border border-black text-purple-900 dark:text-purple-200 text-[11px]">
                                PASS: <span className="font-black">{session.password}</span>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Action buttons */}
                      <div className="flex gap-1.5 shrink-0 self-start">
                        {session.type === 'docker-container' && (
                          <button
                            onClick={() => startEditing(session)}
                            className="px-2.5 py-1 bg-white hover:bg-[#FFE600] text-black font-mono font-black text-[11px] uppercase border-2 border-black shadow-[2px_2px_0px_#000] active:translate-x-0.5 active:translate-y-0.5 transition-all flex items-center gap-1"
                          >
                            <Edit3 className="w-3 h-3" /> EDIT
                          </button>
                        )}
                        <button
                          onClick={() => stopSession(session.id, session.type)}
                          className="px-2.5 py-1 bg-[#FF5722] hover:bg-[#E63946] text-white font-mono font-black text-[11px] uppercase border-2 border-black shadow-[2px_2px_0px_#000] active:translate-x-0.5 active:translate-y-0.5 transition-all flex items-center gap-1"
                        >
                          <Trash2 className="w-3 h-3" /> STOP
                        </button>
                      </div>
                    </div>

                    {/* Webhook Section */}
                    {webhookUrl && (
                      <div className="pt-2 border-t-2 border-dashed border-black/40 flex flex-col sm:flex-row sm:items-center justify-between gap-2 bg-[#F4EADA] dark:bg-slate-900 p-2.5 border-2 border-black">
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          <span className="bg-[#FF007A] text-white text-[10px] font-mono font-black px-1.5 py-0.5 border border-black shrink-0">
                            ⚓ WEBHOOK
                          </span>
                          <span
                            title={webhookUrl}
                            className="text-slate-800 dark:text-slate-200 font-mono text-[11px] truncate select-all"
                          >
                            {webhookUrl}
                          </span>
                        </div>
                        <button
                          onClick={() => copyToClipboard(webhookUrl)}
                          className="px-2.5 py-1 bg-[#00F0FF] hover:bg-[#00FF66] text-black font-mono text-[10px] font-black uppercase tracking-wider border-2 border-black shadow-[2px_2px_0px_#000] active:translate-x-0.5 active:translate-y-0.5 transition-all shrink-0 flex items-center gap-1"
                        >
                          <Copy className="w-3 h-3" /> COPY WEBHOOK
                        </button>
                      </div>
                    )}
                  </div>
                );
              };

              const elements: JSX.Element[] = [];

              if ((activeTab === 'all' || activeTab === 'docker') && dockerSessions.length > 0) {
                dockerSessions.forEach(s => {
                  const card = <SessionCard key={s.id} session={s} icon="🐋" categoryBg="bg-[#00FF66]" />;
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
                    elements.push(<SessionCard key={s.id} session={s} icon="🌐" categoryBg="bg-[#FF007A]" />);
                  }
                });
              }

              if ((activeTab === 'all' || activeTab === 'browser') && browsers.length > 0) {
                browsers.forEach((b, i) => {
                  if (matchesSearch('General Browser Pool', b.url || '')) {
                    elements.push(
                      <div key={`gb-${i}`} className="bg-[#FFFDF5] dark:bg-[#181926] p-3.5 border-3 border-black shadow-[4px_4px_0px_#000] flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                        <div className="flex items-start gap-3 flex-1 min-w-0">
                          <span className="text-xl p-2 bg-[#FF007A] text-white border-2 border-black shadow-[2px_2px_0px_#000]">🌍</span>
                          <div className="text-xs font-mono space-y-1 flex-1 min-w-0">
                            <div className="text-black dark:text-white font-black">General Browser Pool #{i + 1}</div>
                            <ColorizedUrlLink url={b.url} onCopy={() => setResult(`COPIED: ${b.url}`)} />
                            <div className="text-slate-600 dark:text-slate-400 text-[11px]">
                              USER: <span className="font-bold text-black dark:text-white">{b.username}</span> · PASS: <span className="font-bold text-black dark:text-white">{b.password}</span> · PORT: {b.port}
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
                    elements.push(<SessionCard key={s.id} session={s} icon="💻" categoryBg="bg-[#00F0FF]" />);
                  }
                });
              }

              if ((activeTab === 'all' || activeTab === 'vscode') && vscodeSessions.length > 0) {
                vscodeSessions.forEach(s => {
                  const mainUrl = s.metadata?.cloudflaredUrl || s.url;
                  const name = s.metadata?.containerName || 'VSCode Session';
                  if (matchesSearch(name, mainUrl)) {
                    elements.push(<SessionCard key={s.id} session={s} icon="⚡" categoryBg="bg-[#9D4EDD]" />);
                  }
                });
              }

              if ((activeTab === 'all' || activeTab === 'android') && android) {
                if (matchesSearch(android.deviceInfo || 'Android Emulator', android.webUrl || '')) {
                  elements.push(
                    <div key="android" className="bg-[#FFFDF5] dark:bg-[#181926] p-3.5 border-3 border-black shadow-[4px_4px_0px_#000] flex items-start gap-3">
                      <span className="text-xl p-2 bg-[#FF9F1C] text-black border-2 border-black shadow-[2px_2px_0px_#000]">📱</span>
                      <div className="text-xs font-mono space-y-1 flex-1">
                        <div className="text-black dark:text-white font-black">{android.deviceInfo || 'Android Emulator'}</div>
                        {android.webUrl && <ColorizedUrlLink url={android.webUrl} onCopy={() => setResult(`COPIED: ${android.webUrl}`)} />}
                        <div className="text-slate-600 dark:text-slate-400 text-[11px]">UPTIME: {android.uptime || 'Unknown'}</div>
                      </div>
                    </div>
                  );
                }
              }

              if (elements.length === 0) {
                return (
                  <div className="flex flex-col items-center justify-center h-full text-slate-500 space-y-2 py-16 bg-white dark:bg-black border-2 border-black">
                    <span className="text-4xl p-3 bg-[#FFE600] border-2 border-black shadow-[3px_3px_0px_#000]">📭</span>
                    <p className="text-xs font-mono font-black uppercase text-black dark:text-white">
                      No matching workloads found.
                    </p>
                    {searchQuery && (
                      <button
                        onClick={() => setSearchQuery('')}
                        className="px-3 py-1 bg-[#FF007A] text-white text-xs font-mono font-black border border-black shadow-[2px_2px_0px_#000]"
                      >
                        CLEAR SEARCH FILTER
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
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-xs">
          <div className="w-full max-w-lg border-4 border-black bg-[#FFFDF5] dark:bg-[#151620] p-5 space-y-4 max-h-[90vh] overflow-y-auto shadow-[10px_10px_0px_#FF007A]">
            <div className="flex justify-between items-center pb-2 border-b-3 border-black bg-[#FFE600] text-black p-2 -mx-5 -mt-5">
              <CardTitle className="text-xs uppercase font-mono font-black tracking-wider flex items-center gap-1.5">
                ⚙️ EDIT CONTAINER CONFIG
              </CardTitle>
              <button
                onClick={() => setEditingSession(null)}
                className="px-2 py-0.5 bg-black text-white text-xs font-bold border border-black hover:bg-[#FF007A]"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3 text-xs font-mono">
              <div>
                <label className="text-[10px] text-black dark:text-slate-200 font-black uppercase block mb-1">IMAGE URI</label>
                <Input type="text" value={editImage} onChange={(e) => setEditImage(e.target.value)} className="w-full text-xs border-2 border-black bg-white text-black" />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] text-black dark:text-slate-200 font-black uppercase block mb-1">CONTAINER PORT</label>
                  <Input type="number" value={editPort} onChange={(e) => setEditPort(e.target.value)} className="w-full text-xs border-2 border-black bg-white text-black" />
                </div>
                <div>
                  <label className="text-[10px] text-black dark:text-slate-200 font-black uppercase block mb-1">HOST PORT</label>
                  <Input type="number" value={editHostPort} onChange={(e) => setEditHostPort(e.target.value)} className="w-full text-xs border-2 border-black bg-white text-black" />
                </div>
              </div>

              <div>
                <label className="text-[10px] text-black dark:text-slate-200 font-black uppercase block mb-1">ENVIRONMENT VARIABLES</label>
                <textarea value={editEnv} onChange={(e) => setEditEnv(e.target.value)} rows={4} placeholder="KEY=VALUE" className="w-full border-2 border-black bg-white dark:bg-black p-2 font-mono text-xs text-black dark:text-white outline-none resize-y" />
              </div>
            </div>

            <div className="pt-3 border-t-2 border-black flex justify-end gap-2">
              <button onClick={() => setEditingSession(null)} className="px-3 py-1.5 bg-white text-black border-2 border-black font-mono text-xs font-black uppercase shadow-[2px_2px_0px_#000]">
                CANCEL
              </button>
              <button onClick={saveEditedContainer} disabled={loading} className="px-4 py-1.5 bg-[#00FF66] hover:bg-[#FFE600] text-black border-2 border-black font-mono text-xs font-black uppercase shadow-[3px_3px_0px_#000]">
                {loading ? 'REDEPLOYING...' : 'SAVE & REDEPLOY'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}