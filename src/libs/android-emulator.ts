/**
 * @file android-emulator.ts
 * @description Manages Docker-based Android emulator with web interface.
 * 
 * Uses budtmo/docker-android for a lightweight Android emulator with built-in web UI.
 * Exposes via Cloudflare tunnel on a dedicated port.
 */

import { spawn, ChildProcess, exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

let dockerProcess: ChildProcess | null = null;
let tunnelProcess: ChildProcess | null = null;
let isEmulatorRunning = false;
let emulatorStartTime: Date | null = null;
let emulatorUrl: string | null = null;

const ANDROID_PORT = 6081; // Web UI port (6080 is used by runner's noVNC)
const CONTAINER_NAME = 'android-emulator';

/**
 * Starts the Docker Android emulator with web interface.
 */
export async function startAndroidEmulator(): Promise<{
  success: boolean;
  message: string;
  webUrl?: string;
  error?: string;
}> {
  if (isEmulatorRunning) {
    return {
      success: false,
      message: 'Android emulator is already running',
      error: 'Stop the current session first with .android stop',
    };
  }

  try {

    // Pull the image if not exists
    await execAsync('docker pull budtmo/docker-android:emulator_13.0', { timeout: 120000 });

    // Start the container
    dockerProcess = spawn('docker', [
      'run',
      '--rm',
      '--name', CONTAINER_NAME,
      '--privileged',
      '-p', `${ANDROID_PORT}:6080`,
      '-e', 'EMULATOR_DEVICE=Samsung Galaxy S10',
      '-e', 'WEB_VNC=true',
      'budtmo/docker-android:emulator_13.0'
    ], {
      detached: false,
    });

    dockerProcess.stdout?.on('data', (data) => {
    });

    dockerProcess.stderr?.on('data', (data) => {
    });

    dockerProcess.on('error', (err) => {
      console.error('❌ Docker process error:', err);
      isEmulatorRunning = false;
    });

    dockerProcess.on('exit', (code) => {
      isEmulatorRunning = false;
      dockerProcess = null;
      emulatorUrl = null;
    });

    // Wait for container to be ready
    await new Promise(resolve => setTimeout(resolve, 15000)); // Initial wait

    // Check if container is running and wait for Android to boot
    for (let i = 0; i < 18; i++) {
      try {
        const { stdout } = await execAsync(`docker ps --filter name=${CONTAINER_NAME} --format "{{.Status}}"`);
        if (stdout.includes('Up')) {
          // Wait a bit more for Android to fully boot
          if (i >= 12) { // At least 60 seconds
            break;
          }
        }
      } catch (err) {
        // Continue waiting
      }
      await new Promise(resolve => setTimeout(resolve, 5000));
    }

    // Start Cloudflare tunnel for the web UI
    emulatorUrl = await startTunnel(ANDROID_PORT);

    if (!emulatorUrl) {
      throw new Error('Failed to create Cloudflare tunnel');
    }

    // Append the correct path for noVNC
    emulatorUrl = emulatorUrl + '/vnc.html';

    isEmulatorRunning = true;
    emulatorStartTime = new Date();

    // Register in dashboard
    const { registerUrl } = require('./dashboard-server');
    registerUrl('android', '📱 Android Emulator', emulatorUrl);


    return {
      success: true,
      message: 'Android emulator started successfully',
      webUrl: emulatorUrl,
    };

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('❌ Failed to start Android emulator:', errMsg);
    
    // Cleanup on failure
    await cleanupDocker();

    return {
      success: false,
      message: 'Failed to start Android emulator',
      error: errMsg,
    };
  }
}

/**
 * Starts a Cloudflare tunnel for the given port.
 */
async function startTunnel(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let url = '';
    
    tunnelProcess = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`]);
    
    tunnelProcess.stdout?.on('data', (data) => {
    });
    
    tunnelProcess.stderr?.on('data', (data) => {
      const output = data.toString();
      
      const match = output.match(/https:\/\/[-0-9a-z]*\.trycloudflare\.com/);
      if (match && !url) {
        url = match[0];
        resolve(url);
      }
    });
    
    tunnelProcess.on('error', (err) => {
      console.error('❌ Cloudflare tunnel error:', err);
      reject(err);
    });

    tunnelProcess.on('close', (code) => {
      emulatorUrl = null;
    });
    
    // Timeout after 30 seconds
    setTimeout(() => {
      if (!url) {
        console.error('❌ Tunnel creation timed out after 30s');
        reject(new Error('Tunnel creation timed out'));
      }
    }, 30000);
  });
}

/**
 * Gets the current Android emulator status.
 */
export async function getAndroidEmulatorStatus(): Promise<{
  running: boolean;
  uptime?: string;
  deviceInfo?: string;
  webUrl?: string;
}> {
  if (!isEmulatorRunning) {
    return { running: false };
  }

  try {
    // Check if container is still running
    const { stdout } = await execAsync(`docker ps --filter name=${CONTAINER_NAME} --format "{{.Status}}"`);
    
    if (!stdout.includes('Up')) {
      isEmulatorRunning = false;
      return { running: false };
    }

    // Calculate uptime
    let uptime = 'Unknown';
    if (emulatorStartTime) {
      const uptimeMs = Date.now() - emulatorStartTime.getTime();
      const minutes = Math.floor(uptimeMs / 60000);
      const hours = Math.floor(minutes / 60);
      const mins = minutes % 60;
      uptime = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
    }

    return {
      running: true,
      uptime,
      deviceInfo: 'Android 13 - Samsung Galaxy S10',
      webUrl: emulatorUrl || undefined,
    };

  } catch (err) {
    console.error('Error getting emulator status:', err);
    isEmulatorRunning = false;
    return { running: false };
  }
}

/**
 * Stops the Android emulator.
 */
export async function stopAndroidEmulator(): Promise<{
  success: boolean;
  message: string;
}> {
  if (!isEmulatorRunning) {
    return {
      success: false,
      message: 'No Android emulator is running',
    };
  }

  try {

    await cleanupDocker();

    isEmulatorRunning = false;
    emulatorStartTime = null;
    emulatorUrl = null;


    return {
      success: true,
      message: 'Android emulator stopped successfully',
    };

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('❌ Failed to stop emulator:', errMsg);
    return {
      success: false,
      message: `Failed to stop emulator: ${errMsg}`,
    };
  }
}

/**
 * Cleanup Docker container and tunnel.
 */
async function cleanupDocker(): Promise<void> {
  // Stop tunnel
  if (tunnelProcess) {
    tunnelProcess.kill('SIGTERM');
    tunnelProcess = null;
  }

  // Stop Docker container
  try {
    await execAsync(`docker stop ${CONTAINER_NAME}`);
  } catch {
    // Container might already be stopped
  }

  // Kill docker process if still running
  if (dockerProcess) {
    dockerProcess.kill('SIGTERM');
    dockerProcess = null;
  }
}
