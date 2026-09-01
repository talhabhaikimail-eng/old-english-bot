import crypto from 'crypto';
import { sessionManager } from './session-manager';

export interface TerminalOptions {
  isDemo?: boolean;
  ttlMinutes?: number;
  customDomain?: string;
}

const GO_MANAGER_URL = 'http://127.0.0.1:18080';

export async function startTerminal(options: TerminalOptions = {}): Promise<{ url?: string; username?: string; password?: string; sessionId?: string; error?: string }> {
  try {
    const hash = crypto.randomBytes(4).toString('hex');
    const sessionId = `docker-${hash}`;
    const username = `guest_${crypto.randomBytes(2).toString('hex')}`;
    const password = crypto.randomBytes(6).toString('hex');

    // 1. Check if Go Container Manager is available
    try {
      const healthRes = await fetch(`${GO_MANAGER_URL}/api/go/containers/health`).catch(() => null);
      if (healthRes && healthRes.ok) {
        console.log('🐳 Spawning sandboxed Web Terminal inside isolated Docker container via Go Container Manager...');
        
        const payload = {
          name: 'terminal',
          template: 'terminal',
          image: 'tsl0922/ttyd:alpine',
          port: 7681,
          command: ['ttyd', '-W', '-p', '7681', 'sh'],
          domainMode: 'custom',
          customDomain: options.customDomain || '',
          ttlMinutes: options.ttlMinutes || (options.isDemo ? 5 : 0),
          isDemo: !!options.isDemo,
          sessionId: hash
        };

        const startRes = await fetch(`${GO_MANAGER_URL}/api/go/containers/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (!startRes.ok) {
          const errData = await startRes.json().catch(() => ({ error: 'Failed to start terminal container' })) as any;
          return { error: `Go container manager failed: ${errData.error || startRes.statusText}` };
        }

        const startData = await startRes.json() as { jobId: string; sessionId: string };
        const jobId = startData.jobId;

        // Poll for job completion
        let finished = false;
        let attempts = 0;
        while (!finished && attempts < 60) {
          await new Promise(r => setTimeout(r, 1000));
          attempts++;

          const jobRes = await fetch(`${GO_MANAGER_URL}/api/go/containers/jobs?id=${jobId}`).catch(() => null);
          if (jobRes && jobRes.ok) {
            const jobData = await jobRes.json() as any;
            if (jobData.status === 'done') {
              finished = true;
              break;
            } else if (jobData.status === 'failed') {
              return { error: `Terminal container deployment failed: ${jobData.error || 'Unknown error'}` };
            }
          }
        }

        if (!finished) {
          return { error: 'Timed out waiting for Terminal container to initialize' };
        }

        // Fetch session details
        const sessRes = await fetch(`${GO_MANAGER_URL}/api/go/containers/sessions`);
        const sessions = await sessRes.json() as any[];
        const found = sessions.find(s => s.id === sessionId || s.id === `docker-${hash}`);
        const baseDomain = options.isDemo ? (process.env.PORTFOLIO_DOMAIN || 'talhacodes.site') : (process.env.MAIN_DOMAIN || 'ufone-claim.site');
        const defaultSubdomain = options.isDemo ? `demo-${hash}.${baseDomain}` : `term-${hash}.${baseDomain}`;
        const url = found?.url || (options.customDomain ? `https://${options.customDomain}` : `https://${defaultSubdomain}`);

        sessionManager.addSession({
          id: sessionId,
          type: 'terminal',
          url,
          username,
          password,
          startedAt: new Date(),
          metadata: {
            isContainerized: true,
            expiresAt: found?.metadata?.expiresAt,
            isDemo: options.isDemo,
          },
        });

        return { url, username, password, sessionId };
      }
    } catch (e: any) {
      console.warn('⚠️ Go Container Manager unreachable:', e.message);
    }

    return { error: 'Go Container Manager is offline. Ensure container-manager is running on port 18080.' };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return { error: `Failed to set up terminal: ${errMsg}` };
  }
}

export async function stopTerminal(sessionId: string): Promise<{ success: boolean; message: string }> {
  try {
    const cleanId = sessionId.startsWith('docker-') ? sessionId : `docker-${sessionId}`;
    
    // Stop via Go Container Manager
    const stopRes = await fetch(`${GO_MANAGER_URL}/api/go/containers/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: cleanId, force: true })
    }).catch(() => null);

    sessionManager.removeSession(sessionId);
    sessionManager.removeSession(cleanId);

    // Unregister URL if registered
    try {
      const { unregisterUrl } = require('./dashboard-server');
      unregisterUrl('terminal');
    } catch (e) {
      // ignore
    }

    return { success: true, message: 'Terminal container stopped successfully' };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return { success: false, message: `Failed to stop terminal: ${errMsg}` };
  }
}
