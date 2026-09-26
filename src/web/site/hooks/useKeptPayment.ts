import { useEffect, useState } from "react";
import type { MarketConfig } from "../../../market.ts";
import { keptPaymentStore } from "../../post/hooks/index.ts";
import type { Kept } from "../../post/state/index.ts";

/** A payment this browser sent for a job it never published, read once the page is in the browser. */
export function useKeptPayment(market: MarketConfig): Kept | undefined {
  const [kept, setKept] = useState<Kept | undefined>(undefined);
  useEffect(() => setKept(keptPaymentStore.read(market)), [market]);
  return kept;
}
