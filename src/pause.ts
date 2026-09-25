/**
 * Waiting between looks, for the loops that look again every few seconds: the worker and the
 * reference agent. A stop ends the wait at once, and a wait that ends on its own leaves nothing
 * listening on the stop: these loops run for days, and a listener left behind each look adds up.
 */
import { setTimeout as sleep } from "node:timers/promises";

export async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  try {
    await sleep(ms, undefined, { signal });
  } catch (error) {
    if (!signal?.aborted) throw error;
  }
}
