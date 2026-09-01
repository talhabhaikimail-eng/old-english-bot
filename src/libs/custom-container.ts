import { exec, spawn } from 'child_process';
import util from 'util';
import crypto from 'crypto';
import { sessionManager } from './session-manager';

const execAsync = util.promisify(exec);

function getSanitizedEnv(key: string): string {
  const raw = process.env[key];
  if (!raw) return '';
  return raw.trim().replace(/^['"]|['"]$/g, '').replace(/;$/, '').trim();
}

let nextPort = 15000;

async function waitForHealthyUrl(targetUrl: string, timeoutMs = 35000): Promise<boolean> {
  const startTime = Date.now();
  console.log(`[Health Check] Polling ${targetUrl} every 1s until healthy status...`);
  let attempt = 0;
  while (Date.now() - startTime < timeoutMs) {
    attempt++;
    try {
      const res = await fetch(targetUrl, { signal: AbortSignal.timeout(2000) });
      if (res.status < 500 && res.status !== 530) {
        console.log(`[Health Check] ✅ Target ${targetUrl} is healthy with HTTP status ${res.status} (attempt ${attempt})`);
        return true;
      }
      console.log(`[Health Check] Attempt ${attempt}: Target ${targetUrl} returned status ${res.status}, waiting 1s...`);
    } catch (e: any) {
      console.log(`[Health Check] Attempt ${attempt}: Target ${targetUrl} ping failed (${e.message}), retrying in 1s...`);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.warn(`[Health Check] ⚠️ Timeout waiting for ${targetUrl} to become healthy. Continuing.`);
  return false;
}

export async function cleanupCloudflareResources(meta: any, sessionId?: string): Promise<void> {
  if (!meta) return;
  const { tunnelPid, tunnelId, customDomain } = meta;

  // Clear tunnelPid in session manager first to prevent the close/exit handlers from deleting the session
  if (sessionId) {
    sessionManager.updateSessionMetadata(sessionId, {
      tunnelPid: undefined
    });
  }

  // 1. Kill tunnel process
  if (tunnelPid) {
    try {
      process.kill(tunnelPid);
      console.log(`[Cloudflare Cleanup] Killed tunnel process PID ${tunnelPid}`);
    } catch (e) {
      // ignore
    }
  }

  // 2. Delete Cloudflare Tunnel & DNS CNAME if created programmatically
  const ACCOUNT_ID = getSanitizedEnv('CLOUDFLARE_ACCOUNT_ID');
  const ZONE_ID = getSanitizedEnv('CLOUDFLARE_ZONE_ID');
  const API_TOKEN = getSanitizedEnv('CLOUDFLARE_API_TOKEN');

  if (tunnelId && ACCOUNT_ID && API_TOKEN) {
    try {
      console.log(`[Cloudflare Cleanup] Deleting Cloudflare tunnel ${tunnelId}...`);
      
      // Wait a brief moment to ensure the tunnel process is fully terminated and disconnected
      await new Promise(resolve => setTimeout(resolve, 2000));

      const delRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/cfd_tunnel/${tunnelId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${API_TOKEN}`,
          'Content-Type': 'application/json'
        }
      });
      const delData = await delRes.json() as any;
      if (delData.success) {
        console.log(`[Cloudflare Cleanup] Successfully deleted Cloudflare tunnel ${tunnelId}`);
      } else {
        console.warn(`[Cloudflare Cleanup] Failed to delete Cloudflare tunnel:`, delData.errors);
      }
    } catch (err) {
      console.error(`[Cloudflare Cleanup] Error deleting Cloudflare tunnel:`, err);
    }
  }

  if (customDomain && ZONE_ID && API_TOKEN) {
    try {
      const hostname = customDomain.replace(/^https?:\/\//, '');
      console.log(`[Cloudflare Cleanup] Cleaning up DNS CNAME record for ${hostname}...`);

      // Find DNS record ID
      const dnsListRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records?name=${hostname}&type=CNAME`, {
        headers: {
          'Authorization': `Bearer ${API_TOKEN}`,
          'Content-Type': 'application/json'
        }
      });
      const dnsListData = await dnsListRes.json() as any;
      if (dnsListData.success && dnsListData.result && dnsListData.result.length > 0) {
        const dnsRecordId = dnsListData.result[0].id;
        const delDnsRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records/${dnsRecordId}`, {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${API_TOKEN}`,
            'Content-Type': 'application/json'
          }
        });
        const delDnsData = await delDnsRes.json() as any;
        if (delDnsData.success) {
          console.log(`[Cloudflare Cleanup] Successfully deleted CNAME record for ${hostname}`);
        } else {
          console.warn(`[Cloudflare Cleanup] Failed to delete CNAME record:`, delDnsData.errors);
        }
      }
    } catch (err) {
      console.error(`[Cloudflare Cleanup] Error cleaning up CNAME record:`, err);
    }
  }
}

export async function startCustomContainer(
  image: string,
  containerPort: number,
  env: Record<string, string>,
  name?: string,
  domainMode: 'quick' | 'custom' = 'quick',
  customDomain?: string,
  requestedHostPort?: number,
  tunnelToken?: string,
  existingSessionId?: string
): Promise<{ url?: string; containerName?: string; error?: string }> {
  try {
    // Check docker version first to verify docker is installed
    try {
      await execAsync('docker --version');
    } catch {
      return { error: 'Docker is not installed or not running on the host system.' };
    }

    const hash = existingSessionId ? existingSessionId.replace(/^docker-/, '') : crypto.randomBytes(4).toString('hex');
    const sessionId = existingSessionId || `docker-${hash}`;

    // 1. If updating/redeploying, stop old container and clean up old Cloudflare resources first
    const existingSession = existingSessionId ? sessionManager.getSession(existingSessionId) : null;
    const webhookSecret = existingSession?.metadata?.webhookSecret || crypto.randomBytes(16).toString('hex');

    let activeTunnelToken = tunnelToken;
    let activeTunnelId = '';
    let reuseTunnel = false;

    if (existingSession) {
      const oldMeta = existingSession.metadata as any;
      if (oldMeta) {
        console.log(`[Docker Deploy] Stopping existing container for ${existingSessionId}...`);
        
        // Stop old container
        if (oldMeta.containerName) {
          try {
            await execAsync(`docker stop ${oldMeta.containerName}`);
            console.log(`[Docker Deploy] Stopped old container ${oldMeta.containerName}`);
          } catch (e) {
            console.warn(`[Docker Deploy] Failed to stop old container:`, e);
          }
        }

        // Clear tunnelPid in session manager first to prevent the close/exit handlers from deleting the session
        sessionManager.updateSessionMetadata(sessionId, {
          tunnelPid: undefined
        });

        // Kill old tunnel process
        if (oldMeta.tunnelPid) {
          try {
            process.kill(oldMeta.tunnelPid);
            console.log(`[Docker Deploy] Killed old tunnel process PID ${oldMeta.tunnelPid}`);
          } catch (e) {
            // ignore
          }
        }

        // Check if we can reuse the Cloudflare tunnel (only if domainMode is custom, we have an existing token, and the custom domain is the same)
        const targetUrl = customDomain ? (customDomain.startsWith('http') ? customDomain : `https://${customDomain}`) : '';
        const oldTargetUrl = oldMeta.customDomain ? (oldMeta.customDomain.startsWith('http') ? oldMeta.customDomain : `https://${oldMeta.customDomain}`) : '';
        
        if (
          domainMode === 'custom' &&
          oldMeta.domainMode === 'custom' &&
          oldMeta.tunnelToken &&
          targetUrl &&
          targetUrl === oldTargetUrl
        ) {
          console.log(`[Docker Deploy] Reusing existing Cloudflare tunnel token: ${oldMeta.tunnelId}`);
          activeTunnelToken = oldMeta.tunnelToken;
          activeTunnelId = oldMeta.tunnelId || '';
          reuseTunnel = true;
        } else {
          // Clean up Cloudflare resources (tunnels, DNS) since we cannot reuse them
          await cleanupCloudflareResources({
            tunnelId: oldMeta.tunnelId,
            customDomain: oldMeta.customDomain
          });
        }
      }
    }
    const cleanName = (name || 'custom-app').replace(/[^a-zA-Z0-9_-]/g, '_');
    const containerName = `docker-custom-${cleanName}-${hash}`;
    const hostPort = requestedHostPort && requestedHostPort > 0 ? requestedHostPort : nextPort++;

    // Format env parameters
    const envArgs: string[] = [];
    for (const [k, v] of Object.entries(env)) {
      if (k && v) {
        envArgs.push('-e', `${k}=${v}`);
      }
    }

    console.log(`[Docker Deploy] Pulling image ${image}...`);
    await execAsync(`docker pull ${image}`);

    console.log(`[Docker Deploy] Running container ${containerName} on host port ${hostPort}...`);
    const dockerCmd = [
      'docker', 'run', '-d', '--rm',
      '--name', containerName,
      '-p', `${hostPort}:${containerPort}`,
      ...envArgs,
      image
    ];

    await execAsync(dockerCmd.join(' '));

    if (domainMode === 'custom') {
      if (!customDomain) {
        return { error: 'Custom domain is required when domain mode is custom.' };
      }
      const targetUrl = customDomain.startsWith('http') ? customDomain : `https://${customDomain}`;
      const hostname = targetUrl.replace(/^https?:\/\//, '');
      console.log(`[Docker Deploy] Custom domain configured: ${targetUrl} (hostname: ${hostname})`);

      const ACCOUNT_ID = getSanitizedEnv('CLOUDFLARE_ACCOUNT_ID');
      const ZONE_ID = getSanitizedEnv('CLOUDFLARE_ZONE_ID');
      const API_TOKEN = getSanitizedEnv('CLOUDFLARE_API_TOKEN');

      // Use existing tunnel token if reuseTunnel is true, otherwise use the passed parameter
      if (!reuseTunnel && tunnelToken) {
        activeTunnelToken = tunnelToken;
      }

      // If no tunnel token is provided, and we have Cloudflare credentials, auto-generate the tunnel
      if (!activeTunnelToken) {
        if (!ACCOUNT_ID || !ZONE_ID || !API_TOKEN) {
          return { error: 'Missing Cloudflare credentials (CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ZONE_ID, CLOUDFLARE_API_TOKEN) in environment to auto-configure custom domain.' };
        }

        try {
          console.log('[Docker Deploy] Auto-configuring Cloudflare Tunnel...');
          const tunnelSecret = crypto.randomBytes(32).toString('base64');
          const tunnelName = `tunnel-${cleanName}-${hash}`.substring(0, 120);

          // 1. Create Tunnel
          const tunnelRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/cfd_tunnel`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${API_TOKEN}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              name: tunnelName,
              tunnel_secret: tunnelSecret
            })
          });
          const tunnelData = await tunnelRes.json() as any;
          if (!tunnelData.success) {
            return { error: `Cloudflare tunnel creation failed: ${JSON.stringify(tunnelData.errors)}` };
          }
          activeTunnelId = tunnelData.result.id;
          console.log(`[Docker Deploy] Cloudflare Tunnel Created: ${activeTunnelId}`);

          // 2. Configure Ingress Rules
          const configRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/cfd_tunnel/${activeTunnelId}/configurations`, {
            method: 'PUT',
            headers: {
              'Authorization': `Bearer ${API_TOKEN}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              config: {
                ingress: [
                  { hostname: hostname, service: `http://localhost:${hostPort}` },
                  { service: 'http_status:404' }
                ]
              }
            })
          });
          const configData = await configRes.json() as any;
          if (!configData.success) {
            return { error: `Cloudflare tunnel configuration failed: ${JSON.stringify(configData.errors)}` };
          }
          console.log('[Docker Deploy] Cloudflare Ingress Rules configured.');

          // 3. Create or Update DNS CNAME record
          const dnsListRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records?name=${hostname}&type=CNAME`, {
            headers: { 'Authorization': `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' }
          });
          const dnsListData = await dnsListRes.json() as any;
          let dnsRecordId = '';
          if (dnsListData.success && dnsListData.result && dnsListData.result.length > 0) {
            dnsRecordId = dnsListData.result[0].id;
          }

          const dnsUrl = dnsRecordId 
            ? `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records/${dnsRecordId}`
            : `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records`;
          const dnsMethod = dnsRecordId ? 'PUT' : 'POST';

          const dnsRes = await fetch(dnsUrl, {
            method: dnsMethod,
            headers: {
              'Authorization': `Bearer ${API_TOKEN}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              type: 'CNAME',
              name: hostname,
              content: `${activeTunnelId}.cfargotunnel.com`,
              proxied: true
            })
          });
          const dnsData = await dnsRes.json() as any;
          if (!dnsData.success) {
            console.warn('⚠️ DNS record creation/update failed:', dnsData.errors);
          } else {
            console.log(`[Docker Deploy] DNS Record mapped ${hostname} to ${activeTunnelId}.cfargotunnel.com`);
          }

          // 4. Construct Tunnel Token
          const tokenPayload = { a: ACCOUNT_ID, t: activeTunnelId, s: tunnelSecret };
          activeTunnelToken = Buffer.from(JSON.stringify(tokenPayload)).toString('base64');
        } catch (err: any) {
          return { error: `Failed during Cloudflare API calls: ${err.message}` };
        }
      } else {
        if (!activeTunnelId && activeTunnelToken) {
          try {
            const decoded = JSON.parse(Buffer.from(activeTunnelToken, 'base64').toString('utf8'));
            activeTunnelId = decoded.t;
          } catch {
            // ignore
          }
        }
      }

      if (reuseTunnel && ACCOUNT_ID && API_TOKEN && activeTunnelId) {
        try {
          console.log(`[Docker Deploy] Updating Ingress Rules for existing Cloudflare Tunnel ${activeTunnelId} to point to port ${hostPort}...`);
          const configRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/cfd_tunnel/${activeTunnelId}/configurations`, {
            method: 'PUT',
            headers: {
              'Authorization': `Bearer ${API_TOKEN}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              config: {
                ingress: [
                  { hostname: hostname, service: `http://localhost:${hostPort}` },
                  { service: 'http_status:404' }
                ]
              }
            })
          });
          const configData = await configRes.json() as any;
          if (!configData.success) {
            console.warn('[Docker Deploy] Failed to update Ingress Rules on reused tunnel:', configData.errors);
          } else {
            console.log('[Docker Deploy] Ingress Rules updated on reused tunnel.');
          }
        } catch (err: any) {
          console.warn('[Docker Deploy] Failed to update Ingress Rules on reused tunnel:', err.message);
        }
      }

      let tunnelProcess: any = null;
      if (activeTunnelToken) {
        console.log(`[Docker Deploy] Starting Cloudflare Named Tunnel for ${targetUrl}...`);
        tunnelProcess = spawn('cloudflared', [
          'tunnel', '--no-autoupdate', 'run', '--token', activeTunnelToken
        ]);

        tunnelProcess.on('close', (code: any) => {
          console.log(`[Docker Deploy] Named tunnel closed with code ${code}`);
        });
      }

      sessionManager.addSession({
        id: sessionId,
        type: 'docker-container',
        url: targetUrl,
        startedAt: new Date(),
        metadata: {
          port: containerPort,
          hostPort,
          containerName,
          image,
          env,
          domainMode,
          customDomain: targetUrl,
          cloudflaredUrl: targetUrl,
          tunnelPid: tunnelProcess ? tunnelProcess.pid : undefined,
          tunnelToken: activeTunnelToken,
          tunnelId: activeTunnelId,
          webhookSecret,
        },
      });

      // Poll endpoint every 1s until healthy status is returned
      await waitForHealthyUrl(targetUrl);

      return { url: targetUrl, containerName };
    }

    // Spawn Cloudflare Tunnel (Quick Tunnel)
    console.log(`[Docker Deploy] Exposing port ${hostPort} via Cloudflare Quick Tunnel...`);
    const tunnelProcess = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${hostPort}`]);

    return new Promise((resolve) => {
      let cloudflareUrl = '';

      tunnelProcess.stderr?.on('data', async (data) => {
        const output = data.toString();
        const match = output.match(/https:\/\/[-0-9a-z]*\.trycloudflare\.com/);
        if (match && !cloudflareUrl) {
          cloudflareUrl = match[0];
          console.log(`[Docker Deploy] Live tunnel URL: ${cloudflareUrl}`);

          sessionManager.addSession({
            id: sessionId,
            type: 'docker-container',
            url: cloudflareUrl,
            startedAt: new Date(),
            metadata: {
              port: containerPort,
              hostPort,
              containerName,
              image,
              env,
              domainMode,
              webhookSecret,
              cloudflaredUrl: cloudflareUrl,
              tunnelPid: tunnelProcess.pid,
            },
          });

          await waitForHealthyUrl(cloudflareUrl);
          resolve({ url: cloudflareUrl, containerName });
        }
      });

      tunnelProcess.on('close', (code) => {
        console.log(`[Docker Deploy] Cloudflare tunnel process closed with code ${code}`);
      });

      setTimeout(async () => {
        if (!cloudflareUrl) {
          console.error('[Docker Deploy] Cloudflare tunnel setup timed out.');
          try { await execAsync(`docker stop ${containerName}`); } catch {}
          try { tunnelProcess.kill(); } catch {}
          resolve({ error: 'Timed out waiting for Cloudflare Tunnel URL.' });
        }
      }, 30000);
    });

  } catch (error: any) {
    console.error('❌ Failed to deploy custom container:', error);
    return { error: error.message || 'Unknown error occurred during container deployment.' };
  }
}

export async function restoreDockerContainers(): Promise<void> {
  console.log('[Docker Restore] Checking for container sessions to restore...');
  const sessions = sessionManager.getAllSessions().filter(s => s.type === 'docker-container');
  if (sessions.length === 0) {
    console.log('[Docker Restore] No container sessions found to restore.');
    return;
  }

  for (const session of sessions) {
    try {
      const meta = session.metadata as any;
      if (!meta) continue;

      const { containerName, image, port, hostPort, env, domainMode, customDomain, tunnelToken } = meta;
      if (!containerName || !image) continue;

      // Check if container is running
      let isRunning = false;
      try {
        const { stdout } = await execAsync(`docker ps --filter name=${containerName} --format "{{.Names}}"`);
        if (stdout.trim() === containerName) {
          isRunning = true;
        }
      } catch (err) {
        // ignore
      }

      if (isRunning) {
        console.log(`[Docker Restore] Container ${containerName} is already running.`);
      } else {
        console.log(`[Docker Restore] Restoring container ${containerName} (${image})...`);
        
        // Pull image just in case
        try { await execAsync(`docker pull ${image}`); } catch {}

        const envArgs: string[] = [];
        if (env) {
          for (const [k, v] of Object.entries(env)) {
            if (k && v) {
              envArgs.push('-e', `${k}=${v}`);
            }
          }
        }

        const dockerCmd = [
          'docker', 'run', '-d', '--rm',
          '--name', containerName,
          '-p', `${hostPort}:${port}`,
          ...envArgs,
          image
        ];

        await execAsync(dockerCmd.join(' '));
      }

      if (domainMode === 'custom') {
        if (tunnelToken) {
         const tunnelProcess = spawn('cloudflared', [
            'tunnel', '--no-autoupdate', 'run', '--token', tunnelToken
          ]);

          tunnelProcess.on('close', (code: any) => {
            console.log(`[Docker Restore] Named tunnel closed with code ${code}`);
          });

          session.metadata = {
            ...session.metadata,
            tunnelProcess,
            tunnelPid: tunnelProcess.pid
          };
          sessionManager.updateSessionMetadata(session.id, {
            tunnelPid: tunnelProcess.pid
          });
        } else {
          console.log(`[Docker Restore] Custom domain preserved without named tunnel: ${customDomain}`);
        }
        continue;
      }

      // If quick tunnel, we need to spawn a new quick tunnel process
      console.log(`[Docker Restore] Restarting Cloudflare Quick Tunnel for port ${hostPort}...`);
      const tunnelProcess = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${hostPort}`]);

      tunnelProcess.stderr?.on('data', (data) => {
        const output = data.toString();
        const match = output.match(/https:\/\/[-0-9a-z]*\.trycloudflare\.com/);
        if (match) {
          const newUrl = match[0];
          console.log(`[Docker Restore] New quick tunnel URL: ${newUrl}`);
          sessionManager.updateSessionUrl(session.id, newUrl);
          sessionManager.updateSessionMetadata(session.id, {
            cloudflaredUrl: newUrl,
            tunnelPid: tunnelProcess.pid
          });
        }
      });

      tunnelProcess.on('close', (code: any) => {
        console.log(`[Docker Restore] Cloudflare Quick Tunnel closed with code ${code}`);
      });

      // Bind dynamic tunnel process object to in-memory session (if desired)
      session.metadata = {
        ...session.metadata,
        tunnelProcess,
        tunnelPid: tunnelProcess.pid
      };

    } catch (restoreErr) {
      console.error(`[Docker Restore] Failed to restore session ${session.id}:`, restoreErr);
    }
  }
}

