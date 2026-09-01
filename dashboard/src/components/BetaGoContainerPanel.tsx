import React, { useState, useEffect, useRef } from 'react';
import { api, BASE } from '../api';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

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
  const [activeTab, setActiveTab] = useState<'single' | 'compose' | 'backups' | 'history'>('single');

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
            setResult(`✅ Deploy completed successfully!`);
          } else {
            setResult(`❌ Deploy failed: ${status.error}`);
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
      setLogsLines(prev => [...prev, '⚠️ [Real-time stream connection ended]']);
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
      setLogsLines([`❌ Failed to load logs: ${e.message}`]);
    }
  };

  useEffect(() => {
    if (logsSession && !followLogs) {
      loadStaticLogs();
    }
  }, [logsSession, logsService, followLogs]);

  const handleDeploy = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!image) return setResult('❌ Please enter a Docker Image URI');
    const portNum = parseInt(port, 10);
    if (isNaN(portNum) || portNum <= 0) return setResult('❌ Invalid container port');
    
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
        setResult(`⚡ Deployment job created. Polling progress...`);
      } else {
        setResult(`✅ Go Container started!`);
        loadSessions();
      }
    } catch (err: any) {
      setResult(`❌ Error: ${err.message}`);
      setLoading(false);
    }
  };

  const handleStop = async (sessionId: string) => {
    setLoading(true);
    setResult('');
    try {
      const res = await api.stopGoDocker(sessionId);
      if (res.success) {
        setResult(`✅ ${res.message}`);
      } else {
        setResult(`❌ ${res.message}`);
      }
      await loadSessions();
      loadHistory();
    } catch (err: any) {
      setResult(`❌ Error: ${err.message}`);
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
      setResult('✅ Successfully parsed Compose configuration!');

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
      setResult(`❌ Parse error: ${e.message}`);
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
        setResult(`⚡ Compose Stack Deployment job created. Polling progress...`);
      } else {
        setResult(`✅ Compose stack deployed successfully!`);
        loadSessions();
      }
    } catch (err: any) {
      setResult(`❌ Error: ${err.message}`);
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
    if (!image) return setResult('❌ Please enter a Docker Image URI');
    const portNum = parseInt(port, 10);
    if (isNaN(portNum) || portNum <= 0) return setResult('❌ Invalid container port');

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
        setResult(`⚡ Redeployment job created. Polling progress...`);
      } else {
        setResult(`✅ Go Container redeployed successfully!`);
        loadSessions();
      }
      setEditingSession(null);
    } catch (err: any) {
      setResult(`❌ Error: ${err.message}`);
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
      setResult(`✅ ${res.message}`);
      setBackupVolumeInput('');
      loadBackups();
    } catch (err: any) {
      setResult(`❌ Failed to backup: ${err.message}`);
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
      setResult(`✅ ${res.message}`);
    } catch (err: any) {
      setResult(`❌ Failed to restore: ${err.message}`);
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
        setResult(`⚡ Rollback job created. Polling progress...`);
      } else {
        setResult(`✅ Rollback completed successfully!`);
        loadSessions();
      }
    } catch (err: any) {
      setResult(`❌ Rollback failed: ${err.message}`);
      setLoading(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setResult('✅ Copied to clipboard!');
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
    <div className="space-y-6 text-sm text-white">
      {/* Offline Warning Banner */}
      {!daemonOnline && (
        <div className="glass rounded-xl p-4 border border-red-500/30 bg-red-500/5 flex items-center gap-3 animate-pulse">
          <span className="text-xl">⚠️</span>
          <div>
            <div className="font-bold text-red-400">Go Container Manager Offline</div>
            <div className="text-xs text-white/50">The daemon process on port 18080 is unreachable. Ensure the backend Go server is running.</div>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <p className="text-white/40">
          Enterprise Container Panel managed by the Go service daemon on port 18080.
        </p>

        {/* Tab switcher */}
        <div className="flex flex-wrap gap-2 border-b border-white/5 pb-3">
          <Button
            onClick={() => setActiveTab('single')}
            variant="ghost"
            className={`text-xs font-semibold px-4 py-2 h-auto rounded-lg ${activeTab === 'single' ? 'bg-[#0061FF] text-white' : 'text-white/50 hover:text-white hover:bg-white/[0.04]'}`}
          >
            🐋 Single Container
          </Button>
          <Button
            onClick={() => setActiveTab('compose')}
            variant="ghost"
            className={`text-xs font-semibold px-4 py-2 h-auto rounded-lg ${activeTab === 'compose' ? 'bg-[#0061FF] text-white' : 'text-white/50 hover:text-white hover:bg-white/[0.04]'}`}
          >
            ⚡ Compose Stacks
          </Button>
          <Button
            onClick={() => setActiveTab('backups')}
            variant="ghost"
            className={`text-xs font-semibold px-4 py-2 h-auto rounded-lg ${activeTab === 'backups' ? 'bg-[#0061FF] text-white' : 'text-white/50 hover:text-white hover:bg-white/[0.04]'}`}
          >
            💾 Volume Backups (R2)
          </Button>
          <Button
            onClick={() => setActiveTab('history')}
            variant="ghost"
            className={`text-xs font-semibold px-4 py-2 h-auto rounded-lg ${activeTab === 'history' ? 'bg-[#0061FF] text-white' : 'text-white/50 hover:text-white hover:bg-white/[0.04]'}`}
          >
            📜 Deployment History
          </Button>
        </div>

        {/* Status/Result Alert Box */}
        {result && (
          <div className="glass rounded-xl p-3 border border-[#00E5FF]/30 bg-[#00E5FF]/5 animate-in slide-in-from-top-2 flex justify-between items-center">
            <pre className="text-xs text-white/80 whitespace-pre-wrap font-mono m-0">{result}</pre>
            <button onClick={() => setResult('')} className="text-white/40 hover:text-white text-xs px-2">✕</button>
          </div>
        )}

        {/* Live Stepper Job Progress */}
        {jobStatus && (
          <div className="glass rounded-2xl p-5 border border-indigo-500/20 bg-indigo-500/5 space-y-4 animate-in slide-in-from-top-3">
            <div className="flex justify-between items-center">
              <span className="font-bold text-indigo-300 text-xs flex items-center gap-1.5">
                <span className="animate-spin text-sm">🔄</span> Active Deployment Stepper ({jobStatus.id})
              </span>
              <Badge variant="outline" className={`text-[10px] capitalize ${jobStatus.status === 'error' ? 'bg-red-500/10 text-red-400 border-red-500/20' : 'bg-indigo-500/10 text-indigo-300 border-indigo-500/20'}`}>
                {jobStatus.status}
              </Badge>
            </div>

            {/* Steps Visualizer */}
            <div className="grid grid-cols-5 gap-2 text-center text-[10px] uppercase font-bold text-white/40 select-none">
              {(['validating', 'pulling', 'starting', 'tunneling', 'completed'] as const).map((step, idx) => {
                const phases = ['validating', 'pulling', 'starting', 'tunneling', 'completed'];
                const curIdx = phases.indexOf(jobStatus.phase);
                const stepIdx = phases.indexOf(step);

                let badgeColor = 'bg-white/5 text-white/30 border-white/5';
                let stepIndicator = '⚪';
                if (jobStatus.phase === 'failed' && stepIdx === curIdx) {
                  badgeColor = 'bg-red-500/10 text-red-400 border-red-500/20';
                  stepIndicator = '❌';
                } else if (stepIdx < curIdx || jobStatus.phase === 'completed') {
                  badgeColor = 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
                  stepIndicator = '✅';
                } else if (stepIdx === curIdx) {
                  badgeColor = 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30 animate-pulse';
                  stepIndicator = '🔵';
                }

                return (
                  <div key={step} className={`p-2.5 rounded-xl border flex flex-col items-center gap-1.5 ${badgeColor}`}>
                    <span>{stepIndicator}</span>
                    <span className="truncate w-full">{step === 'completed' ? 'ready' : step}</span>
                  </div>
                );
              })}
            </div>

            {/* Stepper mini-console */}
            <div className="bg-black/60 border border-white/10 rounded-xl p-3.5 font-mono text-[10.5px] text-emerald-400 h-40 overflow-y-auto space-y-1 scrollbar-thin">
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
            <Card className="glass border border-white/10 rounded-2xl p-5 space-y-4">
              <CardHeader className="p-0">
                <CardTitle className="text-base font-bold flex items-center gap-2">
                  <span>🐋</span> Single Container Launch
                </CardTitle>
                <CardDescription className="text-xs text-white/40">
                  Deploy standalone containers with rich networks, mounts, and limits.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0 space-y-3.5">
                <div>
                  <label className="text-[10px] text-white/50 font-bold uppercase block mb-1">Docker Image URI</label>
                  <Input
                    type="text"
                    value={image}
                    onChange={(e) => setImage(e.target.value)}
                    placeholder="e.g. nginx:alpine"
                    className="bg-black/20 border-white/10 focus:border-indigo-500 rounded-lg text-xs"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] text-white/50 font-bold uppercase block mb-1">Container Port</label>
                    <Input
                      type="number"
                      value={port}
                      onChange={(e) => setPort(e.target.value)}
                      className="bg-black/20 border-white/10 focus:border-indigo-500 rounded-lg text-xs"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-white/50 font-bold uppercase block mb-1">Host Port (Optional)</label>
                    <Input
                      type="number"
                      value={hostPort}
                      onChange={(e) => setHostPort(e.target.value)}
                      placeholder="Auto-allocated if blank"
                      className="bg-black/20 border-white/10 focus:border-indigo-500 rounded-lg text-xs"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] text-white/50 font-bold uppercase block mb-1">Tunnel Mode</label>
                    <select
                      value={domainMode}
                      onChange={(e) => setDomainMode(e.target.value as 'quick' | 'custom')}
                      className="w-full h-9 px-3 rounded-lg bg-[#1E2330] border border-white/10 text-[var(--input-text)] text-xs outline-none focus:border-indigo-500"
                    >
                      <option value="quick">Quick Tunnel</option>
                      <option value="custom">Custom Subdomain</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] text-white/50 font-bold uppercase block mb-1">Instance Name</label>
                    <Input
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="custom-app"
                      className="bg-black/20 border-white/10 focus:border-indigo-500 rounded-lg text-xs"
                    />
                  </div>
                </div>

                {domainMode === 'custom' && (
                  <div className="animate-in fade-in duration-150">
                    <label className="text-[10px] text-white/50 font-bold uppercase block mb-1">Custom Domain</label>
                    <Input
                      type="text"
                      value={customDomain}
                      onChange={(e) => setCustomDomain(e.target.value)}
                      placeholder="sub.domain.com"
                      className="bg-black/20 border-white/10 focus:border-indigo-500 rounded-lg text-xs"
                    />
                  </div>
                )}

                {/* Advanced Collapsible Section */}
                <div className="border-t border-white/5 pt-3">
                  <button
                    type="button"
                    onClick={() => setShowAdvanced(!showAdvanced)}
                    className="flex justify-between items-center w-full text-xs font-bold text-indigo-400 hover:text-indigo-300"
                  >
                    <span>⚙️ Advanced Configuration</span>
                    <span>{showAdvanced ? '▼' : '►'}</span>
                  </button>

                  {showAdvanced && (
                    <div className="space-y-4 pt-3.5 animate-in slide-in-from-top-2 duration-150">
                      {/* Resource limits */}
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="text-[10px] text-white/50 font-bold uppercase block mb-1">Memory Limit (MB)</label>
                          <Input
                            type="number"
                            value={memoryLimit}
                            onChange={(e) => setMemoryLimit(e.target.value)}
                            placeholder="e.g. 512"
                            className="bg-black/20 border-white/10 focus:border-indigo-500 rounded-lg text-xs"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] text-white/50 font-bold uppercase block mb-1">CPU cores limit</label>
                          <Input
                            type="number"
                            step="0.1"
                            value={cpuLimit}
                            onChange={(e) => setCpuLimit(e.target.value)}
                            placeholder="e.g. 0.5"
                            className="bg-black/20 border-white/10 focus:border-indigo-500 rounded-lg text-xs"
                          />
                        </div>
                      </div>

                      {/* Restart Policy */}
                      <div>
                        <label className="text-[10px] text-white/50 font-bold uppercase block mb-1">Restart Policy</label>
                        <select
                          value={restartPolicy}
                          onChange={(e) => setRestartPolicy(e.target.value)}
                          className="w-full h-9 px-3 rounded-lg bg-[#1E2330] border border-white/10 text-[var(--input-text)] text-xs outline-none focus:border-indigo-500"
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
                          <label className="text-[10px] text-white/50 font-bold uppercase block mb-1">Command overrides</label>
                          <Input
                            type="text"
                            value={commandInput}
                            onChange={(e) => setCommandInput(e.target.value)}
                            placeholder="e.g. sh -c"
                            className="bg-black/20 border-white/10 focus:border-indigo-500 rounded-lg text-xs"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] text-white/50 font-bold uppercase block mb-1">Args</label>
                          <Input
                            type="text"
                            value={argsInput}
                            onChange={(e) => setArgsInput(e.target.value)}
                            placeholder="e.g. run-app"
                            className="bg-black/20 border-white/10 focus:border-indigo-500 rounded-lg text-xs"
                          />
                        </div>
                      </div>

                      {/* Multi ports */}
                      <div className="space-y-2">
                        <label className="text-[10px] text-white/50 font-bold uppercase block">Extra Port Mappings</label>
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
                              className="bg-black/20 border-white/10 text-xs w-24"
                            />
                            <span>→</span>
                            <Input
                              type="number"
                              placeholder="Container"
                              value={p.container}
                              onChange={(e) => {
                                const copy = [...extraPorts];
                                copy[idx].container = e.target.value;
                                setExtraPorts(copy);
                              }}
                              className="bg-black/20 border-white/10 text-xs w-24"
                            />
                            <select
                              value={p.protocol}
                              onChange={(e) => {
                                const copy = [...extraPorts];
                                copy[idx].protocol = e.target.value as 'tcp' | 'udp';
                                setExtraPorts(copy);
                              }}
                              className="bg-[#1E2330] border border-white/10 rounded-lg h-9 px-2 text-xs"
                            >
                              <option value="tcp">TCP</option>
                              <option value="udp">UDP</option>
                            </select>
                            <Button
                              onClick={() => setExtraPorts(extraPorts.filter((_, i) => i !== idx))}
                              variant="ghost"
                              className="h-9 px-2 text-red-400 hover:text-red-300"
                            >
                              ✕
                            </Button>
                          </div>
                        ))}
                        <Button
                          type="button"
                          onClick={() => setExtraPorts([...extraPorts, { host: '', container: '', protocol: 'tcp' }])}
                          variant="outline"
                          className="h-8 text-xs border-white/10 text-white/60 hover:text-white bg-white/[0.02] w-full"
                        >
                          + Add Port Mapping
                        </Button>
                      </div>

                      {/* Volumes */}
                      <div className="space-y-2">
                        <label className="text-[10px] text-white/50 font-bold uppercase block">Volume Mounts</label>
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
                              className="bg-black/20 border-white/10 text-xs flex-1 min-w-[120px]"
                            />
                            <span>:</span>
                            <Input
                              placeholder="Destination Path"
                              value={v.destination}
                              onChange={(e) => {
                                const copy = [...extraVolumes];
                                copy[idx].destination = e.target.value;
                                setExtraVolumes(copy);
                              }}
                              className="bg-black/20 border-white/10 text-xs flex-1 min-w-[120px]"
                            />
                            <label className="flex items-center gap-1.5 text-xs text-white/50">
                              <input
                                type="checkbox"
                                checked={v.readOnly}
                                onChange={(e) => {
                                  const copy = [...extraVolumes];
                                  copy[idx].readOnly = e.target.checked;
                                  setExtraVolumes(copy);
                                }}
                                className="rounded border-white/15 bg-black/20"
                              />
                              RO
                            </label>
                            <Button
                              onClick={() => setExtraVolumes(extraVolumes.filter((_, i) => i !== idx))}
                              variant="ghost"
                              className="h-9 px-2 text-red-400 hover:text-red-300"
                            >
                              ✕
                            </Button>
                          </div>
                        ))}
                        <Button
                          type="button"
                          onClick={() => setExtraVolumes([...extraVolumes, { source: '', destination: '', readOnly: false }])}
                          variant="outline"
                          className="h-8 text-xs border-white/10 text-white/60 hover:text-white bg-white/[0.02] w-full"
                        >
                          + Add Volume Mount
                        </Button>
                      </div>

                      {/* Registry login */}
                      <div className="border-t border-white/5 pt-3 space-y-2">
                        <label className="text-[10px] text-white/50 font-bold uppercase block">Private Registry Login (Required for private images)</label>
                        <div className="grid grid-cols-3 gap-2">
                          <Input
                            placeholder="Server URL"
                            value={registryAuth.server}
                            onChange={(e) => setRegistryAuth({ ...registryAuth, server: e.target.value })}
                            className="bg-black/20 border-white/10 text-xs col-span-1"
                          />
                          <Input
                            placeholder="Username"
                            value={registryAuth.username}
                            onChange={(e) => setRegistryAuth({ ...registryAuth, username: e.target.value })}
                            className="bg-black/20 border-white/10 text-xs col-span-1"
                          />
                          <Input
                            type="password"
                            placeholder="Password"
                            value={registryAuth.password}
                            onChange={(e) => setRegistryAuth({ ...registryAuth, password: e.target.value })}
                            className="bg-black/20 border-white/10 text-xs col-span-1"
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Env block */}
                <div>
                  <label className="text-[10px] text-white/50 font-bold uppercase block mb-1">Environment Variables (KEY=VALUE)</label>
                  <textarea
                    value={env}
                    onChange={(e) => setEnv(e.target.value)}
                    placeholder="PORT=80&#10;NODE_ENV=production"
                    rows={3}
                    className="w-full px-3 py-2 rounded-lg bg-black/20 border border-white/10 text-white text-xs font-mono focus:border-indigo-500 focus:outline-none transition-colors"
                  />
                </div>

                <Button
                  onClick={handleDeploy}
                  disabled={loading || !daemonOnline}
                  className="w-full py-2.5 rounded-lg bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300 border border-indigo-500/30 font-semibold text-xs transition-all shadow-md"
                >
                  {loading ? '⚡ Deploying...' : 'Deploy Container'}
                </Button>
              </CardContent>
            </Card>
          </div>

          {/* Right: Workload List */}
          <div className="lg:col-span-7 glass rounded-2xl border border-white/10 overflow-hidden flex flex-col h-full min-h-[500px]">
            <div className="px-5 py-4 border-b border-white/10 bg-white/5 flex justify-between items-center">
              <h3 className="font-bold text-white text-sm">Active Single Workloads ({sessions.filter(s => s.type === 'docker-container').length})</h3>
              <Button onClick={loadSessions} variant="outline" className="h-7 px-2.5 rounded-lg text-xs border-white/10 text-white/60 hover:text-white bg-white/[0.04]">
                🔄 Reload
              </Button>
            </div>

            <div className="p-5 flex-1 overflow-y-auto space-y-4 max-h-[70vh] scrollbar-thin">
              {sessions.filter(s => s.type === 'docker-container').map((sess) => {
                const sStats = stats[sess.id]?.[0];
                return (
                  <div key={sess.id} className="bg-black/20 rounded-xl p-4 border border-white/5 hover:border-white/10 transition-all group relative">
                    <div className="flex flex-col gap-3">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0 space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xl">🐋</span>
                            <span className="text-white font-semibold truncate">
                              {sess.metadata?.containerName || `${sess.id}`}
                            </span>
                            <Badge className={`text-[10px] capitalize ${sess.metadata?.status === 'running' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-red-500/10 text-red-400 border border-red-500/20'}`}>
                              {sess.metadata?.status || 'unknown'} {sess.metadata?.exitCode !== undefined && sess.metadata.exitCode !== 0 ? `(Code ${sess.metadata.exitCode})` : ''}
                            </Badge>
                            {sess.metadata?.health && (
                              <Badge className={`text-[10px] lowercase ${sess.metadata.health === 'healthy' ? 'bg-green-500/10 text-green-400' : 'bg-yellow-500/10 text-yellow-400'}`}>
                                {sess.metadata.health}
                              </Badge>
                            )}
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5 text-xs text-white/50">
                            <div>
                              🖼️ Image: <span className="text-white/80 font-mono text-[11px]">{sess.metadata?.image}</span>
                            </div>
                            <div>
                              ⏱️ Started: <span className="text-white/80">{new Date(sess.startedAt).toLocaleString()}</span>
                            </div>
                            <div className="col-span-1 sm:col-span-2">
                              🔗 Public Tunnel: <a href={sess.metadata?.cloudflaredUrl || sess.url} target="_blank" rel="noopener noreferrer" className="text-[#00E5FF] hover:underline font-mono text-[11px]">
                                {sess.metadata?.cloudflaredUrl || sess.url}
                              </a>
                            </div>
                            <div>
                              🔌 Ports: <span className="text-white/80 font-mono">{sess.metadata?.hostPort} → {sess.metadata?.port}</span>
                            </div>
                            <div>
                              🛡️ Domain Mode: <span className="text-white/80 capitalize">{sess.metadata?.domainMode}</span>
                            </div>
                          </div>
                        </div>

                        {/* Top-Right action buttons */}
                        <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                          <Button
                            onClick={() => { setLogsSession(sess); setLogsService(''); setFollowLogs(true); }}
                            className="h-7 px-2.5 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/20 text-xs"
                          >
                            Logs
                          </Button>
                          <Button
                            onClick={() => handleInspect(sess.id)}
                            className="h-7 px-2.5 rounded-lg bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 border border-indigo-500/20 text-xs"
                          >
                            Inspect
                          </Button>
                          <Button
                            onClick={() => startEditing(sess)}
                            className="h-7 px-2.5 rounded-lg bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 border border-blue-500/20 text-xs"
                          >
                            Edit
                          </Button>
                          <Button
                            onClick={() => handleStop(sess.id)}
                            className="h-7 px-2.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 text-xs"
                          >
                            Stop
                          </Button>
                        </div>
                      </div>

                      {/* CPU & Memory Stat bar */}
                      {sStats && (
                        <div className="grid grid-cols-2 gap-4 border-t border-white/5 pt-2 text-[11px] text-white/40 bg-white/[0.01] p-2 rounded-lg">
                          <div>
                            🖥️ CPU: <span className="text-emerald-400 font-bold font-mono">{sStats.CPUPerc}</span>
                          </div>
                          <div>
                            🧠 Memory: <span className="text-indigo-400 font-bold font-mono">{sStats.MemUsage} ({sStats.MemPerc})</span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}

              {sessions.filter(s => s.type === 'docker-container').length === 0 && (
                <div className="flex flex-col items-center justify-center h-full text-white/30 space-y-2 py-12">
                  <span className="text-4xl">📭</span>
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
            <Card className="glass border border-white/10 rounded-2xl p-5 flex flex-col flex-1 min-h-[450px]">
              <div className="flex justify-between items-center mb-4">
                <div className="flex items-center gap-2">
                  <span className="text-indigo-400">📝</span>
                  <h3 className="font-bold text-white text-sm m-0">Docker Compose Config</h3>
                </div>
                <Button 
                  onClick={handleParseYAML}
                  disabled={isParsing || !daemonOnline}
                  className="h-8 px-4 rounded-lg bg-[#0061FF] hover:bg-[#004ecb] text-white text-xs font-bold flex items-center gap-1.5"
                >
                  {isParsing ? 'Parsing...' : 'Parse Config'}
                </Button>
              </div>

              <div className="flex-1 relative rounded-xl border border-white/10 overflow-hidden bg-[#11151F] min-h-[350px]">
                <textarea
                  value={yamlInput}
                  onChange={(e) => setYamlInput(e.target.value)}
                  className="w-full h-full p-4 font-mono text-xs bg-transparent border-0 outline-none resize-none text-emerald-400 focus:ring-0"
                />
              </div>

              {parseError && (
                <div className="mt-3 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
                  ⚠️ {parseError}
                </div>
              )}
            </Card>
          </div>

          {/* Visual Setup & Active compose stacks */}
          <div className="lg:col-span-7 flex flex-col gap-6">
            {parsedCompose ? (
              <Card className="glass border border-white/10 rounded-2xl p-5 space-y-4 animate-in slide-in-from-right-3">
                <div className="flex justify-between items-center">
                  <h3 className="font-bold text-white text-sm m-0 flex items-center gap-2">
                    <span>⚡</span> Configured Stack Services
                  </h3>
                  <Badge variant="outline" className="text-[10px] bg-indigo-500/10 text-indigo-300">
                    YAML Version: {parsedCompose.version}
                  </Badge>
                </div>

                <div className="space-y-3.5 max-h-[350px] overflow-y-auto pr-1 scrollbar-thin">
                  {Object.entries(parsedCompose.services).map(([sName, svc]) => (
                    <div key={sName} className="p-3.5 rounded-xl border border-white/5 bg-black/20 space-y-3">
                      <div className="flex justify-between items-start">
                        <div>
                          <h4 className="text-xs font-bold text-indigo-300 m-0">{sName}</h4>
                          <span className="text-[10px] text-white/40 block mt-0.5">{svc.image}</span>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="text-[10px] text-white/50 font-bold uppercase block mb-1">Tunnel Routing</label>
                          <select
                            value={serviceSettings[sName]?.domainMode || 'none'}
                            onChange={(e) => handleServiceSettingChange(sName, 'domainMode', e.target.value)}
                            className="w-full h-9 px-2.5 rounded-lg bg-[#1E2330] border border-white/10 text-[var(--input-text)] text-xs outline-none"
                          >
                            <option value="none">No External Tunnel</option>
                            <option value="quick">Quick Tunnel</option>
                            <option value="custom">Custom Subdomain</option>
                          </select>
                        </div>
                        {serviceSettings[sName]?.domainMode === 'custom' && (
                          <div className="animate-in fade-in">
                            <label className="text-[10px] text-white/50 font-bold uppercase block mb-1">Custom Domain</label>
                            <Input
                              type="text"
                              placeholder="app.mydomain.com"
                              value={serviceSettings[sName]?.customDomain || ''}
                              onChange={(e) => handleServiceSettingChange(sName, 'customDomain', e.target.value)}
                              className="bg-black/20 border-white/10 text-xs"
                            />
                          </div>
                        )}
                      </div>

                      {Object.keys(svc.environment).length > 0 && (
                        <div className="space-y-1.5 border-t border-white/5 pt-2">
                          <label className="text-[10px] text-white/50 font-bold uppercase block">Environment Overrides</label>
                          <div className="grid grid-cols-1 gap-1.5">
                            {Object.entries(svc.environment).map(([k]) => (
                              <div key={k} className="flex gap-2 items-center text-xs">
                                <span className="text-[10px] font-mono text-white/40 truncate w-24 shrink-0">{k}</span>
                                <input
                                  type="text"
                                  value={serviceSettings[sName]?.env[k] || ''}
                                  onChange={(e) => handleServiceEnvChange(sName, k, e.target.value)}
                                  className="flex-1 bg-black/20 border border-white/10 rounded-lg py-1 px-2 text-xs focus:outline-none focus:border-indigo-500 text-white"
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
                    className="flex-1 py-2 text-xs border-white/10 text-white/60 hover:text-white"
                  >
                    Clear Setup
                  </Button>
                  <Button
                    onClick={handleDeployCompose}
                    disabled={loading || !daemonOnline}
                    className="flex-[2] py-2 rounded-xl bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300 border border-indigo-500/30 font-bold text-xs"
                  >
                    🚀 Deploy Stack Setup
                  </Button>
                </div>
              </Card>
            ) : null}

            {/* Active Compose Stacks */}
            <div className="glass rounded-2xl border border-white/10 overflow-hidden flex flex-col flex-1">
              <div className="px-5 py-4 border-b border-white/10 bg-white/5">
                <h3 className="font-bold text-white text-sm m-0">Active Compose Systems ({sessions.filter(s => s.type === 'docker-compose').length})</h3>
              </div>

              <div className="p-5 space-y-4 max-h-[50vh] overflow-y-auto scrollbar-thin">
                {sessions.filter(s => s.type === 'docker-compose').map((stack) => (
                  <div key={stack.id} className="bg-black/20 rounded-xl p-4 border border-white/5 hover:border-white/10 transition-all space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-xl">⚡</span>
                        <span className="font-bold text-white">{stack.id}</span>
                        <Badge className="bg-blue-500/10 text-blue-400 border border-blue-500/20 text-[10px]">STACK</Badge>
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
                          className="h-7 px-2.5 rounded-lg bg-blue-500/15 hover:bg-blue-500/25 text-blue-400 border border-blue-500/20 text-xs"
                        >
                          Redeploy Stack
                        </Button>
                        <Button
                          onClick={() => handleStop(stack.id)}
                          className="h-7 px-2.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 text-xs"
                        >
                          Down Stack
                        </Button>
                      </div>
                    </div>

                    {/* Services nested inside Stack */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-2">
                      {stack.metadata?.services && Object.entries(stack.metadata.services).map(([svcName, svc]) => {
                        const sStats = stats[stack.id]?.find((st: any) => st.Name?.includes(`-${svcName}-`));
                        return (
                          <div key={svcName} className="bg-black/40 border border-white/5 p-3 rounded-lg flex flex-col gap-2 relative group/item">
                            <div className="flex justify-between items-start gap-1">
                              <div>
                                <h4 className="text-xs font-semibold text-white">{svcName}</h4>
                                <Badge className={`text-[9px] uppercase mt-1 ${svc.status === 'running' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
                                  {svc.status || 'unknown'}
                                </Badge>
                              </div>
                              <div className="flex gap-1 opacity-0 group-hover/item:opacity-100 transition-opacity">
                                <Button
                                  onClick={() => { setLogsSession(stack); setLogsService(svcName); setFollowLogs(true); }}
                                  className="h-6 px-1.5 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/20 text-[9px]"
                                >
                                  Logs
                                </Button>
                                <Button
                                  onClick={() => handleInspect(stack.id, svcName)}
                                  className="h-6 px-1.5 rounded-lg bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 border border-indigo-500/20 text-[9px]"
                                >
                                  Inspect
                                </Button>
                              </div>
                            </div>

                            {svc.cloudflaredUrl && (
                              <a href={svc.cloudflaredUrl} target="_blank" rel="noopener noreferrer" className="text-[10px] text-[#00E5FF] hover:underline truncate font-mono">
                                🔗 {svc.cloudflaredUrl}
                              </a>
                            )}

                            {sStats && (
                              <div className="grid grid-cols-2 gap-2 text-[9.5px] text-white/30 border-t border-white/5 pt-1.5 font-mono">
                                <div>🖥️ CPU: <span className="text-emerald-400">{sStats.CPUPerc}</span></div>
                                <div>🧠 MEM: <span className="text-indigo-400">{sStats.MemUsage}</span></div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}

                {sessions.filter(s => s.type === 'docker-compose').length === 0 && (
                  <div className="flex flex-col items-center justify-center h-full text-white/30 space-y-2 py-12">
                    <span className="text-4xl">📭</span>
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
            <Card className="glass border border-white/10 rounded-2xl p-5 space-y-4">
              <CardHeader className="p-0">
                <CardTitle className="text-base font-bold flex items-center gap-2">
                  <span>💾</span> Trigger Docker Volume Backup
                </CardTitle>
                <CardDescription className="text-xs text-white/40">
                  Runs a lightweight Alpine helper container to tar and stream your target volume contents directly to Cloudflare R2 storage.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0 space-y-4">
                <div>
                  <label className="text-[10px] text-white/50 font-bold uppercase block mb-1">Volume Name / Mount Source</label>
                  <Input
                    type="text"
                    value={backupVolumeInput}
                    onChange={(e) => setBackupVolumeInput(e.target.value)}
                    placeholder="e.g. redis_data, web_html"
                    className="bg-black/20 border-white/10 focus:border-indigo-500 rounded-lg text-xs"
                  />
                </div>
                <Button
                  onClick={handleBackupVolume}
                  disabled={backupLoading || !backupVolumeInput || !daemonOnline}
                  className="w-full py-2.5 rounded-lg bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300 border border-indigo-500/30 font-semibold text-xs tracking-wider"
                >
                  {backupLoading ? '💾 Archiving & Uploading...' : 'Backup Volume to R2'}
                </Button>
              </CardContent>
            </Card>
          </div>

          {/* List of backups on R2 */}
          <div className="lg:col-span-7 glass rounded-2xl border border-white/10 overflow-hidden flex flex-col h-full min-h-[400px]">
            <div className="px-5 py-4 border-b border-white/10 bg-white/5 flex justify-between items-center">
              <h3 className="font-bold text-white text-sm">Stored Cloudflare R2 Backups ({volumeBackups.length})</h3>
              <Button onClick={loadBackups} variant="outline" className="h-7 px-2.5 rounded-lg text-xs border-white/10 text-white/60 hover:text-white bg-white/[0.04]">
                🔄 Refresh R2
              </Button>
            </div>

            <div className="p-5 flex-1 overflow-y-auto space-y-3.5 scrollbar-thin">
              {volumeBackups.map((vol) => (
                <div key={vol} className="bg-black/20 rounded-xl p-3.5 border border-white/5 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2.5">
                    <span className="text-xl">📦</span>
                    <div>
                      <div className="font-bold text-white text-xs font-mono">{vol}</div>
                      <div className="text-[10px] text-white/40 mt-0.5">CF-R2 Cloud Backup File: volumes/{vol}.tar.gz</div>
                    </div>
                  </div>

                  <Button
                    onClick={() => handleRestoreVolume(vol)}
                    disabled={backupLoading || !daemonOnline}
                    className="h-7 px-3.5 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/20 text-xs transition-colors"
                  >
                    Restore
                  </Button>
                </div>
              ))}

              {volumeBackups.length === 0 && (
                <div className="flex flex-col items-center justify-center h-full text-white/30 space-y-2 py-12">
                  <span className="text-4xl">📂</span>
                  <p>No volume backup archives found in Cloudflare R2.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'history' && (
        <div className="glass rounded-2xl border border-white/10 overflow-hidden flex flex-col h-full min-h-[500px] animate-in fade-in duration-200">
          <div className="px-5 py-4 border-b border-white/10 bg-white/5 flex justify-between items-center">
            <h3 className="font-bold text-white text-sm">Deployment rollback history</h3>
            <Button onClick={loadHistory} variant="outline" className="h-7 px-2.5 rounded-lg text-xs border-white/10 text-white/60 hover:text-white bg-white/[0.04]">
              🔄 Refresh
            </Button>
          </div>

          <div className="p-5 flex-1 overflow-y-auto space-y-4 max-h-[70vh] scrollbar-thin">
            {deployments.map((dep) => (
              <DeploymentRow key={dep.id} dep={dep} onRollback={handleRollback} daemonOnline={daemonOnline} />
            ))}

            {deployments.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-white/30 space-y-2 py-12">
                <span className="text-4xl">📜</span>
                <p>No deployment logs or history recorded yet.</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* MODAL: Realtime log stream */}
      {logsSession && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="w-full max-w-3xl glass rounded-2xl border border-white/10 bg-[#0d1117] shadow-2xl flex flex-col h-[75vh]">
            <div className="p-4 border-b border-white/10 flex justify-between items-center bg-white/5">
              <div>
                <h3 className="font-bold text-white text-sm flex items-center gap-2">
                  <span>📜</span> Log Streaming: {logsSession.id}
                </h3>
                {logsService && <span className="text-[10px] text-indigo-400 font-bold block mt-0.5">Service: {logsService}</span>}
              </div>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-1.5 text-xs text-white/60 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={followLogs}
                    onChange={(e) => setFollowLogs(e.target.checked)}
                    className="rounded border-white/10 text-indigo-500 bg-black/20 focus:ring-0"
                  />
                  Follow Logs
                </label>
                <button onClick={() => setLogsSession(null)} className="text-white/40 hover:text-white p-1">✕</button>
              </div>
            </div>
            
            <div className="flex-1 bg-black/50 p-4 font-mono text-[11px] text-emerald-400 overflow-y-auto space-y-1.5 scrollbar-thin">
              {logsLines.map((line, idx) => (
                <div key={idx} className="whitespace-pre-wrap leading-relaxed border-l-2 border-emerald-500/20 pl-2 hover:bg-white/[0.02]">
                  {line}
                </div>
              ))}
              <div ref={logEndRef} />
            </div>

            <div className="p-3.5 border-t border-white/10 flex justify-between items-center bg-white/5 text-xs text-white/40">
              <span>Showing up to last 500 lines of output.</span>
              <Button onClick={() => setLogsLines([])} variant="outline" className="h-7 text-xs border-white/10 hover:text-white bg-white/[0.02]">
                Clear View
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL: Inspect details */}
      {inspectData && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="w-full max-w-2xl glass rounded-2xl border border-white/10 bg-[#0d1117] shadow-2xl flex flex-col h-[70vh]">
            <div className="p-4 border-b border-white/10 flex justify-between items-center bg-white/5">
              <h3 className="font-bold text-white text-sm flex items-center gap-2">
                <span>🔍</span> {inspectTitle}
              </h3>
              <button onClick={() => setInspectData(null)} className="text-white/40 hover:text-white p-1">✕</button>
            </div>

            <div className="flex-1 bg-black/40 p-4 overflow-y-auto scrollbar-thin">
              <pre className="font-mono text-emerald-400 text-xs whitespace-pre-wrap m-0 leading-relaxed">
                {JSON.stringify(inspectData, null, 2)}
              </pre>
            </div>

            <div className="p-3.5 border-t border-white/10 flex justify-end bg-white/5">
              <Button onClick={() => setInspectData(null)} className="h-8 rounded-lg text-xs bg-indigo-500/20 text-indigo-400 hover:bg-indigo-500/30 border border-indigo-500/30 font-medium">
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
    <div className="bg-black/25 rounded-xl border border-white/5 p-4 space-y-3.5 hover:border-white/10 transition-all">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="text-lg">{dep.type === 'docker-compose' ? '⚡' : '🐋'}</span>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-white text-xs font-mono truncate max-w-[150px] sm:max-w-xs">{dep.sessionId}</span>
              <Badge className={`text-[9px] uppercase ${dep.status === 'success' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
                {dep.status}
              </Badge>
            </div>
            <div className="text-[10px] text-white/40 mt-1">
              📅 {new Date(dep.timestamp).toLocaleString()} | ID: <span className="font-mono">{dep.id}</span>
            </div>
          </div>
        </div>

        <div className="flex gap-2 text-xs">
          <Button
            onClick={() => setExpanded(!expanded)}
            variant="outline"
            className="h-7 text-xs border-white/10 hover:text-white bg-white/[0.02]"
          >
            {expanded ? 'Hide Config' : 'View Config'}
          </Button>
          {dep.logs && dep.logs.length > 0 && (
            <Button
              onClick={() => setLogsExpanded(!logsExpanded)}
              variant="outline"
              className="h-7 text-xs border-white/10 hover:text-white bg-white/[0.02]"
            >
              {logsExpanded ? 'Hide Logs' : 'View Logs'}
            </Button>
          )}
          {dep.status === 'success' && (
            <Button
              onClick={() => onRollback(dep.id)}
              disabled={!daemonOnline}
              className="h-7 bg-indigo-500/15 hover:bg-indigo-500/25 text-indigo-400 border border-indigo-500/20 text-xs"
            >
              Rollback
            </Button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="p-3.5 rounded-lg bg-black/40 border border-white/5 animate-in slide-in-from-top-1">
          <div className="text-[10px] text-white/40 font-bold uppercase mb-2">Deploy Configuration Options</div>
          <pre className="font-mono text-[10.5px] text-indigo-300 whitespace-pre-wrap m-0 leading-relaxed overflow-x-auto max-h-60 scrollbar-thin">
            {dep.type === 'docker-compose'
              ? `YAML:\n${dep.config?.yaml || 'None'}\n\nService Settings:\n${JSON.stringify(dep.config?.serviceSettings || {}, null, 2)}`
              : JSON.stringify(dep.config || {}, null, 2)}
          </pre>
        </div>
      )}

      {logsExpanded && dep.logs && (
        <div className="p-3.5 rounded-lg bg-black/40 border border-white/5 animate-in slide-in-from-top-1">
          <div className="text-[10px] text-white/40 font-bold uppercase mb-2">Job Deployment Terminal Logs</div>
          <div className="font-mono text-[10.5px] text-emerald-400 space-y-1 max-h-48 overflow-y-auto pr-1 scrollbar-thin">
            {dep.logs.map((logLine, idx) => (
              <div key={idx} className="leading-relaxed">{logLine}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
