/**
 * diagnose-yt.ts
 *
 * Standalone YouTube-dl Diagnostic & Troubleshooting Script for VPS.
 * Run this on your VPS to identify why formats/cookies or downloading is failing.
 *
 * Usage:
 *   npx ts-node src/libs/diagnose-yt.ts [videoUrlOrId]
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
// Import the same youtube-dl wrapper the main project uses
import youtubedl from 'youtube-dl-exec';

const DEFAULT_VIDEO = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'; // Rick Astley
const targetUrl = process.argv[2] || DEFAULT_VIDEO;

// Helper to make HTTPS requests easily
function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'curl/7.64.1' } }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    }).on('error', reject);
  });
}

async function runYtdlpProbe(url: string, flags: Record<string, any>): Promise<{ stdout: string; stderr: string; success: boolean }> {
  try {
    const output = await youtubedl(url, flags);
    return {
      stdout: JSON.stringify(output),
      stderr: '',
      success: true,
    };
  } catch (error: any) {
    return {
      stdout: '',
      stderr: error.message || String(error),
      success: false,
    };
  }
}

async function main() {
  console.log('='.repeat(70));
  console.log('🔍 YOUTUBE-DL & VPS ENVIRONMENT DIAGNOSTIC TOOL');
  console.log('='.repeat(70));
  console.log(`Diagnostic Time : ${new Date().toISOString()}`);
  console.log(`Current Dir     : ${process.cwd()}`);
  console.log(`Target Video    : ${targetUrl}`);
  console.log('='.repeat(70));

  // 1. VPS Network & IP Status
  console.log('🌐 1. Checking VPS Network & IP Address Status...');
  try {
    const ipInfo = await fetchJson('https://ipapi.co/json/');
    if (ipInfo && typeof ipInfo === 'object') {
      console.log(`   - Public IP  : ${ipInfo.ip || 'Unknown'}`);
      console.log(`   - Provider/Org: ${ipInfo.org || 'Unknown'}`);
      console.log(`   - Country    : ${ipInfo.country_name || 'Unknown'} (${ipInfo.city || 'Unknown'})`);
      
      const isCloud = /amazon|aws|google|microsoft|azure|digitalocean|linode|ovh|hetzner|coackroach|vultr|datacenter|hosting/i.test(ipInfo.org || '');
      if (isCloud) {
        console.log('   ⚠️ WARNING: This IP belongs to a known cloud hosting/datacenter provider.');
        console.log('      YouTube aggressively targets datacenter IPs with blocks (403 Forbidden/429 Too Many Requests) and');
        console.log('      strips adaptive quality formats when requests are cookieless.');
      } else {
        console.log('   ✅ Residential/ISP IP detected. Less likely to face aggressive IP blocks.');
      }
    } else {
      console.log('   - Could not retrieve full IP metadata. Simple pinging...');
    }
  } catch (e: any) {
    console.log(`   ❌ Failed to query IP info: ${e.message}`);
  }
  console.log();

  // 2. Checking yt-dlp Version and Presence via youtube-dl-exec wrapper
  console.log('📦 2. Checking yt-dlp Executable Status...');
  try {
    const version = await youtubedl.exec('', { version: true });
    console.log(`   ✅ yt-dlp wrapper is installed and available!`);
    console.log(`   - Version: ${version.stdout.trim()}`);
  } catch (e: any) {
    console.log(`   ❌ Error running yt-dlp wrapper: ${e.message}`);
  }
  console.log();

  // 3. Cookie File Check
  console.log('🍪 3. Checking Cookie Configurations...');
  const cookiesPath = path.join(process.cwd(), 'browser_data', 'youtube-cookies.txt');
  console.log(`   - Expected Cookie Path: ${cookiesPath}`);

  if (process.env.YOUTUBE_COOKIES) {
    console.log('   ✅ YOUTUBE_COOKIES environment variable is SET.');
  } else {
    console.log('   ℹ️ YOUTUBE_COOKIES environment variable is NOT set.');
  }

  if (fs.existsSync(cookiesPath)) {
    const stats = fs.statSync(cookiesPath);
    console.log(`   ✅ Physical cookie file exists!`);
    console.log(`     - Size: ${stats.size} bytes`);
    console.log(`     - Last modified: ${stats.mtime.toISOString()}`);
    
    // Check if valid netscape format
    try {
      const content = fs.readFileSync(cookiesPath, 'utf8');
      if (content.includes('# Netscape') || content.includes('.youtube.com')) {
        console.log('     - Format: Valid Netscape/YouTube format detected.');
        const lines = content.split('\n').filter(line => line.trim() && !line.startsWith('#'));
        console.log(`     - Number of cookies: ${lines.length}`);
      } else {
        console.log('     - ⚠️ WARNING: Cookie file does not start with "# Netscape HTTP Cookie File". yt-dlp might reject it.');
      }
    } catch (e: any) {
      console.log(`     - ❌ Failed to read cookie file: ${e.message}`);
    }
  } else {
    console.log('   ❌ Physical cookie file does NOT exist at this location.');
  }
  console.log();

  // 4. Comparison Probes
  console.log('🧪 4. Comparison Probes: Testing User Agents & Cookie Settings...');
  console.log('='.repeat(70));

  // Probe A: Googlebot User-Agent (No Cookies)
  console.log('📡 Probe A: Googlebot User-Agent + Cookieless');
  const probeAFlags = {
    noCheckCertificates: true,
    noWarnings: true,
    addHeader: [
      'user-agent:googlebot',
      'referer:youtube.com'
    ],
    dumpSingleJson: true,
    preferFreeFormats: false
  };
  console.log(`   Running: youtubedl("${targetUrl}", { user-agent: "googlebot" })`);
  
  const probeAStart = Date.now();
  const probeARes = await runYtdlpProbe(targetUrl, probeAFlags);
  const probeAElapsed = ((Date.now() - probeAStart) / 1000).toFixed(2);

  if (probeARes.success) {
    try {
      const parsed = JSON.parse(probeARes.stdout);
      const formatsCount = parsed.formats ? parsed.formats.length : 0;
      console.log(`   ✅ Success in ${probeAElapsed}s!`);
      console.log(`   - Title: ${parsed.title}`);
      console.log(`   - Available formats: ${formatsCount}`);
      if (formatsCount === 0 || (parsed.formats && parsed.formats.length <= 3)) {
        console.log('   ⚠️ Alert: Returned 0 or very few (<=3) formats! This indicates YouTube bot-protection stripped the streams.');
      } else {
        console.log('   ✨ Full streams returned under Googlebot.');
      }
    } catch {
      console.log(`   ⚠️ Probe succeeded but output was not valid JSON.`);
    }
  } else {
    console.log(`   ❌ Probe A Failed in ${probeAElapsed}s!`);
    console.log(`   - Error: ${probeARes.stderr.trim().split('\n').slice(0, 3).join('\n     ')}`);
  }
  console.log();

  // Probe B: Chrome Desktop User-Agent (No Cookies)
  console.log('📡 Probe B: Desktop Chrome User-Agent + Cookieless');
  const desktopUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  const probeBFlags = {
    noCheckCertificates: true,
    noWarnings: true,
    addHeader: [
      `user-agent:${desktopUA}`,
      'referer:youtube.com'
    ],
    dumpSingleJson: true,
    preferFreeFormats: false
  };
  console.log(`   Running: youtubedl("${targetUrl}", { user-agent: "Chrome Desktop" })`);
  
  const probeBStart = Date.now();
  const probeBRes = await runYtdlpProbe(targetUrl, probeBFlags);
  const probeBElapsed = ((Date.now() - probeBStart) / 1000).toFixed(2);

  if (probeBRes.success) {
    try {
      const parsed = JSON.parse(probeBRes.stdout);
      const formatsCount = parsed.formats ? parsed.formats.length : 0;
      console.log(`   ✅ Success in ${probeBElapsed}s!`);
      console.log(`   - Title: ${parsed.title}`);
      console.log(`   - Available formats: ${formatsCount}`);
      if (formatsCount <= 3) {
        console.log('   ⚠️ Alert: Cookieless Desktop UA also returned <= 3 formats. Cookies are definitely required for this IP.');
      } else {
        console.log('   ✨ Cookieless Desktop UA returned full formats list!');
      }
    } catch {
      console.log(`   ⚠️ Probe succeeded but output was not valid JSON.`);
    }
  } else {
    console.log(`   ❌ Probe B Failed in ${probeBElapsed}s!`);
    console.log(`   - Error: ${probeBRes.stderr.trim().split('\n').slice(0, 3).join('\n     ')}`);
  }
  console.log();

  // Probe C: Desktop Chrome User-Agent + Cookied (If cookie file exists)
  if (fs.existsSync(cookiesPath)) {
    console.log('📡 Probe C: Desktop Chrome User-Agent + COOKIES');
    const probeCFlags = {
      noCheckCertificates: true,
      noWarnings: true,
      cookies: cookiesPath,
      dumpSingleJson: true,
      preferFreeFormats: false
    };
    console.log(`   Running: youtubedl("${targetUrl}", { cookies: "${cookiesPath}" })`);
    
    const probeCStart = Date.now();
    const probeCRes = await runYtdlpProbe(targetUrl, probeCFlags);
    const probeCElapsed = ((Date.now() - probeCStart) / 1000).toFixed(2);

    if (probeCRes.success) {
      try {
        const parsed = JSON.parse(probeCRes.stdout);
        const formatsCount = parsed.formats ? parsed.formats.length : 0;
        console.log(`   ✅ Success in ${probeCElapsed}s!`);
        console.log(`   - Title: ${parsed.title}`);
        console.log(`   - Available formats: ${formatsCount}`);
        if (formatsCount <= 3) {
          console.log('   ❌ Error: Even with cookies, YouTube only returned <= 3 formats. Cookies may be invalid/expired or VPS IP is flagged.');
        } else {
          console.log('   ✨ Success! Probe C with cookies successfully unlocked all format streams!');
        }
      } catch {
        console.log(`   ⚠️ Probe succeeded but output was not valid JSON.`);
      }
    } else {
      console.log(`   ❌ Probe C Failed in ${probeCElapsed}s!`);
      console.log(`   - Error: ${probeCRes.stderr.trim().split('\n').slice(0, 3).join('\n     ')}`);
    }
    console.log();
  } else {
    console.log('📡 Probe C: Desktop Chrome User-Agent + COOKIES');
    console.log('   ℹ️ Skipped (youtube-cookies.txt is not present to test).');
    console.log();
  }

  console.log('='.repeat(70));
  console.log('📋 DIAGNOSTIC CONCLUSION & NEXT STEPS');
  console.log('='.repeat(70));

  const probeBSuccess = probeBRes.success;
  const probeBFormats = probeBSuccess ? (JSON.parse(probeBRes.stdout || '{}').formats?.length ?? 0) : 0;
  const probeASuccess = probeARes.success;
  const probeAFormats = probeASuccess ? (JSON.parse(probeARes.stdout || '{}').formats?.length ?? 0) : 0;
  
  const isBBetter = probeBSuccess && (!probeASuccess || probeBFormats > probeAFormats);
  
  if (isBBetter) {
    console.log('👉 RECOMMENDATION 1: The Googlebot User-Agent was indeed blocking formats on your VPS!');
    console.log('   Switching to the Desktop UA resolved the issue and unlocked formats.');
  }

  if (fs.existsSync(cookiesPath)) {
    console.log('👉 RECOMMENDATION 2: Cookie status checked.');
    console.log('   If Probe C succeeded but B failed, cookies are mandatory on your VPS.');
    console.log('   If Probe C failed or returned <= 3 formats, your cookies are either expired or invalid.');
  } else {
    console.log('👉 RECOMMENDATION 2: COOKIES ARE MISSING!');
    console.log('   Please set the YOUTUBE_COOKIES environment variable in your VPS environment to activate full formats download.');
  }

  console.log('='.repeat(70));
}

main().catch(err => {
  console.error('Fatal diagnostic error:', err);
});
