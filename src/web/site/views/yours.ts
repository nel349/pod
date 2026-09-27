import { z } from "zod";
import type { PaidJob } from "../../../owners.ts";
import { refundByNumberPath } from "../../../routes.ts";
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

/** A job a wallet paid for that never reached the wall: the contract knows it only by its number. */
export const UnpublishedViewSchema = z.object({
  onChainId: z.string(),
  price: WEI,
  money: MoneyViewSchema,
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

/** Where the money for a job that never reached the wall is: the contract is the only one who knows. */
export function unpublishedView(paid: PaidJob): UnpublishedView {
  const { job } = paid;
  const takeBack = refundByNumberPath(paid.onChainId.toString());
  const money: MoneyView = job.state === "refunded" ? { kind: "refunded" }
    : job.state === "settled" ? { kind: "paid" }
    : { kind: "held", endsAt: new Date(Number(job.endsAt) * MS_IN_A_SECOND).toISOString(), takeBack };
  return { onChainId: paid.onChainId.toString(), price: job.price.toString(), money };
}
