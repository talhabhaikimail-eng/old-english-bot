import { useState, useEffect } from 'react';
import { 
  Layers, 
  Cpu, 
  Terminal as TerminalIcon, 
  RefreshCw, 
  Share2,
} from 'lucide-react';
import ContainerManager from './components/ContainerManager';
import BrowserCDP from './components/BrowserCDP';
import ContactScraper from './components/ContactScraper';

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

const API_BASE = 'http://localhost:18080';

export default function App() {
  const [activePackage, setActivePackage] = useState<'containers' | 'browser-cdp' | 'contact-scraper'>('containers');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [isLoadingSessions, setIsLoadingSessions] = useState<boolean>(false);
  const [logs, setLogs] = useState<string[]>([]);

  useEffect(() => {
    fetchSessions();
  }, []);

  const addLog = (msg: string) => {
    setLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
  };

  const fetchSessions = async () => {
    setIsLoadingSessions(true);
    try {
      const res = await fetch(`${API_BASE}/api/go/containers/sessions`);
      if (res.ok) {
        const data = await res.json();
        setSessions(data);
      }
    } catch (e: any) {
      addLog(`Failed to fetch sessions: ${e.message}`);
    } finally {
      setIsLoadingSessions(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#090d16] text-white flex flex-col antialiased">
      {/* Header */}
      <header className="glass border-b border-white/5 py-4 px-8 sticky top-0 z-50 flex justify-between items-center">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-tr from-brand to-teal flex items-center justify-center shadow-lg shadow-brand/20">
            <Layers className="h-5 w-5 text-white animate-pulse" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-white m-0 leading-none">Go Suite Dashboard</h1>
            <span className="text-xs text-muted">Unified Go Package Administration</span>
          </div>
        </div>

        {/* Package Selector */}
        <div className="flex items-center gap-2 bg-[#11151f]/80 p-1.5 border border-white/5 rounded-xl">
          <button 
            onClick={() => setActivePackage('containers')}
            className={`px-4 py-2 rounded-lg font-bold text-xs transition-all duration-200 flex items-center gap-2 ${activePackage === 'containers' ? 'bg-brand text-white shadow-lg shadow-brand/20' : 'text-muted hover:text-white'}`}
          >
            <Layers className="h-3.5 w-3.5" />
            container-manager
          </button>
          <button 
            onClick={() => setActivePackage('browser-cdp')}
            className={`px-4 py-2 rounded-lg font-bold text-xs transition-all duration-200 flex items-center gap-2 ${activePackage === 'browser-cdp' ? 'bg-brand text-white shadow-lg shadow-brand/20' : 'text-muted hover:text-white'}`}
          >
            <Cpu className="h-3.5 w-3.5" />
            browser-cdp-connection
          </button>
          <button 
            onClick={() => setActivePackage('contact-scraper')}
            className={`px-4 py-2 rounded-lg font-bold text-xs transition-all duration-200 flex items-center gap-2 ${activePackage === 'contact-scraper' ? 'bg-brand text-white shadow-lg shadow-brand/20' : 'text-muted hover:text-white'}`}
          >
            <Share2 className="h-3.5 w-3.5" />
            contact-scraper
          </button>
        </div>

        <div className="flex items-center gap-4">
          <button 
            onClick={fetchSessions}
            className="p-2 rounded-lg border border-white/10 hover:bg-white/5 transition-all"
            title="Refresh Overall Sessions"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </header>

      {/* Main Panel */}
      <main className="flex-1 max-w-[1600px] w-full mx-auto p-8 flex flex-col gap-8">
        {activePackage === 'containers' ? (
          <ContainerManager 
            apiBase={API_BASE}
            addLog={addLog}
            sessions={sessions}
            fetchSessions={fetchSessions}
            isLoadingSessions={isLoadingSessions}
          />
        ) : activePackage === 'browser-cdp' ? (
          <BrowserCDP 
            addLog={addLog}
          />
        ) : (
          <ContactScraper 
            addLog={addLog}
          />
        )}
      </main>

      {/* Terminal Logs Panel */}
      <footer className="glass border-t border-white/5 p-6 bg-[#06090f]">
        <div className="max-w-[1600px] w-full mx-auto">
          <div className="flex items-center gap-2 mb-3">
            <TerminalIcon className="h-4 w-4 text-brand" />
            <span className="text-xs font-bold uppercase tracking-wider text-muted">System Logs & Outputs</span>
          </div>
          <div className="h-32 rounded-xl bg-black/40 border border-white/5 p-4 font-mono text-xs text-emerald-400 overflow-y-auto scrollbar-thin">
            {logs.length === 0 ? (
              <span className="text-muted">Console idle... Click 'Parse Configuration' or run connection checks.</span>
            ) : (
              logs.map((log, i) => (
                <div key={i} className="mb-1 leading-relaxed">{log}</div>
              ))
            )}
          </div>
        </div>
      </footer>
    </div>
  );
}
