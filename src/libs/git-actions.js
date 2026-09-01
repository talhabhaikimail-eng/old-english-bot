import * as dotenv from 'dotenv';
dotenv.config();
const PAT_TOKEN = process.env.PAT_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO || 'talharhshdh/discord-to-whatsapp';
/**
 * Get HTTP headers required for GitHub API requests.
 */
function getHeaders() {
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
async function githubRequest(path, options = {}) {
    const url = `https://api.github.com${path}`;
    const response = await fetch(url, {
        ...options,
        headers: {
            ...getHeaders(),
            ...options.headers,
        },
    });
    if (!response.ok) {
        const errorText = await response.text().catch(() => 'No error response body');
        throw new Error(`GitHub API request failed: ${response.status} ${response.statusText} - ${errorText}`);
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
export async function getWorkflowRuns(params = {}) {
    const query = new URLSearchParams();
    if (params.status)
        query.append('status', params.status);
    if (params.branch)
        query.append('branch', params.branch);
    if (params.event)
        query.append('event', params.event);
    if (params.per_page)
        query.append('per_page', params.per_page.toString());
    if (params.page)
        query.append('page', params.page.toString());
    const queryString = query.toString() ? `?${query.toString()}` : '';
    const data = await githubRequest(`/repos/${GITHUB_REPO}/actions/runs${queryString}`);
    return data.workflow_runs || [];
}
/**
 * Fetch all running/active/queued workflow runs.
 */
export async function getRunningWorkflowRuns() {
    // Fetch latest 100 runs and filter locally for anything that isn't 'completed'
    const runs = await getWorkflowRuns({ per_page: 100 });
    return runs.filter(run => run.status !== 'completed');
}
/**
 * Fetch details of a specific workflow run.
 */
export async function getWorkflowRun(runId) {
    return githubRequest(`/repos/${GITHUB_REPO}/actions/runs/${runId}`);
}
/**
 * Cancel a specific running workflow run.
 */
export async function cancelWorkflowRun(runId) {
    await githubRequest(`/repos/${GITHUB_REPO}/actions/runs/${runId}/cancel`, {
        method: 'POST',
    });
}
/**
 * Fetch all jobs for a specific workflow run.
 */
export async function getWorkflowRunJobs(runId) {
    const data = await githubRequest(`/repos/${GITHUB_REPO}/actions/runs/${runId}/jobs`);
    return data.jobs || [];
}
/**
 * Fetch details of a specific job.
 */
export async function getJobDetails(jobId) {
    return githubRequest(`/repos/${GITHUB_REPO}/actions/jobs/${jobId}`);
}
/**
 * Fetch text logs of a specific job.
 */
export async function getJobLogs(jobId) {
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
export async function triggerWorkflowDispatch(workflowFileName, ref = 'main', inputs = {}) {
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
