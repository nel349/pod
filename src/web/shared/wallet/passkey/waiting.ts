/**
 * What the passkey wallet is waiting for while a payment is on its way, if it is waiting for anything.
 *
 * The wallet is asked to send and answers when it has: a page cannot see inside that. When the
 * wallet has to wait on the network, it says so here, so the page can tell the person why nothing
 * seems to be happening, in the page's own words.
 */

/**
 * "settling": the wallet's money has only just arrived, and the network is given a moment to know it.
 * "another way": the chain's endpoint is refusing the wallet for now, so the payment goes through another.
 */
export const WALLET_WAITS = ["settling", "another way"] as const;
export type WalletWaits = (typeof WALLET_WAITS)[number];

let waiting: WalletWaits | undefined;
const listeners = new Set<() => void>();

export const walletWaits = (): WalletWaits | undefined => waiting;

/** Say what the wallet is waiting for, or with nothing, that it no longer is. */
export function sayTheWalletWaits(what?: WalletWaits): void {
  if (waiting === what) return;
  waiting = what;
  listeners.forEach((listener) => listener());
}

/** Be told when what the wallet waits for changes, as React's external stores are. */
export function onWalletWaits(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
