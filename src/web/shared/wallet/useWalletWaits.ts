import { useSyncExternalStore } from "react";
import { onWalletWaits, walletWaits, type WalletWaits } from "./passkey/index.ts";

/** What the passkey wallet is waiting for while a payment is on its way, or nothing when it is not waiting. */
export function useWalletWaits(): WalletWaits | undefined {
  return useSyncExternalStore(onWalletWaits, walletWaits, () => undefined);
}
