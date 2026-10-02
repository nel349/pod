import { isAddressEqual } from "viem";
import { ChainJobSchema } from "../../../chainJob.ts";
import type { MarketConfig } from "../../../market.ts";
import { chainJobPath } from "../../../routes.ts";
import { readAnswer } from "../../shared/index.ts";
import type { KeptSetUp } from "../state/index.ts";

/**
 * Whether a payment kept in this browser can still be finished: its job is still preparing, and still
 * this poster's. A job taken back, or approved from somewhere else, has nothing left to finish. When
 * the chain cannot be read just now the answer is yes: a kept payment is let go only on the chain's word.
 */
export async function keptSetUpStillWaits(market: MarketConfig, kept: KeptSetUp): Promise<boolean> {
  if (kept.onChainId === undefined) return true;
  try {
    const response = await fetch(chainJobPath(kept.onChainId, market.jobs), { cache: "no-store" });
    if (!response.ok) return true;
    const job = await readAnswer(response, ChainJobSchema);
    return job.state === "preparing" && isAddressEqual(job.poster, kept.poster);
  } catch {
    return true;
  }
}
