/**
 * The worker: what turns a pod's approvals into a verdict, a settlement, a POD and a main branch.
 *
 * Nobody asks it to. It looks at every job on this contract and, whenever the chain says every seat
 * the policy asks for has approved one commit, it grades that commit in the sealed box, publishes the
 * evidence, settles on the contract, mints the title to whoever paid, and puts the work on the main
 * branch. Then, for every agent that asks, it records the verdict on its seat in ERC-8004 (see
 * RegistryAnswers.ts). So no party has to be trusted to press a button, and no pod can stall a job by never asking.
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
import { isAddressEqual, zeroHash, type Address, type Hex } from "viem";
import { branchFor } from "../door/seat.ts";
import { firstLine } from "../errors.ts";
import { START } from "../job.ts";
import { policyMet, readApprovals, readJob, readSeats, settle, type Contract, type OnChainJob } from "../jobs.ts";
import { pause } from "../pause.ts";
import { gradeCommit } from "../pipeline.ts";
import { publish } from "../publish.ts";
import { ensureRepository, push as pushToGitHub, setDefaultBranch } from "../github.ts";
import { BRANCH, bytes32ToCommit, commitToBytes32, has, onBranch, openRepository, putOnMain, shortCommit } from "../repo.ts";
import { moneyMove } from "../runner.ts";
import { jobPath } from "../routes.ts";
import { SEATS } from "../seal.ts";
import type { Registries } from "../registry.ts";
import { readableToTheBox } from "../sandbox.ts";
import type { SignedReceipt } from "../receipt.ts";
import type { JobRecord, JobStore, OnChain } from "../store.ts";
import { mintPod, tokenOfJob } from "../token.ts";
import { RegistryAnswers } from "./RegistryAnswers.ts";

/** How many jobs are graded at once. Grading is Docker boxes, and a machine has only so many to give */
export const GRADED_AT_ONCE = 2;
/** How often the worker looks at every job */
export const LOOK_EVERY_MS = 10_000;
/** How long a job whose grading failed is left before it is graded again: Docker, the chain and the disk have bad moments */
export const GRADE_AGAIN_AFTER_MS = 5 * 60_000;

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
  /**
   * The ERC-8004 registries, where agents ask for their verdicts to be recorded, and the folder the
   * worker keeps how far it has read them in. Left out, nothing is recorded there.
   */
  readonly registry?: { readonly registries: Registries; readonly stateFolder: string };
  readonly gradedAtOnce?: number;
  /** how long a job whose grading failed waits before it is graded again: GRADE_AGAIN_AFTER_MS unless said */
  readonly gradeAgainAfterMs?: number;
  /** how many times the whole set of checks runs, which have to agree. Two at least */
  readonly times?: number;
  /**
   * The GitHub account or organisation work that passed is published under, as a repository of its
   * own: what the POD's holder claims, and where GitHub counts the pod's commits. Left out, nothing
   * leaves this server.
   */
  readonly publishTo?: { readonly owner: string };
  readonly say?: (what: string) => void;
}


export class Worker {
  private readonly grading = new Map<string, Promise<void>>();
  /** when each job's last grading failed, so a job that keeps failing is not graded again every look */
  private readonly failedAt = new Map<string, number>();
  /** the look under way, so two never run at once */
  private looking?: Promise<void>;
  /** every chain write, in order: one key, one nonce stream */
  private chainWrites: Promise<unknown> = Promise.resolve();
  private readonly runner: Address;
  private readonly answers?: RegistryAnswers;

  constructor(private readonly options: WorkerOptions) {
    this.runner = privateKeyToAccount(options.runnerKey).address;
    if (options.registry) {
      this.answers = new RegistryAnswers({
        store: options.store, jobs: options.jobs, runner: this.runner,
        registries: options.registry.registries, stateFolder: options.registry.stateFolder,
        ...(options.site ? { site: options.site } : {}),
        onTheChain: (write) => this.onTheChain(write),
        say: (what) => this.say(what),
      });
    }
  }

  /** One look at every job: start what can start, finish what can finish. A look asked for during another is that one. */
  tick(): Promise<void> {
    if (!this.looking) this.looking = this.look().finally(() => { this.looking = undefined; });
    return this.looking;
  }

