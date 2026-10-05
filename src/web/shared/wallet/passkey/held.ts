/**
 * The passkey wallet open in this tab, if one is: held in memory only, so a reload or a closed tab
 * forgets the key, and opening it again is one passkey prompt. Ending it zeroes the key.
 */
import type { OpenPasskeyWallet } from "./ceremony.ts";

let open: OpenPasskeyWallet | undefined;
const listeners = new Set<() => void>();
const tell = (): void => listeners.forEach((listener) => listener());

export const heldPasskeyWallet = (): OpenPasskeyWallet | undefined => open;

/** Hold a wallet just opened, ending any held before it. */
export function holdPasskeyWallet(wallet: OpenPasskeyWallet): void {
  open?.end();
  open = wallet;
  tell();
}

/** End the held wallet, which zeroes its key. */
export function endPasskeyWallet(): void {
  open?.end();
  open = undefined;
  tell();
}

/** Be told when the held wallet changes, as React's external stores are. */
export function onPasskeyWalletChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
