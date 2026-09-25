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

/** what the worker keeps for itself: how far it has read the registry for requests, and those it is holding */
export const WORKER_FOLDER = ".worker";
