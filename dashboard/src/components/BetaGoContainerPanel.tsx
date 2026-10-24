import React, { useState, useEffect, useRef } from 'react';
import { api, BASE } from '../api';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { SessionControls, EventsTab, SettingsTab, VolumesCard } from './GoContainerExtras';
import { Activity, SlidersHorizontal } from 'lucide-react';
import { X, Inbox, FolderOpen, ScrollText, RefreshCw, TriangleAlert, Box, Layers, HardDrive, History, Loader2, Circle, CircleCheck, CircleX, CircleDot, ChevronDown, ChevronRight, Settings2, Rocket, Search } from 'lucide-react';

interface ServiceSessionMetadata {
  serviceName: string;
  port: number;
  hostPort: number;
  domainMode: string;
  customDomain?: string;
  cloudflaredUrl?: string;
  tunnelPid?: number;
  tunnelToken?: string;
  tunnelId?: string;
  status?: string;
  exitCode?: number;
  health?: string;
  tunnelStatus?: string;
}

interface GoSession {
  id: string;
  type: string;
  url: string;
  startedAt: string;
  metadata?: {
    port?: number;
    hostPort?: number;
    containerName?: string;
    image?: string;
    env?: Record<string, string>;
    domainMode?: 'quick' | 'custom';
    customDomain?: string;
    cloudflaredUrl?: string;
    webhookSecret?: string;
    tunnelToken?: string;
    tunnelId?: string;
    composeFile?: string;
    services?: Record<string, ServiceSessionMetadata>;
    status?: string;
    exitCode?: number;
    health?: string;
    tunnelStatus?: string;
    ports?: { host: number; container: number; protocol: string }[];
    volumes?: { source: string; destination: string; readOnly: boolean }[];
    memoryLimitMB?: number;
    cpus?: number;
    restartPolicy?: string;
    command?: string[];
    args?: string[];
    yaml?: string;
    serviceSettings?: Record<string, any>;
    desired?: string;
    restartCount?: number;
    oomKilled?: boolean;
    statusSince?: string;
    agentReadToken?: string;
    agentWriteToken?: string;
  };
}

interface ServiceConfig {
  image: string;
  ports: string[];
  environment: Record<string, string>;
  volumes: string[];
  labels: Record<string, string>;
}

interface NormalizedCompose {
  version: string;
  services: Record<string, ServiceConfig>;
  volumes: string[];
}

interface DeploymentRecord {
  id: string;
  sessionId: string;
  type: string;
  timestamp: string;
  status: 'success' | 'failed';
  logs?: string[];
  error?: string;
  config?: any;
}

interface JobStatus {
  id: string;
  status: 'running' | 'done' | 'error';
  phase: 'validating' | 'pulling' | 'starting' | 'tunneling' | 'completed' | 'failed';
  logs: string[];
  result?: string;
  error?: string;
}

