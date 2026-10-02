import { useEffect, useState } from "react";
import type { MarketConfig } from "../../../market.ts";
import { keptPaymentStore, keptSetUpStillWaits, keptSetUpStore, type Kept, type KeptSetUp } from "../../post/index.ts";

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
      if (!setUp) return undefined;
      // shown only while its job still waits to be set up; one taken back or set up since is let go
      let isCurrent = true;
      void keptSetUpStillWaits(market, setUp).then((waits) => {
        if (!isCurrent) return;
        if (waits) setKept({ kind: "setUp", kept: setUp, onChainId: setUp.onChainId });
        else keptSetUpStore.forget(market);
      });
      return () => { isCurrent = false; };
    }
    const payment = keptPaymentStore.read(market);
    setKept(payment ? { kind: "payment", kept: payment, onChainId: payment.payment.onChainId } : undefined);
    return undefined;
  }, [market]);
  return kept;
}
