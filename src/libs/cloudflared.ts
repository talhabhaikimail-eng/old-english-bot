import { spawn, ChildProcess } from 'child_process';

let cloudflareUrl = '';
let tunnelProcess: ChildProcess | null = null;

export async function getCloudflareTunnelUrl(port = 6080): Promise<string> {
  if (cloudflareUrl) return cloudflareUrl;
  
  return new Promise((resolve) => {
    try {
      tunnelProcess = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`]);
      
      tunnelProcess.stderr?.on('data', (data) => {
        const output = data.toString();
        const match = output.match(/https:\/\/[-0-9a-z]*\.trycloudflare\.com/);
        if (match && !cloudflareUrl) {
          cloudflareUrl = match[0];
          resolve(cloudflareUrl);
        }
      });
      
      tunnelProcess.on('error', (err) => {
        console.error('❌ Cloudflare Tunnel spawn error:', err);
        resolve('');
      });

      tunnelProcess.on('close', (code) => {
        cloudflareUrl = '';
      });
      
      // Safety timeout in case Cloudflare doesn't output the URL within 15 seconds
      setTimeout(() => {
        if (!cloudflareUrl) {
          resolve('');
        }
      }, 15000);
      
    } catch (err) {
      console.error('❌ Failed to start Cloudflare tunnel:', err);
      resolve('');
    }
  });
}
