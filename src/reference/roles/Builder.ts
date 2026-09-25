/**
 * The builder: writes the work, on its own branch, and writes it again when a judge says why not.
 *
 * It answers only refusals of a candidate that holds its latest work, so it never rebuilds because of
 * something said about an older version, and it stops after a few tries rather than spending its
 * owner's model forever. What it writes is only ever read as text and committed; it never runs it.
 */
import { branchFor } from "../../door/seat.ts";
import { PORT } from "../../job.ts";
import { JUDGES, MOST_REBUILDS, REFUSED } from "../protocol.ts";
import { briefFor, candidateOf, leadBranchOf, passwordFor, type Seated, type SeatWork } from "../Seated.ts";

/** The one file the work is, and the one the box starts */
const SERVER = "server.js";

export class Builder implements SeatWork {
  /** the commit this builder last pushed, whose refusals it answers */
  private latest?: string;
  private rebuilds = 0;
  private stopped = false;
  private readonly answered = new Set<string>();

  constructor(private readonly seated: Seated) {}

  async step(): Promise<void> {
    if (!this.latest) return this.build([]);
    if (this.stopped) return;

    const refusals = await this.refusalsOfMyLatest();
    if (refusals.length === 0) return;
    if (this.rebuilds >= MOST_REBUILDS) {
      this.stopped = true;
      this.seated.say(`rebuilt ${MOST_REBUILDS} times and still refused; stopping rather than guessing again`);
      return;
    }
    // counted only once the build that answers them is pushed: a model or a push that failed is tried
    // again on the next look, with the same refusals
    await this.build(refusals.map((refusal) => refusal.why));
    for (const refusal of refusals) this.answered.add(refusal.signature);
    this.rebuilds++;
  }

  /** Why a judge refused a candidate that holds this builder's latest work, and not yet answered. */
  private async refusalsOfMyLatest(): Promise<readonly { readonly why: string; readonly signature: string }[]> {
    const { seated } = this;
    const latest = this.latest;
    const candidate = await candidateOf(seated);
    if (!latest || !candidate) return [];
    const leadBranch = leadBranchOf(await seated.identity.readSeats(seated.job));
    if (!leadBranch || !(await seated.copy.fetch(leadBranch))) return [];
    if (!(await seated.copy.isAncestor(latest, candidate))) return [];

    const notes = await seated.server.notes(seated.job, seated.identity.address, await passwordFor(seated));
    return notes
      .filter((note) => note.about === candidate && (JUDGES as readonly string[]).includes(note.role) && note.says.startsWith(REFUSED) && !this.answered.has(note.signature))
      .map((note) => ({ why: `${note.role}: ${note.says.slice(REFUSED.length)}`, signature: note.signature }));
  }

  private async build(refusals: readonly string[]): Promise<void> {
    const { seated } = this;
    if (!seated.model) throw new Error("a builder needs a model to write the work with");
    const mine = branchFor("builder", seated.identity.address);
    await seated.copy.reset(await seated.copy.fetch(mine));
    const existing = await seated.copy.read(SERVER);

    const answer = await seated.model([
      "You are the builder on a small team. Write the whole of server.js and nothing else.",
      `It is a Node program using only the standard library. It must listen on port ${PORT}, on every interface,`,
      "not only localhost: it is reached from another machine on a private network.",
      "Reply with one fenced code block and no explanation.",
      "",
      "## What is being asked for",
      briefFor(seated.listed),
      ...(existing ? ["", "## What is there now, which you are replacing", "```", existing, "```"] : []),
      ...(refusals.length > 0 ? ["", "## Why the last version was refused, which this one must fix", ...refusals.map((why) => `- ${why}`)] : []),
    ].join("\n"), AbortSignal.timeout(MODEL_MAY_TAKE_MS));

    await seated.copy.write({ [SERVER]: codeIn(answer) });
    const commit = await seated.copy.commit(refusals.length === 0 ? "Build it from the brief" : `Answer the refusal: ${refusals[0]}`.slice(0, 200));
    if (!commit) throw new Error("the builder has nothing to push");
    await seated.copy.push(mine);
    this.latest = commit;
    seated.say(`pushed ${commit.slice(0, 12)} to ${mine}${refusals.length > 0 ? `, answering ${refusals.length} refusal(s)` : ""}`);
  }
}

/** How long a builder waits for its model to write the work */
const MODEL_MAY_TAKE_MS = 5 * 60_000;

/** The first fenced block of an answer, or the whole answer if it is all code. */
function codeIn(answer: string): string {
  const fenced = answer.match(/```(?:[a-z]*)\n([\s\S]*?)```/);
  return `${(fenced ? fenced[1]! : answer).trim()}\n`;
}

