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
import { isAddress, isAddressEqual, recoverMessageAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import { readyToSeal, WriteRequestSchema, WritingFailed, writeChecks, type CheckWriter, type Stage, type WriteRequest, type WrittenSet } from "../checkwriting/index.ts";
import { sealWritten } from "../checkwriting/sealWritten.ts";
import { secondsNow } from "../clock.ts";
import { firstLine } from "../errors.ts";
import { MODE_NAMES, MODES } from "../job.ts";
import type { JobV2, WritingMoney } from "../jobsV2.ts";
import { setUpMessage } from "../messages.ts";
import { isWallName } from "../routes.ts";
import { specToTheWire } from "../specWire.ts";
import type { JobStore } from "../store.ts";
import { posterStatementFrom, posterStatementHolds } from "./posterStatement.ts";
import type { PreparingStore } from "./PreparingStore.ts";
import { ApprovalSchema, SALT, type Approval, type Asked, type Finished, type Outcome, type SetUp } from "./records.ts";

/** How many jobs' checks are written at once: each is a model's time and a dozen boxes */
export const PREPARING_AT_ONCE = 2;

/** What the preparing jobs ask of the chain, which is the only authority on who paid for what. */
export interface PreparingChain {
  readonly jobs: Address;
  readonly chainId: number;
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
  /** where what happens is said, for whoever runs the server */
  readonly say?: (what: string) => void;
}

export type Answer<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly status: number; readonly why: string };

const refused = (status: number, why: string): Answer<never> => ({ ok: false, status, why });

/** What a poster sends after paying, to have the job prepared. */
export const SetUpRequestSchema = z.object({
  onChainId: z.string().regex(/^[0-9]+$/, "the job number on the chain is a whole number"),
  name: z.string(),
  mode: z.enum(MODE_NAMES, { error: "say how long the job runs once it opens" }),
  salt: z.string().regex(SALT, "a salt is 32 hex characters"),
  /** the first writing: what the poster wants built, and the lines that would prove it */
  request: WriteRequestSchema,
  poster: z.string().refine((value): value is Address => isAddress(value), "the poster is not an address"),
  signature: z.string().refine((value): value is Hex => /^0x[0-9a-fA-F]*$/.test(value), "the signature is not hex"),
});

/** Where a job's writing stands right now, for its poster. */
export type Now =
  | { readonly kind: "waiting"; readonly place: number }
  | { readonly kind: "writing" | "trying" }
  | { readonly kind: "idle" };

/** A preparing job as its poster reads it. */
export interface PreparingView {
  readonly onChainId: string;
  readonly name: string;
  readonly mode: SetUp["mode"];
  readonly now: Now;
  /** the writing waiting or under way, if there is one */
  readonly asked?: WriteRequest;
  /** every writing whose price is settled, first to last */
  readonly writings: readonly Finished[];
  readonly money: WritingMoney & { readonly writingPrice: bigint };
}

type Running = Stage | "starting";

export class Preparing {
  private readonly waiting: string[] = [];
  private readonly running = new Map<string, Running>();
  private readonly underWay = new Set<Promise<void>>();
  /** jobs whose poster is being answered right now, so two asks at once cannot both be taken */
  private readonly asking = new Set<string>();
  private readonly atOnce: number;
  private readonly say: (what: string) => void;

  constructor(private readonly options: PreparingOptions) {
    this.atOnce = options.atOnce ?? PREPARING_AT_ONCE;
    this.say = options.say ?? ((what) => console.log(`[preparing] ${what}`));
  }

  get jobs(): Address {
    return this.options.chain.jobs;
  }

  /** Whether a preparing job holds this name. */
  async isNameTaken(name: string): Promise<boolean> {
    return (await this.options.store.nameHolder(name)) !== undefined;
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
    const claimed = await this.options.store.claimName(name, onChainId);
    if (!claimed.ok) return refused(409, `there is already a job called ${name}`);

    await this.options.store.saveSetUp({ onChainId, jobs: this.jobs, name, poster, mode, salt, setUpAt: new Date().toISOString() });
    await this.options.store.ask(onChainId, { request, askedAt: new Date().toISOString() });
    this.enqueue(onChainId);
    this.say(`job ${onChainId} is set up as ${name}; its first writing waits its turn`);
    return { ok: true, value: { onChainId, name } };
  }

  /** The poster asks for the checks to be written again, from the lines as they read now. */
  async write(onChainId: string, authorization: string | null, asked: unknown): Promise<Answer<{ readonly now: Now }>> {
    if (this.asking.has(onChainId)) return refused(409, "a writing of these checks is already being asked for");
    this.asking.add(onChainId);
    try {
      return await this.writeOnce(onChainId, authorization, asked);
    } finally {
      this.asking.delete(onChainId);
    }
  }

