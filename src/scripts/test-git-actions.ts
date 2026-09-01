import {
  getWorkflowRuns,
  getRunningWorkflowRuns,
  getWorkflowRunJobs,
  getWorkflowRun,
  getJobDetails,
  getJobLogs,
  getWorkflowFileName,
  getRunDurationInfo,
  getJobDurationInfo
} from '../libs/git-actions';

async function runTests() {
  console.log("🧪 Starting GitHub Actions Integration Tests (with files & duration check)...\n");

  try {
    // 1. Test getWorkflowRuns
    console.log("1. Fetching latest workflow runs...");
    const runs = await getWorkflowRuns({ per_page: 5 });
    console.log(`✅ Success: Found ${runs.length} recent runs.`);
    if (runs.length > 0) {
      const firstRun = runs[0];
      const runDuration = getRunDurationInfo(firstRun);
      const workflowFile = getWorkflowFileName(firstRun);

      console.log(`   Latest Run ID: ${firstRun.id}`);
      console.log(`   Name: ${firstRun.name}`);
      console.log(`   Workflow File: ${workflowFile}`);
      console.log(`   Status: ${firstRun.status}`);
      console.log(`   Conclusion: ${firstRun.conclusion}`);
      console.log(`   Duration: ${runDuration.formatted} (${runDuration.seconds}s)`);
      console.log(`   Commit message: ${firstRun.head_commit?.message?.trim()}\n`);

      // 2. Test getWorkflowRun (specific)
      console.log(`2. Fetching details for specific Run ID ${firstRun.id}...`);
      const runDetail = await getWorkflowRun(firstRun.id);
      console.log(`✅ Success: Fetched run detail.`);
      console.log(`   HTML URL: ${runDetail.html_url}\n`);

      // 3. Test getWorkflowRunJobs
      console.log(`3. Fetching jobs for Run ID ${firstRun.id}...`);
      const jobs = await getWorkflowRunJobs(firstRun.id);
      console.log(`✅ Success: Found ${jobs.length} jobs.`);
      for (const job of jobs) {
        const jobDuration = getJobDurationInfo(job);
        console.log(`   - Job ID: ${job.id}, Name: ${job.name}, Status: ${job.status}, Conclusion: ${job.conclusion}, Duration: ${jobDuration.formatted}`);
        console.log(`     Steps count: ${job.steps.length}`);
      }
      console.log();

      // 4. Test getJobDetails and getJobLogs if there is a job
      if (jobs.length > 0) {
        const firstJob = jobs[0];
        console.log(`4. Fetching job details for Job ID ${firstJob.id}...`);
        const jobDetail = await getJobDetails(firstJob.id);
        console.log(`✅ Success: Fetched job details.`);
        console.log(`   HTML URL: ${jobDetail.html_url}\n`);

        console.log(`5. Fetching logs for Job ID ${firstJob.id}...`);
        try {
          const logs = await getJobLogs(firstJob.id);
          console.log(`✅ Success: Fetched logs.`);
          const lines = logs.split('\n');
          console.log(`   Log size: ${logs.length} characters (${lines.length} lines)`);
          console.log(`   First 5 lines of logs:`);
          lines.slice(0, 5).forEach(line => console.log(`     > ${line}`));
          console.log();
        } catch (logErr: any) {
          console.log(`❌ Failed to fetch logs (logs may be expired/archived or not ready): ${logErr.message}\n`);
        }
      }
    } else {
      console.log("⚠️ No workflow runs found. Skipping run-specific tests.\n");
    }

    // 5. Test getRunningWorkflowRuns
    console.log("6. Fetching currently active/running workflow runs...");
    const runningRuns = await getRunningWorkflowRuns();
    console.log(`✅ Success: Found ${runningRuns.length} active/queued runs.`);
    for (const run of runningRuns) {
      const runningDuration = getRunDurationInfo(run);
      const runningFile = getWorkflowFileName(run);
      console.log(`   - Run ID: ${run.id}`);
      console.log(`     Workflow File: ${runningFile}`);
      console.log(`     Status: ${run.status}`);
      console.log(`     Duration: ${runningDuration.formatted} (Running for ${runningDuration.seconds}s)`);
      console.log(`     Commit: ${run.head_commit?.message?.trim()}`);
    }
    console.log();

    console.log("🎉 All read-only integration tests completed successfully!");

  } catch (error: any) {
    console.error("❌ Test execution failed:", error);
    process.exit(1);
  }
}

runTests();

