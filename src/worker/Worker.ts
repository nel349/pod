/**
 * The worker: what turns a pod's approvals into a verdict, a settlement, a POD and a main branch.
 *
 * Nobody asks it to. It looks at every job on this contract and, whenever the chain says every seat
 * the policy asks for has approved one commit, it grades that commit in the sealed box, publishes the
 * evidence, settles on the contract, mints the title to whoever paid, and puts the work on the main
 * branch. So no party has to be trusted to press a button, and no pod can stall a job by never asking.
 *
 * Every step asks what has already happened before it acts, and the answers live where the wall and
 * the chain already keep them: the job's record, the contract, the token, the repository. A worker
 * that dies half way picks up where it stopped, and a step done twice is the same as a step done
 * once. Grading runs a few jobs at a time; writing to the chain goes one transaction at a time,
 * because the validator is one key with one sequence of transactions.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { START } from "../job.ts";
import { policyMet, readApprovals, readJob, readSeats, settle, type Contract, type OnChainJob } from "../jobs.ts";
import { gradeCommit } from "../pipeline.ts";
import { publish } from "../publish.ts";
import { bytes32ToCommit, commitToBytes32, has, openRepository, putOnMain } from "../repo.ts";
import { moneyMove } from "../runner.ts";
import { jobPath } from "../routes.ts";
import { SEATS } from "../seal.ts";
import { readableToTheBox } from "../sandbox.ts";
import type { JobRecord, JobStore, OnChain } from "../store.ts";
import { mintPod, tokenOfJob } from "../token.ts";

/** How many jobs are graded at once. Grading is Docker boxes, and a machine has only so many to give */
export const GRADED_AT_ONCE = 2;
/** How often the worker looks at every job */
export const LOOK_EVERY_MS = 10_000;

export interface WorkerOptions {
  readonly store: JobStore;
  /** where each job's repository is: the same folder the git door serves */
  readonly repositories: string;
  /** the jobs contract, with the validator's wallet: the only key it takes a verdict from */
  readonly jobs: Contract;
  /** the title contract, which the validator mints on. Left out, jobs still settle and pods are still paid */
  readonly token?: Contract;
  /** the validator's key, which signs every receipt as well as every settlement */
  readonly runnerKey: Hex;
  /** the image the work is run in: the same pinned one for every verdict */
  readonly image: string;
  /** where job pages are served, so a title points at its job. Left out, the path alone */
  readonly site?: string;
  readonly gradedAtOnce?: number;
  /** how many times the whole set of checks runs, which have to agree. Two at least */
  readonly times?: number;
  readonly say?: (what: string) => void;
}

const NO_COMMIT = /^0x0{64}$/i;

export class Worker {
  private readonly grading = new Map<string, Promise<void>>();
  /** every chain write, in order: one key, one nonce stream */
  private chainWrites: Promise<unknown> = Promise.resolve();
  private readonly runner: Address;

  constructor(private readonly options: WorkerOptions) {
    this.runner = privateKeyToAccount(options.runnerKey).address;
  }

  /** One look at every job: start what can start, finish what can finish. */
  async tick(): Promise<void> {
    for (const record of await this.options.store.all()) {
      try {
        await this.advance(record.jobId);
      } catch (error) {
        // one job's trouble is not every job's: it is said, and tried again on the next look
        this.say(`${record.jobId}: ${(error as Error).message.split("\n")[0]}`);
      }
    }
  }

  /** Look every so often until told to stop, then let grading under way finish. */
  async run(signal: AbortSignal, every = LOOK_EVERY_MS): Promise<void> {
    while (!signal.aborted) {
      await this.tick();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, every);
        signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
    await this.whenIdle();
  }

  /** When every grading under way has finished, whatever it found. */
  async whenIdle(): Promise<void> {
    while (this.grading.size > 0) await Promise.allSettled([...this.grading.values()]);
  }

  private async advance(jobId: string): Promise<void> {
    const { store, jobs } = this.options;
    const record = await store.read(jobId);
    if (!record?.chain || record.chain.jobs.toLowerCase() !== jobs.address.toLowerCase()) return;
    if (this.grading.has(jobId)) return;
    const onChainId = BigInt(record.chain.jobId);
    const onChain = await readJob(jobs, onChainId);

    const graded = record.signed?.receipt;
    if (graded && record.tile.verdict !== "running") {
      if (onChain.state === "working" && !NO_COMMIT.test(onChain.commit) && bytes32ToCommit(onChain.commit) === graded.commit) {
        await this.settle(record, onChainId);
        return;
      }
      if (onChain.state === "settled" && graded.verdict === "passed") {
        await this.titleAndMain(record, onChainId, graded.commit);
        return;
      }
      // a verdict that did not settle (the runs disagreed) leaves the job to the pod: if it approves
      // another commit, that one is graded; otherwise the poster takes the money back at the deadline
      if (onChain.state !== "working" || NO_COMMIT.test(onChain.commit) || bytes32ToCommit(onChain.commit) === graded.commit) return;
    }

    const ready = await this.readyToGrade(onChain, onChainId);
    if (!ready) return;
    const repo = await openRepository(this.options.repositories, jobId);
    if (!(await has(repo, ready))) {
      const why = `the pod approved ${ready}, which was never pushed to the job's repository, so there is nothing to grade`;
      if (record.waitingBecause !== why) await store.save({ ...record, waitingBecause: why });
      return;
    }
    if (this.grading.size >= (this.options.gradedAtOnce ?? GRADED_AT_ONCE)) return;
    const work = this.grade(record, onChainId, ready).finally(() => this.grading.delete(jobId));
    this.grading.set(jobId, work);
  }

