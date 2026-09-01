import * as dotenv from 'dotenv';
dotenv.config();

const pat = process.env.PAT_TOKEN;
const repo = 'talharhshdh/discord-to-whatsapp';

async function main() {
  if (!pat) {
    console.error("No PAT_TOKEN found");
    return;
  }
  const url = `https://api.github.com/repos/${repo}/actions/runs?per_page=20`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${pat}`,
      'X-GitHub-Api-Version': '2022-11-28',
    }
  });
  if (!res.ok) {
    console.error(`Failed to fetch: ${res.status} ${res.statusText}`);
    return;
  }
  const data = await res.json() as any;
  console.log("Latest GHA runs:");
  for (const run of data.workflow_runs) {
    console.log(`- Run ID: ${run.id}, Status: ${run.status}, Conclusion: ${run.conclusion}, Event: ${run.event}, Created At: ${run.created_at}, Commit: ${run.head_commit.message.trim()}`);
  }
}

main().catch(console.error);
