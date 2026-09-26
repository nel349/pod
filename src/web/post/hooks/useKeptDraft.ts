import { useEffect } from "react";
import type { MarketConfig } from "../../../market.ts";
import { isWorthKeeping, keepDraft, type Draft, type DraftForm, type WrittenFor } from "../state/index.ts";
import { draftStore } from "./draftStore.ts";

/**
 * Keep the draft as it changes, until the job is paid for: from then on the kept payment is what
 * brings the poster back, and a draft beside it would be a second, older copy of the same job. It is
 * written only when what would be kept has changed, not on every drawing of the page.
 */
export function useKeptDraft(market: MarketConfig, form: DraftForm, written: WrittenFor | undefined, isPaidFor: boolean): void {
  const draft: Draft = { form, ...(written ? { written } : {}) };
  const kept = !isPaidFor && isWorthKeeping(draft) ? keepDraft(draft) : undefined;
  useEffect(() => {
    if (kept === undefined) draftStore.forget(market);
    else draftStore.write(market, kept);
  }, [market, kept]);
}
