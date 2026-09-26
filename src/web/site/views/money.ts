import { z } from "zod";
import { refundPath } from "../../../routes.ts";
import type { JobRecord } from "../../../store.ts";
import type { ChainSays } from "./job.ts";
import { MS_IN_A_SECOND, WHEN } from "./kinds.ts";

/**
 * Where the poster's money is. It sits in the contract while the pod works; the verdict pays the pod
 * or gives it back; and money nobody settled is the poster's to take back once the window closes.
 */
export const MoneyViewSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("held"), endsAt: WHEN, takeBack: z.string() }),
  z.object({ kind: z.literal("returnable"), takeBack: z.string() }),
  z.object({ kind: z.literal("paid") }),
  z.object({ kind: z.literal("refunded") }),
]);
export type MoneyView = z.infer<typeof MoneyViewSchema>;

/** Money held past its window is returnable: the page works this out again as the clock moves. */
export function moneyAt(money: MoneyView, now: Date): MoneyView {
  return money.kind === "held" && new Date(money.endsAt) <= now ? { kind: "returnable", takeBack: money.takeBack } : money;
}

/**
 * Whether the record alone can say where the money is. A job still in its window, or settled, can;
 * one past its window, or one the runs disagreed on, may have been taken back since, and only the
 * contract knows.
 */
export function needsTheChainForMoney(record: JobRecord, now: Date): boolean {
  if (!record.chain || record.chain.settled) return false;
  if (record.tile.verdict === "not-reproducible") return true;
  return record.tile.verdict === "running" && (!record.brief || new Date(record.brief.endsAt) <= now);
}

/** Where the money for a job is, from its record and, when it had to be asked, the chain. */
export function moneyOf(record: JobRecord, onChain: ChainSays["onChain"]): MoneyView | undefined {
  if (!record.chain) return undefined;
  const takeBack = refundPath(record.jobId);
  if (onChain?.state === "refunded") return { kind: "refunded" };
  if (onChain?.state === "settled") return record.tile.verdict === "failed" ? { kind: "refunded" } : { kind: "paid" };
  if (record.tile.verdict === "passed") return { kind: "paid" };
  if (record.tile.verdict === "failed") return { kind: "refunded" };
  const endsAt = onChain ? new Date(Number(onChain.endsAt) * MS_IN_A_SECOND).toISOString() : record.brief?.endsAt;
  return endsAt ? { kind: "held", endsAt, takeBack } : { kind: "returnable", takeBack };
}
