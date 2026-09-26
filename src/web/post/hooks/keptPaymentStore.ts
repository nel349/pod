import type { MarketConfig } from "../../../market.ts";
import { keepPayment, keptPaymentKey, readKeptPayment, type Kept } from "../state/index.ts";

/**
 * The browser's own storage for a payment not yet published. Storage can be refused (a private
 * window, a full disk, a browser that blocks it), and a page that cannot keep the payment must still
 * post: every read and write here gives up quietly, and the page carries on as it did before.
 */
export const keptPaymentStore = {
  read(market: MarketConfig): Kept | undefined {
    try {
      return readKeptPayment(localStorage.getItem(keptPaymentKey(market.chainId, market.jobs)));
    } catch {
      return undefined;
    }
  },
  write(market: MarketConfig, kept: Kept): void {
    try {
      localStorage.setItem(keptPaymentKey(market.chainId, market.jobs), keepPayment(kept));
    } catch {
      // not kept: the page still finishes it for as long as it stays open
    }
  },
  forget(market: MarketConfig): void {
    try {
      localStorage.removeItem(keptPaymentKey(market.chainId, market.jobs));
    } catch {
      // nothing was kept, or it cannot be reached: either way there is nothing to finish on return
    }
  },
};
