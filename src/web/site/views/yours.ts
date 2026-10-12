import { z } from "zod";
import type { PaidJob } from "../../../owners.ts";
import { preparingPagePath, refundByNumberPath } from "../../../routes.ts";
import type { JobRecord } from "../../../store.ts";
import { jobView, TitleViewSchema, type ChainSays } from "./job.ts";
import { MS_IN_A_SECOND, WEI, WHEN } from "./kinds.ts";
import { MoneyViewSchema, type MoneyView } from "./money.ts";
import { SEATS } from "../../../seal.ts";
import type { Question } from "../../../triage.ts";
import { tileView, TileViewSchema } from "./tile.ts";

/** A job on your own page, with what its money and its title let you do. */
export const YoursEntrySchema = z.object({
  tile: TileViewSchema,
  money: MoneyViewSchema.optional(),
  title: TitleViewSchema.optional(),
  /** until when each question its pod asked and nobody has answered may still be answered, in seconds since 1970 */
  asked: z.array(z.number()).optional(),
});
export type YoursEntry = z.infer<typeof YoursEntrySchema>;

/**
 * A job paid for on a contract that prepares jobs, still preparing: its checks being written on its
 * own page, or never sent to be written at all (R13). Either way its page is where to go next.
 */
export const PreparingNextSchema = z.object({ kind: z.enum(["preparing", "notSetUp"]), page: z.string() });
export type PreparingNext = z.infer<typeof PreparingNextSchema>;

/**
 * A job its poster approved, open to builders on the contract, that the server has not put on the wall
 * yet. Nobody can have a seat on a job not on the wall, so its poster may still take the money back.
 */
export const ApprovedNextSchema = z.object({ kind: z.literal("approved"), endsAt: WHEN, takeBack: z.string() });
export type ApprovedNext = z.infer<typeof ApprovedNextSchema>;

/** A job a wallet paid for that is not on the wall: the contract knows it only by its number. */
export const UnpublishedViewSchema = z.object({
  onChainId: z.string(),
  price: WEI,
  money: z.union([MoneyViewSchema, PreparingNextSchema, ApprovedNextSchema]),
});
export type UnpublishedView = z.infer<typeof UnpublishedViewSchema>;

/**
 * What a seat got or stands to get, by where its job stands: nothing while it is built; its pay if the
 * poster accepts, when it stands behind the work; its pay, part of it, or nothing once the job has ended.
 */
export const SEAT_OUTCOMES = ["seated", "awaiting", "paid", "keptPart", "notBehind", "nothing"] as const;
export type SeatOutcome = (typeof SEAT_OUTCOMES)[number];

/** A seat on a job that a wallet's agent holds, or that the wallet holds itself, with what it paid. */
export const SeatOfYoursSchema = z.object({
  jobId: z.string(),
  idea: z.string(),
  standing: z.string(),
  role: z.enum(SEATS),
  agent: z.string(),
  /** the seat's share of the job's price */
  pay: WEI,
  outcome: z.enum(SEAT_OUTCOMES),
});
export type SeatOfYours = z.infer<typeof SeatOfYoursSchema>;

/** A wallet's own page: the jobs it paid for, those that never reached the wall, the titles it holds, and the seats its agents hold. */
export const YoursViewSchema = z.object({
  address: z.string(),
  posted: z.array(YoursEntrySchema),
  /** every seat this wallet owns or holds itself, newest job first */
  seats: z.array(SeatOfYoursSchema),
  /** absent when the contract could not be read just now, which is not the same as there being none */
  unpublished: z.array(UnpublishedViewSchema).optional(),
  holds: z.array(YoursEntrySchema),
});
export type YoursView = z.infer<typeof YoursViewSchema>;

/**
 * @param questions what the job's pod asked its poster, when the entry is for the poster: the ones
 *                  not yet answered are what they may still be needed for
 */
export function yoursEntry(record: JobRecord, chainSays: ChainSays, questions: readonly Question[] = []): YoursEntry {
  const view = jobView(record, [], chainSays);
  const asked = view.verdict === "running" ? questions.filter((question) => !question.answer).map((question) => question.answerBy) : [];
  return {
    tile: tileView(record.tile, record.signed !== undefined, view.answer), ...(view.money ? { money: view.money } : {}), ...(view.title ? { title: view.title } : {}),
    ...(asked.length > 0 ? { asked } : {}),
  };
}

/**
 * The seats on a job that a wallet owns, as an agent's owner does under a grant, or holds with its
 * own key, each with what it paid. Read from the job's record as its page reads it.
 */
export function seatsOfYours(record: JobRecord, wallet: string): SeatOfYours[] {
  const wanted = wallet.toLowerCase();
  const mine = record.tile.pod.filter((seat) => seat.owner.toLowerCase() === wanted || seat.agent.toLowerCase() === wanted);
  if (mine.length === 0) return [];
  const view = jobView(record, [], {});
  return mine.flatMap((seat) => {
    const drawn = view.seats.find((one) => one.role === seat.role);
    if (!drawn) return [];
    return [{
      jobId: record.jobId, idea: view.idea, standing: view.standing, role: drawn.role, agent: seat.agent, pay: drawn.pay,
      outcome: seatOutcomeOf(view, drawn.role),
    }];
  });
}

/** What a seat got from its job, as the job's page already says it of the whole pod. */
function seatOutcomeOf(view: ReturnType<typeof jobView>, role: SeatOfYours["role"]): SeatOutcome {
  const { delivery } = view;
  // on a contract that settles on the verdict alone, every seat is paid when the work passes
  if (!delivery) return view.verdict === "passed" && view.money?.kind === "paid" ? "paid" : view.verdict === "failed" ? "nothing" : "seated";
  const isBehind = delivery.behind.includes(role);
  if (delivery.answer === "awaited") return isBehind ? "awaiting" : "notBehind";
  const isPaid = delivery.answer === "accepted" || (delivery.answer === "unanswered" && delivery.checksPassed);
  if (isPaid) return isBehind ? "paid" : "notBehind";
  if (delivery.answer === "refused" && delivery.checksPassed) return isBehind ? "keptPart" : "notBehind";
  return "nothing";
}

/**
 * Where the money for a job that is not on the wall is: the contract is the only one who knows.
 *
 * @param isSetUp whether the server has the job's lines, for a job still preparing
 */
export function unpublishedView(paid: PaidJob, isSetUp = false): UnpublishedView {
  const { job } = paid;
  const onChainId = paid.onChainId.toString();
  if (job.state === "preparing") {
    return { onChainId, price: job.price.toString(), money: { kind: isSetUp ? "preparing" : "notSetUp", page: preparingPagePath(onChainId) } };
  }
  const takeBack = refundByNumberPath(onChainId, paid.jobs);
  const endsAt = new Date(Number(job.endsAt) * MS_IN_A_SECOND).toISOString();
  if (paid.prepares && job.state === "open") return { onChainId, price: job.price.toString(), money: { kind: "approved", endsAt, takeBack } };
  // a delivered job is always on the wall, so one not on it is never waiting for its poster's answer
  const money: MoneyView = job.state === "refunded" ? { kind: "refunded" }
    : job.state === "settled" ? { kind: "paid" }
    : { kind: "held", endsAt, takeBack };
  return { onChainId, price: job.price.toString(), money };
}
