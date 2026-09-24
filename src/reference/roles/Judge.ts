/**
 * A seat that judges the candidate: the reviewer, QA and security.
 *
 * Each looks at every candidate the lead names, once, and either approves it on the contract or
 * refuses it in a note that says why, which is what the builder answers. How it judges is the seat's
 * own (see judgements.ts); what it does with the judgement is the same for all three.
 *
 * It re-reads the candidate just before approving. Approving a commit that is no longer the
 * candidate would make it the candidate again and clear everybody else's approvals, which is the
 * contract's rule and exactly what a late judge must not do.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APPROVED, REFUSED, type Verdict } from "../protocol.ts";
import { candidateOf, leadBranchOf, tellThePod, type Seated, type SeatWork } from "../Seated.ts";

/** How one seat judges a candidate, given its files laid out in a folder of their own. */
export type Judgement = (seated: Seated, files: string) => Promise<Verdict>;

export class Judge implements SeatWork {
  private readonly judged = new Set<string>();

  constructor(private readonly seated: Seated, private readonly judgement: Judgement) {}

  async step(): Promise<void> {
    const { seated } = this;
    const candidate = await candidateOf(seated);
    if (!candidate || this.judged.has(candidate)) return;
    const leadBranch = leadBranchOf(await seated.identity.readSeats(seated.job));
    if (!leadBranch || !(await seated.copy.fetch(leadBranch))) return;

    const files = await mkdtemp(join(tmpdir(), `pod-${seated.role}-`));
    let verdict: Verdict;
    try {
      await seated.copy.layOut(candidate, files);
      verdict = await this.judgement(seated, files);
    } finally {
      await rm(files, { recursive: true, force: true });
    }
    this.judged.add(candidate);

    if (!verdict.approve) {
      await tellThePod(seated, `${REFUSED}${verdict.why}`, candidate);
      seated.say(`refused ${candidate.slice(0, 12)}: ${verdict.why}`);
      return;
    }
    if ((await candidateOf(seated)) !== candidate) {
      seated.say(`${candidate.slice(0, 12)} stopped being the candidate while it was judged; judging the new one instead`);
      return;
    }
    await seated.identity.approve(seated.job, seated.role, candidate);
    await tellThePod(seated, `${APPROVED}${verdict.why}`, candidate);
    seated.say(`approved ${candidate.slice(0, 12)}: ${verdict.why}`);
  }
}
