import { z } from "zod";
import { shareOf, type Role } from "../../../job.ts";
import { REFUSAL_SHARE_PERCENT } from "../../../jobsV3.ts";
import { SEATS } from "../../../seal.ts";
import type { JobRecord } from "../../../store.ts";
import { WEI, WHEN } from "./kinds.ts";

/**
 * Where a delivered job stands with its poster, on the contract where they have the last word:
 * awaited while their time to answer runs, then what they said, or that they said nothing.
 */
export const ANSWERS = ["awaited", "accepted", "refused", "unanswered"] as const;
export const AnswerSchema = z.enum(ANSWERS);
export type Answer = z.infer<typeof AnswerSchema>;

const COUNT = z.number().int().nonnegative();

/** How a poster's jobs have ended, as the contract counts them. */
export const PosterRecordSchema = z.object({ posted: COUNT, accepted: COUNT, refusedPassed: COUNT, refusedFailed: COUNT, unanswered: COUNT });
export type PosterRecordView = z.infer<typeof PosterRecordSchema>;

/** How the jobs an agent held a seat on have ended, as the contract counts them. */
export const AgentRecordSchema = z.object({ accepted: COUNT, paidUnanswered: COUNT, refusedPassed: COUNT, failed: COUNT, undelivered: COUNT });
export type AgentRecordView = z.infer<typeof AgentRecordSchema>;

/** A job's delivery: what its poster has until, what a refusal would leave the pod, and how it ended. */
export const DeliveryViewSchema = z.object({
  answer: AnswerSchema,
  /** until when the poster may refuse, after which the checks decide */
  answerBy: WHEN,
  /** what the checks found, which decides when the poster says nothing, and what a refusal costs */
  checksPassed: z.boolean(),
  /** the seats that stand behind the work, in the order of the seats: its builder, who put it forward, and each seat that said yes */
  behind: z.array(z.enum(SEATS)),
  /** the seats that were taken and did not stand behind it, which are paid nothing for it and answer for nothing */
  notBehind: z.array(z.enum(SEATS)),
  /** the seats behind it that its lead kept from the pay, where a lead names who is paid: their share comes back to the poster */
  keptFromPay: z.array(z.enum(SEATS)).optional(),
  /** in wei: what accepting pays, the share of every seat behind the work. The rest of the price goes back to the poster */
  paidOnAcceptance: WEI,
  /** in wei: what the seats behind it keep if the poster refuses, a share of each one's pay when the checks passed, nothing when they failed */
  keptOnRefusal: WEI,
  /** when it ended, and the transaction that ended it when that was found */
  answeredAt: WHEN.optional(),
  hash: z.string().optional(),
});
export type DeliveryView = z.infer<typeof DeliveryViewSchema>;

/** Where a job stands with its poster, or nothing for a job not delivered or on a contract that settles on the verdict alone. */
export function answerOf(record: Pick<JobRecord, "chain">): Answer | undefined {
  const chain = record.chain;
  if (chain?.answer) return chain.answer.how;
  return chain?.answerBy ? "awaited" : undefined;
}

/**
 * The seats that stood behind a delivery: its builder, who put the work forward, and each seat that
 * said yes to it while its review ran. Read from what the grader wrote down from the contract when it
 * graded the work, which nothing can change afterwards.
 */
export function seatsBehind(record: Pick<JobRecord, "approvals" | "tile">): readonly Role[] {
  return SEATS.filter((role) => record.tile.pod.some((seat) =>
    seat.role === role && record.approvals.some((one) => one.role === role && one.agent.toLowerCase() === seat.agent.toLowerCase())));
}

/**
 * The seats behind a delivery that its lead kept from the pay, where a lead names who is paid: they
 * said yes and answer for it, and are paid nothing. None on a contract that pays every seat behind the work.
 */
export function seatsKeptFromPay(record: Pick<JobRecord, "approvals" | "tile">): readonly Role[] {
  return seatsBehind(record).filter((role) => record.approvals.some((one) => one.role === role && one.isKeptFromPay === true
    && record.tile.pod.some((seat) => seat.role === role && seat.agent.toLowerCase() === one.agent.toLowerCase())));
}

/** What accepting pays: the share of every seat that is paid for the work, and of no other. */
export function paidOnAcceptance(price: bigint, behind: readonly Role[]): bigint {
  return behind.reduce((paid, role) => paid + shareOf(price, role), 0n);
}

/**
 * What a refusal leaves the seats behind the work: a share of each one's pay when the checks passed,
 * as the contract works it out seat by seat, and nothing when they failed.
 */
export function keptOnRefusal(price: bigint, behind: readonly Role[], checksPassed: boolean): bigint {
  if (!checksPassed) return 0n;
  return behind.reduce((kept, role) => kept + (shareOf(price, role) * BigInt(REFUSAL_SHARE_PERCENT)) / 100n, 0n);
}

/** A job's delivery, from its record, once the validator's report is on the chain. */
export function deliveryOf(record: JobRecord): DeliveryView | undefined {
  const answer = answerOf(record);
  const answerBy = record.chain?.answerBy;
  const verdict = record.signed?.receipt.verdict;
  if (!answer || !answerBy || (verdict !== "passed" && verdict !== "failed")) return undefined;
  const ended = record.chain?.answer;
  const checksPassed = verdict === "passed";
  const behind = seatsBehind(record);
  const keptFromPay = seatsKeptFromPay(record);
  // a yes, and the quarter a refusal leaves, go to the seats behind the work that its lead did not keep from the pay
  const paid = behind.filter((role) => !keptFromPay.includes(role));
  return {
    answer, answerBy, checksPassed,
    behind: [...behind],
    ...(keptFromPay.length > 0 ? { keptFromPay: [...keptFromPay] } : {}),
    notBehind: SEATS.filter((role) => !behind.includes(role) && record.tile.pod.some((seat) => seat.role === role)),
    paidOnAcceptance: paidOnAcceptance(record.tile.price, paid).toString(),
    // what was kept is the chain's word once there is one; before that, what the contract would keep
    keptOnRefusal: ended?.keptByThePod ?? keptOnRefusal(record.tile.price, paid, checksPassed).toString(),
    ...(ended ? { answeredAt: ended.at } : {}),
    ...(ended?.hash ? { hash: ended.hash } : {}),
  };
}
