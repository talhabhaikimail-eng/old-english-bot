import * as dotenv from 'dotenv';
dotenv.config();

const PAT_TOKEN = process.env.PAT_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO || 'talharhshdh/discord-to-whatsapp';

export interface GitHubWorkflowRun {
  id: number;
  name: string;
  node_id: string;
  head_branch: string;
  head_sha: string;
  run_number: number;
  event: string;
  status: string; // queued, in_progress, completed, waiting, requested, pending
  conclusion: string | null; // success, failure, neutral, cancelled, skipped, timed_out, action_required
  workflow_id: number;
  url: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  run_started_at?: string;
  path?: string;
  actor: {
    login: string;
    avatar_url: string;
  };
  head_commit: {
    id: string;
    message: string;
    timestamp: string;
    author: {
      name: string;
      email: string;
    };
  };
}

export interface GitHubJobStep {
  name: string;
  status: string; // queued, in_progress, completed
  conclusion: string | null;
  number: number;
  started_at: string | null;
  completed_at: string | null;
}

export interface GitHubJob {
  id: number;
  run_id: number;
  workflow_name: string;
  head_sha: string;
  status: string; // queued, in_progress, completed
  conclusion: string | null;
  started_at: string;
  completed_at: string | null;
  name: string;
  steps: GitHubJobStep[];
  html_url: string;
}

/**
 * Get HTTP headers required for GitHub API requests.
 */
function getHeaders(): Record<string, string> {
  if (!PAT_TOKEN) {
    throw new Error('❌ GitHub PAT_TOKEN is not defined in the environment variables (.env)');
  }
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${PAT_TOKEN}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Discord-WhatsApp-Bridge-Dashboard',
  };
}

/**
 * Helper to perform fetch requests to GitHub API.
 */
async function githubRequest(path: string, options: RequestInit = {}): Promise<any> {
  const url = `https://api.github.com${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      ...getHeaders(),
      ...(options.headers as Record<string, string>),
    },
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'No error response body');
    throw new Error(
      `GitHub API request failed: ${response.status} ${response.statusText} - ${errorText}`
    );
  }

  // Certain endpoints (like cancel or dispatch) might return 204 No Content
  if (response.status === 204) {
    return null;
  }

  return response.json();
}

/**
 * Fetch latest workflow runs for the repository.
 */
export async function getWorkflowRuns(params: {
  status?: string;
  branch?: string;
  event?: string;
  per_page?: number;
  page?: number;
} = {}): Promise<GitHubWorkflowRun[]> {
  const query = new URLSearchParams();
  if (params.status) query.append('status', params.status);
  if (params.branch) query.append('branch', params.branch);
  if (params.event) query.append('event', params.event);
  if (params.per_page) query.append('per_page', params.per_page.toString());
  if (params.page) query.append('page', params.page.toString());

  const queryString = query.toString() ? `?${query.toString()}` : '';
  const data = await githubRequest(`/repos/${GITHUB_REPO}/actions/runs${queryString}`);
  return data.workflow_runs || [];
}

/**
 * Fetch all running/active/queued workflow runs.
 */
export async function getRunningWorkflowRuns(): Promise<GitHubWorkflowRun[]> {
  // Fetch latest 100 runs and filter locally for anything that isn't 'completed'
  const runs = await getWorkflowRuns({ per_page: 100 });
  return runs.filter(run => run.status !== 'completed');
}

/**
 * Fetch details of a specific workflow run.
 */
export async function getWorkflowRun(runId: number): Promise<GitHubWorkflowRun> {
  return githubRequest(`/repos/${GITHUB_REPO}/actions/runs/${runId}`);
}

/**
 * Cancel a specific running workflow run.
 */
export async function cancelWorkflowRun(runId: number): Promise<void> {
  await githubRequest(`/repos/${GITHUB_REPO}/actions/runs/${runId}/cancel`, {
    method: 'POST',
  });
}

/**
 * Fetch all jobs for a specific workflow run.
 */
export async function getWorkflowRunJobs(runId: number): Promise<GitHubJob[]> {
  const data = await githubRequest(`/repos/${GITHUB_REPO}/actions/runs/${runId}/jobs`);
  return data.jobs || [];
}

/**
 * Fetch details of a specific job.
 */
export async function getJobDetails(jobId: number): Promise<GitHubJob> {
  return githubRequest(`/repos/${GITHUB_REPO}/actions/jobs/${jobId}`);
}

/**
 * Fetch text logs of a specific job.
 */
export async function getJobLogs(jobId: number): Promise<string> {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/actions/jobs/${jobId}/logs`;
  const response = await fetch(url, {
    headers: getHeaders(),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch logs for job ${jobId}: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

/**
 * Trigger a workflow run manually via repository dispatch.
 */
export async function triggerWorkflowDispatch(
  workflowFileName: string,
  ref: string = 'main',
  inputs: Record<string, any> = {}
): Promise<void> {
  await githubRequest(`/repos/${GITHUB_REPO}/actions/workflows/${workflowFileName}/dispatches`, {
    method: 'POST',
    body: JSON.stringify({
      ref,
      inputs,
    }),
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

/**
 * Calculates the difference between two timestamps and returns the duration in seconds and formatted string.
 */
export function calculateDuration(startedAt: string, completedAt?: string | null): { seconds: number; formatted: string } {
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const diffMs = end - start;
  const diffSec = Math.max(0, Math.floor(diffMs / 1000));

  const hours = Math.floor(diffSec / 3600);
  const minutes = Math.floor((diffSec % 3600) / 60);
  const seconds = diffSec % 60;

  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || hours > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);

  return {
    seconds: diffSec,
    formatted: parts.join(' '),
  };
}

/**
 * Gets duration details for a workflow run.
 */
export function getRunDurationInfo(run: GitHubWorkflowRun): { seconds: number; formatted: string } {
  const startedAt = run.run_started_at || run.created_at;
  const completedAt = run.status === 'completed' ? run.updated_at : null;
  return calculateDuration(startedAt, completedAt);
}

/**
 * Gets duration details for a job.
 */
export function getJobDurationInfo(job: GitHubJob): { seconds: number; formatted: string } {
  return calculateDuration(job.started_at, job.completed_at);
}

/**
 * Extracts the file name of the workflow from its path.
 */
export function getWorkflowFileName(run: GitHubWorkflowRun): string {
  if (!run.path) return 'unknown';
  const parts = run.path.split('/');
  return parts[parts.length - 1];
}

