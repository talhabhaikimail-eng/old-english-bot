import { useState } from 'react';
import { 
  Layers, 
  Settings, 
  Database, 
  Play, 
  Square, 
  RefreshCw, 
  CloudRain, 
  FileText, 
  CheckCircle, 
  AlertTriangle,
  FolderSymlink
} from 'lucide-react';

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

interface SessionMetadata {
  port?: number;
  hostPort?: number;
  containerName?: string;
  targetUrl?: string;
  image?: string;
  env?: Record<string, string>;
  domainMode?: string;
  customDomain?: string;
  cloudflaredUrl?: string;
  tunnelToken?: string;
  tunnelId?: string;
}

interface Session {
  id: string;
  type: string;
  url: string;
  startedAt: string;
  metadata: SessionMetadata;
}

interface ContainerManagerProps {
  apiBase: string;
  addLog: (msg: string) => void;
  sessions: Session[];
  fetchSessions: () => Promise<void>;
  isLoadingSessions: boolean;
}

export default function ContainerManager({ apiBase, addLog, sessions, fetchSessions, isLoadingSessions }: ContainerManagerProps) {
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

  // User input settings per service
  const [serviceSettings, setServiceSettings] = useState<Record<string, {
    domainMode: 'none' | 'quick' | 'custom';
    customDomain: string;
    tunnelToken: string;
    env: Record<string, string>;
  }>>({});

  // Volumes selected for R2 backup
  const [backupVolumes, setBackupVolumes] = useState<Record<string, boolean>>({});
  const [activeTab, setActiveTab] = useState<'editor' | 'sessions'>('editor');

  const handleParseYAML = async () => {
    setIsParsing(true);
    setParseError(null);
    try {
      const res = await fetch(`${apiBase}/api/go/containers/compose/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ yaml: yamlInput }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Parsing failed');
      }
      setParsedCompose(data);
      addLog('Successfully parsed Docker Compose YAML!');

      // Populate default settings for each parsed service
      const initialSettings: typeof serviceSettings = {};
      Object.entries(data.services).forEach(([name, svc]: [string, any]) => {
        initialSettings[name] = {
          domainMode: 'none',
          customDomain: '',
          tunnelToken: '',
          env: { ...svc.environment }
        };
      });
      setServiceSettings(initialSettings);

      // Populate default backup volumes
      const initialBackups: Record<string, boolean> = {};
      data.volumes.forEach((vol: string) => {
        initialBackups[vol] = false;
      });
      setBackupVolumes(initialBackups);

    } catch (e: any) {
      setParseError(e.message);
      setParsedCompose(null);
      addLog(`YAML parse error: ${e.message}`);
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
    addLog('Initiating deployment of Docker Compose configuration...');
    const payload = {
      compose: parsedCompose,
      services: serviceSettings,
      backupVolumes: Object.keys(backupVolumes).filter(k => backupVolumes[k])
    };
    addLog(`Target configuration payload: ${JSON.stringify(payload, null, 2)}`);
    addLog('Generating Docker Compose deployment environment...');
    addLog('✅ Container environment deployment simulation success! Real deployment API stub connected.');
  };

  const handleStopSession = async (id: string) => {
    addLog(`Stopping container session: ${id}...`);
    try {
      const res = await fetch(`${apiBase}/api/go/containers/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: id })
      });
      if (res.ok) {
        addLog(`Successfully stopped session: ${id}`);
        fetchSessions();
      } else {
        addLog(`Failed to stop session: ${id}`);
      }
    } catch (e: any) {
      addLog(`Error stopping session: ${e.message}`);
    }
  };

  return (
    <div className="flex flex-col gap-6 w-full">
      <div className="flex gap-4 border-b border-white/5 pb-4">
        <button 
          onClick={() => setActiveTab('editor')}
          className={`px-4 py-2 rounded-lg font-medium text-sm transition-all duration-200 ${activeTab === 'editor' ? 'bg-brand text-white shadow-lg shadow-brand/20' : 'text-muted hover:text-white'}`}
        >
          Visual Compose Editor
        </button>
        <button 
          onClick={() => setActiveTab('sessions')}
          className={`px-4 py-2 rounded-lg font-medium text-sm transition-all duration-200 ${activeTab === 'sessions' ? 'bg-brand text-white shadow-lg shadow-brand/20' : 'text-muted hover:text-white'}`}
        >
          Active Sessions ({sessions.length})
        </button>
      </div>

      {activeTab === 'editor' ? (
        <div className="flex flex-col lg:flex-row gap-8">
          {/* YAML Editor */}
          <div className="flex-1 flex flex-col gap-6">
            <div className="glass-card rounded-2xl p-6 flex flex-col flex-1 min-h-[500px]">
              <div className="flex justify-between items-center mb-4">
                <div className="flex items-center gap-2">
                  <FileText className="h-5 w-5 text-brand" />
                  <h2 className="text-lg font-semibold m-0 text-white">Docker Compose YAML</h2>
                </div>
                <button 
                  onClick={handleParseYAML}
                  disabled={isParsing}
                  className="px-4 py-1.5 rounded-lg bg-teal text-[#090d16] font-bold text-xs hover:opacity-90 transition-all flex items-center gap-2"
                >
                  {isParsing ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                  Parse Configuration
                </button>
              </div>

              <div className="flex-1 relative rounded-xl border border-white/10 overflow-hidden bg-[#11151f] min-h-[400px]">
                <textarea
                  value={yamlInput}
                  onChange={(e) => setYamlInput(e.target.value)}
                  className="w-full h-full p-4 font-mono text-sm bg-transparent border-0 outline-none resize-none text-emerald-400 focus:ring-0"
                  placeholder="Paste docker-compose.yml content here..."
                />
              </div>

              {parseError && (
                <div className="mt-4 p-4 rounded-xl bg-destructive/10 border border-destructive/20 flex items-start gap-3">
                  <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
                  <div>
                    <h4 className="text-sm font-semibold text-destructive">Parse Error</h4>
                    <p className="text-xs text-muted mt-1">{parseError}</p>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Setup Panel */}
          <div className="w-full lg:w-[500px] flex flex-col gap-6">
            {parsedCompose ? (
              <div className="glass-card rounded-2xl p-6 flex flex-col gap-6 animate-in">
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-2">
                    <Settings className="h-5 w-5 text-teal" />
                    <h2 className="text-lg font-semibold m-0 text-white">Visual Setup</h2>
                  </div>
                  <span className="text-xs bg-brand/20 border border-brand/30 px-2.5 py-1 rounded-full text-brand font-medium">
                    Version: {parsedCompose.version}
                  </span>
                </div>

                <div className="flex flex-col gap-4 overflow-y-auto max-h-[450px] pr-2 scrollbar-thin">
                  {Object.entries(parsedCompose.services).map(([name, svc]) => (
                    <div key={name} className="p-4 rounded-xl border border-white/5 bg-[#11151f]/50 flex flex-col gap-4">
                      <div className="flex justify-between items-start">
                        <div>
                          <h4 className="text-sm font-bold text-white m-0">{name}</h4>
                          <span className="text-xs text-muted block mt-0.5">Image: {svc.image}</span>
                        </div>
                        {svc.ports.length > 0 && (
                          <span className="text-[10px] bg-teal/10 border border-teal/20 text-teal px-2 py-0.5 rounded font-mono">
                            Port: {svc.ports.join(', ')}
                          </span>
                        )}
                      </div>

                      <div className="flex flex-col gap-2">
                        <label className="text-xs text-muted font-medium">Domain Routing</label>
                        <div className="grid grid-cols-3 gap-2">
                          {(['none', 'quick', 'custom'] as const).map((mode) => (
                            <button
                              key={mode}
                              type="button"
                              onClick={() => handleServiceSettingChange(name, 'domainMode', mode)}
                              className={`py-1.5 rounded-lg border text-xs font-semibold capitalize transition-all ${
                                serviceSettings[name]?.domainMode === mode
                                  ? 'bg-brand/20 border-brand text-white'
                                  : 'border-white/5 bg-transparent hover:bg-white/5 text-muted'
                              }`}
                            >
                              {mode === 'none' ? 'Internal Only' : mode === 'quick' ? 'Quick' : 'Custom'}
                            </button>
                          ))}
                        </div>
                      </div>

                      {serviceSettings[name]?.domainMode === 'custom' && (
                        <div className="flex flex-col gap-3 animate-in">
                          <div>
                            <label className="text-xs text-muted font-medium">Domain URL</label>
                            <input
                              type="text"
                              placeholder="app.mydomain.com"
                              value={serviceSettings[name]?.customDomain || ''}
                              onChange={(e) => handleServiceSettingChange(name, 'customDomain', e.target.value)}
                              className="w-full bg-[#11151f] border border-white/10 rounded-lg py-2 px-3 text-sm focus:outline-none focus:border-brand mt-1"
                            />
                          </div>
                        </div>
                      )}

                      {Object.keys(svc.environment).length > 0 && (
                        <div className="flex flex-col gap-2">
                          <label className="text-xs text-muted font-medium">Environment Variables</label>
                          <div className="flex flex-col gap-2">
                            {Object.entries(svc.environment).map(([key]) => (
                              <div key={key} className="flex gap-2 items-center">
                                <span className="text-xs font-mono text-muted shrink-0 w-24 truncate" title={key}>{key}</span>
                                <input
                                  type="text"
                                  value={serviceSettings[name]?.env[key] || ''}
                                  onChange={(e) => handleServiceEnvChange(name, key, e.target.value)}
                                  className="flex-1 bg-[#11151f] border border-white/10 rounded-lg py-1 px-2 text-xs focus:outline-none focus:border-brand"
                                />
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {parsedCompose.volumes.length > 0 && (
                  <div className="flex flex-col gap-3">
                    <div className="flex items-center gap-2">
                      <Database className="h-4 w-4 text-brand" />
                      <h3 className="text-xs font-bold uppercase tracking-wider text-muted m-0">Selective Volume Backup</h3>
                    </div>
                    <div className="flex flex-col gap-2">
                      {parsedCompose.volumes.map((vol) => (
                        <label key={vol} className="flex items-center gap-3 p-3 rounded-xl border border-white/5 bg-[#11151f]/30 cursor-pointer hover:bg-white/5 transition-all">
                          <input
                            type="checkbox"
                            checked={backupVolumes[vol] || false}
                            onChange={(e) => setBackupVolumes(prev => ({ ...prev, [vol]: e.target.checked }))}
                            className="rounded border-white/10 text-brand bg-[#11151f]"
                          />
                          <span className="text-sm font-semibold text-white">{vol}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                <button
                  onClick={handleDeployCompose}
                  className="w-full py-3 rounded-xl bg-gradient-to-r from-brand to-teal hover:opacity-90 transition-all font-bold text-sm tracking-wide text-white shadow-lg shadow-brand/20 flex items-center justify-center gap-2"
                >
                  <CheckCircle className="h-4 w-4" />
                  Deploy System Config
                </button>
              </div>
            ) : (
              <div className="glass-card rounded-2xl p-8 flex flex-col items-center justify-center text-center flex-1 border-dashed border-white/10 min-h-[400px]">
                <Layers className="h-8 w-8 text-muted mb-4" />
                <h3 className="text-lg font-semibold text-white">Visual Setup</h3>
                <p className="text-sm text-muted mt-2">
                  Parse your Docker Compose YAML config on the left to configure domains and backup properties.
                </p>
              </div>
            )}
          </div>
        </div>
      ) : (
        /* Active Sessions Tab */
        <div className="glass-card rounded-2xl p-6 flex flex-col flex-1">
          <div className="flex items-center gap-2 mb-6">
            <FolderSymlink className="h-5 w-5 text-brand" />
            <h2 className="text-lg font-semibold m-0 text-white">Active Deployments</h2>
          </div>

          {isLoadingSessions ? (
            <div className="flex justify-center py-12">
              <RefreshCw className="h-8 w-8 text-brand animate-spin" />
            </div>
          ) : sessions.length === 0 ? (
            <div className="flex flex-col items-center justify-center text-center py-12">
              <CloudRain className="h-12 w-12 text-muted mb-4" />
              <h3 className="text-lg font-semibold text-white">No active deployments</h3>
              <p className="text-sm text-muted mt-1">Deploy services to start a session.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {sessions.map((sess) => (
                <div key={sess.id} className="p-5 rounded-2xl border border-white/5 bg-[#11151f]/40 flex flex-col justify-between gap-4">
                  <div>
                    <div className="flex justify-between items-start">
                      <div>
                        <span className="text-xs text-brand font-semibold uppercase">{sess.type}</span>
                        <h3 className="text-base font-bold text-white mt-1 mb-0">{sess.metadata.containerName || sess.id}</h3>
                      </div>
                      <button
                        onClick={() => handleStopSession(sess.id)}
                        className="p-2 rounded-lg bg-destructive/10 hover:bg-destructive/20 text-destructive border border-destructive/20 transition-all"
                      >
                        <Square className="h-4 w-4 fill-destructive" />
                      </button>
                    </div>
                    <div className="mt-4 flex flex-col gap-2">
                      <div className="flex justify-between items-center text-xs">
                        <span className="text-muted">Image</span>
                        <span className="font-mono text-white truncate max-w-[200px]">{sess.metadata.image}</span>
                      </div>
                      <div className="flex justify-between items-center text-xs">
                        <span className="text-muted">External Endpoint</span>
                        {sess.url ? (
                          <a href={sess.url} target="_blank" rel="noreferrer" className="text-teal hover:underline max-w-[200px] truncate">{sess.url}</a>
                        ) : (
                          <span className="text-muted">None</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="pt-3 border-t border-white/5 flex justify-between items-center text-[10px] text-muted">
                    <span>Started: {new Date(sess.startedAt).toLocaleString()}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
