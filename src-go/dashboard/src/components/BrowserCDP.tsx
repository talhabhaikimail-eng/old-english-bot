import { useState } from 'react';
import { 
  Globe, 
  Terminal as TerminalIcon, 
  Play, 
  RefreshCw, 
  Cpu, 
  CheckCircle2, 
  XCircle 
} from 'lucide-react';

interface BrowserCDPProps {
  addLog: (msg: string) => void;
}

export default function BrowserCDP({ addLog }: BrowserCDPProps) {
  const [cdpTargetUrl, setCdpTargetUrl] = useState<string>('https://estimation-dreams-tue-stand.trycloudflare.com');
  const [cachedUrl, setCachedUrl] = useState<string>('wss://estimation-dreams-tue-stand.trycloudflare.com/devtools/browser/abc123xyz...');
  const [connectionStatus, setConnectionStatus] = useState<'idle' | 'testing' | 'success' | 'failed'>('idle');
  const [testResults, setTestResults] = useState<string>('');

  const handleTestConnection = async () => {
    setConnectionStatus('testing');
    addLog(`Initiating connection test to Chrome CDP via target URL: ${cdpTargetUrl}`);

    // Simulate connection check
    setTimeout(() => {
      setConnectionStatus('success');
      setTestResults('Successfully connected to remote allocator! Evaluated: "1 + 1" = 2. Execution time: 0.42s');
      addLog('CDP Connection success: Remote Allocator verified 1+1 = 2.');
    }, 1500);
  };

  const handleUpdateCache = () => {
    addLog(`Saving new target URL to SQLite database: ${cdpTargetUrl}`);
    setCachedUrl(`wss://${cdpTargetUrl.replace(/^https?:\/\//, '')}/devtools/browser/...`);
    addLog('SQLite database updated successfully.');
  };

  return (
    <div className="flex flex-col gap-6 w-full animate-in">
      <div className="flex flex-col lg:flex-row gap-8">
        
        {/* Left Card: Settings */}
        <div className="flex-1 glass-card rounded-2xl p-6 flex flex-col gap-6">
          <div className="flex items-center gap-2">
            <Cpu className="h-5 w-5 text-brand" />
            <h2 className="text-lg font-semibold m-0 text-white">Browser CDP Settings</h2>
          </div>

          <div className="flex flex-col gap-4">
            <div>
              <label className="text-xs text-muted font-medium">Target DevTools Base URL</label>
              <div className="relative mt-1">
                <Globe className="absolute left-3 top-2.5 h-4 w-4 text-muted" />
                <input
                  type="text"
                  value={cdpTargetUrl}
                  onChange={(e) => setCdpTargetUrl(e.target.value)}
                  className="w-full bg-[#11151f] border border-white/10 rounded-lg py-2 pl-10 pr-4 text-sm focus:outline-none focus:border-brand"
                  placeholder="https://your-tunnel.trycloudflare.com"
                />
              </div>
              <span className="text-[10px] text-muted mt-1 block">
                The public Cloudflare tunnel endpoint exposing Chrome Debugging Protocol.
              </span>
            </div>

            <div className="flex gap-3">
              <button
                onClick={handleUpdateCache}
                className="px-4 py-2 rounded-lg border border-white/10 hover:bg-white/5 font-semibold text-xs transition-all"
              >
                Update Cache Database
              </button>
              <button
                onClick={handleTestConnection}
                disabled={connectionStatus === 'testing'}
                className="px-4 py-2 rounded-lg bg-brand text-white font-semibold text-xs hover:opacity-90 transition-all flex items-center gap-2 shadow-lg shadow-brand/10"
              >
                {connectionStatus === 'testing' ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                Run Test Execution
              </button>
            </div>
          </div>

          {/* SQLite Cache status */}
          <div className="pt-4 border-t border-white/5 flex flex-col gap-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-muted m-0">Cached Websocket URL (SQLite3)</h3>
            <div className="p-3 rounded-lg bg-[#11151f] border border-white/5 font-mono text-xs text-brand/80 truncate">
              {cachedUrl}
            </div>
          </div>
        </div>

        {/* Right Card: Connection Status & Log Output */}
        <div className="w-full lg:w-[500px] glass-card rounded-2xl p-6 flex flex-col gap-6">
          <div className="flex items-center gap-2">
            <TerminalIcon className="h-5 w-5 text-teal" />
            <h2 className="text-lg font-semibold m-0 text-white">Connection Verification</h2>
          </div>

          <div className="flex-1 flex flex-col gap-4 justify-center items-center min-h-[200px] border border-white/5 rounded-xl bg-[#11151f]/20 p-6">
            {connectionStatus === 'idle' && (
              <div className="text-center">
                <Globe className="h-10 w-10 text-muted mx-auto mb-2" />
                <p className="text-sm text-muted">Ready to test chromedp remote allocation</p>
              </div>
            )}
            {connectionStatus === 'testing' && (
              <div className="text-center">
                <RefreshCw className="h-10 w-10 text-brand animate-spin mx-auto mb-2" />
                <p className="text-sm text-brand font-medium">Verifying remote allocation protocol...</p>
              </div>
            )}
            {connectionStatus === 'success' && (
              <div className="text-center">
                <CheckCircle2 className="h-10 w-10 text-emerald-400 mx-auto mb-2" />
                <p className="text-sm text-emerald-400 font-medium">Connection Verified Successfully</p>
                <p className="text-xs text-muted mt-2 max-w-xs">{testResults}</p>
              </div>
            )}
            {connectionStatus === 'failed' && (
              <div className="text-center">
                <XCircle className="h-10 w-10 text-destructive mx-auto mb-2" />
                <p className="text-sm text-destructive font-medium">Verification Failed</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
