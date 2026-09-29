/**
 * A paid job, prepared: its checks written, reworded and written again, until its poster approves one
 * set on the chain.
 *
 * Nothing here spends anything before money has arrived. A job is set up only once the chain shows it
 * paid for, by the poster who asks. Each writing waits its turn, and its price is set aside on the
 * chain before a word is written; when it finishes, the price is kept if the model answered and
 * released if the fault was ours. The poster sees a set only once its price is settled either way.
 *
 * A set in which every line is proven comes with everything the poster needs to approve it: the whole
 * spec built here from what was written, its seal, and the writer's signature over that seal for this
 * job. The contract opens the job only on a seal the writer signed, so it can never open on checks
 * nobody holds.
 *
 * Everything is kept on disk as it happens, so a server that stops and starts again picks up where it
 * was: a writing whose price was never settled is settled, and one that was under way is released and
 * waits its turn again.
 */
import { isAddressEqual, recoverMessageAddress, type Address, type Hex } from "viem";
import { readyToSeal, WriteRequestSchema, WritingFailed, writeChecks, type CheckWriter, type Stage, type WriteRequest, type WrittenSet } from "../checkwriting/index.ts";
import { sealWritten } from "../checkwriting/sealWritten.ts";
import { secondsNow } from "../clock.ts";
import { firstLine } from "../errors.ts";
import { MODES } from "../job.ts";
import type { JobV2, WritingMoney } from "../jobsV2.ts";
import { setUpMessage } from "../messages.ts";
import { isWallName } from "../routes.ts";
import { specToTheWire } from "../specWire.ts";
import type { JobStore } from "../store.ts";
import { posterStatementFrom, posterStatementHolds } from "./posterStatement.ts";
import type { PreparingStore } from "./PreparingStore.ts";
import {
  ApprovalSchema, ON_CHAIN_NUMBER, SetUpRequestSchema,
  type Approval, type Asked, type Finished, type Now, type Outcome, type PreparingView, type SetUp,
} from "./records.ts";

/** How many jobs' checks are written at once: each is a model's time and a dozen boxes */
export const PREPARING_AT_ONCE = 2;
/** How long a writing that stopped on our side waits before it is tried again: the chain and the disk have bad moments */
export const TRY_AGAIN_AFTER_MS = 30_000;

/** What the preparing jobs ask of the chain, which is the only authority on who paid for what. */
export interface PreparingChain {
  readonly jobs: Address;
  job(onChainId: bigint): Promise<JobV2 | undefined>;
  money(onChainId: bigint): Promise<WritingMoney>;
  writingPrice(): Promise<bigint>;
}

/** What the writer key does with a job's writing money, and its word on what it wrote. */
export interface Writer {
  reserve(onChainId: bigint): Promise<Hex>;
  keep(onChainId: bigint): Promise<Hex>;
  release(onChainId: bigint): Promise<Hex>;
  sign(onChainId: bigint, seal: Hex): Promise<Hex>;
}

export interface PreparingOptions {
  readonly store: PreparingStore;
  /** the jobs on the wall, whose names a preparing job may not take */
  readonly wall: JobStore;
  readonly chain: PreparingChain;
  readonly writer: Writer;
  readonly checkWriter: CheckWriter;
  readonly atOnce?: number;
  /** how long a writing that stopped on our side waits before it is tried again */
  readonly tryAgainAfterMs?: number;
  /** where what happens is said, for whoever runs the server */
  readonly say?: (what: string) => void;
}

export type Answer<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly status: number; readonly why: string };

const refused = (status: number, why: string): Answer<never> => ({ ok: false, status, why });

/** How a writing ended, before it is kept on disk and its money settled. */
interface Ending {
  readonly asked: Asked;
  readonly number: number;
  readonly isCharged: boolean;
  readonly outcome: Outcome;
  /** true when no money was ever set aside for it, so there is nothing to keep or release */
  readonly isSettled: boolean;
}

type Running = Stage | "starting";

export class Preparing {
  private readonly waiting: string[] = [];
  private readonly running = new Map<string, Running>();
  private readonly underWay = new Set<Promise<void>>();
  /** jobs whose poster is being answered right now, so two asks at once cannot both be taken */
  private readonly asking = new Set<string>();
  private readonly atOnce: number;
  private readonly tryAgainAfterMs: number;
  private readonly say: (what: string) => void;