export async function stopCustomContainer(sessionId: string): Promise<{ success: boolean; message: string }> {
  const session = sessionManager.getSession(sessionId);
  if (!session || session.type !== 'docker-container') {
    return { success: false, message: 'Docker session not found' };
  }

  const meta = session.metadata as any;
  if (meta) {
    const { containerName, tunnelPid, tunnelId, customDomain } = meta;

    // 1. Stop container
    if (containerName) {
      try {
        await execAsync(`docker stop ${containerName}`);
        console.log(`[Docker Stop] Stopped container ${containerName}`);
      } catch (e: any) {
        console.error(`[Docker Stop] Failed to stop container ${containerName}:`, e);
      }
    }

    // 2. Kill tunnel process
    if (tunnelPid) {
      try {
        process.kill(tunnelPid);
        console.log(`[Docker Stop] Killed tunnel process PID ${tunnelPid}`);
      } catch (e) {
        // ignore
      }
    }

    // 3. Delete Cloudflare Tunnel & DNS CNAME if created programmatically
    const ACCOUNT_ID = getSanitizedEnv('CLOUDFLARE_ACCOUNT_ID');
    const ZONE_ID = getSanitizedEnv('CLOUDFLARE_ZONE_ID');
    const API_TOKEN = getSanitizedEnv('CLOUDFLARE_API_TOKEN');

    if (tunnelId && ACCOUNT_ID && API_TOKEN) {
      try {
        console.log(`[Docker Stop] Deleting Cloudflare tunnel ${tunnelId}...`);
        
        // Wait a brief moment to ensure the tunnel process is fully terminated and disconnected
        await new Promise(resolve => setTimeout(resolve, 2000));

        const delRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/cfd_tunnel/${tunnelId}`, {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${API_TOKEN}`,
            'Content-Type': 'application/json'
          }
        });
        const delData = await delRes.json() as any;
        if (delData.success) {
          console.log(`[Docker Stop] Successfully deleted Cloudflare tunnel ${tunnelId}`);
        } else {
          console.warn(`[Docker Stop] Failed to delete Cloudflare tunnel:`, delData.errors);
        }
      } catch (err) {
        console.error(`[Docker Stop] Error deleting Cloudflare tunnel:`, err);
      }
    } 

    if (customDomain && ZONE_ID && API_TOKEN) {
      try {
        const hostname = customDomain.replace(/^https?:\/\//, '');
        console.log(`[Docker Stop] Cleaning up DNS CNAME record for ${hostname}...`);

        // Find DNS record ID
        const dnsListRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records?name=${hostname}&type=CNAME`, {
          headers: {
            'Authorization': `Bearer ${API_TOKEN}`,
            'Content-Type': 'application/json'
          }
        });
        const dnsListData = await dnsListRes.json() as any;
        if (dnsListData.success && dnsListData.result && dnsListData.result.length > 0) {
          const dnsRecordId = dnsListData.result[0].id;
          const delDnsRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records/${dnsRecordId}`, {
            method: 'DELETE',
            headers: {
              'Authorization': `Bearer ${API_TOKEN}`,
              'Content-Type': 'application/json'
            }
          });
          const delDnsData = await delDnsRes.json() as any;
          if (delDnsData.success) {
            console.log(`[Docker Stop] Successfully deleted CNAME record for ${hostname}`);
          } else {
            console.warn(`[Docker Stop] Failed to delete CNAME record:`, delDnsData.errors);
          }
        }
      } catch (err) {
        console.error(`[Docker Stop] Error cleaning up CNAME record:`, err);
      }
    }
  }

  sessionManager.removeSession(sessionId);
  return { success: true, message: 'Docker container stopped and resources cleaned up.' };
}
