/**
 * The worker: what turns a pod's approvals into a verdict, a settlement, a POD and a main branch.
 *
 * Nobody asks it to. It looks at every job on this contract and, whenever the chain says every seat
 * the policy asks for has approved one commit, it grades that commit in the sealed box, publishes the
 * evidence, settles on the contract, mints the title to whoever paid, and puts the work on the main
 * branch. Then, for every agent that asks, it records the verdict on its seat in ERC-8004 (see
 * RegistryAnswers.ts). So no party has to be trusted to press a button, and no pod can stall a job by never asking.
 *
 * On the contract where the poster has the last word it settles nothing. It reports what the checks
 * found, which moves no money, and the job waits for its poster. If they say nothing in their time,
 * it settles the job as the checks found, which anybody may do; and whichever way the job ends, it
 * writes that down, and mints the title and publishes the work when the pod was paid.
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
import { secondsNow } from "../clock.ts";
import { questionsOn } from "../door/QuestionBoard.ts";
import { branchFor } from "../door/seat.ts";
import { firstLine } from "../errors.ts";
import { SITE_FOLDER, SITE_FRONT_PAGE, startFor } from "../job.ts";
import { NotAWebsite, siteFilesIn, siteMadeFor, siteNameFor, type SiteHost } from "../hosting/index.ts";
import { policyMet, readApprovals, readJob, readSeats, readSeatsTaken, settle, type Contract, type HeldSeat, type OnChainJob } from "../jobs.ts";
import { closeJob, isLocked, releaseLock, settleV2, type VerdictOnChain } from "../jobsV2.ts";
import { readAnswerBy, readHowItEnded, readReviewBy, readTheAnswersTransaction, readWhenPutForward, report, settleUnanswered } from "../jobsV3.ts";
import { MOST_BLOCKS_A_LOG_READ_COVERS, MOST_BLOCKS_LOOKED_BACK_FOR_APPROVALS } from "../jobs.ts";
import { longestRunSeconds } from "../blackbox.ts";
import { pause } from "../pause.ts";
import { gradeCommit } from "../pipeline.ts";
import { publish } from "../publish.ts";
import { publishJob } from "../github.ts";
import { BRANCH, bundle, bytes32ToCommit, checkout, commitToBytes32, existingRepository, has, onBranch, openRepository, putOnMain, shortCommit, type Repository } from "../repo.ts";
import { moneyMove } from "../runner.ts";
import { bundlePath, jobPath } from "../routes.ts";
import { SEATS } from "../seal.ts";
import type { Registries } from "../registry.ts";
import { readableToTheBox } from "../sandbox.ts";
import type { SignedReceipt } from "../receipt.ts";
import { isPublished, wasThePodPaid, type JobRecord, type JobStore, type OnChain, type Told, type Tries, type UnderReview } from "../store.ts";
import { mintPod, sealOfTitle, tokenOfJob } from "../token.ts";
import { deliveredMail, lastDayMail, questionsMail, type Mailer } from "../mail/index.ts";
import { isWaiting } from "../triage.ts";
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

/** How long before a poster's time runs out they are told once more that their answer is waited for. */
export const LAST_DAY_SECONDS = 24n * 60n * 60n;

/**
 * How long a question is left before its poster is written to about it: a seat asks its few questions
 * one after another, and one message with all of them is better than one for each.
 */
export const QUESTIONS_SETTLE_SECONDS = 2 * 60;

/** How long a message that could not be sent waits before it is tried again: doubled after each failure, up to the longest wait. */
export const MAIL_AGAIN_AFTER_MS = 5 * 60_000;
export const LONGEST_MAIL_WAIT_MS = 2 * 60 * 60_000;

/** The wait before the next try of a message that has failed this many times. */
export const mailWait = (failed: number, first: number = MAIL_AGAIN_AFTER_MS): number =>
  Math.min(first * 2 ** Math.max(failed - 1, 0), LONGEST_MAIL_WAIT_MS);

/**
 * Which message a poster is owed now, if any: that the job is delivered, as soon as it is; and that a
 * day is left, when one is and the first message went out before that day began. A poster given a day
 * or less to answer gets the one message.
 */