  private async look(): Promise<void> {
    for (const record of await this.options.store.all()) {
      try {
        await this.advance(record.jobId);
      } catch (error) {
        // one job's trouble is not every job's: it is said, and tried again on the next look
        this.say(`${record.jobId}: ${firstLine(error)}`);
      }
    }
    try {
      await this.answers?.look();
    } catch (error) {
      this.say(`the registry could not be read, and will be on the next look: ${firstLine(error)}`);
    }
  }

  /** Look every so often until told to stop, then let grading under way finish. */
  async run(signal: AbortSignal, every = LOOK_EVERY_MS): Promise<void> {
    while (!signal.aborted) {
      await this.tick();
      await pause(every, signal);
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
    if (!record?.chain || !isAddressEqual(record.chain.jobs, jobs.address)) return;
    if (this.grading.has(jobId) || this.isFinished(record)) return;
    const onChainId = BigInt(record.chain.jobId);
    const onChain = await readJob(jobs, onChainId);

    const signed = record.signed;
    if (signed && record.tile.verdict !== "running") {
      const graded = signed.receipt;
      if (onChain.state === "working" && onChain.commit !== zeroHash && bytes32ToCommit(onChain.commit) === graded.commit) {
        // the contract settles nothing after the window, so a verdict that came too late is said, not sent
        if ((await this.now()) >= onChain.endsAt) {
          const why = "the verdict came after the job's window closed, and the contract settles nothing after it: the poster takes the money back";
          if (record.waitingBecause !== why) await store.save({ ...record, waitingBecause: why });
          return;
        }
        await this.settle(record.jobId, signed, onChainId);
        // and straight on to the title and main for work that passed, rather than a look later: a
        // worker stopped between the two would leave a paid job with no title until it started again
        if (graded.verdict === "passed" && (await readJob(jobs, onChainId)).state === "settled") {
          await this.titleAndMain((await store.read(jobId)) ?? record, signed, onChainId);
        }
        return;
      }
      if (onChain.state === "settled" && graded.verdict === "passed") {
        await this.titleAndMain(record, signed, onChainId);
        return;
      }
      // a verdict that did not settle (the runs disagreed) leaves the job to the pod: if it approves
      // another commit, that one is graded; otherwise the poster takes the money back at the deadline
      if (onChain.state !== "working" || onChain.commit === zeroHash || bytes32ToCommit(onChain.commit) === graded.commit) return;
    }

    const ready = await this.readyToGrade(onChain, onChainId);
    if (!ready) return;
    const notOnTheLeadsBranch = await this.whyNotGradable(jobId, onChainId, ready);
    if (notOnTheLeadsBranch) {
      if (record.waitingBecause !== notOnTheLeadsBranch) await store.save({ ...record, waitingBecause: notOnTheLeadsBranch });
      return;
    }
    const failed = this.failedAt.get(jobId);
    if (failed !== undefined && Date.now() - failed < (this.options.gradeAgainAfterMs ?? GRADE_AGAIN_AFTER_MS)) return;
    if (this.grading.size >= (this.options.gradedAtOnce ?? GRADED_AT_ONCE)) return;
    const work = this.grade(record, onChainId, ready)
      .then(() => { this.failedAt.delete(jobId); })
      // a grading that failed is said, and tried again later: it never takes the worker down with it
      .catch((error: unknown) => {
        this.failedAt.set(jobId, Date.now());
        this.say(`${jobId}: the grading failed, and is tried again later: ${firstLine(error)}`);
      })
      .finally(() => this.grading.delete(jobId));
    this.grading.set(jobId, work);
  }

  /**
   * Why an approved commit cannot be graded, or nothing if it can. It has to be in the repository and
   * on the lead's branch: the lead names the candidate, and a commit that no branch holds was never
   * checked by the git door's rules, whoever it says wrote it.
   */
  private async whyNotGradable(jobId: string, onChainId: bigint, commit: string): Promise<string | undefined> {
    const repo = await openRepository(this.options.repositories, jobId);
    if (!(await has(repo, commit))) return `the pod approved ${commit}, which was never pushed to the job's repository, so there is nothing to grade`;
    const lead = (await readSeats(this.options.jobs, onChainId)).find((seat) => seat.role === "lead");
    if (!lead || !(await onBranch(repo, commit, branchFor("lead", lead.agent)))) {
      return `the pod approved ${commit}, which is not on the lead's branch, so it is not graded: a commit the pod ships is one the lead brought in`;
    }
    return undefined;
  }

  /**
   * Whether there is nothing left for the worker to do on this job: its money has moved, and if it
   * passed, its title is minted. Such a job is not read from the chain again.
   */
  private isFinished(record: JobRecord): boolean {
    if (!record.chain?.settled || !record.signed) return false;
    if (record.signed.receipt.verdict !== "passed") return true;
    const titled = !this.options.token || record.chain.tokenId !== undefined;
    const published = !this.options.publishTo || record.repository !== undefined;
    return titled && published;
  }

  private async now(): Promise<bigint> {
    return (await this.options.jobs.publicClient.getBlock()).timestamp;
  }

  /** The commit to grade, if the chain says the pod is done with one and there is still time to settle it. */
  private async readyToGrade(onChain: OnChainJob, onChainId: bigint): Promise<string | undefined> {
    if (onChain.state !== "working" || onChain.commit === zeroHash) return undefined;
    // the contract refuses a settlement after the window, so a verdict then would change nothing
    if ((await this.now()) >= onChain.endsAt) return undefined;
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
    this.say(`${record.jobId}: grading ${shortCommit(commit)}`);
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
      const approved = seats.filter((seat) => seat.approved);
      const { found, lookedBackTo } = await readApprovals(jobs, onChainId, commitToBytes32(commit), approved);
      // each approving seat with the time the contract recorded; one approved longer ago than was
      // read back says so, rather than a time being made up for it
      const approvals = approved.map((seat) => {
        const when = found.find((approval) => approval.role === seat.role && isAddressEqual(approval.agent, seat.agent));
        return { role: seat.role, agent: seat.agent, commit, at: when ? isoOf(when.at) : `before ${isoOf(lookedBackTo)}` };
      });

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
  private async settle(jobId: string, signed: SignedReceipt, onChainId: bigint): Promise<void> {
    const move = moneyMove(signed.receipt.verdict);
    if (move === "hold") return;
    const commit = commitToBytes32(signed.receipt.commit);
    const hash = await this.onTheChain(async () => {
      // read again inside the queue: another look may have settled it while this one waited, or the
      // pod moved to another commit, which a refund would otherwise take no notice of
      const now = await readJob(this.options.jobs, onChainId);
      if (now.state !== "working" || now.commit.toLowerCase() !== commit.toLowerCase()) return undefined;
      return settle(this.options.jobs, onChainId, commit, move === "pay");
    });
    if (!hash) return;
    await this.remember(jobId, { settled: hash });
    this.say(`${jobId}: settled, ${move === "pay" ? "the pod is paid" : "the poster is refunded"}`);
  }

  /**
   * On a job that passed and settled: the work on the main branch, then the title to whoever paid.
   * Main first: once the title is written down the job is finished and not looked at again.
   */
  private async titleAndMain(record: JobRecord, signed: SignedReceipt, onChainId: bigint): Promise<void> {
    const { token, jobs } = this.options;
    const commit = signed.receipt.commit;
    await putOnMain(await openRepository(this.options.repositories, record.jobId), commit);
    if (token && record.chain?.tokenId === undefined) {
      const minted = await this.onTheChain(async () => {
        if ((await tokenOfJob(token, onChainId)) !== 0n) return undefined;
        return mintPod(token, {
          jobs, jobId: onChainId, seal: record.seal, commit: commitToBytes32(commit),
          receiptHash: signed.hash,
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
    // last, and apart from the money and the title: GitHub having a bad moment holds up neither, and
    // publishing is tried again on the next look until it is done
    if (this.options.publishTo && record.repository === undefined) await this.publish(record.jobId, record.tile.idea, this.options.publishTo.owner);
  }

  /** The job's whole repository on GitHub, opening on the work that passed, and where it is kept on the record. */
  private async publish(jobId: string, idea: string, owner: string): Promise<void> {
    const published = await ensureRepository(owner, jobId, idea);
    await pushToGitHub(await openRepository(this.options.repositories, jobId), published, "every branch");
    await setDefaultBranch(published, BRANCH);
    const record = await this.options.store.read(jobId);
    if (record) await this.options.store.save({ ...record, repository: published.url });
    this.say(`${jobId}: published at ${published.url}`);
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

/** A time the chain gave in seconds, as the job page writes it. */
function isoOf(seconds: bigint): string {
  return new Date(Number(seconds) * 1000).toISOString();
}
