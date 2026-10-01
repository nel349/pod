import { useEffect, useState } from "react";
import type { MarketConfig } from "../../../market.ts";
import { keptPaymentStore, keptSetUpStore, type Kept, type KeptSetUp } from "../../post/index.ts";

/**
 * A payment this browser sent and never finished, read once the page is in the browser: on a contract
 * that prepares jobs, one never sent to be written; otherwise, one never published.
 */
export type KeptHere =
  | { readonly kind: "payment"; readonly kept: Kept; readonly onChainId: string | undefined }
  | { readonly kind: "setUp"; readonly kept: KeptSetUp; readonly onChainId: string | undefined };

export function useKeptPayment(market: MarketConfig): KeptHere | undefined {
  const [kept, setKept] = useState<KeptHere | undefined>(undefined);
  useEffect(() => {
    if (market.writing) {
      const setUp = keptSetUpStore.read(market);
      setKept(setUp ? { kind: "setUp", kept: setUp, onChainId: setUp.onChainId } : undefined);
      return;
    }
    const payment = keptPaymentStore.read(market);
    setKept(payment ? { kind: "payment", kept: payment, onChainId: payment.payment.onChainId } : undefined);
  }, [market]);
  return kept;
}
