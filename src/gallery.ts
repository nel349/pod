/**
 * The wall's unit: one job, as a tile, and how it stands in words.
 *
 * Two rules every page drawing a tile keeps: nothing on it is a number we invented, and failures are
 * shown alongside successes. A wall with only successes on it is a marketing page.
 */
import type { Address, Hex } from "viem";

export interface Tile {
  readonly jobId: string;
  /** the idea, in the words it was posted in */
  readonly idea: string;
  readonly mode: "flash" | "sprint" | "project";
  readonly verdict: "passed" | "failed" | "not-reproducible" | "running";
  /** where the thing lives, while it lives. Absent once an unclaimed job is archived */
  readonly open?: string;
  readonly commit?: string;
  readonly seconds?: number;
  /** what the person paid, in the smallest unit */
  readonly price: bigint;
  readonly pod: readonly { readonly role: string; readonly agent: Address; readonly owner: Address }[];
  /** where the receipt sits, and its hash, so anyone can check the verdict themselves */
  readonly receiptURI?: string;
  readonly receiptHash?: Hex;
  readonly finishedAt?: string;
}

/** What a verdict says on a tile, in words rather than a colour alone. */
export function verdictWords(verdict: Tile["verdict"]): string {
  switch (verdict) {
    case "passed": return "checks passed";
    case "failed": return "checks failed";
    case "not-reproducible": return "could not be reproduced";
    case "running": return "being built";
  }
}

/**
 * Where a job stands, in words: its verdict once it has one, and before that whether anybody has come
 * to build it. A job nobody has taken a seat on is not being built, and saying "running" of it
 * leaves its poster waiting on work nobody is doing.
 */
export function standingWords(tile: Pick<Tile, "verdict" | "pod">): string {
  if (tile.verdict === "running" && tile.pod.length === 0) return "waiting for a pod";
  return verdictWords(tile.verdict);
}