  /** The commit to grade, if the chain says the pod is done with one and there is still time to settle it. */
  private async readyToGrade(onChain: OnChainJob, onChainId: bigint): Promise<string | undefined> {
    if (onChain.state !== "working" || NO_COMMIT.test(onChain.commit)) return undefined;
    // the contract refuses a settlement after the window, so a verdict then would change nothing
    const now = (await this.options.jobs.publicClient.getBlock()).timestamp;
    if (now >= onChain.endsAt) return undefined;
    if (!(await policyMet(this.options.jobs, onChainId, onChain.commit))) return undefined;
    return bytes32ToCommit(onChain.commit);
  }

  private async grade(record: JobRecord, onChainId: bigint, commit: string): Promise<void> {
    const { store, jobs } = this.options;
    const spec = await store.spec(record.jobId);
    if (!spec) {
      await store.save({ ...record, waitingBecause: "the spec this job was sealed under is not kept here, so it cannot be graded" });
      return;
    }
    this.say(`${record.jobId}: grading ${commit.slice(0, 12)}`);
    const checks = await mkdtemp(join(tmpdir(), "pod-worker-checks-"));
    try {
      for (const [name, contents] of Object.entries(await store.allCheckFiles(record.jobId))) await writeFile(join(checks, name), contents);
      await readableToTheBox(checks);
      const report = await gradeCommit({
        repo: await openRepository(this.options.repositories, record.jobId),
        commit, seal: record.seal, start: START, checks,
        toRun: spec.checks.map((check) => ({ says: check.says, command: check.run, hidden: check.hidden })),
        image: this.options.image,
        allowedHosts: spec.allowed.map((allowed) => allowed.host),
        runner: this.runner, runnerKey: this.options.runnerKey,
        ...(this.options.times === undefined ? {} : { times: this.options.times }),
      });

      const seats = await readSeats(jobs, onChainId);
      const approvedNow = new Set(seats.filter((seat) => seat.approved).map((seat) => `${seat.role}:${seat.agent.toLowerCase()}`));
      const approvals = (await readApprovals(jobs, onChainId, commitToBytes32(commit)))
        .filter((approval) => approvedNow.has(`${approval.role}:${approval.agent.toLowerCase()}`))
        .map((approval) => ({ role: approval.role, agent: approval.agent, commit, at: new Date(Number(approval.at) * 1000).toISOString() }));

      const published = await publish(store, {
        jobId: record.jobId, seal: record.seal, idea: spec.idea, mode: spec.mode, price: spec.price, report,
        pod: seats.map((seat) => ({ role: seat.role, agent: seat.agent, owner: seat.owner })),
        checksDirectory: checks, approvals,
        ...(record.repository ? { repository: record.repository } : {}),
        ...(record.podHolder ? { podHolder: record.podHolder } : {}),
      });
      // what the chain already knows about the job stays with it: the grading does not know it
      await store.save({ ...published, chain: record.chain });
      this.say(`${record.jobId}: ${report.signed.receipt.verdict}`);
    } finally {
      await rm(checks, { recursive: true, force: true });
    }
  }

  /** Move the money the way the verdict says, once. A held verdict moves nothing. */
  private async settle(record: JobRecord, onChainId: bigint): Promise<void> {
    const verdict = record.signed!.receipt.verdict;
    const move = moneyMove(verdict);
    if (move === "hold") return;
    const commit = commitToBytes32(record.signed!.receipt.commit);
    const hash = await this.onTheChain(async () => {
      // read again inside the queue: another look may have settled it while this one waited
      if ((await readJob(this.options.jobs, onChainId)).state !== "working") return undefined;
      return settle(this.options.jobs, onChainId, commit, move === "pay");
    });
    if (!hash) return;
    await this.remember(record.jobId, { settled: hash });
    this.say(`${record.jobId}: settled, ${move === "pay" ? "the pod is paid" : "the poster is refunded"}`);
  }

  /** On a job that passed and settled: the title to whoever paid, and the work on the main branch. Each once. */
  private async titleAndMain(record: JobRecord, onChainId: bigint, commit: string): Promise<void> {
    const { token, jobs } = this.options;
    if (token && !record.chain?.minted) {
      const minted = await this.onTheChain(async () => {
        if ((await tokenOfJob(token, onChainId)) !== 0n) return undefined;
        return mintPod(token, {
          jobs, jobId: onChainId, seal: record.seal, commit: commitToBytes32(commit),
          receiptHash: record.signed!.hash,
          crew: record.tile.pod.flatMap((seat) => {
            const role = SEATS.find((named) => named === seat.role);
            return role ? [{ role, agent: seat.agent }] : [];
          }),
          uri: `${this.options.site ?? ""}${jobPath(record.jobId)}`,
        });
      });
      const tokenId = await tokenOfJob(token, onChainId);
      await this.remember(record.jobId, { ...(minted ? { minted } : {}), tokenId: tokenId.toString() });
      if (minted) this.say(`${record.jobId}: POD #${tokenId} minted to whoever paid`);
    }
    await putOnMain(await openRepository(this.options.repositories, record.jobId), commit);
  }

  /** Keep what the chain did in the job's record, read fresh so nothing written meanwhile is lost. */
  private async remember(jobId: string, done: Partial<OnChain>): Promise<void> {
    const record = await this.options.store.read(jobId);
    if (!record?.chain) return;
    await this.options.store.save({ ...record, chain: { ...record.chain, ...done } });
  }

  /** One chain write at a time, in the order they were asked for. */
  private onTheChain<T>(write: () => Promise<T>): Promise<T> {
    const next = this.chainWrites.then(write, write);
    this.chainWrites = next.catch(() => undefined);
    return next;
  }

  private say(what: string): void {
    (this.options.say ?? console.log)(`[worker] ${what}`);
  }
}
