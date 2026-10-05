import { useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { useConfig } from "wagmi";
import { injectedConnector } from "./wallet/index.ts";
import { hasRememberedPasskey, heldPasskeyWallet, onPasskeyWalletChange } from "./wallet/passkey/index.ts";
import { SHARED_QUERY_KEYS } from "./queryKeys.ts";

/** Whether this browser has a wallet of its own in it, such as MetaMask or Rabby: asked once. */
export function useBrowserWalletPresent(): boolean {
  const config = useConfig();
  const { data: hasWallet } = useQuery({
    queryKey: SHARED_QUERY_KEYS.walletPresent(),
    queryFn: async () => Boolean(await injectedConnector(config).getProvider()),
    staleTime: Infinity,
  });
  return hasWallet ?? false;
}

/** Whether the page has a wallet to pay with: one in the browser, or a passkey wallet it can open. */
export function useWalletPresent(): boolean {
  const hasBrowserWallet = useBrowserWalletPresent();
  const hasPasskeyWallet = useSyncExternalStore(onPasskeyWalletChange, () => heldPasskeyWallet() !== undefined || hasRememberedPasskey(), () => false);
  return hasBrowserWallet || hasPasskeyWallet;
}
