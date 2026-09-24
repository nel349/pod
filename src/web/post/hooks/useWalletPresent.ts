import { useQuery } from "@tanstack/react-query";
import { useConfig } from "wagmi";
import { hasWalletInTheBrowser } from "../wallet/index.ts";
import { QUERY_KEYS } from "./queryKeys.ts";

/** Whether this browser has a wallet in it at all, which decides what the pay button offers. */
export function useWalletPresent(): boolean {
  const config = useConfig();
  const { data: hasWallet } = useQuery({
    queryKey: QUERY_KEYS.walletPresent(),
    queryFn: () => hasWalletInTheBrowser(config),
    staleTime: Infinity,
  });
  return hasWallet ?? false;
}
