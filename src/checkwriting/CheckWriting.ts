/**
 * The writing in progress, by id.
 *
 * Writing takes a minute or two, which is longer than a request should be held open, so the page
 * starts it and then asks how it is going. Held in memory: a server that restarts forgets drafts,
 * and the page says so and offers to write them again, which costs a poster a minute and nothing
 * else.
 */
import { firstLine } from "../errors.ts";
import type { ProvenChecks } from "./ProvenChecks.ts";
import { WriteRequestSchema } from "./request.ts";
import { writeChecks, type CheckWriter } from "./writeChecks.ts";
import { isStillWriting, readyToSeal, type Writing } from "./written.ts";

/**
 * How many posters' checks are written at once. Each one is a model's time and a dozen boxes, and
 * the model is paid for by whoever runs this server, so the number is small and a poster who finds
 * it full is told to try again rather than queued behind strangers indefinitely.
 */
export const WRITING_AT_ONCE = 2;
/** how long a written set stays fetchable, which is longer than anybody takes to read it */
const KEPT_MS = 60 * 60_000;

export type Started =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly status: 400 | 429; readonly why: string };

interface Run {
  readonly startedAt: number;
  readonly state: Writing;
}

export interface CheckWritingOptions {
  readonly writer: CheckWriter;
  /** where the fingerprints of proven checks are written down, which a posting is held to */
  readonly proven: ProvenChecks;
  readonly atOnce?: number;
}

export class CheckWriting {
  /** each run is replaced whole when it moves on, never edited in place */
  private readonly runs = new Map<string, Run>();
  /** the work still under way, so a server stopping can wait for its boxes to be taken down */
  private readonly underWay = new Set<Promise<void>>();
  private readonly writer: CheckWriter;
  private readonly proven: ProvenChecks;
  private readonly atOnce: number;

  constructor(options: CheckWritingOptions) {
    this.writer = options.writer;
    this.proven = options.proven;
    this.atOnce = options.atOnce ?? WRITING_AT_ONCE;
  }

  /** Start writing, if the request is sound and there is room. Only the fields that mean something are kept. */
  start(asked: unknown): Started {
    const parsed = WriteRequestSchema.safeParse(asked);
    if (!parsed.success) {
      return { ok: false, status: 400, why: parsed.error.issues[0]?.message ?? "that is not a request to write checks" };
    }

    this.forgetOld();
    if (this.busy() >= this.atOnce) {
      return { ok: false, status: 429, why: "other people's checks are being written right now. Try again in a minute" };
    }

    const id = crypto.randomUUID();
    const startedAt = Date.now();
    const move = (state: Writing): void => { this.runs.set(id, { startedAt, state }); };
    move({ stage: "writing" });
    const work: Promise<void> = writeChecks(parsed.data, this.writer, (stage) => move({ stage }))
      // written down before the poster is shown them, so there is no moment they could pay for a
      // proven check the server has not yet recorded as proven
      .then(async (set) => {
        await this.proven.remember(set);
        move({ stage: "written", checks: set.checks, ...(set.howItIsAsked ? { howItIsAsked: set.howItIsAsked } : {}), ready: readyToSeal(set.checks) });
      })
      .catch((error: unknown) => move({ stage: "failed", why: firstLine(error) }))
      .finally(() => this.underWay.delete(work));
    this.underWay.add(work);
    return { ok: true, id };
  }

  /**
   * Settles once no writing is under way. A server being stopped waits on this, because a run cut
   * off mid-way leaves its boxes and their network behind: the containers stop, the clean-up in its
   * `finally` never runs.
   */
  async whenIdle(): Promise<void> {
    while (this.underWay.size > 0) await Promise.allSettled([...this.underWay]);
  }

  read(id: string): Writing | undefined {
    return this.runs.get(id)?.state;
  }

  private busy(): number {
    return [...this.runs.values()].filter((run) => isStillWriting(run.state)).length;
  }

  /**
   * Forget finished runs nobody has asked about for a while. A run still going is never forgotten,
   * however long it takes: it still holds boxes, so it still holds its slot. Every step of a run has
   * its own time limit, so every run does finish.
   */
  private forgetOld(): void {
    const now = Date.now();
    for (const [id, run] of this.runs) {
      if (!isStillWriting(run.state) && now - run.startedAt > KEPT_MS) this.runs.delete(id);
    }
  }
}
