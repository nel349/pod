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
import { closeJob, isLocked, releaseLock, settleV2, type VerdictOnChain } from "../jobsV2.ts";
import { longestRunSeconds } from "../blackbox.ts";
import { pause } from "../pause.ts";
import { gradeCommit } from "../pipeline.ts";
import { publish } from "../publish.ts";
import { publishJob } from "../github.ts";
import { BRANCH, bundle, bytes32ToCommit, commitToBytes32, existingRepository, has, onBranch, openRepository, putOnMain, shortCommit, type Repository } from "../repo.ts";
import { moneyMove } from "../runner.ts";
import { bundlePath, jobPath } from "../routes.ts";
import { SEATS } from "../seal.ts";
import type { Registries } from "../registry.ts";
import { readableToTheBox } from "../sandbox.ts";
import type { SignedReceipt } from "../receipt.ts";
import { isPublished, type JobRecord, type JobStore, type OnChain, type Tries } from "../store.ts";
import { mintPod, sealOfTitle, tokenOfJob } from "../token.ts";
import { RegistryAnswers } from "./RegistryAnswers.ts";
import type { PreparingStore } from "../preparing/PreparingStore.ts";
import type { BoxSlots } from "../docker/index.ts";
import { openJob } from "../publish.ts";
import { sealSpec } from "../job.ts";
import { specFromTheWire, SpecOnTheWireSchema } from "../specWire.ts";

/** How many jobs are graded at once. Grading is Docker boxes, and a machine has only so many to give */
export const GRADED_AT_ONCE = 2;
/** How often the worker looks at every job */
export const LOOK_EVERY_MS = 10_000;
/** How long a job whose grading failed is left before it is graded again: Docker, the chain and the disk have bad moments */
export const GRADE_AGAIN_AFTER_MS = 5 * 60_000;
/**
 * How long the work has to start answering when it is graded for a verdict: generous, since work that
 * never starts fails every check, and our own load must never be what cost a pod its deposits
 */
export const GRADING_START_SECONDS = 180;
/** How many gradings in a row may fail on our side before a locked job is let go */
export const FAILED_TRIES_BEFORE_RELEASE = 3;

export interface WorkerOptions {
  readonly store: JobStore;
  /** where each job's repository is: the same folder the git door serves */
  readonly repositories: string;
  /** the jobs contract, with the validator's wallet: the only key it takes a verdict from */
  readonly jobs: Contract;
  /**
   * The contract that prepares jobs before a pod can start, with the same wallet. Its jobs settle with
   * the verdict's report, are let go once when the worker holds them or cannot grade them, and are
   * closed when their window ends with no verdict. Left out, only the first contract is worked.
   */
  readonly prepared?: Contract;
  /** how long after a grading started a release may be sent: a full grading's time unless said */
  readonly releaseAfterMs?: number;
  /**
   * The server's jobs being prepared, read and never written: a job whose poster approved its checks on
   * the chain is put on the wall from the set they approved, whether or not their page is still open.
   */
  readonly preparing?: PreparingStore;
  /** the limit on box work shared with the server's writing, kept on disk; left out, no shared limit */
  readonly boxes?: BoxSlots;
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
        ...(options.prepared ? { prepared: options.prepared } : {}),
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
    await this.publishApproved();
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
    const { store } = this.options;
    const record = await store.read(jobId);
    const on = record?.chain ? this.contractOf(record.chain.jobs) : undefined;
    if (!record?.chain || !on) return;
    if (this.grading.has(jobId) || this.isFinished(record)) return;
    const { contract: jobs, isPreparedFirst } = on;
    const onChainId = BigInt(record.chain.jobId);
    const onChain = await readJob(jobs, onChainId);

    // its money went back to its poster before there was any verdict: the job is closed, written down once
    if (onChain.state === "refunded" && record.tile.verdict === "running") {
      const why = isPreparedFirst
        ? "its money went back to its poster before any verdict"
        : "its poster took the money back before any verdict";
      await store.save({ ...record, tile: { ...record.tile, verdict: "withdrawn", finishedAt: new Date().toISOString() }, endedBecause: record.endedBecause ?? why });
      this.say(`${jobId}: ${why}, so it is closed`);
      return;
    }

