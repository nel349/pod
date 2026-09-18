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
import { grade, type CheckToRun, type GradeOutcome } from "./blackbox.ts";
import { fingerprintTree, signReceipt, type Receipt, type SignedReceipt } from "./receipt.ts";
import { registryResponse, registryTag, reachVerdict, type Verdict } from "./verdict.ts";
import type { Address, Hex } from "viem";

export interface GradeJob {
  readonly seal: Hex;
  readonly commit: string;
  readonly artefact: string;
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
