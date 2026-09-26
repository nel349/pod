import type { MarketConfig } from "../../../market.ts";
import { draftKey, readDraft, type Draft } from "../state/index.ts";

/**
 * The browser's own storage for a draft. Storage can be refused, and a page that cannot keep a draft
 * still posts: every read and write here gives up quietly, and the page works as it did before.
 */
export const draftStore = {
  read(market: MarketConfig): Draft | undefined {
    try {
      return readDraft(localStorage.getItem(draftKey(market.chainId, market.jobs)));
    } catch {
      return undefined;
    }
  },
  /** @param kept the draft, as `keepDraft` writes it */
  write(market: MarketConfig, kept: string): void {
    try {
      localStorage.setItem(draftKey(market.chainId, market.jobs), kept);
    } catch {
      // not kept: the page still works for as long as it stays open
    }
  },
  forget(market: MarketConfig): void {
    try {
      localStorage.removeItem(draftKey(market.chainId, market.jobs));
    } catch {
      // nothing was kept, or it cannot be reached: either way nothing comes back
    }
  },
};