    // a verdict whose money has moved without this worker recording it, such as a job matched to the
    // chain after the fact: written down once, since the publishing rule waits on it
    if ((onChain.state === "settled" || onChain.state === "refunded") && record.tile.verdict !== "running" && !isPublished(record)) {
      await this.remember(record.jobId, { moneyMovedAt: new Date().toISOString() });
      this.say(`${jobId}: its money has moved on the chain, so its verdict is public`);
    }

    // a window that ended with nobody's money moved: anybody may close it, and the worker is always here
    if (isPreparedFirst && (await this.closeIfOver(record, jobs, onChainId, onChain))) return;

    const signed = record.signed;
    if (signed && record.tile.verdict !== "running") {
      const graded = signed.receipt;
      if (onChain.state === "working" && onChain.commit !== zeroHash && bytes32ToCommit(onChain.commit) === graded.commit) {
        // runs that disagreed: on the contract that prepares jobs, the job is let go once
        if (isPreparedFirst && graded.verdict === "not-reproducible") {
          await this.releaseHeld(record, jobs, onChainId);
          return;
        }
        // the contract settles nothing after the window, so a verdict that came too late is said, not sent
        if ((await this.now()) >= onChain.endsAt) {
          const why = "the verdict came after the job's window closed, and the contract settles nothing after it: the poster takes the money back";
          if (record.waitingBecause !== why) await store.save({ ...record, waitingBecause: why });
          return;
        }
        await this.settle(record.jobId, signed, onChainId, on);
        // and straight on to the title and main for work that passed, rather than a look later: a
        // worker stopped between the two would leave a paid job with no title until it started again
        if (graded.verdict === "passed" && (await readJob(jobs, onChainId)).state === "settled") {
          await this.titleAndMain((await store.read(jobId)) ?? record, signed, onChainId, jobs);
        }
        return;
      }
      if (onChain.state === "settled" && graded.verdict === "passed") {
        await this.titleAndMain(record, signed, onChainId, jobs);
        return;
      }
      // a verdict that did not settle (the runs disagreed) leaves the job to the pod: if it approves
      // another commit, that one is graded; otherwise the poster takes the money back at the deadline
      if (onChain.state !== "working" || onChain.commit === zeroHash || bytes32ToCommit(onChain.commit) === graded.commit) return;
    }

