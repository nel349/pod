import { z } from "zod";
import type { JobRecord } from "../../../store.ts";
import { jobView, TitleViewSchema, type ChainSays } from "./job.ts";
import { MoneyViewSchema } from "./money.ts";
import { tileView, TileViewSchema } from "./tile.ts";

/** A job on your own page, with what its money and its title let you do. */
export const YoursEntrySchema = z.object({
  tile: TileViewSchema,
  money: MoneyViewSchema.optional(),
  title: TitleViewSchema.optional(),
});
export type YoursEntry = z.infer<typeof YoursEntrySchema>;

/** A wallet's own page: the jobs it paid for, and the titles it holds. */
export const YoursViewSchema = z.object({
  address: z.string(),
  posted: z.array(YoursEntrySchema),
  holds: z.array(YoursEntrySchema),
});
export type YoursView = z.infer<typeof YoursViewSchema>;

export function yoursEntry(record: JobRecord, chainSays: ChainSays): YoursEntry {
  const view = jobView(record, [], chainSays);
  return { tile: tileView(record.tile, record.signed !== undefined), ...(view.money ? { money: view.money } : {}), ...(view.title ? { title: view.title } : {}) };
}
