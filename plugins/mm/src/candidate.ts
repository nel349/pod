/**
 * Which commit a seat may put forward or approve, by the rule of the contract its job is on.
 *
 * Where a builder puts its own work forward, nobody else names what is graded: the builder names a
 * commit with `mm pod put-forward`, and every other seat, the lead among them, approves the candidate
 * the chain holds or nothing. The contract would refuse anything else, and this says why first.
 *
 * On the contracts before, approving a commit other than the pod's candidate made that one the
 * candidate and cleared every approval given so far. That was the lead's to do, by naming the work it
 * put forward, and nobody else's: a reviewer who approved the wrong commit by a slip would undo the
 * pod's work. So there the lead names a commit, and every other seat approves the candidate the chain
 * holds, or nothing.
 */
import type { Role } from "../../../src/job.ts";

/** a commit as git names it in full */
const A_FULL_COMMIT = /^[0-9a-f]{40}$/;

export type Refusal = "BUILDERS_DO_NOT_APPROVE" | "NOT_A_COMMIT" | "NO_CANDIDATE" | "NOT_THE_CANDIDATE" | "NOT_THE_BUILDER" | "NO_COMMIT_NAMED" | "ALREADY_PUT_FORWARD";

export type Named =
  | { readonly ok: true; readonly commit: string }
  | { readonly ok: false; readonly code: Refusal; readonly why: string; readonly hint: string };
export type ToApprove = Named;

/** A commit as it was told, in git's own lower case, or why it is not one. */
function fullCommit(named: string | undefined): { readonly commit?: string; readonly refusal?: Named } {
  const asked = named?.trim().toLowerCase() || undefined;
  if (asked !== undefined && !A_FULL_COMMIT.test(asked)) {
    return { refusal: { ok: false, code: "NOT_A_COMMIT", why: `"${named}" is not a full commit id.`, hint: "Name the commit in full, 40 characters." } };
  }
  return asked === undefined ? {} : { commit: asked };
}

/**
 * @param named     the commit the seat was told to approve, if it was told one
 * @param candidate the commit the contract's approvals are bound to now, if one has been named
 * @param isPutForwardByItsBuilder whether the job's contract has its builder put the work forward,
 *                                 so that no other seat names a commit, the lead included
 */
export function commitToApprove(role: Role, named: string | undefined, candidate: string | undefined, isPutForwardByItsBuilder = false): ToApprove {
  if (role === "builder") {
    return isPutForwardByItsBuilder
      ? { ok: false, code: "BUILDERS_DO_NOT_APPROVE", why: "The builder does not approve: putting its work forward is how it stands behind it.", hint: "Name the commit with `mm pod put-forward --job <name> --commit <id>`." }
      : { ok: false, code: "BUILDERS_DO_NOT_APPROVE", why: "The builder does not approve: the contract refuses it.", hint: "The lead, the reviewers, QA and security approve the builder's work." };
  }
  const told = fullCommit(named);
  if (told.refusal) return told.refusal;
  const asked = told.commit;
  if (role === "lead" && !isPutForwardByItsBuilder) {
    const commit = asked ?? candidate;
    return commit
      ? { ok: true, commit }
      : { ok: false, code: "NO_CANDIDATE", why: "The pod has no candidate yet, and the lead names it.", hint: "Pass the commit to put forward with --commit." };
  }
  if (!candidate) {
    return isPutForwardByItsBuilder
      ? { ok: false, code: "NO_CANDIDATE", why: "The builder has put nothing forward yet.", hint: "Only the builder names what is graded, with `mm pod put-forward`. There is nothing to stand behind until it has." }
      : { ok: false, code: "NO_CANDIDATE", why: "The pod has no candidate yet.", hint: "The lead names it by approving first." };
  }
  if (asked !== undefined && asked !== candidate) {
    return {
      ok: false, code: "NOT_THE_CANDIDATE", why: `The pod's candidate is ${candidate}, not ${asked}.`,
      hint: isPutForwardByItsBuilder
        ? "The contract takes an approval only of what the builder put forward. Read the candidate, and approve it or say why not in a note."
        : "Approving another commit would clear every approval given so far. Read the candidate, and approve it or say why not in a note.",
    };
  }
  return { ok: true, commit: candidate };
}

/**
 * The commit a builder may put forward: one it names in full, which is not the candidate already.
 * Putting forward is the builder's alone, and is how it stands behind its work.
 *
 * @param named     the commit the builder was told to put forward
 * @param candidate the commit put forward now, if one is
 */
export function commitToPutForward(role: Role, named: string | undefined, candidate: string | undefined): Named {
  if (role !== "builder") {
    return { ok: false, code: "NOT_THE_BUILDER", why: `Only the builder puts work forward, and this is the ${role} seat.`, hint: "Every other seat says whether it stands behind the builder's candidate, with `mm pod approve`." };
  }
  const told = fullCommit(named);
  if (told.refusal) return told.refusal;
  if (told.commit === undefined) {
    return { ok: false, code: "NO_COMMIT_NAMED", why: "No commit was named.", hint: "Push the work to the builder's branch, then pass its full commit id with --commit." };
  }
  if (told.commit === candidate) {
    return { ok: false, code: "ALREADY_PUT_FORWARD", why: `${told.commit} is the pod's candidate already.`, hint: "It is being reviewed, or graded. Put forward a different commit to replace it while its review runs." };
  }
  return { ok: true, commit: told.commit };
}
