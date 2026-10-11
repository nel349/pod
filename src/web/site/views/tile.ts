import { z } from "zod";
import type { Tile } from "../../../gallery.ts";
import { standingWords } from "../../../gallery.ts";
import { receiptPath } from "../../../routes.ts";
import { SEATS } from "../../../seal.ts";
import { AnswerSchema, type Answer } from "./answer.ts";
import { MODES, VerdictSchema, WEI } from "./kinds.ts";

/** A job on the wall, an agent's page or your own page. */
export const TileViewSchema = z.object({
  jobId: z.string(),
  idea: z.string(),
  verdict: VerdictSchema,
  /** where it stands with its poster, once delivered on the contract where they have the last word */
  answer: AnswerSchema.optional(),
  standing: z.string(),
  mode: z.enum(MODES),
  price: WEI,
  commit: z.string().optional(),
  seconds: z.number().optional(),
  pod: z.array(z.object({ role: z.string(), agent: z.string() })),
  openSeats: z.number().int(),
  /** the receipt's page, when there is one */
  receipt: z.string().optional(),
  /** where the website it delivered is live now, for one thing to press on its card */
  live: z.string().optional(),
});
export type TileView = z.infer<typeof TileViewSchema>;

/** What a delivered job's standing says, which is about its poster's answer more than about its checks. */
const ANSWER_WORDS: Record<Answer, string> = {
  awaited: "delivered, waiting for its poster",
  accepted: "accepted by its poster",
  refused: "refused by its poster",
  unanswered: "its poster said nothing, so its checks decided",
};

/** Where a job stands, in words: with its poster once it is delivered, and by its verdict before or without that. */
export function standingOf(tile: Pick<Tile, "verdict" | "pod">, answer: Answer | undefined): string {
  return answer ? ANSWER_WORDS[answer] : standingWords(tile);
}

/**
 * @param hasReceipt whether a signed receipt is kept for it: a tile that names one is not enough
 * @param answer where it stands with its poster, when it was delivered to one who has the last word
 */
export function tileView(tile: Tile, hasReceipt: boolean, answer?: Answer, liveAt?: string): TileView {
  return {
    jobId: tile.jobId, idea: tile.idea, verdict: tile.verdict, ...(answer ? { answer } : {}), standing: standingOf(tile, answer), mode: tile.mode,
    price: tile.price.toString(),
    ...(tile.commit ? { commit: tile.commit } : {}),
    ...(tile.seconds ? { seconds: tile.seconds } : {}),
    pod: tile.pod.map((seat) => ({ role: seat.role, agent: seat.agent })),
    openSeats: tile.verdict === "running" ? SEATS.filter((role) => !tile.pod.some((seat) => seat.role === role)).length : 0,
    ...(hasReceipt ? { receipt: receiptPath(tile.jobId) } : {}),
    ...(liveAt ? { live: liveAt } : {}),
  };
}
