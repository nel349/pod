/**
 * Which commit a seat may approve.
 *
 * On the contract, approving a commit other than the pod's candidate makes that one the candidate and
 * clears every approval given so far. That is the lead's to do, by naming the work it puts forward,
 * and nobody else's: a reviewer who approved the wrong commit by a slip would undo the pod's work. So
 * the lead names a commit, and every other seat approves the candidate the chain holds, or nothing.
 */
import type { Role } from "../../../src/job.ts";

/** a commit as git names it in full */
const A_FULL_COMMIT = /^[0-9a-f]{40}$/;

export type Refusal = "BUILDERS_DO_NOT_APPROVE" | "NOT_A_COMMIT" | "NO_CANDIDATE" | "NOT_THE_CANDIDATE";

export type ToApprove =
  | { readonly ok: true; readonly commit: string }
  | { readonly ok: false; readonly code: Refusal; readonly why: string; readonly hint: string };

/**
 * @param named     the commit the seat was told to approve, if it was told one
 * @param candidate the commit the contract's approvals are bound to now, if the lead has named one
 */
export function commitToApprove(role: Role, named: string | undefined, candidate: string | undefined): ToApprove {
  if (role === "builder") {
    return { ok: false, code: "BUILDERS_DO_NOT_APPROVE", why: "The builder does not approve: the contract refuses it.", hint: "The lead, the reviewers, QA and security approve the builder's work." };
  }
  const asked = named?.trim().toLowerCase() || undefined;
  if (asked !== undefined && !A_FULL_COMMIT.test(asked)) {
    return { ok: false, code: "NOT_A_COMMIT", why: `"${named}" is not a full commit id.`, hint: "Name the commit in full, 40 characters." };
  }
  if (role === "lead") {
    const commit = asked ?? candidate;
    return commit
      ? { ok: true, commit }
      : { ok: false, code: "NO_CANDIDATE", why: "The pod has no candidate yet, and the lead names it.", hint: "Pass the commit to put forward with --commit." };
  }
  if (!candidate) return { ok: false, code: "NO_CANDIDATE", why: "The pod has no candidate yet.", hint: "The lead names it by approving first." };
  if (asked !== undefined && asked !== candidate) {
    return {
      ok: false, code: "NOT_THE_CANDIDATE", why: `The pod's candidate is ${candidate}, not ${asked}.`,
      hint: "Approving another commit would clear every approval given so far. Read the candidate, and approve it or say why not in a note.",
    };
  }
  return { ok: true, commit: candidate };
}