export function whatToTell(told: Told | undefined, answerBy: bigint, now: bigint): "delivered" | "lastDay" | undefined {
  if (!told?.delivered) return "delivered";
  if (told.lastDay) return undefined;
  const lastDayStarts = answerBy - LAST_DAY_SECONDS;
  const toldAt = BigInt(Math.floor(new Date(told.delivered).getTime() / 1000));
  return now >= lastDayStarts && toldAt < lastDayStarts ? "lastDay" : undefined;
}
/** How long a job whose grading failed is left before it is graded again: Docker, the chain and the disk have bad moments */
export const GRADE_AGAIN_AFTER_MS = 5 * 60_000;
/**
 * How long the work has to start answering when it is graded for a verdict: generous, since work that
 * never starts fails every check, and our own load must never be what cost a pod its deposits
 */
export const GRADING_START_SECONDS = 180;
/** How many gradings in a row may fail on our side before a locked job is let go */
export const FAILED_TRIES_BEFORE_RELEASE = 3;
/**
 * How far back the transaction that ended a delivered job is looked for, for the link on its page. A
 * worker that is running sees a job end within one look of it happening, so this is generous; one
 * that was stopped for longer writes down how the job ended, which the contract says, without the link
 */
export const MOST_BLOCKS_LOOKED_BACK_FOR_AN_ANSWER = 1_000n;
/**
 * How long a website that could not be put live, or taken down, is left before its host is asked
 * again, doubled each time it fails in a row and never more than the longest. A host counts what it
 * is asked: Netlify takes three deploys a minute and a hundred a day, for every job together, and a
 * job asked about on every look would spend the day's in a quarter of an hour
 */
export const HOST_AGAIN_AFTER_MS = 60_000;
export const HOST_AGAIN_AT_MOST_MS = 2 * 60 * 60_000;

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
  /**
   * Whether the poster has the last word on the contract that prepares jobs: the worker then reports
   * what the checks found and settles nothing, until the poster's time to answer has run out.
   */
  readonly hasTheLastWord?: boolean;
  /** a contract that prepared jobs before that one: its jobs are finished, and still answered for in ERC-8004 */
  readonly second?: Contract;
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
  /**
   * Where a delivered website is put live, at an address of its own, for its poster to open before
   * they answer. Left out, a website is delivered with its evidence and nowhere to open it.
   */
  readonly siteHost?: SiteHost;
  /**
   * How a poster who left an address is told their job was delivered. Left out, nobody is told: the
   * job's page and their own list of jobs are where they find out.
   */
  readonly mailer?: Mailer;
  /** how long a message that could not be sent waits before it is tried again */
  readonly mailAgainAfterMs?: number;
  /** how long a question is left before its poster is written to, so questions asked together go in one message; left out, the usual */
  readonly questionsSettleSeconds?: number;
  /** how long after a host first fails a job it is asked again: HOST_AGAIN_AFTER_MS unless said */
  readonly hostAgainAfterMs?: number;
  readonly say?: (what: string) => void;
}


/**
 * Whether a job that passed still has to be published, asked by what its repository opens on.
 *
 * Never by whether it has one: a job is published once before it is graded, so the receipt can name
 * somewhere anybody can clone it, and that copy opens on the lead's branch because no work has passed
 * yet. Asking for the address instead left every passing job on GitHub with no main at all, opening
 * on a seat's branch, which is the branch GitHub would have counted its contributions on.
 */
export const stillToPublish = (record: JobRecord): boolean => record.opensOnMain !== true;

export class Worker {
  private readonly grading = new Map<string, Promise<void>>();
  /** when each job's last grading failed, so a job that keeps failing is not graded again every look */
  private readonly failedAt = new Map<string, number>();
  /** messages that could not be sent, by job: how many times, and when last */
  private readonly mailTries = new Map<string, { readonly failed: number; readonly at: number }>();
  /** the messages this worker has sent, by job and kind, so none goes twice while it runs */
  private readonly mailed = new Set<string>();
  /** how often in a row each job's host has failed it, and when last, so a host that keeps failing is asked less and less */
  private readonly hostFailed = new Map<string, { readonly times: number; readonly at: number }>();
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
        ...(options.second ? { second: options.second } : {}),
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
    const kept = await store.read(jobId);
    const on = kept?.chain ? this.contractOf(kept.chain.jobs) : undefined;
    if (!kept?.chain || !on) return;
    if (this.grading.has(jobId) || this.isFinished(kept)) return;
    const { contract: jobs, isPreparedFirst, hasTheLastWord } = on;
    const onChainId = BigInt(kept.chain.jobId);
    const onChain = await readJob(jobs, onChainId);
    // who is seated and what is under review is for the job's page: a node that will not answer for
    // it is said, and never holds up closing a job, delivering it or grading it
    const record = await this.withWhereItStands(kept, jobs, onChainId, onChain, hasTheLastWord).catch((error: unknown) => {
      this.say(`${jobId}: who is on it could not be read just now, and is asked again on the next look: ${firstLine(error)}`);
      return kept;
    });

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