  constructor(private readonly options: PreparingOptions) {
    this.atOnce = options.atOnce ?? PREPARING_AT_ONCE;
    this.tryAgainAfterMs = options.tryAgainAfterMs ?? TRY_AGAIN_AFTER_MS;
    this.say = options.say ?? ((what) => console.log(`[preparing] ${what}`));
  }

  get jobs(): Address {
    return this.options.chain.jobs;
  }

  /**
   * Whether a preparing job holds this name. A job its poster took back before approving holds it no
   * longer: the chain says so, and the name is free for another.
   */
  async isNameTaken(name: string): Promise<boolean> {
    const holder = await this.options.store.nameHolder(name);
    return holder !== undefined && !(await this.wasTakenBackBeforeApproval(holder));
  }

  /**
   * A poster who has paid asks for their job to be prepared, under a name, with its first writing.
   * Asked again the same way, it answers the same: a page that lost the answer can ask again.
   */
  async setUp(asked: unknown): Promise<Answer<{ readonly onChainId: string; readonly name: string }>> {
    const parsed = SetUpRequestSchema.safeParse(asked);
    if (!parsed.success) return refused(400, parsed.error.issues[0]?.message ?? "that is not a job to prepare");
    const { onChainId, name, mode, salt, request, poster, signature } = parsed.data;
    if (!isWallName(name)) return refused(400, "a job's name is lower-case letters, numbers and dashes, from 3 to 64 of them");

    let signer: Address;
    try {
      signer = await recoverMessageAddress({ message: setUpMessage({ jobs: this.jobs, onChainId, name, mode, salt }), signature });
    } catch {
      return refused(401, "that signature could not be read");
    }
    if (!isAddressEqual(signer, poster)) return refused(401, "that signature is not from the address that says it paid");

    const job = await this.options.chain.job(BigInt(onChainId));
    if (!job) return refused(404, `there is no job ${onChainId} on the contract`);
    if (!isAddressEqual(job.poster, signer)) return refused(403, `job ${onChainId} was paid for by somebody else`);
    if (job.state !== "preparing") return refused(409, `job ${onChainId} is not being prepared any more`);
    if (job.window !== BigInt(MODES[mode].windowMinutes * 60)) {
      return refused(409, `the window paid for on the chain is not a ${mode} job's window`);
    }

    const already = await this.options.store.readSetUp(onChainId);
    if (already) {
      const isTheSame = already.name === name && already.mode === mode && already.salt === salt && isAddressEqual(already.poster, poster);
      return isTheSame ? { ok: true, value: { onChainId, name } } : refused(409, `job ${onChainId} was already set up differently`);
    }

    if (await this.options.wall.read(name)) return refused(409, `there is already a job called ${name}`);
    const claimed = await this.claimName(name, onChainId);
    if (!claimed) return refused(409, `there is already a job called ${name}`);

    await this.options.store.saveSetUp({ onChainId, jobs: this.jobs, name, poster, mode, salt, setUpAt: new Date().toISOString() });
    await this.options.store.ask(onChainId, { request, askedAt: new Date().toISOString() });
    this.enqueue(onChainId);
    this.say(`job ${onChainId} is set up as ${name}; its first writing waits its turn`);
    return { ok: true, value: { onChainId, name } };
  }

  /**
   * The poster asks for the checks to be written again, from the lines as they read now. Only the
   * poster is let in; then two of their asks at the same moment are one ask.
   */
  async write(onChainId: string, authorization: string | null, asked: unknown): Promise<Answer<{ readonly now: Now }>> {
    const poster = await this.thePoster(onChainId, authorization);
    if (!poster.ok) return poster;
    if (this.asking.has(onChainId)) return refused(409, "a writing of these checks is already being asked for");
    this.asking.add(onChainId);
    try {
      return await this.askForAnother(onChainId, asked);
    } finally {
      this.asking.delete(onChainId);
    }
  }

  /** The job as its poster reads it, with every set whose price is settled. */
  async read(onChainId: string, authorization: string | null): Promise<Answer<PreparingView>> {
    const poster = await this.thePoster(onChainId, authorization);
    if (!poster.ok) return poster;
    const setUp = poster.value;
    const [asked, writings, money, writingPrice] = await Promise.all([
      this.options.store.readAsked(onChainId),
      this.options.store.writings(onChainId),
      this.options.chain.money(BigInt(onChainId)),
      this.options.chain.writingPrice(),
    ]);
    return {
      ok: true,
      value: {
        onChainId, name: setUp.name, mode: setUp.mode, now: this.nowFor(onChainId),
        ...(asked ? { asked: asked.request } : {}),
        writings: writings.filter((writing) => writing.isSettled),
        money: { ...money, writingPrice },
      },
    };
  }