export default function BetaGoContainerPanel() {
  const [sessions, setSessions] = useState<GoSession[]>([]);
  const [deployments, setDeployments] = useState<DeploymentRecord[]>([]);
  const [volumeBackups, setVolumeBackups] = useState<string[]>([]);
  const [daemonOnline, setDaemonOnline] = useState(true);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState('');
  const [activeTab, setActiveTab] = useState<'single' | 'compose' | 'backups' | 'history' | 'events' | 'settings'>('single');

  // Single Workload Deploy States
  const [image, setImage] = useState('');
  const [port, setPort] = useState('80');
  const [name, setName] = useState('');
  const [env, setEnv] = useState('');
  const [domainMode, setDomainMode] = useState<'quick' | 'custom'>('quick');
  const [customDomain, setCustomDomain] = useState('');
  const [hostPort, setHostPort] = useState('');
  
  // Advanced Deploy States
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [extraPorts, setExtraPorts] = useState<{ host: string; container: string; protocol: 'tcp' | 'udp' }[]>([]);
  const [extraVolumes, setExtraVolumes] = useState<{ source: string; destination: string; readOnly: boolean }[]>([]);
  const [memoryLimit, setMemoryLimit] = useState('');
  const [cpuLimit, setCpuLimit] = useState('');
  const [restartPolicy, setRestartPolicy] = useState('unless-stopped');
  const [registryAuth, setRegistryAuth] = useState({ server: '', username: '', password: '' });
  const [commandInput, setCommandInput] = useState('');
  const [argsInput, setArgsInput] = useState('');

  // Compose Deploy States
  const [yamlInput, setYamlInput] = useState<string>(`version: "3.8"
services:
  web:
    image: nginx:alpine
    ports:
      - "80:80"
    environment:
      - PORT=80
      - APP_ENV=production
    volumes:
      - web_data:/usr/share/nginx/html
  db:
    image: postgres:15-alpine
    environment:
      POSTGRES_DB: main_db
      POSTGRES_USER: postgres
    volumes:
      - db_data:/var/lib/postgresql/data
volumes:
  web_data:
  db_data:`);
  const [parsedCompose, setParsedCompose] = useState<NormalizedCompose | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [isParsing, setIsParsing] = useState<boolean>(false);
  const [serviceSettings, setServiceSettings] = useState<Record<string, {
    domainMode: 'none' | 'quick' | 'custom';
    customDomain: string;
    env: Record<string, string>;
  }>>({});

  // Stats State
  const [stats, setStats] = useState<Record<string, any>>({});

  // Active Job Polling (Stepper)
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null);

  // Modal logs state
  const [logsSession, setLogsSession] = useState<GoSession | null>(null);
  const [logsService, setLogsService] = useState<string>('');
  const [logsLines, setLogsLines] = useState<string[]>([]);
  const [followLogs, setFollowLogs] = useState(true);
  const logStreamRef = useRef<EventSource | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  // Inspect Modal
  const [inspectData, setInspectData] = useState<any>(null);
  const [inspectTitle, setInspectTitle] = useState('');

  // Backups tab states
  const [backupVolumeInput, setBackupVolumeInput] = useState('');
  const [backupLoading, setBackupLoading] = useState(false);

  // Edit / Redeploy Modal
  const [editingSession, setEditingSession] = useState<GoSession | null>(null);
  const [search, setSearch] = useState('');
  const matches = (sess: GoSession) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    const m = sess.metadata;
    return [sess.id, m?.containerName, m?.image, m?.status, sess.url].some(v => (v || '').toLowerCase().includes(q));
  };

  const loadSessions = async () => {
    try {
      const data = await api.getGoSessions();
      setSessions(data || []);
      setDaemonOnline(true);
    } catch (err) {
      console.error('Failed to load Go sessions:', err);
      setDaemonOnline(false);
    }
  };

  const loadHistory = async () => {
    try {
      const data = await api.getGoDeployments();
      setDeployments(data || []);
    } catch (err) {
      console.error('Failed to load deployment history:', err);
    }
  };

  const loadBackups = async () => {
    try {
      const data = await api.listGoVolumeBackups();
      setVolumeBackups(data.backups || []);
    } catch (err) {
      console.error('Failed to load backups list:', err);
    }
  };

  // Poll sessions and stats
  useEffect(() => {
    loadSessions();
    const interval = setInterval(loadSessions, 5000);
    return () => clearInterval(interval);
  }, []);

  // Poll stats for active sessions
  useEffect(() => {
    const fetchAllStats = async () => {
      if (!daemonOnline || sessions.length === 0) return;
      for (const s of sessions) {
        try {
          const sStats = await api.getGoContainerStats(s.id);
          if (sStats && sStats.length > 0) {
            setStats(prev => ({ ...prev, [s.id]: sStats }));
          }
        } catch (e) {
          // ignore transient stats error
        }
      }
    };

    fetchAllStats();
    const statsInterval = setInterval(fetchAllStats, 10000);
    return () => clearInterval(statsInterval);
  }, [sessions, daemonOnline]);

  // Job Polling
  useEffect(() => {
    if (!activeJobId) return;

    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const status = await api.getGoJobStatus(activeJobId);
        setJobStatus(status);

        if (status.status === 'done' || status.status === 'error') {
          setActiveJobId(null);
          setLoading(false);
          if (status.status === 'done') {
            setResult(`Deploy completed successfully!`);
          } else {
            setResult(`Deploy failed: ${status.error}`);
          }
          loadSessions();
          loadHistory();
        } else {
          timer = setTimeout(poll, 1500);
        }
      } catch (err: any) {
        console.error('Failed to poll job status:', err);
        setActiveJobId(null);
        setLoading(false);
      }
    };

    poll();
    return () => clearTimeout(timer);
  }, [activeJobId]);

  // Handle SSE log follow
  useEffect(() => {
    if (!logsSession) return;
    if (!followLogs) {
      if (logStreamRef.current) {
        logStreamRef.current.close();
        logStreamRef.current = null;
      }
      return;
    }

    setLogsLines([]);
    const token = localStorage.getItem('dashboard_token') || '';
    const svcParam = logsService ? `&service=${encodeURIComponent(logsService)}` : '';
    const url = `${BASE}/api/go/containers/logs?sessionId=${encodeURIComponent(logsSession.id)}&follow=true&tail=150${svcParam}&token=${encodeURIComponent(token)}`;

    const es = new EventSource(url);
    logStreamRef.current = es;

    es.onmessage = (event) => {
      setLogsLines(prev => {
        const next = [...prev, event.data];
        if (next.length > 500) {
          return next.slice(next.length - 500);
        }
        return next;
      });
    };

    es.onerror = () => {
      setLogsLines(prev => [...prev, 'Real-time stream connection ended']);
      es.close();
    };

    return () => {
      es.close();
      if (logStreamRef.current === es) {
        logStreamRef.current = null;
      }
    };
  }, [logsSession, logsService, followLogs]);

  // Auto-scroll logs
  useEffect(() => {
    if (logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logsLines]);

  const loadStaticLogs = async () => {
    if (!logsSession) return;
    setLogsLines(['Fetching log history...']);
    try {
      const svcParam = logsService ? `&service=${encodeURIComponent(logsService)}` : '';
      const res = await fetch(`${BASE}/api/go/containers/logs?sessionId=${encodeURIComponent(logsSession.id)}&follow=false&tail=200${svcParam}`, {
        headers: {
          'Authorization': `Basic ${localStorage.getItem('dashboard_token') || ''}`
        }
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      setLogsLines(data.lines || []);
    } catch (e: any) {
      setLogsLines([`Failed to load logs: ${e.message}`]);
    }
  };

  useEffect(() => {
    if (logsSession && !followLogs) {
      loadStaticLogs();
    }
  }, [logsSession, logsService, followLogs]);

  const handleDeploy = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!image) return setResult('Please enter a Docker Image URI');
    const portNum = parseInt(port, 10);
    if (isNaN(portNum) || portNum <= 0) return setResult('Invalid container port');
    
    setLoading(true);
    setResult('');
    setJobStatus(null);

    try {
      const envObj: Record<string, string> = {};
      env.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx !== -1) {
          envObj[trimmed.substring(0, eqIdx).trim()] = trimmed.substring(eqIdx + 1).trim();
        }
      });

      const parsedPorts = extraPorts.map(p => ({
        host: parseInt(p.host, 10),
        container: parseInt(p.container, 10),
        protocol: p.protocol
      })).filter(p => !isNaN(p.host) && !isNaN(p.container));

      const parsedVolumes = extraVolumes.map(v => ({
        source: v.source.trim(),
        destination: v.destination.trim(),
        readOnly: v.readOnly
      })).filter(v => v.source !== '' && v.destination !== '');

      const payload: any = {
        image,
        port: portNum,
        env: envObj,
        name: name || undefined,
        domainMode,
        customDomain: domainMode === 'custom' ? customDomain : undefined,
        hostPort: hostPort ? parseInt(hostPort, 10) : undefined,
        ports: parsedPorts.length > 0 ? parsedPorts : undefined,
        volumes: parsedVolumes.length > 0 ? parsedVolumes : undefined,
        memoryLimitMB: memoryLimit ? parseInt(memoryLimit, 10) : undefined,
        cpus: cpuLimit ? parseFloat(cpuLimit) : undefined,
        restartPolicy: restartPolicy || undefined,
        registryAuth: registryAuth.username ? registryAuth : undefined,
        command: commandInput ? commandInput.split(' ').filter(Boolean) : undefined,
        args: argsInput ? argsInput.split(' ').filter(Boolean) : undefined,
      };

      const res = await api.startGoDocker(payload);
      if (res.error) throw new Error(res.error);

      if (res.jobId) {
        setActiveJobId(res.jobId);
        setResult(`Deployment job created. Polling progress...`);
      } else {
        setResult(`Go Container started!`);
        loadSessions();
      }
    } catch (err: any) {
      setResult(`Error: ${err.message}`);
      setLoading(false);
    }
  };

  const handleStop = async (sessionId: string) => {
    if (!confirm(`Remove ${sessionId}? This stops the container(s), deletes the Cloudflare tunnel and forgets the session. Use Stop instead to keep it.`)) return;
    setLoading(true);
    setResult('');
    try {
      const res = await api.stopGoDocker(sessionId);
      if (res.success) {
        setResult(`${res.message}`);
      } else {
        setResult(`${res.message}`);
      }
      await loadSessions();
      loadHistory();
    } catch (err: any) {
      setResult(`Error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleParseYAML = async () => {
    setIsParsing(true);
    setParseError(null);
    try {
      const data = await api.parseCompose(yamlInput);
      setParsedCompose(data);
      setResult('Successfully parsed Compose configuration!');

      const initialSettings: typeof serviceSettings = {};
      Object.entries(data.services).forEach(([sName, svc]: [string, any]) => {
        initialSettings[sName] = {
          domainMode: 'none',
          customDomain: '',
          env: { ...svc.environment }
        };
      });
      setServiceSettings(initialSettings);
    } catch (e: any) {
      setParseError(e.message);
      setParsedCompose(null);
      setResult(`Parse error: ${e.message}`);
    } finally {
      setIsParsing(false);
    }
  };

  const handleServiceSettingChange = (serviceName: string, field: string, value: any) => {
    setServiceSettings(prev => ({
      ...prev,
      [serviceName]: {
        ...prev[serviceName],
        [field]: value
      }
    }));
  };

  const handleServiceEnvChange = (serviceName: string, envKey: string, value: string) => {
    setServiceSettings(prev => ({
      ...prev,
      [serviceName]: {
        ...prev[serviceName],
        env: {
          ...prev[serviceName].env,
          [envKey]: value
        }
      }
    }));
  };

  const handleDeployCompose = async () => {
    setLoading(true);
    setResult('');
    setJobStatus(null);
    try {
      const res = await api.deployCompose(yamlInput, serviceSettings);
      if (res.error) throw new Error(res.error);
      if (res.jobId) {
        setActiveJobId(res.jobId);
        setResult(`Compose Stack Deployment job created. Polling progress...`);
      } else {
        setResult(`Compose stack deployed successfully!`);
        loadSessions();
      }
    } catch (err: any) {
      setResult(`Error: ${err.message}`);
      setLoading(false);
    }
  };

  const startEditing = (session: GoSession) => {
    setEditingSession(session);
    setImage(session.metadata?.image || '');
    setPort(session.metadata?.port?.toString() || '80');
    setHostPort(session.metadata?.hostPort?.toString() || '');
    
    let nameVal = '';
    if (session.metadata?.containerName) {
      const parts = session.metadata.containerName.split('-');
      if (parts.length >= 4) {
        nameVal = parts.slice(2, parts.length - 1).join('-');
      }
    }
    setName(nameVal);
    
    setDomainMode(session.metadata?.domainMode || 'quick');
    setCustomDomain(session.metadata?.customDomain || '');
    
    const envObj = session.metadata?.env || {};
    const envStr = Object.entries(envObj)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    setEnv(envStr);

    // Populate advanced fields
    setExtraPorts((session.metadata?.ports || []).map(p => ({
      host: p.host.toString(),
      container: p.container.toString(),
      protocol: p.protocol as 'tcp' | 'udp'
    })));
    setExtraVolumes((session.metadata?.volumes || []).map(v => ({
      source: v.source,
      destination: v.destination,
      readOnly: v.readOnly
    })));
    setMemoryLimit(session.metadata?.memoryLimitMB?.toString() || '');
    setCpuLimit(session.metadata?.cpus?.toString() || '');
    setRestartPolicy(session.metadata?.restartPolicy || 'unless-stopped');
    setCommandInput(session.metadata?.command?.join(' ') || '');
    setArgsInput(session.metadata?.args?.join(' ') || '');
  };

  const handleSaveEdit = async () => {
    if (!editingSession) return;
    if (!image) return setResult('Please enter a Docker Image URI');
    const portNum = parseInt(port, 10);
    if (isNaN(portNum) || portNum <= 0) return setResult('Invalid container port');

    setLoading(true);
    setResult('');
    setJobStatus(null);
    try {
      const envObj: Record<string, string> = {};
      env.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx !== -1) {
          envObj[trimmed.substring(0, eqIdx).trim()] = trimmed.substring(eqIdx + 1).trim();
        }
      });

      const parsedPorts = extraPorts.map(p => ({
        host: parseInt(p.host, 10),
        container: parseInt(p.container, 10),
        protocol: p.protocol
      })).filter(p => !isNaN(p.host) && !isNaN(p.container));

      const parsedVolumes = extraVolumes.map(v => ({
        source: v.source.trim(),
        destination: v.destination.trim(),
        readOnly: v.readOnly
      })).filter(v => v.source !== '' && v.destination !== '');

      const payload: any = {
        image,
        port: portNum,
        env: envObj,
        name: name || undefined,
        domainMode,
        customDomain: domainMode === 'custom' ? customDomain : undefined,
        hostPort: hostPort ? parseInt(hostPort, 10) : undefined,
        ports: parsedPorts.length > 0 ? parsedPorts : undefined,
        volumes: parsedVolumes.length > 0 ? parsedVolumes : undefined,
        memoryLimitMB: memoryLimit ? parseInt(memoryLimit, 10) : undefined,
        cpus: cpuLimit ? parseFloat(cpuLimit) : undefined,
        restartPolicy: restartPolicy || undefined,
        registryAuth: registryAuth.username ? registryAuth : undefined,
        command: commandInput ? commandInput.split(' ').filter(Boolean) : undefined,
        args: argsInput ? argsInput.split(' ').filter(Boolean) : undefined,
        sessionId: editingSession.id
      };

      const res = await api.startGoDocker(payload);
      if (res.error) throw new Error(res.error);
      
      if (res.jobId) {
        setActiveJobId(res.jobId);
        setResult(`Redeployment job created. Polling progress...`);
      } else {
        setResult(`Go Container redeployed successfully!`);
        loadSessions();
      }
      setEditingSession(null);
    } catch (err: any) {
      setResult(`Error: ${err.message}`);
      setLoading(false);
    }
  };

  const handleInspect = async (sessionID: string, serviceName?: string) => {
    try {
      const data = await api.inspectGoContainer(sessionID, serviceName);
      setInspectData(data);
      setInspectTitle(serviceName ? `Inspect Service: ${serviceName}` : `Inspect Container: ${sessionID}`);
    } catch (err: any) {
      alert(`Failed to inspect container: ${err.message}`);
    }
  };

  const handleBackupVolume = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!backupVolumeInput) return;
    setBackupLoading(true);
    setResult('');
    try {
      const res = await api.backupGoVolume(backupVolumeInput);
      setResult(`${res.message}`);
      setBackupVolumeInput('');
      loadBackups();
    } catch (err: any) {
      setResult(`Failed to backup: ${err.message}`);
    } finally {
      setBackupLoading(false);
    }
  };

  const handleRestoreVolume = async (volName: string) => {
    if (!confirm(`Are you sure you want to restore the volume '${volName}'? This will overwrite existing local data for this volume.`)) return;
    setBackupLoading(true);
    setResult('');
    try {
      const res = await api.restoreGoVolume(volName);
      setResult(`${res.message}`);
    } catch (err: any) {
      setResult(`Failed to restore: ${err.message}`);
    } finally {
      setBackupLoading(false);
    }
  };

  const handleRollback = async (deploymentId: string) => {
    if (!confirm(`Are you sure you want to rollback to this deployment version?`)) return;
    setLoading(true);
    setResult('');
    setJobStatus(null);
    try {
      const res = await api.rollbackGoContainer(deploymentId);
      if (res.jobId) {
        setActiveJobId(res.jobId);
        setResult(`Rollback job created. Polling progress...`);
      } else {
        setResult(`Rollback completed successfully!`);
        loadSessions();
      }
    } catch (err: any) {
      setResult(`Rollback failed: ${err.message}`);
      setLoading(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setResult('Copied to clipboard!');
    setTimeout(() => setResult(''), 2000);
  };

  // Trigger loading dependent tabs when activeTab changes
  useEffect(() => {
    if (activeTab === 'history') {
      loadHistory();
    } else if (activeTab === 'backups') {
      loadBackups();
    }
  }, [activeTab]);

  return (
    <div className="space-y-6 text-[13px] text-foreground">
      {/* Offline Warning Banner */}
      {!daemonOnline && (
        <div className="rounded-lg p-4 border border-destructive/30 bg-destructive/10 flex items-center gap-3">
          <TriangleAlert className="size-4 text-destructive shrink-0" />
          <div>
            <div className="font-semibold text-destructive">Go Container Manager offline</div>
            <div className="text-xs text-muted-foreground">The daemon process on port 18080 is unreachable. Ensure the backend Go server is running.</div>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-3">
        <p className="text-muted-foreground">
          Enterprise Container Panel managed by the Go service daemon on port 18080.
        </p>

        {/* Tab switcher */}
        <div className="flex flex-wrap gap-1 border-b border-border pb-3">
          {([
            ['single', Box, 'Single container'],
            ['compose', Layers, 'Compose stacks'],
            ['backups', HardDrive, 'Volume backups (R2)'],
            ['history', History, 'Deployment history'],
            ['events', Activity, 'Events & audit'],
            ['settings', SlidersHorizontal, 'Alerts & settings'],
          ] as const).map(([key, Icon, label]) => (
            <Button
              key={key}
              onClick={() => setActiveTab(key)}
              variant={activeTab === key ? 'secondary' : 'ghost'}
              size="sm"
              className={activeTab === key ? 'text-foreground' : ''}
            >
              <Icon /> {label}
            </Button>
          ))}
        </div>

        {(activeTab === 'single' || activeTab === 'compose') && (
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter by name, image, status…" className="text-xs max-w-sm" />
        )}

        {/* Status/Result Alert Box */}
        {result && (
          <div className="rounded-lg p-3 border border-border bg-secondary/40 animate-in slide-in-from-top-2 flex justify-between items-center gap-2">
            <pre className="text-xs text-foreground whitespace-pre-wrap font-mono m-0">{result}</pre>
            <Button onClick={() => setResult('')} variant="ghost" size="icon-xs" aria-label="Dismiss"><X /></Button>
          </div>
        )}

        {/* Live Stepper Job Progress */}
        {jobStatus && (
          <div className="rounded-lg p-4 border border-border bg-card space-y-4 animate-in slide-in-from-top-3">
            <div className="flex justify-between items-center">
              <span className="font-semibold text-xs flex items-center gap-1.5">
                <Loader2 className="size-3.5 animate-spin text-primary" /> Active deployment ({jobStatus.id})
              </span>
              <Badge variant={jobStatus.status === 'error' ? 'destructive' : 'default'} className="capitalize">
                {jobStatus.status}
              </Badge>
            </div>

            {/* Steps Visualizer */}
            <div className="grid grid-cols-5 gap-2 text-center text-[11px] font-medium text-muted-foreground select-none">
              {(['validating', 'pulling', 'starting', 'tunneling', 'completed'] as const).map((step, idx) => {
                const phases = ['validating', 'pulling', 'starting', 'tunneling', 'completed'];
                const curIdx = phases.indexOf(jobStatus.phase);
                const stepIdx = phases.indexOf(step);

                let badgeColor = 'bg-secondary text-muted-foreground border-border';
                let StepIcon = Circle;
                if (jobStatus.phase === 'failed' && stepIdx === curIdx) {
                  badgeColor = 'bg-destructive/10 text-destructive border-destructive/30';
                  StepIcon = CircleX;
                } else if (stepIdx < curIdx || jobStatus.phase === 'completed') {
                  badgeColor = 'bg-primary/10 text-primary border-primary/30';
                  StepIcon = CircleCheck;
                } else if (stepIdx === curIdx) {
                  badgeColor = 'bg-primary/15 text-primary border-primary/30 animate-pulse';
                  StepIcon = CircleDot;
                }

                return (
                  <div key={step} className={`p-2.5 rounded-md border flex flex-col items-center gap-1.5 ${badgeColor}`}>
                    <StepIcon className="size-4" />
                    <span className="truncate w-full">{step === 'completed' ? 'ready' : step}</span>
                  </div>
                );
              })}
            </div>

            {/* Stepper mini-console */}
            <div className="bg-[#0b0c0e] border border-border rounded-md p-3.5 font-mono text-[11px] text-primary h-40 overflow-y-auto space-y-1 scrollbar-thin">
              {jobStatus.logs.map((logLine, idx) => (
                <div key={idx} className="leading-relaxed">{logLine}</div>
              ))}
            </div>
          </div>
        )}
      </div>

      {activeTab === 'single' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 animate-in fade-in duration-200">
          {/* Left: Deploy Form */}
          <div className="lg:col-span-5 space-y-6">
            <Card className="p-5 space-y-4">
              <CardHeader className="p-0">
                <CardTitle className="text-sm font-semibold tracking-tight flex items-center gap-2">
                  <Box className="size-4" /> Single container launch
                </CardTitle>
                <CardDescription className="text-xs text-muted-foreground">
                  Deploy standalone containers with rich networks, mounts, and limits.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0 space-y-3.5">
                <div>
                  <label className="text-xs font-medium text-muted-foreground block mb-1">Docker image URI</label>
                  <Input
                    type="text"
                    value={image}
                    onChange={(e) => setImage(e.target.value)}
                    placeholder="e.g. nginx:alpine"
                    className="text-xs"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground block mb-1">Container port</label>
                    <Input
                      type="number"
                      value={port}
                      onChange={(e) => setPort(e.target.value)}
                      className="text-xs"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground block mb-1">Host port (optional)</label>
                    <Input
                      type="number"
                      value={hostPort}
                      onChange={(e) => setHostPort(e.target.value)}
                      placeholder="Auto-allocated if blank"
                      className="text-xs"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground block mb-1">Tunnel mode</label>
                    <select
                      value={domainMode}
                      onChange={(e) => setDomainMode(e.target.value as 'quick' | 'custom')}
                      className="w-full h-8 px-3 rounded-md bg-card border border-input text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary/25"
                    >
                      <option value="quick">Quick Tunnel</option>
                      <option value="custom">Custom subdomain</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground block mb-1">Instance name</label>
                    <Input
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="custom-app"
                      className="text-xs"
                    />
                  </div>
                </div>

                {domainMode === 'custom' && (
                  <div className="animate-in fade-in duration-150">
                    <label className="text-xs font-medium text-muted-foreground block mb-1">Custom domain</label>
                    <Input
                      type="text"
                      value={customDomain}
                      onChange={(e) => setCustomDomain(e.target.value)}
                      placeholder="sub.domain.com"
                      className="text-xs"
                    />
                  </div>
                )}

                {/* Advanced Collapsible Section */}
                <div className="border-t border-border pt-3">
                  <button
                    type="button"
                    onClick={() => setShowAdvanced(!showAdvanced)}
                    className="flex justify-between items-center w-full text-xs font-medium text-muted-foreground hover:text-foreground"
                  >
                    <span className="flex items-center gap-1.5"><Settings2 className="size-3.5" /> Advanced configuration</span>
                    {showAdvanced ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                  </button>

                  {showAdvanced && (
                    <div className="space-y-4 pt-3.5 animate-in slide-in-from-top-2 duration-150">
                      {/* Resource limits */}
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="text-xs font-medium text-muted-foreground block mb-1">Memory limit (MB)</label>
                          <Input
                            type="number"
                            value={memoryLimit}
                            onChange={(e) => setMemoryLimit(e.target.value)}
                            placeholder="e.g. 512"
                            className="text-xs"
                          />
                        </div>
                        <div>
                          <label className="text-xs font-medium text-muted-foreground block mb-1">CPU cores limit</label>
                          <Input
                            type="number"
                            step="0.1"
                            value={cpuLimit}
                            onChange={(e) => setCpuLimit(e.target.value)}
                            placeholder="e.g. 0.5"
                            className="text-xs"
                          />
                        </div>
                      </div>

                      {/* Restart Policy */}
                      <div>
                        <label className="text-xs font-medium text-muted-foreground block mb-1">Restart policy</label>
                        <select
                          value={restartPolicy}
                          onChange={(e) => setRestartPolicy(e.target.value)}
                          className="w-full h-8 px-3 rounded-md bg-card border border-input text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary/25"
                        >
                          <option value="no">Do not restart</option>
                          <option value="always">Always restart</option>
                          <option value="unless-stopped">Unless stopped</option>
                          <option value="on-failure">On failure</option>
                        </select>
                      </div>

                      {/* Command / Args */}
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="text-xs font-medium text-muted-foreground block mb-1">Command overrides</label>
                          <Input
                            type="text"
                            value={commandInput}
                            onChange={(e) => setCommandInput(e.target.value)}
                            placeholder="e.g. sh -c"
                            className="text-xs"
                          />
                        </div>
                        <div>
                          <label className="text-xs font-medium text-muted-foreground block mb-1">Args</label>
                          <Input
                            type="text"
                            value={argsInput}
                            onChange={(e) => setArgsInput(e.target.value)}
                            placeholder="e.g. run-app"
                            className="text-xs"
                          />
                        </div>
                      </div>

                      {/* Multi ports */}
                      <div className="space-y-2">
                        <label className="text-xs font-medium text-muted-foreground block">Extra port mappings</label>
                        {extraPorts.map((p, idx) => (
                          <div key={idx} className="flex gap-2 items-center">
                            <Input
                              type="number"
                              placeholder="Host"
                              value={p.host}
                              onChange={(e) => {
                                const copy = [...extraPorts];
                                copy[idx].host = e.target.value;
                                setExtraPorts(copy);
                              }}
                              className="text-xs w-24"
                            />
                            <span className="text-muted-foreground">→</span>
                            <Input
                              type="number"
                              placeholder="Container"
                              value={p.container}
                              onChange={(e) => {
                                const copy = [...extraPorts];
                                copy[idx].container = e.target.value;
                                setExtraPorts(copy);
                              }}
                              className="text-xs w-24"
                            />
                            <select
                              value={p.protocol}
                              onChange={(e) => {
                                const copy = [...extraPorts];
                                copy[idx].protocol = e.target.value as 'tcp' | 'udp';
                                setExtraPorts(copy);
                              }}
                              className="bg-card border border-input rounded-md h-8 px-2 text-xs outline-none focus:border-primary"
                            >
                              <option value="tcp">TCP</option>
                              <option value="udp">UDP</option>
                            </select>
                            <Button
                              onClick={() => setExtraPorts(extraPorts.filter((_, i) => i !== idx))}
                              variant="ghost"
                              size="icon-sm"
                              className="text-destructive hover:text-destructive"
                            >
                              <X />
                            </Button>
                          </div>
                        ))}
                        <Button
                          type="button"
                          onClick={() => setExtraPorts([...extraPorts, { host: '', container: '', protocol: 'tcp' }])}
                          variant="outline"
                          size="sm" className="w-full"
                        >
                          + Add port mapping
                        </Button>
                      </div>

                      {/* Volumes */}
                      <div className="space-y-2">
                        <label className="text-xs font-medium text-muted-foreground block">Volume mounts</label>
                        {extraVolumes.map((v, idx) => (
                          <div key={idx} className="flex gap-2 items-center flex-wrap">
                            <Input
                              placeholder="Source Volume/Path"
                              value={v.source}
                              onChange={(e) => {
                                const copy = [...extraVolumes];
                                copy[idx].source = e.target.value;
                                setExtraVolumes(copy);
                              }}
                              className="text-xs flex-1 min-w-[120px]"
                            />
                            <span className="text-muted-foreground">:</span>
                            <Input
                              placeholder="Destination Path"
                              value={v.destination}
                              onChange={(e) => {
                                const copy = [...extraVolumes];
                                copy[idx].destination = e.target.value;
                                setExtraVolumes(copy);
                              }}
                              className="text-xs flex-1 min-w-[120px]"
                            />
                            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                              <input
                                type="checkbox"
                                checked={v.readOnly}
                                onChange={(e) => {
                                  const copy = [...extraVolumes];
                                  copy[idx].readOnly = e.target.checked;
                                  setExtraVolumes(copy);
                                }}
                                className="rounded border-border accent-primary"
                              />
                              RO
                            </label>
                            <Button
                              onClick={() => setExtraVolumes(extraVolumes.filter((_, i) => i !== idx))}
                              variant="ghost"
                              size="icon-sm"
                              className="text-destructive hover:text-destructive"
                            >
                              <X />
                            </Button>
                          </div>
                        ))}
                        <Button
                          type="button"
                          onClick={() => setExtraVolumes([...extraVolumes, { source: '', destination: '', readOnly: false }])}
                          variant="outline"
                          size="sm" className="w-full"
                        >
                          + Add volume mount
                        </Button>
                      </div>

                      {/* Registry login */}
                      <div className="border-t border-border pt-3 space-y-2">
                        <label className="text-xs font-medium text-muted-foreground block">Private registry login (required for private images)</label>
                        <div className="grid grid-cols-3 gap-2">
                          <Input
                            placeholder="Server URL"
                            value={registryAuth.server}
                            onChange={(e) => setRegistryAuth({ ...registryAuth, server: e.target.value })}
                            className="text-xs col-span-1"
                          />
                          <Input
                            placeholder="Username"
                            value={registryAuth.username}
                            onChange={(e) => setRegistryAuth({ ...registryAuth, username: e.target.value })}
                            className="text-xs col-span-1"
                          />
                          <Input
                            type="password"
                            placeholder="Password"
                            value={registryAuth.password}
                            onChange={(e) => setRegistryAuth({ ...registryAuth, password: e.target.value })}
                            className="text-xs col-span-1"
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Env block */}
                <div>
                  <label className="text-xs font-medium text-muted-foreground block mb-1">Environment variables (KEY=VALUE)</label>
                  <textarea
                    value={env}
                    onChange={(e) => setEnv(e.target.value)}
                    placeholder="PORT=80&#10;NODE_ENV=production"
                    rows={3}
                    className="w-full px-3 py-2 rounded-md bg-card border border-input text-foreground text-xs font-mono outline-none focus:border-primary focus:ring-2 focus:ring-primary/25 transition-colors"
                  />
                </div>

                <Button
                  onClick={handleDeploy}
                  disabled={loading || !daemonOnline}
                  className="w-full"
                >
                  {loading ? 'Deploying...' : 'Deploy container'}
                </Button>
              </CardContent>
            </Card>
          </div>

          {/* Right: Workload List */}
          <div className="lg:col-span-7 rounded-lg border border-border bg-card overflow-hidden flex flex-col h-full min-h-[500px]">
            <div className="px-4 py-3 border-b border-border bg-secondary/40 flex justify-between items-center">
              <h3 className="text-sm font-semibold tracking-tight">Active single workloads ({sessions.filter(s => s.type === 'docker-container').length})</h3>
              <Button onClick={loadSessions} variant="outline" size="sm">
                <RefreshCw /> Reload
              </Button>
            </div>

            <div className="p-5 flex-1 overflow-y-auto space-y-4 max-h-[70vh] scrollbar-thin">
              {sessions.filter(s => s.type === 'docker-container' && matches(s)).map((sess) => {
                const sStats = stats[sess.id]?.[0];
                return (
                  <div key={sess.id} className="rounded-lg p-4 border border-border bg-card hover:bg-secondary/30 transition-colors group relative">
                    <div className="flex flex-col gap-3">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0 space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <Box className="size-4 text-muted-foreground shrink-0" />
                            <span className="font-semibold truncate">
                              {sess.metadata?.containerName || `${sess.id}`}
                            </span>
                            <Badge variant={sess.metadata?.status === 'running' ? 'default' : 'destructive'} className="capitalize">
                              {sess.metadata?.status || 'unknown'} {sess.metadata?.exitCode !== undefined && sess.metadata.exitCode !== 0 ? `(Code ${sess.metadata.exitCode})` : ''}
                            </Badge>
                            {sess.metadata?.health && (
                              <Badge variant={sess.metadata.health === 'healthy' ? 'default' : 'secondary'}>
                                {sess.metadata.health}
                              </Badge>
                            )}
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
                            <div>
                              Image: <span className="text-foreground font-mono text-[11px]">{sess.metadata?.image}</span>
                            </div>
                            <div>
                              Started: <span className="text-foreground">{new Date(sess.startedAt).toLocaleString()}</span>
                            </div>
                            <div className="col-span-1 sm:col-span-2">
                              Public tunnel: <a href={sess.metadata?.cloudflaredUrl || sess.url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline font-mono text-[11px]">
                                {sess.metadata?.cloudflaredUrl || sess.url}
                              </a>
                            </div>
                            <div>
                              Ports: <span className="text-foreground font-mono">{sess.metadata?.hostPort} → {sess.metadata?.port}</span>
                            </div>
                            <div>
                              Domain mode: <span className="text-foreground capitalize">{sess.metadata?.domainMode}</span>
                            </div>
                          </div>
                        </div>

                        {/* Top-Right action buttons */}
                        <div className="flex flex-wrap justify-end gap-1.5">
                          <Button
                            onClick={() => { setLogsSession(sess); setLogsService(''); setFollowLogs(true); }}
                            variant="outline" size="sm"
                          >
                            Logs
                          </Button>
                          <Button
                            onClick={() => handleInspect(sess.id)}
                            variant="outline" size="sm"
                          >
                            Inspect
                          </Button>
                          <Button
                            onClick={() => startEditing(sess)}
                            variant="outline" size="sm"
                          >
                            Edit
                          </Button>
                          <Button
                            onClick={() => handleStop(sess.id)}
                            variant="destructive" size="sm"
                          >
                            Remove
                          </Button>
                        </div>
                      </div>

                      {/* CPU & Memory Stat bar */}
                      {sStats && (
                        <div className="grid grid-cols-2 gap-4 border-t border-border pt-2 text-[11px] text-muted-foreground">
                          <div>
                            CPU: <span className="text-foreground font-medium font-mono">{sStats.CPUPerc}</span>
                          </div>
                          <div>
                            Memory: <span className="text-foreground font-medium font-mono">{sStats.MemUsage} ({sStats.MemPerc})</span>
                          </div>
                        </div>
                      )}

                      <SessionControls session={sess} onResult={setResult} onJob={setActiveJobId} reload={loadSessions} />
                    </div>
                  </div>
                );
              })}

              {sessions.filter(s => s.type === 'docker-container').length === 0 && (
                <div className="flex flex-col items-center justify-center h-full text-muted-foreground space-y-2 py-12">
                  <Inbox className="size-8" />
                  <p>No active standalone workloads found.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'compose' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 animate-in fade-in duration-200">
          {/* YAML Input */}
          <div className="lg:col-span-5 flex flex-col gap-4">
            <Card className="p-5 flex flex-col flex-1 min-h-[450px]">
              <div className="flex justify-between items-center mb-4">
                <div className="flex items-center gap-2">
                  <ScrollText className="size-4 text-muted-foreground" />
                  <h3 className="text-sm font-semibold tracking-tight m-0">Docker Compose config</h3>
                </div>
                <Button 
                  onClick={handleParseYAML}
                  disabled={isParsing || !daemonOnline}
                  size="sm"
                >
                  {isParsing ? 'Parsing...' : 'Parse config'}
                </Button>
              </div>

              <div className="flex-1 relative rounded-md border border-border overflow-hidden bg-[#0b0c0e] min-h-[350px]">
                <textarea
                  value={yamlInput}
                  onChange={(e) => setYamlInput(e.target.value)}
                  className="w-full h-full p-4 font-mono text-xs bg-transparent border-0 outline-none resize-none text-primary focus:ring-0"
                />
              </div>

              {parseError && (
                <div className="mt-3 p-3 rounded-md bg-destructive/10 border border-destructive/30 text-destructive text-xs flex items-start gap-2">
                  <TriangleAlert className="size-3.5 mt-0.5 shrink-0" /> {parseError}
                </div>
              )}
            </Card>
          </div>

          {/* Visual Setup & Active compose stacks */}
          <div className="lg:col-span-7 flex flex-col gap-6">
            {parsedCompose ? (
              <Card className="p-5 space-y-4 animate-in slide-in-from-right-3">
                <div className="flex justify-between items-center">
                  <h3 className="text-sm font-semibold tracking-tight m-0 flex items-center gap-2">
                    <Layers className="size-4" /> Configured stack services
                  </h3>
                  <Badge variant="secondary">
                    YAML Version: {parsedCompose.version}
                  </Badge>
                </div>

                <div className="space-y-3.5 max-h-[350px] overflow-y-auto pr-1 scrollbar-thin">
                  {Object.entries(parsedCompose.services).map(([sName, svc]) => (
                    <div key={sName} className="p-3.5 rounded-lg border border-border bg-secondary/30 space-y-3">
                      <div className="flex justify-between items-start">
                        <div>
                          <h4 className="text-xs font-semibold m-0">{sName}</h4>
                          <span className="text-[11px] text-muted-foreground font-mono block mt-0.5">{svc.image}</span>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="text-xs font-medium text-muted-foreground block mb-1">Tunnel routing</label>
                          <select
                            value={serviceSettings[sName]?.domainMode || 'none'}
                            onChange={(e) => handleServiceSettingChange(sName, 'domainMode', e.target.value)}
                            className="w-full h-8 px-3 rounded-md bg-card border border-input text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary/25"
                          >
                            <option value="none">No external tunnel</option>
                            <option value="quick">Quick Tunnel</option>
                            <option value="custom">Custom subdomain</option>
                          </select>
                        </div>
                        {serviceSettings[sName]?.domainMode === 'custom' && (
                          <div className="animate-in fade-in">
                            <label className="text-xs font-medium text-muted-foreground block mb-1">Custom domain</label>
                            <Input
                              type="text"
                              placeholder="app.mydomain.com"
                              value={serviceSettings[sName]?.customDomain || ''}
                              onChange={(e) => handleServiceSettingChange(sName, 'customDomain', e.target.value)}
                              className="text-xs"
                            />
                          </div>
                        )}
                      </div>

                      {Object.keys(svc.environment).length > 0 && (
                        <div className="space-y-1.5 border-t border-border pt-2">
                          <label className="text-xs font-medium text-muted-foreground block">Environment overrides</label>
                          <div className="grid grid-cols-1 gap-1.5">
                            {Object.entries(svc.environment).map(([k]) => (
                              <div key={k} className="flex gap-2 items-center text-xs">
                                <span className="text-[11px] font-mono text-muted-foreground truncate w-24 shrink-0">{k}</span>
                                <input
                                  type="text"
                                  value={serviceSettings[sName]?.env[k] || ''}
                                  onChange={(e) => handleServiceEnvChange(sName, k, e.target.value)}
                                  className="flex-1 bg-card border border-input rounded-md h-7 px-2 text-xs font-mono text-foreground outline-none focus:border-primary"
                                />
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                <div className="flex gap-3">
                  <Button
                    onClick={() => setParsedCompose(null)}
                    variant="outline"
                    className="flex-1"
                  >
                    Clear setup
                  </Button>
                  <Button
                    onClick={handleDeployCompose}
                    disabled={loading || !daemonOnline}
                    className="flex-[2]"
                  >
                    <Rocket /> Deploy stack setup
                  </Button>
                </div>
              </Card>
            ) : null}

            {/* Active Compose Stacks */}
            <div className="rounded-lg border border-border bg-card overflow-hidden flex flex-col flex-1">
              <div className="px-4 py-3 border-b border-border bg-secondary/40">
                <h3 className="text-sm font-semibold tracking-tight m-0">Active compose systems ({sessions.filter(s => s.type === 'docker-compose').length})</h3>
              </div>

              <div className="p-5 space-y-4 max-h-[50vh] overflow-y-auto scrollbar-thin">
                {sessions.filter(s => s.type === 'docker-compose' && matches(s)).map((stack) => (
                  <div key={stack.id} className="rounded-lg p-4 border border-border bg-card space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Layers className="size-4 text-muted-foreground" />
                        <span className="font-semibold">{stack.id}</span>
                        <Badge variant="secondary">Stack</Badge>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          onClick={() => {
                            // Prepopulate editor with this session's configuration
                            setYamlInput(stack.metadata?.yaml || '');
                            if (stack.metadata?.serviceSettings) {
                              setServiceSettings(stack.metadata.serviceSettings);
                            }
                            setActiveTab('compose');
                            setResult(`Loaded Compose config for redeployment: ${stack.id}`);
                          }}
                          variant="outline" size="sm"
                        >
                          Redeploy stack
                        </Button>
                        <Button
                          onClick={() => handleStop(stack.id)}
                          variant="destructive" size="sm"
                        >
                          Remove stack
                        </Button>
                      </div>
                    </div>

                    <SessionControls session={stack} onResult={setResult} onJob={setActiveJobId} reload={loadSessions} />

                    {/* Services nested inside Stack */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-2">
                      {stack.metadata?.services && Object.entries(stack.metadata.services).map(([svcName, svc]) => {
                        const sStats = stats[stack.id]?.find((st: any) => st.Name?.includes(`-${svcName}-`));
                        return (
                          <div key={svcName} className="bg-secondary/30 border border-border p-3 rounded-md flex flex-col gap-2 relative group/item">
                            <div className="flex justify-between items-start gap-1">
                              <div>
                                <h4 className="text-xs font-semibold">{svcName}</h4>
                                <Badge variant={svc.status === 'running' ? 'default' : 'destructive'} className="mt-1 capitalize">
                                  {svc.status || 'unknown'}
                                </Badge>
                              </div>
                              <div className="flex gap-1">
                                <Button
                                  onClick={() => { setLogsSession(stack); setLogsService(svcName); setFollowLogs(true); }}
                                  variant="outline" size="xs"
                                >
                                  Logs
                                </Button>
                                <Button
                                  onClick={() => handleInspect(stack.id, svcName)}
                                  variant="outline" size="xs"
                                >
                                  Inspect
                                </Button>
                                <Button
                                  onClick={async () => {
                                    try { const r = await api.goAction(stack.id, 'restart', { service: svcName }); setResult(r.message); loadSessions(); }
                                    catch (e: any) { setResult(`Error: ${e.message}`); }
                                  }}
                                  variant="outline" size="xs"
                                >
                                  Restart
                                </Button>
                              </div>
                            </div>

                            {svc.cloudflaredUrl && (
                              <a href={svc.cloudflaredUrl} target="_blank" rel="noopener noreferrer" className="text-[10px] text-primary hover:underline truncate font-mono">
                                {svc.cloudflaredUrl}
                              </a>
                            )}

                            {sStats && (
                              <div className="grid grid-cols-2 gap-2 text-[11px] text-muted-foreground border-t border-border pt-1.5 font-mono">
                                <div>CPU: <span className="text-foreground">{sStats.CPUPerc}</span></div>
                                <div>Memory: <span className="text-foreground">{sStats.MemUsage}</span></div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}

                {sessions.filter(s => s.type === 'docker-compose').length === 0 && (
                  <div className="flex flex-col items-center justify-center h-full text-muted-foreground space-y-2 py-12">
                    <Inbox className="size-8" />
                    <p>No active Compose configurations deployed.</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'backups' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 animate-in fade-in duration-200">
          {/* Perform Backup Form */}
          <div className="lg:col-span-5 space-y-6">
            <Card className="p-5 space-y-4">
              <CardHeader className="p-0">
                <CardTitle className="text-sm font-semibold tracking-tight flex items-center gap-2">
                  <HardDrive className="size-4" /> Trigger Docker volume backup
                </CardTitle>
                <CardDescription className="text-xs text-muted-foreground">
                  Runs a lightweight Alpine helper container to tar and stream your target volume contents directly to Cloudflare R2 storage.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0 space-y-4">
                <div>
                  <label className="text-xs font-medium text-muted-foreground block mb-1">Volume name / mount source</label>
                  <Input
                    type="text"
                    value={backupVolumeInput}
                    onChange={(e) => setBackupVolumeInput(e.target.value)}
                    placeholder="e.g. redis_data, web_html"
                    className="text-xs"
                  />
                </div>
                <Button
                  onClick={handleBackupVolume}
                  disabled={backupLoading || !backupVolumeInput || !daemonOnline}
                  className="w-full"
                >
                  {backupLoading ? 'Archiving and uploading...' : 'Backup volume to R2'}
                </Button>
              </CardContent>
            </Card>
            <VolumesCard onPick={setBackupVolumeInput} onResult={setResult} />
          </div>

          {/* List of backups on R2 */}
          <div className="lg:col-span-7 rounded-lg border border-border bg-card overflow-hidden flex flex-col h-full min-h-[400px]">
            <div className="px-4 py-3 border-b border-border bg-secondary/40 flex justify-between items-center">
              <h3 className="text-sm font-semibold tracking-tight">Stored Cloudflare R2 backups ({volumeBackups.length})</h3>
              <Button onClick={loadBackups} variant="outline" size="sm">
                <RefreshCw /> Refresh
              </Button>
            </div>

            <div className="p-5 flex-1 overflow-y-auto space-y-3.5 scrollbar-thin">
              {volumeBackups.map((vol) => (
                <div key={vol} className="rounded-lg p-3.5 border border-border bg-card flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2.5">
                    <HardDrive className="size-4 text-muted-foreground" />
                    <div>
                      <div className="font-medium text-xs font-mono">{vol}</div>
                      <div className="text-[11px] text-muted-foreground mt-0.5">R2 backup file: volumes/{vol}.tar.gz</div>
                    </div>
                  </div>

                  <Button
                    onClick={() => handleRestoreVolume(vol)}
                    disabled={backupLoading || !daemonOnline}
                    variant="outline" size="sm"
                  >
                    Restore
                  </Button>
                </div>
              ))}

              {volumeBackups.length === 0 && (
                <div className="flex flex-col items-center justify-center h-full text-muted-foreground space-y-2 py-12">
                  <FolderOpen className="size-8" />
                  <p>No volume backup archives found in Cloudflare R2.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'history' && (
        <div className="rounded-lg border border-border bg-card overflow-hidden flex flex-col h-full min-h-[500px] animate-in fade-in duration-200">
          <div className="px-4 py-3 border-b border-border bg-secondary/40 flex justify-between items-center">
            <h3 className="text-sm font-semibold tracking-tight">Deployment rollback history</h3>
            <Button onClick={loadHistory} variant="outline" size="sm">
              <RefreshCw /> Refresh
            </Button>
          </div>

          <div className="p-5 flex-1 overflow-y-auto space-y-4 max-h-[70vh] scrollbar-thin">
            {deployments.map((dep) => (
              <DeploymentRow key={dep.id} dep={dep} onRollback={handleRollback} daemonOnline={daemonOnline} />
            ))}

            {deployments.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-muted-foreground space-y-2 py-12">
                <ScrollText className="size-8" />
                <p>No deployment logs or history recorded yet.</p>
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === 'events' && (
        <EventsTab sessionIds={sessions.map(s => ({ id: s.id, label: s.metadata?.containerName || s.id }))} />
      )}

      {activeTab === 'settings' && <SettingsTab onResult={setResult} />}

      {/* MODAL: Realtime log stream */}
      {logsSession && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 animate-in fade-in duration-150">
          <div className="w-full max-w-3xl rounded-lg border border-border bg-card shadow-xl flex flex-col h-[75vh]">
            <div className="px-4 py-3 border-b border-border flex justify-between items-center bg-secondary/40">
              <div>
                <h3 className="text-sm font-semibold tracking-tight flex items-center gap-2">
                  <ScrollText className="size-4" /> Log streaming: <span className="font-mono">{logsSession.id}</span>
                </h3>
                {logsService && <span className="text-xs text-muted-foreground block mt-0.5">Service: {logsService}</span>}
              </div>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={followLogs}
                    onChange={(e) => setFollowLogs(e.target.checked)}
                    className="rounded border-border accent-primary"
                  />
                  Follow logs
                </label>
                <Button onClick={() => setLogsSession(null)} variant="ghost" size="icon-xs" aria-label="Close"><X /></Button>
              </div>
            </div>
            
            <div className="flex-1 bg-[#0b0c0e] p-4 font-mono text-[11px] text-primary overflow-y-auto space-y-1.5 scrollbar-thin">
              {logsLines.map((line, idx) => (
                <div key={idx} className="whitespace-pre-wrap leading-relaxed border-l-2 border-primary/30 pl-2 hover:bg-secondary/20">
                  {line}
                </div>
              ))}
              <div ref={logEndRef} />
            </div>

            <div className="px-4 py-3 border-t border-border flex justify-between items-center bg-secondary/40 text-xs text-muted-foreground">
              <span>Showing up to last 500 lines of output.</span>
              <Button onClick={() => setLogsLines([])} variant="outline" size="sm">
                Clear view
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL: Inspect details */}
      {inspectData && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 animate-in fade-in duration-150">
          <div className="w-full max-w-2xl rounded-lg border border-border bg-card shadow-xl flex flex-col h-[70vh]">
            <div className="px-4 py-3 border-b border-border flex justify-between items-center bg-secondary/40">
              <h3 className="text-sm font-semibold tracking-tight flex items-center gap-2">
                <Search className="size-4" /> {inspectTitle}
              </h3>
              <Button onClick={() => setInspectData(null)} variant="ghost" size="icon-xs" aria-label="Close"><X /></Button>
            </div>

            <div className="flex-1 bg-[#0b0c0e] p-4 overflow-y-auto scrollbar-thin">
              <pre className="font-mono text-primary text-xs whitespace-pre-wrap m-0 leading-relaxed">
                {JSON.stringify(inspectData, null, 2)}
              </pre>
            </div>

            <div className="px-4 py-3 border-t border-border flex justify-end bg-secondary/40">
              <Button onClick={() => setInspectData(null)} size="sm">
                Close
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DeploymentRow({ dep, onRollback, daemonOnline }: { dep: DeploymentRecord; onRollback: (id: string) => void; daemonOnline: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [logsExpanded, setLogsExpanded] = useState(false);

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3.5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          {dep.type === 'docker-compose' ? <Layers className="size-4 text-muted-foreground" /> : <Box className="size-4 text-muted-foreground" />}
          <div>
            <div className="flex items-center gap-2">
              <span className="font-medium text-xs font-mono truncate max-w-[150px] sm:max-w-xs">{dep.sessionId}</span>
              <Badge variant={dep.status === 'success' ? 'default' : 'destructive'} className="capitalize">
                {dep.status}
              </Badge>
            </div>
            <div className="text-[11px] text-muted-foreground mt-1">
              {new Date(dep.timestamp).toLocaleString()} | ID: <span className="font-mono">{dep.id}</span>
            </div>
          </div>
        </div>

        <div className="flex gap-2 text-xs">
          <Button
            onClick={() => setExpanded(!expanded)}
            variant="outline"
            size="sm"
          >
            {expanded ? 'Hide config' : 'View config'}
          </Button>
          {dep.logs && dep.logs.length > 0 && (
            <Button
              onClick={() => setLogsExpanded(!logsExpanded)}
              variant="outline"
              size="sm"
            >
              {logsExpanded ? 'Hide logs' : 'View logs'}
            </Button>
          )}
          {dep.status === 'success' && (
            <Button
              onClick={() => onRollback(dep.id)}
              disabled={!daemonOnline}
              variant="outline" size="sm"
            >
              Rollback
            </Button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="p-3.5 rounded-md bg-[#0b0c0e] border border-border animate-in slide-in-from-top-1">
          <div className="text-xs font-medium text-muted-foreground mb-2">Deploy configuration options</div>
          <pre className="font-mono text-[11px] text-foreground whitespace-pre-wrap m-0 leading-relaxed overflow-x-auto max-h-60 scrollbar-thin">
            {dep.type === 'docker-compose'
              ? `YAML:\n${dep.config?.yaml || 'None'}\n\nService Settings:\n${JSON.stringify(dep.config?.serviceSettings || {}, null, 2)}`
              : JSON.stringify(dep.config || {}, null, 2)}
          </pre>
        </div>
      )}

      {logsExpanded && dep.logs && (
        <div className="p-3.5 rounded-md bg-[#0b0c0e] border border-border animate-in slide-in-from-top-1">
          <div className="text-xs font-medium text-muted-foreground mb-2">Job deployment terminal logs</div>
          <div className="font-mono text-[11px] text-primary space-y-1 max-h-48 overflow-y-auto pr-1 scrollbar-thin">
            {dep.logs.map((logLine, idx) => (
              <div key={idx} className="leading-relaxed">{logLine}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