    // a pod's questions to its poster, while it builds: said and never waited on
    if (onChain.state === "open" || onChain.state === "working") {
      await this.tellOfQuestions(record).catch((error: unknown) => this.say(`${jobId}: its pod's questions could not be looked at just now: ${firstLine(error)}`));
    }

    // a window that ended with nobody's money moved: anybody may close it, and the worker is always here
    if (isPreparedFirst && (await this.closeIfOver(record, jobs, onChainId, onChain))) return;

    // delivered, where the poster has the last word: the job waits for them, and is written down when it ends
    if (hasTheLastWord && (await this.whileDelivered(record, jobs, onChainId, onChain))) return;

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
        if (hasTheLastWord) {
          await this.report(record.jobId, signed, onChainId, jobs);
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
      // settled is the pod paid in full: by a pass, or, where the poster has the last word, by their yes
      if (onChain.state === "settled" && (graded.verdict === "passed" || hasTheLastWord)) {
        await this.titleAndMain((await store.read(jobId)) ?? record, signed, onChainId, jobs);
        return;
      }
      // a verdict that did not settle (the runs disagreed) leaves the job to the pod: if it approves
      // another commit, that one is graded; otherwise the poster takes the money back at the deadline
      if (onChain.state !== "working" || onChain.commit === zeroHash || bytes32ToCommit(onChain.commit) === graded.commit) return;
    }

    // where the poster has the last word, no seat can hold work back either: its builder puts it forward
    const isPutForward = hasTheLastWord;
    const ready = await this.readyToGrade(onChain, onChainId, jobs, isPutForward);
    if (!ready) return;
    const notGradable = await this.whyNotGradable(jobId, onChainId, ready, jobs, isPutForward);
    if (notGradable) {
      if (record.waitingBecause !== notGradable) await store.save({ ...record, waitingBecause: notGradable });
      return;
    }
    const failed = this.failedAt.get(jobId);
    if (failed !== undefined && Date.now() - failed < (this.options.gradeAgainAfterMs ?? GRADE_AGAIN_AFTER_MS)) return;
    if (this.grading.size >= (this.options.gradedAtOnce ?? GRADED_AT_ONCE)) return;
    const work = this.grade(record, onChainId, ready, jobs, isPutForward)
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
   * Tell a poster who left an address what their pod has asked them, once for each question, with the
   * questions asked close together in one message. Only questions still waiting on them are told: one
   * already answered on the page, or whose day has passed, needs nothing from them. A send that fails
   * is tried again as a delivery's is, and no job waits on it: a poster who is never reached is the
   * case the questions' own assumptions are for.
   */
  private async tellOfQuestions(record: JobRecord): Promise<void> {
    const { mailer, preparing, site, store } = this.options;
    if (!mailer || !preparing || !site || !record.chain) return;
    const now = secondsNow();
    const toldAlready = new Set((record.told?.questions ?? []).map((id) => id.toLowerCase()));
    const untold = (await questionsOn(store, record))
      .filter((question) => isWaiting(question, now) && !toldAlready.has(question.id.toLowerCase()) && !this.mailed.has(`${record.jobId}:${question.id.toLowerCase()}`));
    if (untold.length === 0 || untold.some((question) => now - question.askedAt < (this.options.questionsSettleSeconds ?? QUESTIONS_SETTLE_SECONDS))) return;
    const trying = `${record.jobId}:questions`;
    const tried = this.mailTries.get(trying);
    if (tried && Date.now() - tried.at < mailWait(tried.failed, this.options.mailAgainAfterMs ?? MAIL_AGAIN_AFTER_MS)) return;
    // by its name as well as its number: a number alone is shared with the contracts before this one
    const setUp = await preparing.readSetUp(record.chain.jobId);
    const to = setUp?.name === record.jobId ? setUp.tell : undefined;
    if (!to) return;
    try {
      await mailer.send({ to, ...questionsMail({
        idea: record.tile.idea, page: new URL(`${jobPath(record.jobId)}#questions`, site).toString(),
        questions: untold.map((question) => ({ asks: question.asks, assumes: question.assumes, answerBy: new Date(question.answerBy * 1000) })),
      }) });
    } catch (error) {
      this.mailTries.set(trying, { failed: (tried?.failed ?? 0) + 1, at: Date.now() });
      if (!tried) this.say(`${record.jobId}: its poster could not be told by mail of its pod's questions, and is tried again: ${firstLine(error).replaceAll(to, "their address")}`);
      return;
    }
    for (const question of untold) this.mailed.add(`${record.jobId}:${question.id.toLowerCase()}`);
    this.mailTries.delete(trying);
    const fresh = (await store.read(record.jobId)) ?? record;
    await store.save({ ...fresh, told: { ...fresh.told, questions: [...(fresh.told?.questions ?? []), ...untold.map((question) => question.id)] } });
    this.say(`${record.jobId}: its poster was told by mail of ${untold.length === 1 ? "a question its pod asked" : `${untold.length} questions its pod asked`}`);
  }

