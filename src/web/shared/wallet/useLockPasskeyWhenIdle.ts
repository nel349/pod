import { useEffect, useSyncExternalStore } from "react";
import { useConfig } from "wagmi";
import { disconnect, getConnection } from "wagmi/actions";
import { endPasskeyWallet, heldPasskeyWallet, onPasskeyWalletChange, PASSKEY_CONNECTOR_ID } from "./passkey/index.ts";

/** how long a passkey wallet stays open with nobody touching the page */
export const PASSKEY_IDLE_LOCK_MS = 15 * 60_000;

/** what counts as somebody being at the page */
const ACTIVITY = ["pointerdown", "keydown", "scroll", "touchstart"] as const;

/**
 * Call `lock` once nobody has been at the page for `idleMs`: any activity on `at` starts the wait again.
 * Gives back how to stop watching.
 */
export function lockWhenIdle(input: { readonly idleMs: number; readonly lock: () => void; readonly at: EventTarget }): () => void {
  let timer = setTimeout(input.lock, input.idleMs);
  const stillHere = (): void => {
    clearTimeout(timer);
    timer = setTimeout(input.lock, input.idleMs);
  };
  for (const event of ACTIVITY) input.at.addEventListener(event, stillHere, { passive: true });
  return () => {
    clearTimeout(timer);
    for (const event of ACTIVITY) input.at.removeEventListener(event, stillHere);
  };
}

/**
 * A passkey wallet open with nobody at the page is locked: its key is zeroed and it is disconnected, so
 * a tab left open is not a wallet left open. Opening it again is one passkey prompt.
 */
export function useLockPasskeyWhenIdle(idleMs: number = PASSKEY_IDLE_LOCK_MS): void {
  const config = useConfig();
  const open = useSyncExternalStore(onPasskeyWalletChange, heldPasskeyWallet, () => undefined);
  useEffect(() => {
    if (!open) return;
    return lockWhenIdle({
      idleMs,
      at: window,
      lock: () => {
        endPasskeyWallet();
        // the key is gone either way; a disconnect that fails leaves a connection with nothing to sign with, which asks for the passkey again
        if (getConnection(config).connector?.id === PASSKEY_CONNECTOR_ID) void disconnect(config).catch(() => undefined);
      },
    });
  }, [open, config, idleMs]);
}
