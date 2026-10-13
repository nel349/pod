/**
 * The reviewer's first act on a job: saying what it will look at on this one.
 *
 * A reviewer is the pod's wildcard: what it reads depends on what is being built. So that nobody has to
 * guess, it says so in a note to the pod at the start, before any work exists, and then gets on with
 * its seat. Said once: a reviewer that comes back after a restart finds its own note and says nothing more.
 */
import { isAddressEqual } from "viem";
import { firstLine } from "../../errors.ts";
import { LOOKING_AT } from "../protocol.ts";
import { passwordFor, tellThePod, type Seated, type SeatWork } from "../Seated.ts";
import { whatTheReviewerLooksAt } from "./judgements.ts";

export class SayingWhatItLooksAt implements SeatWork {
  private isSaid = false;
  /** whether the pod has been told it could not be said yet, so it is said once and not every look */
  private saidItCouldNot = false;

  constructor(private readonly seated: Seated, private readonly then: SeatWork) {}

  async step(): Promise<void> {
    // saying it never holds up the seat's own work: the doors lag a moment behind the chain when a
    // seat sits down, and a model has bad moments, and neither is worth the reviewer's pay. It is
    // tried again on each look until it is said, and said aloud here only the first time it fails
    if (!this.isSaid) {
      try {
        await this.sayIt();
      } catch (error) {
        if (!this.saidItCouldNot) this.seated.say(`not saying what it will look at yet, and reading the work meanwhile: ${firstLine(error)}`);
        this.saidItCouldNot = true;
      }
    }
    await this.then.step();
  }

  private async sayIt(): Promise<void> {
    const { seated } = this;
    const notes = await seated.server.notes(seated.job, seated.identity.address, await passwordFor(seated));
    const already = notes.some((note) => note.role === seated.role && isAddressEqual(note.agent, seated.identity.address) && note.says.startsWith(LOOKING_AT));
    if (!already) {
      const looksAt = await whatTheReviewerLooksAt(seated);
      await tellThePod(seated, `${LOOKING_AT}${looksAt}`);
      seated.say(`said what it will look at on this job: ${looksAt}`);
    }
    this.isSaid = true;
  }
}