  /**
   * Tell a poster who left an address that their job was delivered, and once more when a day of their
   * time to answer is left. Each message is sent once and written down with the job. A send that
   * fails is said once and tried again after a wait that doubles, for as long as their time runs:
   * a mail service having a bad hour must not cost a poster the message. Mail is a kindness all the
   * same, and no delivery waits on it.
   *
   * A message is sent before it is written down, so a worker stopped between the two sends it again
   * when it starts: twice is the lesser fault than never. Within one worker a sent message is
   * remembered at once, so a record that cannot be saved does not send it on every look.
   */
  private async tellItsPoster(record: JobRecord, answerBy: bigint): Promise<void> {
    const { mailer, preparing, site, store } = this.options;
    if (!mailer || !preparing || !site || !record.chain || !record.signed) return;
    const which = whatToTell(record.told, answerBy, await this.now());
    if (!which || this.mailed.has(`${record.jobId}:${which}`)) return;
    const tried = this.mailTries.get(record.jobId);
    if (tried && Date.now() - tried.at < mailWait(tried.failed, this.options.mailAgainAfterMs ?? MAIL_AGAIN_AFTER_MS)) return;
    const to = (await preparing.readSetUp(record.chain.jobId))?.tell;
    if (!to) return;
    const ran = record.signed.receipt.checks;
    const delivery = {
      idea: record.tile.idea, checksPassed: record.signed.receipt.verdict === "passed",
      answerBy: new Date(Number(answerBy) * 1000), page: new URL(jobPath(record.jobId), site).toString(),
      checks: { passed: ran.filter((check) => check.exitCode === 0).length, of: ran.length },
      ...(record.live && record.live.removedAt === undefined ? { live: record.live.url } : {}),
    };
    try {
      await mailer.send({ to, ...(which === "delivered" ? deliveredMail(delivery) : lastDayMail(delivery)) });
    } catch (error) {
      this.mailTries.set(record.jobId, { failed: (tried?.failed ?? 0) + 1, at: Date.now() });
      // why is the mail service's own word: should it ever repeat the address, the address is taken out of it
      if (!tried) this.say(`${record.jobId}: its poster could not be told by mail, and is tried again: ${firstLine(error).replaceAll(to, "their address")}`);
      return;
    }
    this.mailed.add(`${record.jobId}:${which}`);
    this.mailTries.delete(record.jobId);
    await store.save({ ...((await store.read(record.jobId)) ?? record), told: { ...record.told, [which]: new Date().toISOString() } });
    this.say(which === "delivered"
      ? `${record.jobId}: its poster was told by mail that it is delivered`
      : `${record.jobId}: its poster was told by mail that a day is left to answer`);
  }

  /**
   * The job with whoever has sat down so far and, where a builder puts its own work forward, the work
   * under review: both as the contract has them. Its page, the wall and its agents' pages read these
   * from the record, so without this a job being built would read as one nobody took until its work
   * was graded. Seats are only ever added, so how many there are says whether there is anybody new;
   * who stands behind work under review can change on any look, so that is read while a review runs.
   */
  private async withWhereItStands(record: JobRecord, jobs: Contract, onChainId: bigint, onChain: OnChainJob, isPutForward: boolean): Promise<JobRecord> {
    if (record.tile.verdict !== "running") return record;
    const isUnderReview = isPutForward && onChain.state === "working" && onChain.commit !== zeroHash;
    // with no review to follow, how many seats are taken is all there is to ask, and it costs half as much
    if (!isUnderReview && !record.review && (await readSeatsTaken(jobs, onChainId)) === record.tile.pod.length) return record;
    const seats = await readSeats(jobs, onChainId);
    const isSeatedAsKept = seats.length === record.tile.pod.length;
    const review = isUnderReview ? await this.reviewOf(record, seats, jobs, onChainId, onChain.commit) : undefined;
    if (isSeatedAsKept && JSON.stringify(review) === JSON.stringify(record.review)) return record;
    // written over the record as it is now, not as it was before the chain was asked: a seat that named
    // its identity in the meantime keeps what it said
    const { review: _before, ...rest } = (await this.options.store.read(record.jobId)) ?? record;
    const pod = seats.map((seat) => ({ role: seat.role, agent: seat.agent, owner: seat.owner }));
    const standing = { ...rest, tile: { ...rest.tile, pod }, ...(review ? { review } : {}) };
    await this.options.store.save(standing);
    if (!isSeatedAsKept) this.say(`${record.jobId}: seated so far: ${pod.map((seat) => seat.role).join(", ")}`);
    return standing;
  }