    const ready = await this.readyToGrade(onChain, onChainId, jobs);
    if (!ready) return;
    const notOnTheLeadsBranch = await this.whyNotGradable(jobId, onChainId, ready, jobs);
    if (notOnTheLeadsBranch) {
      if (record.waitingBecause !== notOnTheLeadsBranch) await store.save({ ...record, waitingBecause: notOnTheLeadsBranch });
      return;
    }
    const failed = this.failedAt.get(jobId);
    if (failed !== undefined && Date.now() - failed < (this.options.gradeAgainAfterMs ?? GRADE_AGAIN_AFTER_MS)) return;
    if (this.grading.size >= (this.options.gradedAtOnce ?? GRADED_AT_ONCE)) return;
    const work = this.grade(record, onChainId, ready, jobs)
      .then(() => { this.failedAt.delete(jobId); })
      // a grading that failed is said, and tried again later: it never takes the worker down with it
      .catch(async (error: unknown) => {
        this.failedAt.set(jobId, Date.now());
        this.say(`${jobId}: the grading failed, and is tried again later: ${firstLine(error)}`);
        if (isPreparedFirst) await this.failedTry(jobId, jobs, onChainId, error);
      })
      .catch((error: unknown) => this.say(`${jobId}: a failed grading could not be written down: ${firstLine(error)}`))
      .finally(() => this.grading.delete(jobId));
    this.grading.set(jobId, work);
  }

  /**
   * Why an approved commit cannot be graded, or nothing if it can. It has to be in the repository and
   * on the lead's branch: the lead names the candidate, and a commit that no branch holds was never
   * checked by the git door's rules, whoever it says wrote it.
   */
  private async whyNotGradable(jobId: string, onChainId: bigint, commit: string, jobs: Contract): Promise<string | undefined> {
    const repo = await openRepository(this.options.repositories, jobId);
    if (!(await has(repo, commit))) return `the pod approved ${commit}, which was never pushed to the job's repository, so there is nothing to grade`;
    const lead = (await readSeats(jobs, onChainId)).find((seat) => seat.role === "lead");
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
    if (record.tile.verdict === "withdrawn") return true;
    if (!(record.chain?.settled || record.chain?.moneyMovedAt) || !record.signed) return false;
    if (record.signed.receipt.verdict !== "passed") return true;
    const titled = !this.options.token || record.chain.tokenId !== undefined;
    const published = !this.options.publishTo || record.opensOnMain === true;
    return titled && published;
  }

  private async now(): Promise<bigint> {
    return (await this.options.jobs.publicClient.getBlock()).timestamp;
  }

  /** The commit to grade, if the chain says the pod is done with one and there is still time to settle it. */
  private async readyToGrade(onChain: OnChainJob, onChainId: bigint, jobs: Contract): Promise<string | undefined> {
    if (onChain.state !== "working" || onChain.commit === zeroHash) return undefined;
    // the contract refuses a settlement after the window, so a verdict then would change nothing
    if ((await this.now()) >= onChain.endsAt) return undefined;
    if (!(await policyMet(jobs, onChainId, onChain.commit))) return undefined;
    return bytes32ToCommit(onChain.commit);
  }

  private async grade(record: JobRecord, onChainId: bigint, commit: string, jobs: Contract): Promise<void> {
    const { store } = this.options;
    const spec = await store.spec(record.jobId);
    if (!spec) {
      await store.save({ ...record, waitingBecause: "the spec this job was sealed under is not kept here, so it cannot be graded" });
      return;
    }
    this.say(`${record.jobId}: grading ${shortCommit(commit)}`);
    // when it started, kept with the job: a release waits a full grading's time after it
    await this.rememberTries(record.jobId, { startedAt: new Date().toISOString() });
    const repo = await openRepository(this.options.repositories, record.jobId);
    const fetchFrom = await this.whereAnybodyFetches(record, repo, onChainId, jobs);
    const checks = await mkdtemp(join(tmpdir(), "pod-worker-checks-"));
    try {
      for (const [name, contents] of Object.entries(await store.allCheckFiles(record.jobId))) await writeFile(join(checks, name), contents);
      await readableToTheBox(checks);
      const grading = (): ReturnType<typeof gradeCommit> => gradeCommit({
        repo, repository: fetchFrom.url,
        commit, seal: record.seal, start: START, checks,
        toRun: spec.checks.map((check) => ({ says: check.says, command: check.run, hidden: check.hidden })),
        image: this.options.image,
        allowedHosts: spec.allowed.map((allowed) => allowed.host),
        startSeconds: GRADING_START_SECONDS,
        runner: this.runner, runnerKey: this.options.runnerKey,
        ...(this.options.times === undefined ? {} : { times: this.options.times }),
      });
      const report = this.options.boxes ? await this.options.boxes.inASlot(grading) : await grading();

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
        ...(fetchFrom.onGitHub ? { repository: fetchFrom.url } : record.repository ? { repository: record.repository } : {}),
        ...(record.podHolder ? { podHolder: record.podHolder } : {}),
      });
      // what the chain already knows about the job, who paid for it, and its brief, whose window decides
      // when a held verdict is published, stay with it: the grading knows none of them
      // and the worker's tries, read fresh: this grading started one, and it did not fail on our side
      const tries = (await store.read(record.jobId))?.tries;
      await store.save({
        ...published, chain: record.chain,
        ...(record.poster ? { poster: record.poster } : {}),
        ...(record.brief ? { brief: record.brief } : {}),
        ...(tries ? { tries: { ...tries, failed: 0 } } : {}),
      });
      this.say(`${record.jobId}: ${report.signed.receipt.verdict}`);
    } finally {
      await rm(checks, { recursive: true, force: true });
    }
  }

  /**
   * Move the money the way the verdict says, once. A held verdict moves nothing. On the contract that
   * prepares jobs the verdict says more: whether only a hidden check failed, or one the pod could see,
   * which is what costs the seats that approved; and it carries the receipt's fingerprint.
   */
  private async settle(jobId: string, signed: SignedReceipt, onChainId: bigint, on: { readonly contract: Contract; readonly isPreparedFirst: boolean }): Promise<void> {
    const move = moneyMove(signed.receipt.verdict);
    if (move === "hold") return;
    const commit = commitToBytes32(signed.receipt.commit);
    const hash = await this.onTheChain(async () => {
      // read again inside the queue: another look may have settled it while this one waited, or the
      // pod moved to another commit, which a refund would otherwise take no notice of
      const now = await readJob(on.contract, onChainId);
      if (now.state !== "working" || now.commit.toLowerCase() !== commit.toLowerCase()) return undefined;
      return on.isPreparedFirst
        ? settleV2(on.contract, onChainId, commit, verdictOnChain(signed), signed.hash)
        : settle(on.contract, onChainId, commit, move === "pay");
    });
    if (!hash) return;
    await this.remember(jobId, { settled: hash });
    this.say(`${jobId}: settled, ${move === "pay" ? "the pod is paid" : "the poster is refunded"}`);
  }

  /**
   * On a job that passed and settled: the work on the main branch, then the title to whoever paid.
   * Main first: once the title is written down the job is finished and not looked at again.
   */
  private async titleAndMain(record: JobRecord, signed: SignedReceipt, onChainId: bigint, jobs: Contract): Promise<void> {
    const { token } = this.options;
    const commit = signed.receipt.commit;
    // a job graded before this server kept its repositories has its work somewhere else: it is said
    // once and left alone, rather than tried again on every look against an empty repository
    const repo = await existingRepository(this.options.repositories, record.jobId);
    if (!repo || !(await has(repo, commit))) {
      const why = `the work that passed, ${shortCommit(commit)}, is not in this server's copy of the job's repository, so it is neither put on main nor published from here`;
      if (record.waitingBecause !== why) await this.options.store.save({ ...record, waitingBecause: why });
      return;
    }
    await putOnMain(repo, commit);
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
      // a title is this job's only under this job's seal: another job numbered the same, on an earlier
      // contract, could hold one already, and it is not this job's to record
      if ((await sealOfTitle(token, tokenId)).toLowerCase() !== record.seal.toLowerCase()) {
        const why = `title #${tokenId} is for job ${onChainId} under another seal, so it is not this job's: nothing is recorded`;
        if (record.waitingBecause !== why) await this.options.store.save({ ...((await this.options.store.read(record.jobId)) ?? record), waitingBecause: why });
        this.say(`${record.jobId}: ${why}`);
        return;
      }
      await this.remember(record.jobId, { ...(minted ? { minted } : {}), tokenId: tokenId.toString() });
      if (minted) this.say(`${record.jobId}: POD #${tokenId} minted to whoever paid`);
    }
    // last, and apart from the money and the title: GitHub having a bad moment holds up neither, and
    // publishing is tried again on the next look until it is done
    if (this.options.publishTo && record.repository === undefined) await this.publish(record.jobId, record.tile.idea, this.options.publishTo.owner);
  }

  /** The job's whole repository on GitHub, opening on the work that passed, and where it is kept on the record. */
  private async publish(jobId: string, idea: string, owner: string): Promise<void> {
    const published = await publishJob(await openRepository(this.options.repositories, jobId), owner, jobId, idea, BRANCH);
    const record = await this.options.store.read(jobId);
    if (record) await this.options.store.save({ ...record, repository: published.url, opensOnMain: true });
    this.say(`${jobId}: published at ${published.url}, opening on the work that passed`);
  }

  /**
   * Where anybody can fetch the work being graded, which is what the receipt names: a verdict nobody
   * can clone is a verdict nobody can check. The job's whole history is kept on this server as one
   * file, and published on GitHub too when the server names an owner, before anything is signed; the
   * receipt names GitHub when that worked, and this server's copy when it did not, so GitHub having a
   * bad moment never holds up a verdict. Failed work is published as well: both outcomes are evidence.
   */
  private async whereAnybodyFetches(record: JobRecord, repo: Repository, onChainId: bigint, jobs: Contract): Promise<{ readonly url: string; readonly onGitHub: boolean }> {
    await bundle(repo, this.options.store.historyFileOf(record.jobId));
    const onThisServer = { url: `${this.options.site ?? ""}${bundlePath(record.jobId)}`, onGitHub: false };
    const owner = this.options.publishTo?.owner;
    if (!owner) return onThisServer;
    const lead = (await readSeats(jobs, onChainId)).find((seat) => seat.role === "lead");
    if (!lead) return onThisServer;
    try {
      // it opens on the lead's branch, where the candidate is, until work that passed is on main
      const published = await publishJob(repo, owner, record.jobId, record.tile.idea, branchFor("lead", lead.agent));
      return { url: published.url, onGitHub: true };
    } catch (error) {
      this.say(`${record.jobId}: could not publish before grading, so the receipt names this server's copy: ${firstLine(error)}`);
      return onThisServer;
    }
  }

  /** Every job being prepared whose poster has approved its checks, put on the wall. */
  private async publishApproved(): Promise<void> {
    const { preparing, prepared } = this.options;
    if (!preparing || !prepared) return;
    for (const onChainId of await preparing.all()) {
      try {
        await this.publishIfApproved(onChainId, preparing, prepared);
      } catch (error) {
        this.say(`job ${onChainId}: could not be put on the wall, and is tried on the next look: ${firstLine(error)}`);
      }
    }
  }

  /**
   * Put a job on the wall once the chain shows its poster approved a set: the set whose seal is the one
   * the contract fixed, which the writer signed, with its checks. Done once; done again, nothing changes.
   */
  private async publishIfApproved(onChainId: string, preparing: PreparingStore, prepared: Contract): Promise<void> {
    const { store } = this.options;
    const setUp = await preparing.readSetUp(onChainId);
    if (!setUp || !isAddressEqual(setUp.jobs, prepared.address)) return;
    const onTheWall = await store.read(setUp.name);
    if (onTheWall?.chain?.jobId === onChainId && isAddressEqual(onTheWall.chain.jobs, prepared.address)) return;

    const job = await readJob(prepared, BigInt(onChainId));
    // still preparing, taken back before any set was approved, or taken back or closed after approval
    // before it was ever published: nothing to put on the wall
    if (job.state === "preparing" || job.state === "refunded" || job.seal === zeroHash) return;
    if (onTheWall) {
      this.say(`job ${onChainId}: approved as ${setUp.name}, which another job on the wall already has; it is not put there`);
      return;
    }
    const approved = (await preparing.writings(onChainId))
      .flatMap((writing) => (writing.outcome.kind === "written" && writing.outcome.approval ? [writing.outcome.approval] : []))
      .find((approval) => approval.seal.toLowerCase() === job.seal.toLowerCase());
    if (!approved) {
      this.say(`job ${onChainId}: its poster approved a seal this server holds no set for, so it is not put on the wall`);
      return;
    }
    const spec = specFromTheWire(SpecOnTheWireSchema.parse(approved.spec));
    if ((await sealSpec(spec)).toLowerCase() !== job.seal.toLowerCase()) {
      this.say(`job ${onChainId}: the set kept for its seal does not seal to it, so it is not put on the wall`);
      return;
    }
    const opened = await openJob(store, {
      jobId: setUp.name, seal: job.seal, spec, endsAt: new Date(Number(job.endsAt) * 1000),
      seats: SEATS.map((role) => ({ role })),
    });
    await store.save({ ...opened, chain: { network: "monad-testnet", jobId: onChainId, jobs: prepared.address }, poster: setUp.poster }, approved.files);
    await store.saveSpec(setUp.name, spec);
    this.say(`${setUp.name}: its poster approved its checks, so it is on the wall and open to a pod`);
  }

  /** Which contract a job is on, if it is one this worker works. */
  private contractOf(address: Address): { readonly contract: Contract; readonly isPreparedFirst: boolean } | undefined {
    const { jobs, prepared } = this.options;
    if (isAddressEqual(address, jobs.address)) return { contract: jobs, isPreparedFirst: false };
    if (prepared && isAddressEqual(address, prepared.address)) return { contract: prepared, isPreparedFirst: true };
    return undefined;
  }

  /**
   * Close a job whose window has ended with nobody's money moved: the poster's money and every deposit
   * go home, since nothing was judged. True when the job is over, whoever closed it.
   */
  private async closeIfOver(record: JobRecord, jobs: Contract, onChainId: bigint, onChain: OnChainJob): Promise<boolean> {
    const chain = record.chain;
    if (!chain || (onChain.state !== "open" && onChain.state !== "working") || (await this.now()) < onChain.endsAt) return false;
    const hash = await this.onTheChain(async () => {
      const now = await readJob(jobs, onChainId);
      if (now.state !== "open" && now.state !== "working") return undefined;
      return closeJob(jobs, onChainId);
    });
    const why = record.tile.verdict === "not-reproducible"
      ? "its runs disagreed, and its window closed with no verdict: the poster's money and every deposit went home"
      : "its window closed with no verdict: the poster's money and every deposit went home";
    const fresh = (await this.options.store.read(record.jobId)) ?? record;
    await this.options.store.save({
      ...fresh, endedBecause: why,
      tile: fresh.tile.verdict === "running" ? { ...fresh.tile, verdict: "withdrawn", finishedAt: new Date().toISOString() } : fresh.tile,
      chain: { ...chain, moneyMovedAt: new Date().toISOString() },
    });
    this.say(`${record.jobId}: ${hash ? "closed: " : ""}${why}`);
    return true;
  }

  /**
   * Runs that disagreed, on the contract that prepares jobs: the job is let go once, so the pod may
   * approve a commit again, the same one or a fixed one, and it is graded afresh. A second hold stands
   * until the window closes. The release waits a full grading's time after the grading started, so
   * when it comes says nothing about how the work behaved; the held receipt is kept aside.
   */
  private async releaseHeld(record: JobRecord, jobs: Contract, onChainId: bigint): Promise<void> {
    const signed = record.signed;
    if (!signed) return;
    if (record.tries?.released) {
      const why = "its runs disagreed again after it was let go once, so the hold stands until the window closes";
      if (record.waitingBecause !== why) await this.options.store.save({ ...record, waitingBecause: why });
      return;
    }
    const released = await this.release(record, jobs, onChainId, "its runs disagreed");
    if (!released) return;
    const fresh = (await this.options.store.read(record.jobId)) ?? record;
    const { signed: _held, waitingBecause: _why, ...rest } = fresh;
    await this.options.store.save({
      ...rest,
      tile: { ...fresh.tile, verdict: "running" },
      tries: { ...released, heldBefore: [...(fresh.tries?.heldBefore ?? []), signed] },
    });
  }

  /**
   * A grading that failed on our side, on the contract that prepares jobs. Counted with the job, so a
   * restart remembers; after a few in a row a locked job is let go once, so the pod is not held for
   * our trouble. After that one release, it is tried again until the window closes.
   */
  private async failedTry(jobId: string, jobs: Contract, onChainId: bigint, error: unknown): Promise<void> {
    const record = await this.options.store.read(jobId);
    if (!record) return;
    const failed = (record.tries?.failed ?? 0) + 1;
    await this.rememberTries(jobId, { failed });
    if (failed < FAILED_TRIES_BEFORE_RELEASE || record.tries?.released) return;
    const released = await this.release({ ...record, tries: { ...record.tries, failed } }, jobs, onChainId, `${failed} gradings in a row failed on our side: ${firstLine(error)}`);
    if (released) await this.rememberTries(jobId, released);
  }

  /** Send the one release, if it is due and the job is still locked; what the tries become once it is sent. */
  private async release(record: JobRecord, jobs: Contract, onChainId: bigint, why: string): Promise<Tries | undefined> {
    if (!(await this.isReleaseDue(record))) return undefined;
    const hash = await this.onTheChain(async () => (await isLocked(jobs, onChainId)) ? releaseLock(jobs, onChainId) : undefined);
    if (!hash) return undefined;
    this.say(`${record.jobId}: let go once, since ${why}; the pod may approve again`);
    return { failed: 0, released: { at: new Date().toISOString(), why }, ...(record.tries?.heldBefore ? { heldBefore: record.tries.heldBefore } : {}) };
  }

  private async isReleaseDue(record: JobRecord): Promise<boolean> {
    const startedAt = record.tries?.startedAt;
    if (!startedAt) return true;
    const spec = await this.options.store.spec(record.jobId);
    const fullGrading = this.options.releaseAfterMs
      ?? (this.options.times ?? 3) * longestRunSeconds(spec?.checks.length ?? 0, GRADING_START_SECONDS) * 1000;
    return Date.now() >= new Date(startedAt).getTime() + fullGrading;
  }

  /** Keep the worker's tries with the job, read fresh so nothing written meanwhile is lost. */
  private async rememberTries(jobId: string, tries: Partial<Tries>): Promise<void> {
    const record = await this.options.store.read(jobId);
    if (!record) return;
    await this.options.store.save({ ...record, tries: { failed: 0, ...record.tries, ...tries } });
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

/**
 * The verdict as the contract that prepares jobs takes it: a failure says whether a check the pod could
 * see failed, which is what costs the seats that approved, or only a hidden one.
 */
function verdictOnChain(signed: SignedReceipt): VerdictOnChain {
  if (signed.receipt.verdict === "passed") return "passed";
  return signed.receipt.checks.some((check) => !check.hidden && check.exitCode !== 0) ? "visible-failed" : "hidden-failed";
}

/** A time the chain gave in seconds, as the job page writes it. */
function isoOf(seconds: bigint): string {
  return new Date(Number(seconds) * 1000).toISOString();
}
