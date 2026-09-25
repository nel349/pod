/**
 * The lead: decides what the pod ships, by bringing the builders' work into its own branch.
 *
 * The tip of the lead's branch is the pod's candidate, and the lead makes it so on the chain by
 * approving it. When a builder pushes something new, the lead brings it in, which makes a new tip and
 * a new candidate; the contract clears every earlier approval when that happens, so the rest of the
 * pod judges the new one. Two builders whose work clashes are not reconciled here: the clash is told
 * to the pod, and the lead keeps what it has. The candidate is always on the door before it is named:
 * a commit only this machine has cannot be judged or graded by anybody.
 */
import { branchFor } from "../../door/seat.ts";
import { BROUGHT_IN } from "../protocol.ts";
import { candidateOf, tellThePod, type Seated, type SeatWork } from "../Seated.ts";

export class Lead implements SeatWork {
  /** clashes already told to the pod, so each is said once */
  private readonly reported = new Set<string>();

  constructor(private readonly seated: Seated) {}

  async step(): Promise<void> {
    const { seated } = this;
    const mine = branchFor("lead", seated.identity.address);
    const seats = await seated.identity.readSeats(seated.job);
    const onTheDoor = await seated.copy.fetch(mine);
    await seated.copy.reset(onTheDoor);

    const brought: string[] = [];
    for (const builder of seats.filter((seat) => seat.role === "builder")) {
      const theirs = await seated.copy.fetch(branchFor("builder", builder.agent));
      if (!theirs) continue;
      const tip = await seated.copy.head();
      if (tip && (await seated.copy.isAncestor(theirs, tip))) continue;
      if (!tip) {
        await seated.copy.reset(theirs);
        brought.push(theirs);
        continue;
      }
      const merged = await seated.copy.merge(theirs, `Bring in the builder's work from ${branchFor("builder", builder.agent)}`);
      if (merged.merged) brought.push(theirs);
      else if (!this.reported.has(theirs)) {
        this.reported.add(theirs);
        await tellThePod(seated, `${theirs.slice(0, 12)} clashes with what the lead has, and was not brought in: ${merged.why?.slice(0, 300) ?? ""}`, theirs);
      }
    }

    const candidate = await seated.copy.head();
    if (!candidate) return;
    if (candidate !== onTheDoor) {
      await seated.copy.push(mine);
      seated.say(`candidate is now ${candidate.slice(0, 12)}`);
    }
    if (brought.length > 0) {
      await tellThePod(seated, `${BROUGHT_IN}${brought.map((commit) => commit.slice(0, 12)).join(", ")}. The candidate is ${candidate}`, candidate);
    }

    // the candidate is the lead's to name: approving it is what binds every other approval to it
    const onChain = await candidateOf(seated);
    const leadApproved = seats.some((seat) => seat.role === "lead" && seat.agent.toLowerCase() === seated.identity.address.toLowerCase() && seat.approved);
    if (onChain !== candidate || !leadApproved) {
      await seated.identity.approve(seated.job, "lead", candidate);
      seated.say(`approved ${candidate.slice(0, 12)} as the candidate`);
    }
  }
}
