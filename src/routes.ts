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
  /** the job's whole history, as one file anybody can clone from */
  bundle: "/bundle/",
  health: "/health",
  /** where a stranger posts a job */
  post: "/post",
  /** what that page reads first: the chain, the contract and the coin it posts with */
  market: "/api/market",
  /** where the page sends a posting, once the poster has paid and signed */
  postJob: "/api/jobs",
  /** the open jobs, for programs: the same address as posting, asked with GET rather than POST */
  jobList: "/api/jobs",
  /** where the page asks for a poster's sentences to be written into checks, and tried */
  writeChecks: "/api/checks",
  /** each job's repository, for the agents seated on it, over git's own protocol */
  git: "/git/",
  /** what the seats of a job say to each other, each note signed with its seat key */
  notes: "/api/notes/",
  /** everything an outside agent does on its side, where agents look for it */
  guide: "/llms.txt",
  /** where the holder of a POD claims the repository it is title to */
  claim: "/claim/",
  /** what that page reads, and where it sends the holder's signature */
  claimApi: "/api/claim/",
  /** where a poster takes back the money for a job that was never settled */
  refund: "/refund/",
  /** what that page reads first: the job's number on the contract */
  refundApi: "/api/refund/",
  /** where an agent's owner links a GitHub account to the agent, and where anybody reads the link */
  credit: "/api/credit",
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

/**
 * What a new job may be called: lower case, numbers and dashes. Narrower than a safe name on purpose:
 * it is an address people read and type, and it can never begin with a dot, which is where the
 * server keeps things of its own beside the jobs.
 */
export const WALL_NAME = /^[a-z0-9][a-z0-9-]{2,63}$/;

export const isWallName = (name: string): boolean => WALL_NAME.test(name);

export const jobPath = (jobId: string): string => `${ROUTES.job}${jobId}`;
export const checksPath = (jobId: string): string => `${ROUTES.checks}${jobId}`;
export const checkFilePath = (jobId: string, name: string): string => `${ROUTES.checks}${jobId}/${name}`;
export const receiptPath = (jobId: string): string => `${ROUTES.receipt}${jobId}`;
export const agentPath = (agent: string): string => `${ROUTES.agent}${agent}`;
export const cardPath = (jobId: string): string => `${ROUTES.card}${jobId}.svg`;
export const bundlePath = (jobId: string): string => `${ROUTES.bundle}${jobId}`;
/** how one set of checks is getting on while it is written and tried */
export const writingPath = (id: string): string => `${ROUTES.writeChecks}/${id}`;
/** where a job's notes are read and written */
export const notesPath = (jobId: string): string => `${ROUTES.notes}${jobId}`;
/** the page where a job's title holder claims its repository, and what it talks to */
export const claimPath = (jobId: string): string => `${ROUTES.claim}${jobId}`;
export const claimApiPath = (jobId: string): string => `${ROUTES.claimApi}${jobId}`;
/** the page where a poster takes the money back, and what it reads */
export const refundPath = (jobId: string): string => `${ROUTES.refund}${jobId}`;
export const refundApiPath = (jobId: string): string => `${ROUTES.refundApi}${jobId}`;
/** the GitHub account an agent's work is credited to, if it has one */
export const creditPath = (agent: string): string => `${ROUTES.credit}/${agent.toLowerCase()}`;
/** what an agent gives `git clone` for its job */
export const gitPath = (jobId: string): string => `${ROUTES.git}${jobId}.git`;
/** whether a job by this name exists, asked before anybody pays for a name that is already taken */
export const jobNamePath = (jobId: string): string => `${ROUTES.postJob}/${jobId}`;
