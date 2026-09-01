import * as dotenv from 'dotenv';
dotenv.config();

const pat = process.env.PAT_TOKEN;
const repo = 'talharhshdh/discord-to-whatsapp';

async function main() {
  if (!pat) {
    console.error("No PAT_TOKEN found");
    return;
  }
  const url = `https://api.github.com/repos/${repo}/actions/workflows/browser-worker.yml/runs?per_page=100`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${pat}`,
      'X-GitHub-Api-Version': '2022-11-28',
    }
  });
  if (!res.ok) {
    console.error(`Failed to fetch runs: ${res.status} ${res.statusText}`);
    return;
  }
  const data = await res.json() as any;
  const activeRuns = (data.workflow_runs || []).filter(
    (run: any) => run.status !== 'completed'
  );

  console.log(`Found ${activeRuns.length} active/queued runs. Cancelling them...`);
  for (const run of activeRuns) {
    console.log(`Cancelling run ID: ${run.id} (Status: ${run.status}, Event: ${run.event})...`);
    const cancelUrl = `https://api.github.com/repos/${repo}/actions/runs/${run.id}/cancel`;
    const cancelRes = await fetch(cancelUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${pat}`,
        'X-GitHub-Api-Version': '2022-11-28',
      }
    });
    if (cancelRes.ok) {
      console.log(`✅ Run ${run.id} cancelled successfully.`);
    } else {
      console.error(`❌ Failed to cancel run ${run.id}: ${cancelRes.status}`);
    }
  }
}

main().catch(console.error);