  /**
   * Pick up after a stop: settle every writing whose price never was, release money set aside for a
   * writing nobody is waiting for any more, and put every job whose writing is still asked for back
   * in the queue, in the order they were asked.
   */
  async recover(): Promise<void> {
    const toWrite: { readonly onChainId: string; readonly askedAt: string }[] = [];
    for (const onChainId of await this.options.store.all()) {
      try {
        const askedAt = await this.recoverOne(onChainId);
        if (askedAt !== undefined) toWrite.push({ onChainId, askedAt });
      } catch (error) {
        this.say(`job ${onChainId} could not be picked up again, and is tried again shortly: ${firstLine(error)}`);
        this.tryAgainLater(onChainId);
      }
    }
    for (const { onChainId } of toWrite.sort((a, b) => a.askedAt.localeCompare(b.askedAt))) this.enqueue(onChainId);
  }

  /** Settles once no writing is under way, so a server being stopped can wait for its boxes. */
  async whenIdle(): Promise<void> {
    while (this.underWay.size > 0) await Promise.allSettled([...this.underWay]);
  }

  /** Hold the name for this job, taking it over from a job taken back before approval if that is who holds it. */
  private async claimName(name: string, onChainId: string): Promise<boolean> {
    const { store } = this.options;
    const claimed = await store.claimName(name, onChainId);
    if (claimed.ok) return true;
    if (!(await this.wasTakenBackBeforeApproval(claimed.heldBy))) return false;
    return (await store.takeOverName(name, claimed.heldBy, onChainId)).ok;
  }

  /** Whether the chain shows this job taken back by its poster before any checks were approved. */
  private async wasTakenBackBeforeApproval(onChainId: string): Promise<boolean> {
    const job = await this.options.chain.job(BigInt(onChainId));
    // approving fixes the seal: a refunded job with no seal was never approved
    return job?.state === "refunded" && /^0x0{64}$/.test(job.seal);
  }

  private async askForAnother(onChainId: string, asked: unknown): Promise<Answer<{ readonly now: Now }>> {
    const request = WriteRequestSchema.safeParse(asked);
    if (!request.success) return refused(400, request.error.issues[0]?.message ?? "that is not a request to write checks");
    if (await this.options.store.readAsked(onChainId)) return refused(409, "a writing of these checks is already waiting or under way");

    // an earlier writing whose price was never settled is settled first; what is set aside after that
    // belongs to no writing, and is the next one's
    await this.settleEarlier(onChainId);
    const [money, price] = await Promise.all([this.options.chain.money(BigInt(onChainId)), this.options.chain.writingPrice()]);
    if (money.balance + money.reserved < price) {
      return refused(402, "every writing paid for has been used: pay for one more on the chain, and ask again");
    }

    await this.options.store.ask(onChainId, { request: request.data, askedAt: new Date().toISOString() });
    this.enqueue(onChainId);
    return { ok: true, value: { now: this.nowFor(onChainId) } };
  }

  /** The job's number when a writing is still asked for, after settling what was left unsettled. */
  private async recoverOne(onChainId: string): Promise<string | undefined> {
    await this.settleEarlier(onChainId);
    const asked = await this.clearIfFinished(onChainId);
    const job = await this.options.chain.job(BigInt(onChainId));
    if (asked && job?.state === "preparing") return asked.askedAt;

    if (asked) await this.options.store.clearAsked(onChainId);
    // set aside for a writing nobody is waiting for any more: it was ours to finish, so it is not charged
    if ((await this.options.chain.money(BigInt(onChainId))).reserved > 0n) {
      await this.options.writer.release(BigInt(onChainId));
      this.say(`job ${onChainId}: money set aside for a writing nobody waits for any more was released`);
    }
    return undefined;
  }

  /** The asked writing, unless it already finished and its money was settled, in which case it is cleared. */
  private async clearIfFinished(onChainId: string): Promise<Asked | undefined> {
    const asked = await this.options.store.readAsked(onChainId);
    if (!asked) return undefined;
    const writings = await this.options.store.writings(onChainId);
    if (writings.some((writing) => writing.askedAt === asked.askedAt && writing.isSettled)) {
      await this.options.store.clearAsked(onChainId);
      return undefined;
    }
    return asked;
  }

