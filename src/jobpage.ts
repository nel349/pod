/**
 * One job, opened.
 *
 * The tile is the claim. This is the evidence: what was asked for, who signed what, what ran, and
 * exactly how to run it again yourself. The last part is the one that matters, because the reason to
 * believe a verdict here is not that we signed it, it is that anybody can repeat it.
 */
import type { Receipt } from "./receipt.ts";
import { checksPath, jobPath, ROUTES } from "./routes.ts";

/** Where a command names this site, which only the page the reader is on knows the address of. */
export const THIS_SITE = "<this site>";

/** Where this code is published: what a stranger runs to check a verdict is ours to read, not ours to vouch for */
export const POD_SOURCE = "https://github.com/nel349/pod";

export interface Approval {
  readonly role: string;
  readonly agent: string;
  readonly commit: string;
  readonly at: string;
}

/** The names a machine has for itself, which mean a different machine to everybody else. */
const ITS_OWN_NAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Whether an address is one only the machine that wrote it can reach. */
function isTheGradersOwnMachine(address: string): boolean {
  return URL.canParse(address) && ITS_OWN_NAMES.has(new URL(address).hostname);
}

/**
 * How a stranger fetches the code at the graded commit, from wherever the receipt says it is. A
 * receipt signed before the worker kept a fetchable copy names a folder on the grader's own machine:
 * that cannot be changed, since the receipt is signed, so it is said, and the published repository,
 * if there is one, is where to fetch it instead. One signed while the wall was served from the
 * grader's machine names that machine's own address: that is said too, and the history is fetched
 * from this site, which serves the same file at the same path.
 */
function fetchTheCode(receipt: Receipt, publishedAt: string | undefined): readonly string[] {
  const checkout = `cd work && git checkout ${receipt.commit}`;
  const where = receipt.repository;
  const isBundle = where.startsWith(ROUTES.bundle) || (/^https?:\/\//.test(where) && where.includes(ROUTES.bundle));
  if (isBundle) {
    const fetched = (from: string): string => `curl -fsSL -o job.bundle ${from} && git clone job.bundle work && ${checkout}`;
    // a history named without a host is this site's own: the reader is on it
    if (where.startsWith(ROUTES.bundle)) return [fetched(`${THIS_SITE}${where}`)];
    if (isTheGradersOwnMachine(where)) {
      return [
        `# this receipt names the grader's own machine, which nobody else can reach:`,
        `#   ${where}`,
        `# the same history is served here`,
        fetched(`${THIS_SITE}${new URL(where).pathname}`),
      ];
    }
    return [fetched(where)];
  }
  if (/^https?:\/\//.test(where)) return [`git clone ${where} work && ${checkout}`];
  const note = `# this receipt names a folder on the grader's machine, ${where || "nothing"}, which nobody else can fetch`;
  return publishedAt ? [note, `git clone ${publishedAt} work && ${checkout}`] : [note, `# put the code at commit ${receipt.commit} in ./work some other way, cd into it, then:`];
}

/**
 * What a stranger runs to reach the same verdict, start to finish.
 *
 * Fetching the code at the graded commit, then the same grading we did, by the same program: it
 * checks the receipt's signature, holds the code against the tree the receipt names, fetches the
 * checks from this site and runs them against the code from a box of their own, on a network with no
 * route out. Every line runs as it is written; a command that only looked like the run would be a
 * claim, and this page is where claims are checked.
 */
export function repeatCommand(receipt: Receipt, jobId: string, publishedAt?: string): string {
  return [
    `# needs git, Docker and Bun`,
    ...fetchTheCode(receipt, publishedAt),
    `cd .. && git clone ${POD_SOURCE} pod && cd pod && bun install`,
    `bun run src/repeat.ts ${THIS_SITE}${jobPath(jobId)} ../work`,
    `# it runs the checks published at`,
    `#   ${THIS_SITE}${checksPath(jobId)}`,
    `# against that code, here, in the image the receipt names`,
    `#   ${receipt.image}`,
    `# and holds the code against the tree the receipt names`,
    `#   ${receipt.tree}`,
  ].join("\n");
}
