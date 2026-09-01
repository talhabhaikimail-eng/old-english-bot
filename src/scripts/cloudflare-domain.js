import { randomBytes } from 'crypto';
import 'dotenv/config'
// --- Configuration ---
function sanitize(val) {
  if (!val) return '';
  return val.trim().replace(/^['"]|['"]$/g, '').replace(/;$/, '').trim();
}
const ACCOUNT_ID = sanitize(process.env.CLOUDFLARE_ACCOUNT_ID);
const ZONE_ID = sanitize(process.env.CLOUDFLARE_ZONE_ID); 
const API_TOKEN = sanitize(process.env.CLOUDFLARE_API_TOKEN);

const TUNNEL_NAME = 'vps-automated-tunnel';
const SUBDOMAIN = 'checking.'+ process.env.MAIN_DOMAIN;
const LOCALHOST_URL = 'http://localhost:8000';
// ---------------------

async function setupCloudflareTunnel() {
  try {
    // 1. Generate a secure 32-byte base64 secret for the tunnel
    const tunnelSecret = randomBytes(32).toString('base64');

    // 2. Create the Tunnel in your Cloudflare account
    console.log('Creating Tunnel...');
    const tunnelRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/cfd_tunnel`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: TUNNEL_NAME,
        tunnel_secret: tunnelSecret
      })
    });
    
    const tunnelData = await tunnelRes.json();
    if (!tunnelData.success) throw new Error(`Tunnel creation failed: ${JSON.stringify(tunnelData.errors)}`);
    const tunnelId = tunnelData.result.id;
    console.log(`✅ Tunnel Created! ID: ${tunnelId}`);

    // 3. Configure the Ingress Rules (Mapping subdomain to localhost)
    console.log('Configuring Ingress Routing...');
    const configRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/cfd_tunnel/${tunnelId}/configurations`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        config: {
          ingress: [
            { hostname: SUBDOMAIN, service: LOCALHOST_URL },
            { service: 'http_status:404' } // A catch-all rule is strictly required by Cloudflare
          ]
        }
      })
    });
    const configData = await configRes.json();
    if (!configData.success) throw new Error('Routing configuration failed');
    console.log('✅ Ingress rules applied!');

    // 4. Create the DNS CNAME record
    console.log('Creating DNS Record...');
    const dnsRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        type: 'CNAME',
        name: SUBDOMAIN,
        content: `${tunnelId}.cfargotunnel.com`,
        proxied: true
      })
    });
    const dnsData = await dnsRes.json();
    if (!dnsData.success) {
        console.warn('⚠️ DNS record creation failed (it might already exist).');
    } else {
        console.log(`✅ DNS Record mapped ${SUBDOMAIN} to the tunnel`);
    }

    // 5. Construct the final Cloudflare Tunnel Token
    const tokenPayload = { a: ACCOUNT_ID, t: tunnelId, s: tunnelSecret };
    const tunnelToken = Buffer.from(JSON.stringify(tokenPayload)).toString('base64');
    
    console.log('\n=============================================');
    console.log('🚀 SETUP COMPLETE!');
    console.log('Run this command on your VPS to start the tunnel as a background service:');
    console.log(`sudo cloudflared service install ${tunnelToken}`);
    console.log('=============================================');

  } catch (error) {
    console.error('\n❌ Error:', error.message);
  }
}

setupCloudflareTunnel();