  /** The job's set up, if the authorization is its poster's statement and the job still prepares. */
  private async thePoster(onChainId: string, authorization: string | null): Promise<Answer<SetUp>> {
    if (!ON_CHAIN_NUMBER.test(onChainId)) return refused(400, `${onChainId} is not a job's number on the contract`);
    const setUp = await this.options.store.readSetUp(onChainId);
    if (!setUp) return refused(404, `job ${onChainId} is not being prepared here`);
    const statement = posterStatementFrom(authorization);
    if (!statement.ok) return refused(401, statement.why);
    const holds = await posterStatementHolds(statement.value, { jobs: this.jobs, onChainId, poster: setUp.poster }, secondsNow());
    if (!holds.ok) return refused(403, holds.why);
    const job = await this.options.chain.job(BigInt(onChainId));
    if (job?.state !== "preparing") return refused(409, `job ${onChainId} is not being prepared any more`);
    return { ok: true, value: setUp };
  }

  private nowFor(onChainId: string): Now {
    const running = this.running.get(onChainId);
    if (running === "writing" || running === "trying") return { kind: running };
    if (running === "starting") return { kind: "writing" };
    const place = this.waiting.indexOf(onChainId);
    return place === -1 ? { kind: "idle" } : { kind: "waiting", place: place + 1 };
  }

  private enqueue(onChainId: string): void {
    if (!this.waiting.includes(onChainId) && !this.running.has(onChainId)) this.waiting.push(onChainId);
    this.pump();
  }

  /**
   * Start what there is room for. When a run ends, however it ends, an ask that is still there, or
   * that came while it ran, goes back in the queue: at once when the run finished, a little later when
   * it stopped on our side.
   */
  private pump(): void {
    while (this.running.size < this.atOnce) {
      const onChainId = this.waiting.shift();
      if (onChainId === undefined) return;
      this.running.set(onChainId, "starting");
      const work: Promise<void> = this.run(onChainId)
        .then(
          () => this.afterRun(onChainId, 0),
          (error: unknown) => {
            this.say(`job ${onChainId}: the writing stopped on our side, and is tried again shortly: ${firstLine(error)}`);
            this.afterRun(onChainId, this.tryAgainAfterMs);
          },
        )
        .finally(() => this.underWay.delete(work));
      this.underWay.add(work);
    }
  }

  private afterRun(onChainId: string, waitMs: number): void {
    this.running.delete(onChainId);
    if (waitMs === 0) void this.enqueueIfAsked(onChainId);
    else this.tryAgainLater(onChainId, waitMs);
    this.pump();
  }

  private tryAgainLater(onChainId: string, waitMs: number = this.tryAgainAfterMs): void {
    setTimeout(() => { void this.enqueueIfAsked(onChainId); }, waitMs).unref();
  }

  private async enqueueIfAsked(onChainId: string): Promise<void> {
    try {
      if (await this.options.store.readAsked(onChainId)) this.enqueue(onChainId);
    } catch (error) {
      this.say(`job ${onChainId}: its ask could not be read, and is looked at again shortly: ${firstLine(error)}`);
      this.tryAgainLater(onChainId);
    }
  }

  private async run(onChainId: string): Promise<void> {
    const { store, chain } = this.options;
    const setUp = await store.readSetUp(onChainId);
    await this.settleEarlier(onChainId);
    const asked = await this.clearIfFinished(onChainId);
    if (!asked || !setUp) return;

    const job = await chain.job(BigInt(onChainId));
    if (job?.state !== "preparing") {
      // approved or taken back while it waited: nothing is written for a job that is no longer preparing
      await store.clearAsked(onChainId);
      return;
    }
    const number = await store.nextWritingNumber(onChainId);
    const refusal = await this.setAside(onChainId);
    if (refusal !== undefined) {
      await this.finish(onChainId, { asked, number, isCharged: false, isSettled: true, outcome: { kind: "failed", why: refusal } });
      return;
    }

    this.running.set(onChainId, "writing");
    let set: WrittenSet;
    try {
      set = await writeChecks(asked.request, this.options.checkWriter, (stage) => this.running.set(onChainId, stage));
    } catch (error) {
      // anything that is not the writing's own failure happened on our side, and is not charged
      const isCharged = error instanceof WritingFailed && error.isCharged;
      await this.finish(onChainId, { asked, number, isCharged, isSettled: false, outcome: { kind: "failed", why: firstLine(error) } });
      return;
    }
    // the model answered: from here the writing is charged, whatever happens to sealing it
    await this.finish(onChainId, { asked, number, isCharged: true, isSettled: false, outcome: await this.outcomeOf(onChainId, setUp, asked.request, set, job.price) });
  }

