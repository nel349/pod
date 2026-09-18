/**
 * One job, from the pod's last commit to the money moving.
 *
 * The runner is the only thing that touches all three: the sealed box that decides, the wall that
 * publishes, and the contract that pays. It is deliberately thin, because everything it does is
 * something one of those three already refuses to get wrong.
 *
 * The order is the argument. Grade first, publish second, settle last: by the time anyone is paid,
 * the evidence is already public, and anybody can start disagreeing with it.
 */
import type { Hex } from "viem";
import { gradeJob, type GradeJob } from "./pipeline.ts";
import { publish, type PublishJob } from "./publish.ts";
import { settle, type Contract } from "./jobs.ts";
import { mintPod } from "./token.ts";
import type { Role } from "./job.ts";
import type { JobStore, JobRecord } from "./store.ts";

/**
 * What a runner does with a verdict it could not reproduce.
 *
 * Decided 2026-09-17: **hold**. Nothing is paid, nothing is refunded, and the job is left exactly as
 * it was. The poster takes their money back when the window closes, which the contract already does
 * for them, and the pod's deposits go home at the same moment. A person can still end it by hand
 * before then.
 *
 * The reason is that two runs disagreeing is a fact about the run, not a finding about the work. The
 * cost of holding is a delay; the cost of refunding on the spot is ending somebody's job over one
 * unlucky round. "refund" stays available for a runner that wants it, and nothing chooses it for you.
 */
export type WhenUnreproducible = "hold" | "refund";

/** What the money does, given a verdict and this runner's policy. Nothing else decides this. */
export type MoneyMove = "pay" | "refund" | "hold";

export function moneyMove(
  verdict: "passed" | "failed" | "not-reproducible",
  whenUnreproducible: WhenUnreproducible = "hold",
): MoneyMove {
  if (verdict === "passed") return "pay";
  if (verdict === "failed") return "refund";
  return whenUnreproducible === "refund" ? "refund" : "hold";
}

export interface RunJob {
  readonly grade: GradeJob;
  /** everything the wall needs that the grading does not produce */
  readonly publishAs: Omit<PublishJob, "report">;
  readonly store: JobStore;
  /** absent when there is no chain to settle on yet: the job is still graded and still published */
  readonly chain?: {
    readonly contract: Contract;
    readonly jobId: bigint;
    /** the commit as the contract holds it, which is a hash and not a string */
    readonly commit: Hex;
    /**
     * Where the title is minted, on a job that passed. Left out, the job still settles and the crew
     * is still paid: a mint that cannot happen is not a reason to withhold somebody's money.
     */
    readonly token?: Contract;
    /** the job's own page, which is what the title points at */
    readonly uri?: string;
  };
  readonly whenUnreproducible?: WhenUnreproducible;
}

export interface RunOutcome {
  readonly record: JobRecord;
  readonly verdict: "passed" | "failed" | "not-reproducible";
  /** the settlement, when there was one. A held job has none, and says why */
  readonly settlement?: { readonly hash: Hex; readonly paid: boolean };
  /** the title, minted to the person who paid, on a job that passed */
  readonly mint?: Hex;
  readonly heldBecause?: string;
}

export async function runJob(job: RunJob): Promise<RunOutcome> {
  const report = await gradeJob(job.grade);
  const record = await publish(job.store, { ...job.publishAs, report });
  const verdict = report.signed.receipt.verdict;

  if (!job.chain) return { record, verdict, heldBecause: "no contract was given to settle on" };

  const move = moneyMove(verdict, job.whenUnreproducible);
  if (move === "hold") {
    return {
      record,
      verdict,
      heldBecause: "the runs did not agree. Nothing is settled: the poster takes the money back when the window closes",
    };
  }

  const paid = move === "pay";
  const hash = await settle(job.chain.contract, job.chain.jobId, job.chain.commit, paid);
  if (!paid || !job.chain.token) return { record, verdict, settlement: { hash, paid } };
  if (!record.signed) throw new Error("a job that passed has a signed receipt, and this one does not");

  // the crew has been paid; the title goes to whoever paid for the job, read from the job itself
  const mint = await mintPod(job.chain.token, {
    jobs: job.chain.contract,
    jobId: job.chain.jobId,
    seal: record.seal,
    commit: job.chain.commit,
    receiptHash: record.signed.hash,
    crew: record.tile.pod.map((seat) => ({ role: seat.role as Role, agent: seat.agent })),
    uri: job.chain.uri ?? "",
  });
  return { record, verdict, settlement: { hash, paid }, mint };
}
