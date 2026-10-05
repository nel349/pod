import { isHex, type Hex } from "viem";

/**
 * The open wallet's key, kept for this tab and no longer.
 *
 * A passkey wallet worked out on the page alone is gone on every reload, which asks the person for
 * their face again to see the page they were already on. So the key it derives is kept in the tab's
 * own storage: a reload or a link opened in place finds it; a new tab does not; closing the tab ends
 * it, and so does locking the wallet, which clears this.
 *
 * It is the spending key of the first account, never the recovery phrase, so what is here opens this
 * wallet and nothing else the passkey could derive. Anything that can run a script on this page could
 * read it, which was already true of the key in memory; what changes is only how long that lasts.
 */
const KEPT = "pod.passkey.key";

/** Keep the open wallet's key for this tab. A browser that refuses storage simply keeps nothing. */
export function keepForThisTab(key: Hex): void {
  try {
    sessionStorage.setItem(KEPT, key);
  } catch {
    // private browsing, or storage turned off: the wallet still works, it just asks again after a reload
  }
}

/** The key this tab kept, if it is still there and reads as a key. */
export function keptForThisTab(): Hex | undefined {
  try {
    const kept = sessionStorage.getItem(KEPT);
    return kept !== null && isHex(kept) && kept.length === 66 ? kept : undefined;
  } catch {
    return undefined;
  }
}

/** Forget it: what locking the wallet does, and what closing the tab does by itself. */
export function forgetForThisTab(): void {
  try {
    sessionStorage.removeItem(KEPT);
  } catch {
    // nothing was kept
  }
}
