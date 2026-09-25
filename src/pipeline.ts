/**
 * One job, graded end to end.
 *
 * This is where the pieces meet: the checks run against the artefact from outside, the whole set
 * runs more than once, the runs have to agree, and what comes out is a signed receipt plus the two
 * values the chain takes.
 *
 * The order matters. Nothing is signed until the runs agree, and nothing reaches the chain that the
 * receipt does not already explain.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grade, type CheckToRun, type GradeOutcome } from "./blackbox.ts";
import { checkout, has, type Repository } from "./repo.ts";
import { readableToTheBox } from "./sandbox.ts";
import { fingerprintTree, signReceipt, type Receipt, type SignedReceipt } from "./receipt.ts";
import { registryResponse, registryTag, reachVerdict, type Verdict } from "./verdict.ts";
import type { Address, Hex } from "viem";

export interface GradeJob {
  readonly seal: Hex;
  readonly commit: string;
  /** the directory that is graded. `gradeCommit` fills this in from a repository */
  readonly artefact: string;
  /** where the commit came from, recorded so somebody else can fetch it */
  readonly repository?: string;
  readonly start: string;
  readonly checks: string;
  readonly toRun: readonly CheckToRun[];
  readonly image: string;
  readonly allowedHosts?: readonly string[];
  /** how many times the whole set runs. Two is the minimum that can disagree */
  readonly times?: number;
  readonly runner: Address;
  readonly runnerKey: Hex;
  readonly role?: string;
}

export interface GradeReport {
  readonly verdict: Verdict;
  readonly signed: SignedReceipt;
  /** what goes on chain: a score from 0 to 100 and the tag it is filed under */
  readonly score: number;
  readonly tag: string;
  readonly rounds: readonly GradeOutcome[];
}

/** Lines an artefact printed that suggest it reached for something it never declared. */
export function undeclaredCalls(log: string, allowed: readonly string[]): readonly string[] {
  const suspicious = log
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /reachable|ENOTFOUND|EAI_AGAIN|getaddrinfo|ECONNREFUSED|fetch failed/i.test(line));
  return suspicious.filter((line) => !allowed.some((host) => line.includes(host)));
}

export async function gradeJob(job: GradeJob): Promise<GradeReport> {
  const times = job.times ?? 3;
  if (times < 2) throw new Error("a verdict needs at least two runs");

  const rounds: GradeOutcome[] = [];
  for (let i = 0; i < times; i++) {
    rounds.push(await grade({
      artefact: job.artefact,
      start: job.start,
      checks: job.checks,
      toRun: job.toRun,
      image: job.image,
      allowedHosts: job.allowedHosts,
    }));
  }

  // Two runs are the same run only if every check came back the same way.
  const verdict = reachVerdict(rounds.map((round) => ({
    exitCode: round.passed ? 0 : 1,
    summary: round.checks.map((c) => `${c.says}:${c.exitCode}`).join("|"),
  })));

  const last = rounds[rounds.length - 1]!;
  const allowed = job.allowedHosts ?? [];
  const receipt: Receipt = {
    version: "pod.receipt.v1",
    seal: job.seal,
    commit: job.commit,
    tree: await fingerprintTree(job.artefact),
    repository: job.repository ?? "",
    image: job.image,
    start: job.start,
    checks: last.checks.map((c) => ({
      says: c.says,
      command: c.command,
      exitCode: c.exitCode,
      seconds: c.seconds,
      hidden: c.hidden,
    })),
    runs: times,
    verdict: verdict.kind,
    allowedHosts: allowed,
    undeclaredCalls: undeclaredCalls(rounds.map((r) => r.artefactLog).join("\n"), allowed),
    runner: job.runner,
    finishedAt: new Date().toISOString(),
  };

  const signed = await signReceipt(receipt, job.runnerKey);
  return {
    verdict,
    signed,
    score: registryResponse(verdict),
    tag: registryTag(verdict, job.role ?? "tests"),
    rounds,
  };
}

export interface GradeCommit extends Omit<GradeJob, "artefact"> {
  readonly repo: Repository;
}

/**
 * Grade one exact commit out of a job's repository.
 *
 * This is the way a real job is graded, and the directory version underneath it is for fixtures and
 * for a stranger repeating a run against code they fetched themselves. The commit is laid out fresh,
 * graded, and thrown away: nothing that ran can persist into the next round, and no later commit can
 * change what this verdict was about.
 */
export async function gradeCommit(job: GradeCommit): Promise<GradeReport> {
  if (!(await has(job.repo, job.commit))) {
    throw new Error(`${job.commit} is not a commit in ${job.repo.jobId}, so there is nothing to grade`);
  }
  const laid = await mkdtemp(join(tmpdir(), "pod-graded-"));
  try {
    await checkout(job.repo, job.commit, laid);
    // a temporary folder is its owner's alone on Linux, and the box that runs the work cannot open it
    await readableToTheBox(laid);
    return await gradeJob({ ...job, artefact: laid, repository: job.repository ?? job.repo.path });
  } finally {
    await rm(laid, { recursive: true, force: true });
  }
}
