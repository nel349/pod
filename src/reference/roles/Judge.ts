/**
 * A seat that judges the candidate: the reviewer, QA and security.
 *
 * Each looks at every candidate the lead names, once, and either approves it on the contract or
 * refuses it in a note that says why, which is what the builder answers. How it judges is the seat's
 * own (see judgements.ts); what it does with the judgement is the same for all three.
 *
 * It re-reads the candidate just before approving. Approving a commit that is no longer the
 * candidate would make it the candidate again and clear everybody else's approvals, which is the
 * contract's rule and exactly what a late judge must not do. And it tells the pod before it
 * approves, not after: its approval may be the one that completes the policy, and the job it
 * settles takes no more notes.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APPROVED, REFUSED, type Verdict } from "../protocol.ts";
import { candidateOf, leadBranchOf, tellThePod, type Seated, type SeatWork } from "../Seated.ts";

/** How one seat judges a candidate, given its files laid out in a folder of their own. */
export type Judgement = (seated: Seated, files: string) => Promise<Verdict>;

export class Judge implements SeatWork {
  /** what this seat made of each candidate, so a turn that failed half way does not ask the model again */
  private readonly verdicts = new Map<string, Verdict>();
  /** candidates whose note is sent */
  private readonly told = new Set<string>();
  /** candidates this seat has finished with: refused, or approved on the contract */
  private readonly done = new Set<string>();

  constructor(private readonly seated: Seated, private readonly judgement: Judgement) {}

  async step(): Promise<void> {
    const { seated } = this;
    const candidate = await candidateOf(seated);
    if (!candidate || this.done.has(candidate)) return;
    const verdict = this.verdicts.get(candidate) ?? await this.judge(candidate);
    if (!verdict) return;
    this.verdicts.set(candidate, verdict);

    // the note goes first, while the job is certainly still open: the approval can be the one that
    // completes the policy, and a job the grader settles a moment later takes no more notes
    if (!this.told.has(candidate)) {
      await tellThePod(seated, `${verdict.approve ? APPROVED : REFUSED}${verdict.why}`, candidate);
      this.told.add(candidate);
    }
    if (!verdict.approve) {
      this.done.add(candidate);
      seated.say(`refused ${candidate.slice(0, 12)}: ${verdict.why}`);
      return;
    }
    if ((await candidateOf(seated)) !== candidate) {
      seated.say(`${candidate.slice(0, 12)} stopped being the candidate while it was judged; judging the new one instead`);
      return;
    }
    // counted done only once the chain has it: a transaction that failed is sent again on the next look
    await seated.identity.approve(seated.job, seated.role, candidate);
    this.done.add(candidate);
    seated.say(`approved ${candidate.slice(0, 12)}: ${verdict.why}`);
  }

  /** The seat's judgement of one candidate, or nothing if the lead's branch does not have it yet. */
  private async judge(candidate: string): Promise<Verdict | undefined> {
    const { seated } = this;
    const leadBranch = leadBranchOf(await seated.identity.readSeats(seated.job));
    if (!leadBranch || !(await seated.copy.fetch(leadBranch))) return undefined;
    const files = await mkdtemp(join(tmpdir(), `pod-${seated.role}-`));
    try {
      await seated.copy.layOut(candidate, files);
      return await this.judgement(seated, files);
    } finally {
      await rm(files, { recursive: true, force: true });
    }
  }
}
