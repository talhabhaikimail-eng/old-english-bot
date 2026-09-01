/**
 * @file ssh-terminal.ts
 * @description SSH-based terminal using isolated Docker containers.
 * Each session gets its own container with SSH access.
 */

import { exec, spawn, ChildProcess } from 'child_process';
import util from 'util';
import crypto from 'crypto';
import { sessionManager } from './session-manager';

const execAsync = util.promisify(exec);

interface SSHTerminalInstance {
  sessionId: string;
  host: string;
  port: number;
  username: string;
  password: string;
  containerName: string;
  startedAt: Date;
}

const sshInstances = new Map<string, SSHTerminalInstance>();

/**
 * Start an SSH terminal in an isolated Docker container
 */
export async function startSSHTerminal(): Promise<{
  sessionId?: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  sshCommand?: string;
  error?: string;
}> {
  try {
    const sessionId = `ssh-${crypto.randomBytes(4).toString('hex')}`;
    const port = 2222 + sshInstances.size;
    const username = `user_${crypto.randomBytes(3).toString('hex')}`;
    const password = crypto.randomBytes(8).toString('hex');
    const containerName = `ssh-terminal-${port}`;


    // Ensure Docker is available
    try {
      await execAsync('docker --version');
    } catch {
      return { error: 'Docker is not installed or available.' };
    }

    // Check if container already exists
    try {
      const { stdout } = await execAsync(`docker ps -a --filter name=${containerName} --format "{{.Names}}"`);
      if (stdout.includes(containerName)) {
        await execAsync(`docker stop ${containerName}`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    } catch {
      // No existing container
    }

    // Start SSH container (using linuxserver/openssh-server)
    await execAsync(
      `docker run -d --rm ` +
      `--name ${containerName} ` +
      `-p ${port}:2222 ` +
      `-e PUID=1000 ` +
      `-e PGID=1000 ` +
      `-e TZ=Etc/UTC ` +
      `-e USER_NAME=${username} ` +
      `-e USER_PASSWORD=${password} ` +
      `-e PASSWORD_ACCESS=true ` +
      `-e SUDO_ACCESS=true ` +
      `lscr.io/linuxserver/openssh-server:latest`
    );

    // Wait for container to be ready
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Start Cloudflare tunnel for SSH
    const tunnelProcess = spawn('cloudflared', [
      'tunnel',
      '--url', `tcp://localhost:${port}`
    ]);

    let cloudflaredUrl = '';
    
    // Capture cloudflared URL from stderr
    tunnelProcess.stderr?.on('data', (data) => {
      const output = data.toString();
      const match = output.match(/https:\/\/[-0-9a-z]*\.trycloudflare\.com/);
      if (match && !cloudflaredUrl) {
        cloudflaredUrl = match[0];
        
        // Update session with cloudflared URL
        sessionManager.updateSessionMetadata(sessionId, { cloudflaredUrl });
      }
    });

    const instance: SSHTerminalInstance = {
      sessionId,
      host: 'localhost',
      port,
      username,
      password,
      containerName,
      startedAt: new Date(),
    };

    sshInstances.set(sessionId, instance);

    // Register in session manager
    sessionManager.addSession({
      id: sessionId,
      type: 'terminal',
      url: `ssh://${username}@localhost:${port}`,
      username,
      password,
      startedAt: new Date(),
      metadata: {
        port,
        containerName,
        cloudflaredUrl: cloudflaredUrl || undefined,
      },
    });

    // For GitHub Actions, we need to expose via Cloudflare Tunnel
    // But SSH over Cloudflare requires cloudflared on client
    // So we'll provide both: direct SSH command and web-based alternative

    const sshCommand = `ssh -p ${port} ${username}@localhost`;


    return {
      sessionId,
      host: 'localhost',
      port,
      username,
      password,
      sshCommand,
    };

  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('❌ Failed to start SSH terminal:', errMsg);
    return { error: `Failed to start SSH terminal: ${errMsg}` };
  }
}

/**
 * Stop an SSH terminal session
 */
export async function stopSSHTerminal(sessionId: string): Promise<{
  success: boolean;
  message: string;
}> {
  try {
    const instance = sshInstances.get(sessionId);
    if (!instance) {
      return { success: false, message: 'SSH session not found' };
    }


    // Stop container
    await execAsync(`docker stop ${instance.containerName}`);

    // Remove from tracking
    sshInstances.delete(sessionId);
    sessionManager.removeSession(sessionId);


    return {
      success: true,
      message: 'SSH terminal stopped successfully',
    };

  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('❌ Failed to stop SSH terminal:', errMsg);
    return {
      success: false,
      message: `Failed to stop SSH terminal: ${errMsg}`,
    };
  }
}

/**
 * Get all SSH terminal instances
 */
export function getAllSSHTerminals(): SSHTerminalInstance[] {
  return Array.from(sshInstances.values());
}

/**
 * Get SSH terminal by session ID
 */
export function getSSHTerminal(sessionId: string): SSHTerminalInstance | undefined {
  return sshInstances.get(sessionId);
}
