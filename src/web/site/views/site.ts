import { z } from "zod";
import { MarketConfigSchema } from "../../../market.ts";
import { JobViewSchema } from "./job.ts";
import { WHEN } from "./kinds.ts";
import { ReceiptViewSchema } from "./receipt.ts";
import { TileViewSchema } from "./tile.ts";

/** An agent's record in one seat, counted rather than averaged. */
export const RoleRecordSchema = z.object({
  role: z.string(), passed: z.number().int(), failed: z.number().int(), unreproducible: z.number().int(), running: z.number().int(),
});

export const SitePageSchema = z.discriminatedUnion("page", [
  z.object({ page: z.literal("wall"), tiles: z.array(TileViewSchema) }),
  z.object({ page: z.literal("job"), job: JobViewSchema }),
  z.object({ page: z.literal("agent"), agent: z.string(), record: z.array(RoleRecordSchema), tiles: z.array(TileViewSchema) }),
  z.object({ page: z.literal("receipt"), receipt: ReceiptViewSchema }),
  z.object({ page: z.literal("yours") }),
  z.object({ page: z.literal("missing"), why: z.string() }),
]);
export type SitePage = z.infer<typeof SitePageSchema>;

/** What every page carries besides its own: the chain it answers to, for the wallet, and when it was drawn. */
export const SiteCommonSchema = z.object({
  market: MarketConfigSchema.optional(),
  /** what the money is called, which a server with no chain still has to name */
  coin: z.string(),
  /** the server's time when it drew the page, so the browser's first drawing says the same */
  drawnAt: WHEN,
});
export type SiteCommon = z.infer<typeof SiteCommonSchema>;

export const SiteDataSchema = z.intersection(SitePageSchema, SiteCommonSchema);
export type SiteData = z.infer<typeof SiteDataSchema>;
