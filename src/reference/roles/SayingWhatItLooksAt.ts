/**
 * The reviewer's first act on a job: saying what it will look at on this one.
 *
 * A reviewer is the pod's wildcard: what it reads depends on what is being built. So that nobody has to
 * guess, it says so in a note to the pod at the start, before any work exists, and then gets on with
 * its seat. Said once: a reviewer that comes back after a restart finds its own note and says nothing more.
 */
import { isAddressEqual } from "viem";
import { LOOKING_AT } from "../protocol.ts";
import { passwordFor, tellThePod, type Seated, type SeatWork } from "../Seated.ts";
import { whatTheReviewerLooksAt } from "./judgements.ts";

export class SayingWhatItLooksAt implements SeatWork {
  private isSaid = false;

  constructor(private readonly seated: Seated, private readonly then: SeatWork) {}

  async step(): Promise<void> {
    if (!this.isSaid) await this.sayIt();
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
