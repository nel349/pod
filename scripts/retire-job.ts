/**
 * Take a job off the wall, or put it back.
 *
 * For whoever runs this server: a dry run, or a job whose name no longer says what it is, should not
 * sit on the wall beside the work strangers are shown. Nothing is deleted. The job's page, receipt,
 * checks and history answer at their addresses as before, and its page says it was retired and why.
 *
 *   bun run scripts/retire-job.ts <job> "<why, in a few words>"
 *   bun run scripts/retire-job.ts <job> --back
 */
import { JOBS_FOLDER_SETTING } from "../src/folders.ts";
import { JobStore } from "../src/store.ts";

const BACK = "--back";
const [jobId, why] = process.argv.slice(2);
const folder = process.env[JOBS_FOLDER_SETTING];
if (!folder) throw new Error(`${JOBS_FOLDER_SETTING} is not set; is .env loaded?`);
if (!jobId || !why) throw new Error(`say which job and why: bun run scripts/retire-job.ts <job> "<why>", or ${BACK} to put it back`);

const record = await new JobStore(folder).retire(jobId, why === BACK ? undefined : why);
console.log(record.retired ? `${jobId} is off the wall: ${record.retired.why}` : `${jobId} is back on the wall`);
