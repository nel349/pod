import { useState } from "react";
import type { Now } from "../../../preparing/records.ts";

/**
 * When the page first saw the writing waiting or under way, for the clock beside it: one clock from
 * waiting through writing to trying, not one per stage. Follows the state while rendering, as React
 * recommends for state that follows another value, rather than in an effect that would draw twice.
 */
export function useBusySince(now: Now | undefined): number | undefined {
  const isBusy = now !== undefined && now.kind !== "idle";
  const [seen, setSeen] = useState<{ readonly isBusy: boolean; readonly since: number }>({ isBusy, since: Date.now() });
  if (seen.isBusy !== isBusy) setSeen({ isBusy, since: Date.now() });
  return isBusy ? seen.since : undefined;
}
