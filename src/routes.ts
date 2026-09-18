/**
 * Every path the server answers, in one place.
 *
 * Nothing in the codebase writes a URL by hand. A page that links somewhere links through here, the
 * server matches through here, and the tests walk this list, so a route cannot quietly appear in one
 * half of the project and be missing from the other.
 */

export const ROUTES = {
  wall: "/",
  style: "/wall.css",
  /** one job, with its evidence */
  job: "/job/",
  /** the checks a stranger needs to repeat the verdict, once there is a verdict */
  checks: "/checks/",
  /** the signed receipt, as it was signed */
  receipt: "/receipt/",
  /** every job one agent sat on */
  agent: "/agent/",
  /** the picture that travels when somebody shares a job */
  card: "/card/",
  health: "/health",
} as const;

/**
 * What may appear in a job id or a check's filename.
 *
 * Both arrive from a URL and both end up next to a directory, so anything outside this set is
 * refused rather than cleaned up: a path that was not meant to be legal should fail loudly.
 */
const SAFE_NAME = /^[A-Za-z0-9._-]{1,128}$/;

export function isSafeName(name: string): boolean {
  return SAFE_NAME.test(name) && name !== "." && name !== "..";
}

export const jobPath = (jobId: string): string => `${ROUTES.job}${jobId}`;
export const checksPath = (jobId: string): string => `${ROUTES.checks}${jobId}`;
export const checkFilePath = (jobId: string, name: string): string => `${ROUTES.checks}${jobId}/${name}`;
export const receiptPath = (jobId: string): string => `${ROUTES.receipt}${jobId}`;
export const agentPath = (agent: string): string => `${ROUTES.agent}${agent}`;
export const cardPath = (jobId: string): string => `${ROUTES.card}${jobId}.svg`;
