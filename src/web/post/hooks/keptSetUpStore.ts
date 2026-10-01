import type { MarketConfig } from "../../../market.ts";
import { keepSetUp, keptSetUpKey, readKeptSetUp, type KeptSetUp } from "../state/index.ts";

/**
 * The browser's own storage for a job paid for and not yet set up. Storage can be refused, and a page
 * that cannot keep it must still post: every read and write here gives up quietly.
 */
export const keptSetUpStore = {
  read(market: MarketConfig): KeptSetUp | undefined {
    try {
      return readKeptSetUp(localStorage.getItem(keptSetUpKey(market.chainId, market.jobs)));
    } catch {
      return undefined;
    }
  },
  write(market: MarketConfig, kept: KeptSetUp): void {
    try {
      localStorage.setItem(keptSetUpKey(market.chainId, market.jobs), keepSetUp(kept));
    } catch {
      // not kept: the page still finishes it for as long as it stays open
    }
  },
  forget(market: MarketConfig): void {
    try {
      localStorage.removeItem(keptSetUpKey(market.chainId, market.jobs));
    } catch {
      // nothing was kept, or it cannot be reached: either way there is nothing to finish on return
    }
  },
};
