/**
 * One job, opened.
 *
 * The tile is the claim. This is the evidence: what was asked for, who signed what, what ran, and
 * exactly how to run it again yourself. The last part is the one that matters, because the reason to
 * believe a verdict here is not that we signed it, it is that anybody can repeat it.
 */
import type { Receipt } from "./receipt.ts";
import { ROUTES } from "./routes.ts";

export interface Approval {
  readonly role: string;
  readonly agent: string;
  readonly commit: string;
  readonly at: string;
}

/**
 * How a stranger fetches the code at the graded commit, from wherever the receipt says it is. A
 * receipt signed before the worker kept a fetchable copy names a folder on the grader's own machine:
 * that cannot be changed, since the receipt is signed, so it is said, and the published repository,
 * if there is one, is where to fetch it instead.
 */
function fetchTheCode(receipt: Receipt, publishedAt: string | undefined): readonly string[] {
  const checkout = `cd work && git checkout ${receipt.commit}`;
  const where = receipt.repository;
  const isBundle = where.startsWith(ROUTES.bundle) || (/^https?:\/\//.test(where) && where.includes(ROUTES.bundle));
  if (isBundle) {
    // a history named without a host is this site's own: the reader is on it
    const from = where.startsWith(ROUTES.bundle) ? `<this site>${where}` : where;
    return [`curl -fsSL -o job.bundle ${from} && git clone job.bundle work && ${checkout}`];
  }
  if (/^https?:\/\//.test(where)) return [`git clone ${where} work && ${checkout}`];
  const note = `# this receipt names a folder on the grader's machine, ${where || "nothing"}, which nobody else can fetch`;
  return publishedAt ? [note, `git clone ${publishedAt} work && ${checkout}`] : [note, `# fetch the code at commit ${receipt.commit} some other way, then:`];
}

/**
 * The command a stranger runs to reach the same verdict.
 *
 * Pinned by digest, no route out, checks from outside the artefact's box: the same run we did,
 * written out so it can be checked rather than trusted.
 */
export function repeatCommand(receipt: Receipt, checksURI: string, publishedAt?: string): string {
  return [
    ...fetchTheCode(receipt, publishedAt),
    `docker run --rm --network none \\`,
    `  --cap-drop ALL --security-opt no-new-privileges --read-only \\`,
    `  -v "$PWD":/repo:ro ${receipt.image} \\`,
    `  sh -c 'cp -r /repo/. /work/ && cd /work && ${receipt.start}'`,
    `# the checks are published at ${checksURI}`,
    `# tree fingerprint to compare against: ${receipt.tree}`,
  ].join("\n");
}
