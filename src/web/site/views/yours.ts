import { z } from "zod";
import type { PaidJob } from "../../../owners.ts";
import { preparingPagePath, refundByNumberPath } from "../../../routes.ts";
import type { JobRecord } from "../../../store.ts";
import { jobView, TitleViewSchema, type ChainSays } from "./job.ts";
import { MS_IN_A_SECOND, WEI } from "./kinds.ts";
import { MoneyViewSchema, type MoneyView } from "./money.ts";
import { tileView, TileViewSchema } from "./tile.ts";

/** A job on your own page, with what its money and its title let you do. */
export const YoursEntrySchema = z.object({
  tile: TileViewSchema,
  money: MoneyViewSchema.optional(),
  title: TitleViewSchema.optional(),
});
export type YoursEntry = z.infer<typeof YoursEntrySchema>;

/**
 * A job paid for on a contract that prepares jobs, still preparing: its checks being written on its
 * own page, or never sent to be written at all (R13). Either way its page is where to go next.
 */
export const PreparingNextSchema = z.object({ kind: z.enum(["preparing", "notSetUp"]), page: z.string() });
export type PreparingNext = z.infer<typeof PreparingNextSchema>;

/** A job a wallet paid for that is not on the wall: the contract knows it only by its number. */
export const UnpublishedViewSchema = z.object({
  onChainId: z.string(),
  price: WEI,
  money: z.union([MoneyViewSchema, PreparingNextSchema]),
});
export type UnpublishedView = z.infer<typeof UnpublishedViewSchema>;

/** A wallet's own page: the jobs it paid for, those that never reached the wall, and the titles it holds. */
export const YoursViewSchema = z.object({
  address: z.string(),
  posted: z.array(YoursEntrySchema),
  /** absent when the contract could not be read just now, which is not the same as there being none */
  unpublished: z.array(UnpublishedViewSchema).optional(),
  holds: z.array(YoursEntrySchema),
});
export type YoursView = z.infer<typeof YoursViewSchema>;

export function yoursEntry(record: JobRecord, chainSays: ChainSays): YoursEntry {
  const view = jobView(record, [], chainSays);
  return { tile: tileView(record.tile, record.signed !== undefined), ...(view.money ? { money: view.money } : {}), ...(view.title ? { title: view.title } : {}) };
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
  const money: MoneyView = job.state === "refunded" ? { kind: "refunded" }
    : job.state === "settled" ? { kind: "paid" }
    : { kind: "held", endsAt: new Date(Number(job.endsAt) * MS_IN_A_SECOND).toISOString(), takeBack };
  return { onChainId, price: job.price.toString(), money };
}