  /**
   * Set the writing's price aside on the chain, or say why it could not be. Money already set aside
   * and settled by no writing is this one's: a reservation whose answer was lost on the way back has
   * still landed, and is used rather than stranded.
   */
  private async setAside(onChainId: string): Promise<string | undefined> {
    const { chain, writer } = this.options;
    if ((await chain.money(BigInt(onChainId))).reserved > 0n) return undefined;
    try {
      await writer.reserve(BigInt(onChainId));
      return undefined;
    } catch (error) {
      if ((await chain.money(BigInt(onChainId))).reserved > 0n) return undefined;
      return `the writing could not be started on the chain: ${firstLine(error)}`;
    }
  }

  private async outcomeOf(onChainId: string, setUp: SetUp, request: WriteRequest, set: WrittenSet, price: bigint): Promise<Outcome> {
    const ready = readyToSeal(set.checks);
    const written = { kind: "written" as const, checks: [...set.checks], ready, ...(set.howItIsAsked ? { howItIsAsked: set.howItIsAsked } : {}) };
    if (!ready) return written;
    try {
      return { ...written, approval: await this.approvalFor(onChainId, setUp, request, set, price) };
    } catch (error) {
      return { ...written, whyNoApproval: `these checks could not be sealed and signed here: ${firstLine(error)}` };
    }
  }

  /**
   * Keep the writing on disk, then settle its price, then clear the ask: a stop at any point is
   * picked up where it was, and a new ask cannot slip in before this one is settled.
   */
  private async finish(onChainId: string, ending: Ending): Promise<void> {
    const finished: Finished = {
      number: ending.number, request: ending.asked.request, askedAt: ending.asked.askedAt,
      finishedAt: new Date().toISOString(), isCharged: ending.isCharged, isSettled: ending.isSettled, outcome: ending.outcome,
    };
    await this.options.store.saveWriting(onChainId, finished);
    if (!finished.isSettled) await this.settle(onChainId, finished);
    await this.options.store.clearAsked(onChainId);
  }

  private async settleEarlier(onChainId: string): Promise<void> {
    for (const writing of await this.options.store.writings(onChainId)) {
      if (!writing.isSettled) await this.settle(onChainId, writing);
    }
  }

  /**
   * Keep or release a finished writing's price. If nothing is set aside any more, it was settled
   * already: by a server that stopped before writing so down, or by the poster releasing it after a
   * day. Which, the chain's count of writings kept says; a charge released by the poster was never
   * paid, so that writing is not charged, and has nothing to approve.
   */
  private async settle(onChainId: string, writing: Finished): Promise<void> {
    const { chain, writer, store } = this.options;
    const money = await chain.money(BigInt(onChainId));
    if (money.reserved > 0n) {
      if (writing.isCharged) await writer.keep(BigInt(onChainId));
      else await writer.release(BigInt(onChainId));
      await store.saveWriting(onChainId, { ...writing, isSettled: true });
      return;
    }
    const keptBefore = (await store.writings(onChainId))
      .filter((other) => other.number !== writing.number && other.isSettled && other.isCharged).length;
    const wasKept = money.kept > keptBefore;
    if (!writing.isCharged || wasKept) {
      await store.saveWriting(onChainId, { ...writing, isSettled: true });
      return;
    }
    const outcome: Outcome = writing.outcome.kind === "written"
      ? { kind: "written", checks: writing.outcome.checks, ready: writing.outcome.ready, ...(writing.outcome.howItIsAsked ? { howItIsAsked: writing.outcome.howItIsAsked } : {}) }
      : writing.outcome;
    await store.saveWriting(onChainId, {
      ...writing, outcome, isCharged: false, isSettled: true,
      note: "its money was released by the poster before it was kept, so it is not charged and cannot be approved",
    });
  }

  private async approvalFor(onChainId: string, setUp: SetUp, request: WriteRequest, set: WrittenSet, price: bigint): Promise<Approval> {
    const sealed = await sealWritten({
      idea: request.idea, kind: request.kind, mode: setUp.mode, price, checks: set.checks,
      ...(set.howItIsAsked ? { howItIsAsked: set.howItIsAsked } : {}), salt: setUp.salt,
    });
    const signature = await this.options.writer.sign(BigInt(onChainId), sealed.seal);
    // read through the same schema it is read back with, so what is kept is exactly what will be read
    return ApprovalSchema.parse({ spec: specToTheWire(sealed.spec), files: { ...sealed.files }, seal: sealed.seal, signature });
  }
}
