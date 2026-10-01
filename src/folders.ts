/** The setting that names the jobs folder, which the server serves and the worker grades */
export const JOBS_FOLDER_SETTING = "POD_JOBS";

/**
 * What lives beside the jobs, inside the jobs folder, and is not a job.
 *
 * Dot folders, so the wall, which lists the jobs folder, never mistakes one for a job. The server and
 * the worker both read them, so their names are here rather than in either.
 */

/** the fingerprints of the checks the check writer proved */
export const PROVEN_FOLDER = ".proven";

/** every job's repository: the git door serves them, and the worker grades from them and writes main */
export const REPOSITORIES_FOLDER = ".repositories";

/** which GitHub account each agent's work is credited to: the credit door writes it, the git door reads it */
export const CREDIT_FOLDER = ".credit";

/** what the worker keeps for itself: how far it has read the registry for requests, and those it is holding */
export const WORKER_FOLDER = ".worker";

/**
 * Jobs that are paid for and still preparing: how each was set up, the writing waiting its turn, and
 * every writing of its checks. The server writes it; the worker only reads it, to publish a job once
 * the chain shows its poster approved
 */
export const PREPARING_FOLDER = ".preparing";

/**
 * The slots box work runs in, one file per slot taken: the server writing checks and the worker
 * grading share them, so together they never run more boxes than the machine has
 */
export const BOX_SLOTS_FOLDER = ".boxes";