  private async writeOnce(onChainId: string, authorization: string | null, asked: unknown): Promise<Answer<{ readonly now: Now }>> {
    const poster = await this.thePoster(onChainId, authorization);
    if (!poster.ok) return poster;
    const request = WriteRequestSchema.safeParse(asked);
    if (!request.success) return refused(400, request.error.issues[0]?.message ?? "that is not a request to write checks");
    if (await this.options.store.readAsked(onChainId)) return refused(409, "a writing of these checks is already waiting or under way");

    // an earlier writing whose price was never settled is settled first, so the chain is free for this one
    await this.settleEarlier(onChainId);
    const [money, price] = await Promise.all([this.options.chain.money(BigInt(onChainId)), this.options.chain.writingPrice()]);
    if (money.balance < price) {
      return refused(402, "every writing paid for has been used: pay for one more on the chain, and ask again");
    }

    await this.options.store.ask(onChainId, { request: request.data, askedAt: new Date().toISOString() });
    this.enqueue(onChainId);
    return { ok: true, value: { now: this.nowFor(onChainId) } };
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
   * Pick up after a stop: settle every writing whose price never was, release a writing that was under
   * way, and put back in the queue every job whose writing is still asked for.
   */
  async recover(): Promise<void> {
    for (const onChainId of await this.options.store.all()) {
      try {
        await this.recoverOne(onChainId);
      } catch (error) {
        this.say(`job ${onChainId} could not be picked up again, and is tried on its next writing: ${firstLine(error)}`);
      }
    }
  }

  /** Settles once no writing is under way, so a server being stopped can wait for its boxes. */
  async whenIdle(): Promise<void> {
    while (this.underWay.size > 0) await Promise.allSettled([...this.underWay]);
  }

  private async recoverOne(onChainId: string): Promise<void> {
    await this.settleEarlier(onChainId);
    const asked = await this.options.store.readAsked(onChainId);
    const writings = await this.options.store.writings(onChainId);
    // finished and kept, but stopped before the ask was cleared
    if (asked && writings.some((writing) => writing.askedAt === asked.askedAt)) await this.options.store.clearAsked(onChainId);

    const money = await this.options.chain.money(BigInt(onChainId));
    if (money.reserved > 0n) {
      // set aside for a writing that never finished: it was ours to finish, so it is not charged
      await this.options.writer.release(BigInt(onChainId));
      this.say(`job ${onChainId}: a writing under way when the server stopped was released, and waits its turn again`);
    }
    const job = await this.options.chain.job(BigInt(onChainId));
    if (job?.state === "preparing" && (await this.options.store.readAsked(onChainId))) this.enqueue(onChainId);
  }

  /** The job's set up, if the authorization is its poster's statement and the job still prepares. */
  private async thePoster(onChainId: string, authorization: string | null): Promise<Answer<SetUp>> {
    if (!/^[0-9]+$/.test(onChainId)) return refused(400, `${onChainId} is not a job's number on the contract`);
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

  private pump(): void {
    while (this.running.size < this.atOnce) {
      const onChainId = this.waiting.shift();
      if (onChainId === undefined) return;
      this.running.set(onChainId, "starting");
      const work: Promise<void> = this.run(onChainId)
        .catch((error: unknown) => this.say(`job ${onChainId}: the writing stopped, and is picked up on the next start: ${firstLine(error)}`))
        .finally(() => {
          this.running.delete(onChainId);
          this.underWay.delete(work);
          this.pump();
        });
      this.underWay.add(work);
    }
  }

  private async run(onChainId: string): Promise<void> {
    const { store, chain, writer } = this.options;
    const [asked, setUp] = await Promise.all([store.readAsked(onChainId), store.readSetUp(onChainId)]);
    if (!asked || !setUp) return;
    await this.settleEarlier(onChainId);

    const job = await chain.job(BigInt(onChainId));
    if (job?.state !== "preparing") {
      // approved or taken back while it waited: nothing is written for a job that is no longer preparing
      await store.clearAsked(onChainId);
      return;
    }
    const number = (await store.writings(onChainId)).length + 1;
    try {
      await writer.reserve(BigInt(onChainId));
    } catch (error) {
      await this.finish(onChainId, asked, number, false, { kind: "failed", why: `the writing could not be started on the chain: ${firstLine(error)}` }, true);
      return;
    }

    this.running.set(onChainId, "writing");
    let outcome: Outcome;
    let isCharged: boolean;
    try {
      const set = await writeChecks(asked.request, this.options.checkWriter, (stage) => this.running.set(onChainId, stage));
      const ready = readyToSeal(set.checks);
      const approval = ready ? await this.approvalFor(onChainId, setUp, asked.request, set, job.price) : undefined;
      outcome = {
        kind: "written", checks: [...set.checks], ready,
        ...(set.howItIsAsked ? { howItIsAsked: set.howItIsAsked } : {}),
        ...(approval ? { approval } : {}),
      };
      isCharged = true;
    } catch (error) {
      outcome = { kind: "failed", why: firstLine(error) };
      // anything that is not the writing's own failure happened on our side, and is not charged
      isCharged = error instanceof WritingFailed && error.isCharged;
    }
    await this.finish(onChainId, asked, number, isCharged, outcome, false);
  }

  /** Kept on disk before its price is settled, so a stop in between is settled on the next start. */
  private async finish(onChainId: string, asked: Asked, number: number, isCharged: boolean, outcome: Outcome, isSettled: boolean): Promise<void> {
    const finished: Finished = {
      number, request: asked.request, askedAt: asked.askedAt, finishedAt: new Date().toISOString(), isCharged, isSettled, outcome,
    };
    await this.options.store.saveWriting(onChainId, finished);
    await this.options.store.clearAsked(onChainId);
    if (!isSettled) await this.settle(onChainId, finished);
  }

  private async settleEarlier(onChainId: string): Promise<void> {
    for (const writing of await this.options.store.writings(onChainId)) {
      if (!writing.isSettled) await this.settle(onChainId, writing);
    }
  }

  /**
   * Keep or release a finished writing's price. If nothing is set aside any more, it was settled
   * already, by a server that stopped before writing so down, or by the poster releasing it after a
   * day, and it is only written down.
   */
  private async settle(onChainId: string, writing: Finished): Promise<void> {
    const { chain, writer, store } = this.options;
    if ((await chain.money(BigInt(onChainId))).reserved > 0n) {
      if (writing.isCharged) await writer.keep(BigInt(onChainId));
      else await writer.release(BigInt(onChainId));
    }
    await store.saveWriting(onChainId, { ...writing, isSettled: true });
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
