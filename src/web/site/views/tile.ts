import { z } from "zod";
import type { Tile } from "../../../gallery.ts";
import { standingWords } from "../../../gallery.ts";
import { receiptPath } from "../../../routes.ts";
import { SEATS } from "../../../seal.ts";
import { MODES, VerdictSchema, WEI } from "./kinds.ts";

/** A job on the wall, an agent's page or your own page. */
export const TileViewSchema = z.object({
  jobId: z.string(),
  idea: z.string(),
  verdict: VerdictSchema,
  standing: z.string(),
  mode: z.enum(MODES),
  price: WEI,
  commit: z.string().optional(),
  seconds: z.number().optional(),
  pod: z.array(z.object({ role: z.string(), agent: z.string() })),
  openSeats: z.number().int(),
  /** the receipt's page, when there is one */
  receipt: z.string().optional(),
});
export type TileView = z.infer<typeof TileViewSchema>;

/** @param hasReceipt whether a signed receipt is kept for it: a tile that names one is not enough */
export function tileView(tile: Tile, hasReceipt: boolean): TileView {
  return {
    jobId: tile.jobId, idea: tile.idea, verdict: tile.verdict, standing: standingWords(tile), mode: tile.mode,
    price: tile.price.toString(),
    ...(tile.commit ? { commit: tile.commit } : {}),
    ...(tile.seconds ? { seconds: tile.seconds } : {}),
    pod: tile.pod.map((seat) => ({ role: seat.role, agent: seat.agent })),
    openSeats: tile.verdict === "running" ? SEATS.filter((role) => !tile.pod.some((seat) => seat.role === role)).length : 0,
    ...(hasReceipt ? { receipt: receiptPath(tile.jobId) } : {}),
  };
}
