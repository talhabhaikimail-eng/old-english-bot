import React, { useState, useEffect } from 'react';
import { BASE, authFetch } from '../api';
import { CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
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
        className="flex items-center gap-2 px-3 h-8 rounded-md bg-secondary/40 border border-border hover:border-primary/50 transition-colors cursor-pointer group flex-1 min-w-0"
      >
        <Globe className="size-4 text-muted-foreground shrink-0" />
        <div className="font-mono text-xs truncate flex-1 min-w-0 flex items-center">
          {parsed.protocol && (
            <span className="text-muted-foreground select-none mr-0.5">{parsed.protocol}</span>
          )}
          <span className="text-foreground font-medium hover:underline">
            {parsed.hostname}
          </span>
          {parsed.port && (
            <span className="text-primary font-medium ml-0.5">{parsed.port}</span>
          )}
          {parsed.pathAndQuery && (
            <span className="text-muted-foreground">{parsed.pathAndQuery}</span>
          )}
        </div>
        <ExternalLink className="size-3.5 text-muted-foreground group-hover:text-primary transition-colors shrink-0 ml-1" />
      </div>

      <Button
        onClick={handleCopy}
        type="button"
        variant="outline"
        size="default"
        className={`shrink-0 ${copied ? 'text-primary border-primary/30 bg-primary/10' : ''}`}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        <span>{copied ? 'Copied' : 'Copy'}</span>
      </Button>
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

  const sectionTitle = 'text-sm font-semibold tracking-tight text-foreground';
  const fieldLabel = 'text-xs font-medium text-muted-foreground block mb-1.5';
  const selectCls = 'h-8 w-full rounded-md border border-input bg-card px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/25';
  const chipCls = 'inline-flex items-center gap-1 bg-secondary/60 px-2 py-0.5 rounded-md border border-border text-[11px] text-muted-foreground';

  return (
    <div className="space-y-4 mx-auto text-sm text-foreground">
      {/* Header */}
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="size-9 rounded-md bg-secondary border border-border flex items-center justify-center shrink-0 text-muted-foreground">
              <ShieldCheck className="size-4" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-sm font-semibold tracking-tight text-foreground">
                  Active workloads
                </h1>
                <Badge variant="default">
                  <span className="size-1.5 rounded-full bg-primary" />
                  Cloudflare protected
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                {sessions.length} workload(s) running with Cloudflare secure zero-trust tunnels.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="icon"
              onClick={() => loadSessions()}
              title="Refresh workload sessions"
            >
              <RefreshCw />
            </Button>
            <div className="bg-secondary/40 px-4 py-1.5 rounded-md border border-border text-center min-w-[110px]">
              <span className="text-xs font-medium block text-muted-foreground">
                Total active
              </span>
              <span className="text-xl font-semibold text-foreground">{totalSessions}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Result Status Banner */}
      {result && (
        <div className={`rounded-lg border p-3 flex items-start justify-between gap-3 ${
          result.includes('[ERROR]')
            ? 'bg-destructive/10 border-destructive/30 text-destructive'
            : 'bg-primary/10 border-primary/30 text-primary'
        }`}>
          <pre className="text-xs font-mono whitespace-pre-wrap flex-1 m-0">{result.replace(/^\[(ERROR|SUCCESS|COPIED)\]\s*/, '')}</pre>
          <Button variant="ghost" size="icon-sm" onClick={() => setResult('')} className="-my-1 -mr-1">
            <X />
          </Button>
        </div>
      )}

      {/* Responsive Main Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">

        {/* LEFT COLUMN: Controls & Launchers */}
        <div className="lg:col-span-4 space-y-4">

          {/* Workload Counter Stats Grid */}
          <div className="rounded-lg border border-border bg-card p-4 space-y-4">
            <div className="flex justify-between items-center">
              <span className={`${sectionTitle} flex items-center gap-2`}>
                <Layers className="size-4 text-muted-foreground" /> Workload breakdown
              </span>
              <Badge variant="default">
                <span className="size-1.5 rounded-full bg-primary animate-pulse" /> Live
              </Badge>
            </div>

            <div className="grid grid-cols-2 gap-3">
              {[
                { n: dockerSessions.length, label: 'Docker', icon: <Container className="size-3.5" /> },
                { n: customBrowserSessions.length + browsers.length, label: 'Browsers', icon: <Globe className="size-3.5" /> },
                { n: terminalSessions.length, label: 'Terminals', icon: <Terminal className="size-3.5" /> },
                { n: vscodeSessions.length, label: 'VS Code', icon: <Cpu className="size-3.5" /> },
              ].map((c) => (
                <div key={c.label} className="p-3 rounded-md bg-secondary/40 border border-border">
                  <div className="text-xl font-semibold text-foreground">{c.n}</div>
                  <div className="text-xs font-medium text-muted-foreground flex items-center gap-1.5 mt-0.5">
                    {c.icon} {c.label}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Quick Launch Browser Card */}
          <div className="rounded-lg border border-border bg-card p-4 space-y-3">
            <div className="flex items-center gap-2 text-foreground">
              <Globe className="size-4 text-muted-foreground" />
              <CardTitle className={sectionTitle}>
                Quick web browser
              </CardTitle>
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <Input
                type="url"
                value={customUrl}
                onChange={(e) => setCustomUrl(e.target.value)}
                placeholder="https://example.com"
                className="flex-1 text-xs font-mono"
              />
              <Button onClick={startCustomBrowser} disabled={loading}>
                <Play /> Launch
              </Button>
            </div>
          </div>

          {/* Deploy Container Card */}
          <div className="rounded-lg border border-border bg-card p-4 space-y-4">
            <div className="flex items-center gap-2 border-b border-border pb-3 text-foreground">
              <Container className="size-4 text-muted-foreground" />
              <CardTitle className={sectionTitle}>
                Deploy container instance
              </CardTitle>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label className={fieldLabel}>Image URI</label>
                <Input
                  type="text"
                  value={dockerImage}
                  onChange={(e) => setDockerImage(e.target.value)}
                  placeholder="nginx:latest"
                  className="w-full text-xs font-mono"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={fieldLabel}>Container port</label>
                  <Input
                    type="number"
                    value={dockerPort}
                    onChange={(e) => setDockerPort(e.target.value)}
                    className="w-full text-xs font-mono"
                  />
                </div>
                <div>
                  <label className={fieldLabel}>Host port</label>
                  <Input
                    type="number"
                    value={hostPort}
                    onChange={(e) => setHostPort(e.target.value)}
                    className="w-full text-xs font-mono"
                  />
                </div>
              </div>

              <div>
                <label className={fieldLabel}>Network mode</label>
                <select
                  value={domainMode}
                  onChange={(e) => setDomainMode(e.target.value as 'quick' | 'custom')}
                  className={selectCls}
                >
                  <option value="quick">Quick tunnel (trycloudflare)</option>
                  <option value="custom">Custom subdomain</option>
                </select>
              </div>

              {domainMode === 'custom' && (
                <div>
                  <label className={fieldLabel}>Custom subdomain</label>
                  <Input
                    type="text"
                    value={customDomain}
                    onChange={(e) => setCustomDomain(e.target.value)}
                    placeholder="whoami.yourdomain.com"
                    className="w-full text-xs font-mono"
                  />
                </div>
              )}

              <div>
                <label className={fieldLabel}>Environment variables</label>
                <Textarea
                  value={dockerEnv}
                  onChange={(e) => setDockerEnv(e.target.value)}
                  rows={2}
                  placeholder={"KEY=VALUE\nOTHER_KEY=123"}
                  className="w-full font-mono text-xs resize-y"
                />
              </div>

              <Button onClick={deployCustomContainer} disabled={loading} className="w-full">
                <Zap /> {loading ? 'Deploying...' : 'Deploy container'}
              </Button>
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN: Search Controls, Tabs, Workload List */}
        <div className="lg:col-span-8 space-y-4">

          {/* Search & Filter Bar */}
          <div className="rounded-lg border border-border bg-card p-3 space-y-2">
            <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-center">
              <div className="relative flex-1">
                <Search className="size-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search workloads by URL, container name, or image..."
                  className="pl-8 pr-8 text-xs"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-secondary text-muted-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                )}
              </div>

              {/* Filter mode options */}
              <div className="flex items-center gap-0.5 bg-secondary/40 p-0.5 rounded-md border border-border shrink-0">
                <span className="text-xs font-medium px-1.5 text-muted-foreground">Search</span>
                {(['all', 'name', 'url'] as SearchMode[]).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => setSearchMode(mode)}
                    className={`px-2.5 h-7 text-xs font-medium rounded transition-colors ${
                      searchMode === mode
                        ? 'bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {mode === 'all' ? 'All' : mode === 'name' ? 'By name' : 'By URL'}
                  </button>
                ))}
              </div>
            </div>

            {searchQuery && (
              <div className="text-xs text-muted-foreground flex items-center justify-between px-1">
                <span>Filtering by {searchMode}: <span className="font-medium text-foreground">"{searchQuery}"</span></span>
                <button onClick={() => setSearchQuery('')} className="underline hover:text-foreground">
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
              const tabLabel =
                tab === 'all' ? 'All workloads' :
                tab === 'docker' ? 'Docker' :
                tab === 'browser' ? 'Browser' :
                tab === 'terminal' ? 'Terminal' :
                tab === 'vscode' ? 'VS Code' : 'Android';

              return (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`h-8 px-3 rounded-md text-xs font-medium transition-colors flex items-center gap-2 shrink-0 border ${
                    active
                      ? 'bg-primary/10 text-primary border-primary/30'
                      : 'bg-transparent text-muted-foreground hover:bg-secondary hover:text-foreground border-border'
                  }`}
                >
                  <span>{tabLabel}</span>
                  <span className={`px-1.5 rounded-full text-[10px] font-medium ${
                    active
                      ? 'bg-primary/15 text-primary'
                      : 'bg-secondary text-muted-foreground'
                  }`}>
                    {count}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Workloads Card List Container */}
          <div className="space-y-3">
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
                const containerName = session.metadata?.containerName || session.metadata?.targetUrl || `${session.type} session`;

                // Check search match
                if (!matchesSearch(containerName, mainUrl, `${session.type} ${webhookUrl || ''}`)) {
                  return null;
                }

                return (
                  <div className="rounded-lg border border-border bg-card p-4 flex flex-col gap-3 hover:border-primary/40 transition-colors">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-3 flex-1 min-w-0">
                        <div className="size-9 rounded-md bg-secondary border border-border flex items-center justify-center shrink-0 text-muted-foreground">
                          {icon}
                        </div>

                        <div className="space-y-1 flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-foreground font-semibold font-mono text-sm tracking-tight truncate">
                              {containerName}
                            </span>
                            <span className={`inline-flex items-center h-5 px-2 rounded-full text-[11px] font-medium border ${badgeColor}`}>
                              {typeLabel}
                            </span>
                            <span className="inline-flex items-center gap-1 text-[11px] text-primary font-medium">
                              <span className="size-1.5 rounded-full bg-primary" /> Active
                            </span>
                          </div>

                          {/* Clean, High-Readability URL Link Component */}
                          <ReadableUrlLink url={mainUrl} onCopy={() => setResult(`COPIED LINK: ${mainUrl}`)} />

                          {/* Time & Credentials info */}
                          <div className="flex flex-wrap items-center gap-2 text-xs pt-0.5 text-muted-foreground">
                            <div className={chipCls}>
                              <Clock className="size-3" />
                              {new Date(session.startedAt).toLocaleTimeString()}
                            </div>
                            {session.username && (
                              <div className={chipCls}>
                                User <span className="font-mono font-medium text-foreground">{session.username}</span>
                              </div>
                            )}
                            {session.password && (
                              <div className={chipCls}>
                                Password <span className="font-mono font-medium text-foreground">{session.password}</span>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Action buttons */}
                      <div className="flex items-center gap-2 shrink-0 self-start">
                        {session.type === 'docker-container' && (
                          <Button variant="outline" size="sm" onClick={() => startEditing(session)}>
                            <Edit3 className="size-3.5" /> Edit
                          </Button>
                        )}
                        <Button variant="destructive" size="sm" onClick={() => stopSession(session.id, session.type)}>
                          <Trash2 className="size-3.5" /> Stop
                        </Button>
                      </div>
                    </div>

                    {/* Webhook Section */}
                    {webhookUrl && (
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-2.5 rounded-md bg-secondary/40 border border-border text-xs">
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          <Badge variant="secondary" className="shrink-0">
                            Webhook
                          </Badge>
                          <span
                            title={webhookUrl}
                            className="text-muted-foreground font-mono text-xs truncate select-all"
                          >
                            {webhookUrl}
                          </span>
                        </div>
                        <Button
                          variant="outline"
                          size="xs"
                          onClick={() => copyToClipboard(webhookUrl)}
                          className="shrink-0 self-start sm:self-auto"
                        >
                          <Copy className="size-3" />
                          <span>Copy webhook</span>
                        </Button>
                      </div>
                    )}
                  </div>
                );
              };

              const elements: JSX.Element[] = [];
              const neutralBadge = 'bg-secondary text-secondary-foreground border-border';

              if ((activeTab === 'all' || activeTab === 'docker') && dockerSessions.length > 0) {
                dockerSessions.forEach(s => {
                  const card = (
                    <SessionCard
                      key={s.id}
                      session={s}
                      icon={<Container className="size-4" />}
                      typeLabel="Docker"
                      badgeColor={neutralBadge}
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
                        icon={<Globe className="size-4" />}
                        typeLabel="Browser"
                        badgeColor={neutralBadge}
                      />
                    );
                  }
                });
              }

              if ((activeTab === 'all' || activeTab === 'browser') && browsers.length > 0) {
                browsers.forEach((b, i) => {
                  if (matchesSearch('General Browser Pool', b.url || '')) {
                    elements.push(
                      <div key={`gb-${i}`} className="rounded-lg border border-border bg-card p-4 flex flex-col gap-3 hover:border-primary/40 transition-colors">
                        <div className="flex items-start gap-3 flex-1 min-w-0">
                          <div className="size-9 rounded-md bg-secondary border border-border flex items-center justify-center shrink-0 text-muted-foreground">
                            <Globe className="size-4" />
                          </div>
                          <div className="space-y-1 flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-foreground">General browser pool #{i + 1}</span>
                              <Badge variant="secondary">Pool</Badge>
                            </div>
                            <ReadableUrlLink url={b.url} onCopy={() => setResult(`COPIED: ${b.url}`)} />
                            <div className="text-muted-foreground text-xs flex flex-wrap items-center gap-3 pt-1">
                              <span>User <span className="font-mono font-medium text-foreground">{b.username}</span></span>
                              <span>Password <span className="font-mono font-medium text-foreground">{b.password}</span></span>
                              <span>Port <span className="font-mono font-medium text-foreground">{b.port}</span></span>
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
                        icon={<Terminal className="size-4" />}
                        typeLabel="Terminal"
                        badgeColor={neutralBadge}
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
                        icon={<Cpu className="size-4" />}
                        typeLabel="VS Code"
                        badgeColor={neutralBadge}
                      />
                    );
                  }
                });
              }

              if ((activeTab === 'all' || activeTab === 'android') && android) {
                if (matchesSearch(android.deviceInfo || 'Android Emulator', android.webUrl || '')) {
                  elements.push(
                    <div key="android" className="rounded-lg border border-border bg-card p-4 flex items-start gap-3 hover:border-primary/40 transition-colors">
                      <div className="size-9 rounded-md bg-secondary border border-border flex items-center justify-center shrink-0 text-muted-foreground">
                        <Smartphone className="size-4" />
                      </div>
                      <div className="space-y-1 flex-1">
                        <div className="font-semibold text-foreground">{android.deviceInfo || 'Android Emulator'}</div>
                        {android.webUrl && <ReadableUrlLink url={android.webUrl} onCopy={() => setResult(`COPIED: ${android.webUrl}`)} />}
                        <div className="text-muted-foreground text-xs">Uptime: <span className="font-mono">{android.uptime || 'Unknown'}</span></div>
                      </div>
                    </div>
                  );
                }
              }

              if (elements.length === 0) {
                return (
                  <div className="flex flex-col items-center justify-center py-16 px-4 text-center rounded-lg border border-dashed border-border bg-card/50">
                    <div className="size-10 rounded-full bg-secondary flex items-center justify-center text-muted-foreground mb-3">
                      <Search className="size-4" />
                    </div>
                    <p className="text-sm font-semibold text-foreground">
                      No matching workloads found
                    </p>
                    <p className="text-xs text-muted-foreground mt-1 max-w-sm">
                      {searchQuery ? `No results found for "${searchQuery}". Try searching by another keyword or reset the filter.` : 'There are currently no active workloads in this category.'}
                    </p>
                    {searchQuery && (
                      <Button size="sm" onClick={() => setSearchQuery('')} className="mt-4">
                        Clear search filter
                      </Button>
                    )}
                  </div>
                );
              }

              return elements;
            })()}
          </div>
        </div>
      </div>

      {/* Edit Container Dialog */}
      <Dialog open={!!editingSession} onOpenChange={(o) => { if (!o) setEditingSession(null); }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Edit3 className="size-4 text-muted-foreground" /> Edit container configuration
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-3 text-xs">
            <div>
              <label className={fieldLabel}>Docker image URI</label>
              <Input
                type="text"
                value={editImage}
                onChange={(e) => setEditImage(e.target.value)}
                className="w-full text-xs font-mono"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={fieldLabel}>Container port</label>
                <Input
                  type="number"
                  value={editPort}
                  onChange={(e) => setEditPort(e.target.value)}
                  className="w-full text-xs font-mono"
                />
              </div>
              <div>
                <label className={fieldLabel}>Host port</label>
                <Input
                  type="number"
                  value={editHostPort}
                  onChange={(e) => setEditHostPort(e.target.value)}
                  className="w-full text-xs font-mono"
                />
              </div>
            </div>

            <div>
              <label className={fieldLabel}>Environment variables</label>
              <Textarea
                value={editEnv}
                onChange={(e) => setEditEnv(e.target.value)}
                rows={4}
                placeholder="KEY=VALUE"
                className="w-full font-mono text-xs resize-y"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingSession(null)}>
              Cancel
            </Button>
            <Button onClick={saveEditedContainer} disabled={loading}>
              {loading ? 'Redeploying...' : 'Save & redeploy'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}