  /** The work a builder put forward, with when its review runs out and who stands behind it so far. */
  private async reviewOf(record: JobRecord, seats: readonly HeldSeat[], jobs: Contract, onChainId: bigint, named: Hex): Promise<UnderReview | undefined> {
    const reviewBy = await readReviewBy(jobs, onChainId);
    if (reviewBy === undefined) return undefined;
    const commit = bytes32ToCommit(named);
    // when it was put forward does not change, so it is read from the chain's events once for a commit
    const putForwardAt = record.review?.commit === commit
      ? record.review.putForwardAt
      : await this.whenPutForward(jobs, onChainId, named);
    return {
      commit, reviewBy: isoOf(reviewBy), ...(putForwardAt ? { putForwardAt } : {}),
      behind: SEATS.filter((role) => seats.some((seat) => seat.role === role && seat.approved)),
    };
  }

  private async whenPutForward(jobs: Contract, onChainId: bigint, named: Hex): Promise<string | undefined> {
    const when = await readWhenPutForward(jobs, onChainId, named, MOST_BLOCKS_LOOKED_BACK_FOR_APPROVALS);
    return when ? isoOf(when.at) : undefined;
  }

  /**
   * Why the commit the chain names cannot be graded, or nothing if it can. It has to be in the
   * repository, on the branch of the seat that named it: a commit that branch does not hold was never
   * checked by the git door's rules, whoever it says wrote it. Where a builder puts its own work
   * forward that is the builder's branch; on the contracts before, the lead named the candidate by
   * bringing it into its own.
   */
  private async whyNotGradable(jobId: string, onChainId: bigint, commit: string, jobs: Contract, isPutForward: boolean): Promise<string | undefined> {
    const repo = await openRepository(this.options.repositories, jobId);
    const named = isPutForward ? "the builder put forward" : "the pod approved";
    if (!(await has(repo, commit))) return `${named} ${commit}, which was never pushed to the job's repository, so there is nothing to grade`;
    const namedBy = isPutForward ? "builder" : "lead";
    const seat = (await readSeats(jobs, onChainId)).find((one) => one.role === namedBy);
    if (!seat || !(await onBranch(repo, commit, branchFor(namedBy, seat.agent)))) {
      return isPutForward
        ? `the builder put forward ${commit}, which is not on the builder's own branch, so it is not graded: a builder puts forward what it pushed`
        : `the pod approved ${commit}, which is not on the lead's branch, so it is not graded: a commit the pod ships is one the lead brought in`;
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
    // a pod not paid: finished once its website, if one went live, has been taken down
    if (!wasThePodPaid(record)) return !this.options.siteHost || !record.live || record.live.removedAt !== undefined;
    const titled = !this.options.token || record.chain.tokenId !== undefined;
    const published = !this.options.publishTo || record.opensOnMain === true;
    return titled && published;
  }

  private async now(): Promise<bigint> {
    return (await this.options.jobs.publicClient.getBlock()).timestamp;
  }

  /**
   * The commit to grade, if the chain says it is time to and there is still time to settle it. Where
   * a builder puts its own work forward, that is when the contract says the job is locked on it: the
   * whole pod stands behind it, or the time for reviewing it has run out, whoever does. On the
   * contracts before, it is when every approval the policy asks for is in.
   */
  private async readyToGrade(onChain: OnChainJob, onChainId: bigint, jobs: Contract, isPutForward: boolean): Promise<string | undefined> {
    if (onChain.state !== "working" || onChain.commit === zeroHash) return undefined;
    // the contract refuses a settlement after the window, so a verdict then would change nothing
    if ((await this.now()) >= onChain.endsAt) return undefined;
    const isTime = isPutForward ? await isLocked(jobs, onChainId) : await policyMet(jobs, onChainId, onChain.commit);
    return isTime ? bytes32ToCommit(onChain.commit) : undefined;
  }

  private async grade(record: JobRecord, onChainId: bigint, commit: string, jobs: Contract, isPutForward: boolean): Promise<void> {
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
        commit, seal: record.seal, start: startFor(spec.kind), checks,
        toRun: spec.checks.map((check) => ({ says: check.says, command: check.run, hidden: check.hidden })),
        image: this.options.image,
        allowedHosts: spec.allowed.map((allowed) => allowed.host),
        startSeconds: GRADING_START_SECONDS,
        runner: this.runner, runnerKey: this.options.runnerKey,
        ...(this.options.times === undefined ? {} : { times: this.options.times }),
      });
      const report = this.options.boxes ? await this.options.boxes.inASlot(grading) : await grading();

      // who stands behind the commit, as the contract has it. Where a builder puts its own work
      // forward this cannot change any more: the job is locked, and nobody signs on while it is graded
      const seats = await readSeats(jobs, onChainId);
      const approved = seats.filter((seat) => seat.approved);
      const { found, lookedBackTo } = await readApprovals(jobs, onChainId, commitToBytes32(commit), approved);
      const putForward = isPutForward ? await readWhenPutForward(jobs, onChainId, commitToBytes32(commit), MOST_BLOCKS_LOOKED_BACK_FOR_APPROVALS) : undefined;
      // each seat behind it with the time the contract recorded: a builder when it put the commit
      // forward, another seat when it approved. One longer ago than was read back says so, rather
      // than a time being made up for it
      const approvals = approved.map((seat) => {
        const when = seat.role === "builder" && putForward && isAddressEqual(putForward.builder, seat.agent)
          ? putForward
          : found.find((approval) => approval.role === seat.role && isAddressEqual(approval.agent, seat.agent));
        return { role: seat.role, agent: seat.agent, commit, at: when ? isoOf(when.at) : `before ${isoOf(lookedBackTo)}` };
      });

      // read before the verdict is published, which writes the record afresh from the receipt alone:
      // whatever is to stay with the job is what was beside it a moment before that
      const kept = await store.read(record.jobId);
      const published = await publish(store, {
        jobId: record.jobId, seal: record.seal, idea: spec.idea, mode: spec.mode, price: spec.price, report,
        pod: seats.map((seat) => ({ role: seat.role, agent: seat.agent, owner: seat.owner })),
        checksDirectory: checks, approvals,
        ...(fetchFrom.onGitHub ? { repository: fetchFrom.url } : record.repository ? { repository: record.repository } : {}),
        ...(record.podHolder ? { podHolder: record.podHolder } : {}),
      });
      // what the chain already knows about the job, who paid for it, and its brief, whose window decides
      // when a held verdict is published, stay with it: the grading knows none of them
      // and the worker's tries, read fresh: this grading started one, and it did not fail on our side.
      // So do the identities its seats named as their own, which a seat may say at any time, grading
      // included: a verdict is written to them once the job settles, so losing one here would be a
      // seat told it will be recorded and then never recorded
      const tries = kept?.tries;
      await store.save({
        ...published, chain: record.chain,
        ...(record.poster ? { poster: record.poster } : {}),
        ...(record.brief ? { brief: record.brief } : {}),
        ...(tries ? { tries: { ...tries, failed: 0 } } : {}),
        ...(kept?.identities ? { identities: kept.identities } : {}),
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
   * Report what the checks found, once, where the poster has the last word. No money moves: the job
   * is delivered, and its poster's time to answer starts. A held verdict reports nothing.
   */
  private async report(jobId: string, signed: SignedReceipt, onChainId: bigint, jobs: Contract): Promise<void> {
    if (moneyMove(signed.receipt.verdict) === "hold") return;
    const commit = commitToBytes32(signed.receipt.commit);
    const hash = await this.onTheChain(async () => {
      // read again inside the queue: another look may have reported it while this one waited, or the
      // pod moved to another commit
      const now = await readJob(jobs, onChainId);
      if (now.state !== "working" || now.commit.toLowerCase() !== commit.toLowerCase()) return undefined;
      return report(jobs, onChainId, commit, verdictOnChain(signed), signed.hash);
    });
    if (!hash) return;
    const answerBy = await readAnswerBy(jobs, onChainId);
    await this.remember(jobId, { reported: hash, ...(answerBy === undefined ? {} : { answerBy: isoOf(answerBy) }) });
    this.say(`${jobId}: delivered. Its poster has ${answerBy === undefined ? "their time" : `until ${isoOf(answerBy)}`} to accept or refuse`);
  }

  /**
   * A job on the contract where the poster has the last word, from its delivery on. While it waits for
   * its poster nothing is done; once their time has run out it is settled as its checks found, which
   * anybody may do and the worker is always here to; and when it has ended, however it did, that is
   * written down once. True when there is nothing more to do on this look.
   */
  private async whileDelivered(record: JobRecord, jobs: Contract, onChainId: bigint, onChain: OnChainJob): Promise<boolean> {
    if (!record.chain || !record.signed) return false;
    if (onChain.state === "delivered") {
      const answerBy = await readAnswerBy(jobs, onChainId);
      if (answerBy === undefined) return true;
      // a worker stopped between reporting and writing it down finds the report on the chain
      if (!record.chain.answerBy) await this.remember(record.jobId, { answerBy: isoOf(answerBy) });
      // a website is put live for its poster to open while their time runs, and tried again on each look until it is
      await this.putLive((await this.options.store.read(record.jobId)) ?? record);
      if ((await this.now()) < answerBy) {
        await this.tellItsPoster((await this.options.store.read(record.jobId)) ?? record, answerBy);
        return true;
      }
      const hash = await this.onTheChain(async () => ((await readJob(jobs, onChainId)).state === "delivered" ? settleUnanswered(jobs, onChainId) : undefined));
      if (hash) this.say(`${record.jobId}: its poster said nothing in their time, so it is settled as its checks found`);
      return true;
    }
    if (onChain.state !== "settled" && onChain.state !== "refunded") return false;
    if (record.chain.answer) {
      // written down on an earlier look, with its website still to take down
      if (!wasThePodPaid(record)) await this.takeDown(record);
      return false;
    }
    const how = await readHowItEnded(jobs, onChainId);
    // ended without ever being delivered, which the rest of the look knows what to do with
    if (!how) return false;
    const latest = await jobs.publicClient.getBlockNumber({ cacheTime: 0 });
    const found = await readTheAnswersTransaction(jobs, onChainId, {
      fromBlock: latest > MOST_BLOCKS_LOOKED_BACK_FOR_AN_ANSWER ? latest - MOST_BLOCKS_LOOKED_BACK_FOR_AN_ANSWER : 0n,
      toBlock: latest, sliceBlocks: MOST_BLOCKS_A_LOG_READ_COVERS,
    }).catch((error: unknown) => {
      // the link is a kindness: how the job ended is the contract's word, and is written down without it
      this.say(`${record.jobId}: the transaction that ended it could not be looked up: ${firstLine(error)}`);
      return undefined;
    });
    const at = new Date().toISOString();
    await this.remember(record.jobId, {
      moneyMovedAt: at,
      answer: {
        how, at,
        ...(found ? { hash: found.hash } : {}),
        ...(found?.keptByThePod === undefined ? {} : { keptByThePod: found.keptByThePod.toString() }),
      },
    });
    this.say(`${record.jobId}: ${how === "accepted" ? "accepted by its poster" : how === "refused" ? "refused by its poster" : "its poster said nothing, and its checks decided"}`);
    // a website its pod was not paid for is not left standing at an address: it was the pod's to show, and is not the poster's to keep
    const ended = (await this.options.store.read(record.jobId)) ?? record;
    if (!wasThePodPaid(ended)) await this.takeDown(ended);
    // not the end of the look: a pod paid in full is titled and its work published straight away
    return false;
  }

  /**
   * Put a delivered website live, once: the files of the commit that was graded, at an address of
   * their own. Work that is no website to publish is said once and not tried again; a host having a
   * bad moment is said and tried again on the next look, and holds up nothing else.
   */
  /** Whether a job's host failed it too lately to be asked again yet: each failure in a row doubles the wait. */
  private isTooSoonForTheHost(jobId: string): boolean {
    const failed = this.hostFailed.get(jobId);
    if (!failed) return false;
    const wait = Math.min((this.options.hostAgainAfterMs ?? HOST_AGAIN_AFTER_MS) * 2 ** (failed.times - 1), HOST_AGAIN_AT_MOST_MS);
    return Date.now() - failed.at < wait;
  }

  private theHostFailed(jobId: string): void {
    this.hostFailed.set(jobId, { times: (this.hostFailed.get(jobId)?.times ?? 0) + 1, at: Date.now() });
  }

  private async putLive(record: JobRecord): Promise<void> {
    const { siteHost, store } = this.options;
    if (!siteHost || record.live || record.notLiveBecause || !record.signed) return;
    if ((await store.spec(record.jobId))?.kind !== "site") return;
    if (this.isTooSoonForTheHost(record.jobId)) return;
    const laid = await mkdtemp(join(tmpdir(), "pod-worker-site-"));
    try {
      const repo = await openRepository(this.options.repositories, record.jobId);
      await checkout(repo, record.signed.receipt.commit, laid);
      const files = await siteFilesIn(join(laid, SITE_FOLDER), SITE_FRONT_PAGE);
      const live = await siteHost.publish({ name: siteNameFor(record), files, madeFor: siteMadeFor(record) });
      const fresh = (await store.read(record.jobId)) ?? record;
      await store.save({ ...fresh, live: { host: siteHost.name, siteId: live.siteId, url: live.url, at: new Date().toISOString() } });
      this.hostFailed.delete(record.jobId);
      this.say(`${record.jobId}: live at ${live.url}`);
    } catch (error) {
      if (error instanceof NotAWebsite) {
        const fresh = (await store.read(record.jobId)) ?? record;
        await store.save({ ...fresh, notLiveBecause: error.message });
        this.say(`${record.jobId}: not put live: ${error.message}`);
        return;
      }
      this.theHostFailed(record.jobId);
      this.say(`${record.jobId}: could not be put live, and is tried again later: ${firstLine(error)}`);
    } finally {
      await rm(laid, { recursive: true, force: true });
    }
  }

  /** Take a live website down, once, and write down when. A host having a bad moment is said, and it is tried again. */
  private async takeDown(record: JobRecord): Promise<void> {
    const { siteHost, store } = this.options;
    if (!siteHost || !record.live || record.live.removedAt) return;
    if (this.isTooSoonForTheHost(record.jobId)) return;
    try {
      await siteHost.remove(record.live.siteId);
      const fresh = (await store.read(record.jobId)) ?? record;
      if (fresh.live) await store.save({ ...fresh, live: { ...fresh.live, removedAt: new Date().toISOString() } });
      this.hostFailed.delete(record.jobId);
      this.say(`${record.jobId}: its live address is taken down`);
    } catch (error) {
      this.theHostFailed(record.jobId);
      this.say(`${record.jobId}: its live address could not be taken down, and is tried again later: ${firstLine(error)}`);
    }
  }

  /**
   * On a job whose pod was paid in full: the work on the main branch, then the title to whoever paid.
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
    // publishing is tried again on the next look until it is done.
    //
    // Asked by what the repository opens on, never by whether it exists: a job is published once
    // before it is graded, so the receipt can name somewhere anybody can clone, and that one opens on
    // the lead's branch because there is no passed work yet. Reading `repository` here instead left
    // every passing job on GitHub with no main at all, opening on a seat's branch, which is also the
    // branch GitHub would have counted its contributions on.
    if (this.options.publishTo && stillToPublish(record)) await this.publish(record.jobId, record.tile.idea, this.options.publishTo.owner);
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
    // where the poster has the last word, the code is the pod's until they accept: it goes nowhere public
    // before that, and the receipt names this server's copy, which opens to anybody once the pod is paid
    if (record.chain?.lastWord) return onThisServer;
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
    await store.save({
      ...opened, poster: setUp.poster,
      ...(opened.brief && setUp.references ? { brief: { ...opened.brief, references: setUp.references } } : {}),
      chain: { network: "monad-testnet", jobId: onChainId, jobs: prepared.address, ...(this.options.hasTheLastWord ? { lastWord: true } : {}) },
    }, approved.files);
    await store.saveSpec(setUp.name, spec);
    this.say(`${setUp.name}: its poster approved its checks, so it is on the wall and open to a pod`);
  }

  /** Which contract a job is on, if it is one this worker works. */
  private contractOf(address: Address): { readonly contract: Contract; readonly isPreparedFirst: boolean; readonly hasTheLastWord: boolean } | undefined {
    const { jobs, prepared } = this.options;
    if (isAddressEqual(address, jobs.address)) return { contract: jobs, isPreparedFirst: false, hasTheLastWord: false };
    if (prepared && isAddressEqual(address, prepared.address)) return { contract: prepared, isPreparedFirst: true, hasTheLastWord: this.options.hasTheLastWord === true };
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
    const hash = await this.onTheChain(async () => {
      // read inside the queue. Nothing is let go of once the window has closed: nothing could be
      // graded after it anyway, and the contract where a builder puts its work forward refuses,
      // since a release says the work reached grading
      const { endsAt } = await readJob(jobs, onChainId);
      if ((await this.now()) >= endsAt || !(await isLocked(jobs, onChainId))) return undefined;
      return releaseLock(jobs, onChainId);
    });
    if (!hash) return undefined;
    this.say(`${record.jobId}: let go once, since ${why}; it is graded again once work is put forward or approved again`);
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
