import { useQuery } from "@tanstack/react-query";
import { useConfig } from "wagmi";
import { SHARED_QUERY_KEYS } from "./queryKeys.ts";
import { hasWalletInTheBrowser } from "./wallet/index.ts";

/** Whether this browser has a wallet in it at all, which decides what the header and the pay button offer. */
export function useWalletPresent(): boolean {
  const config = useConfig();
  const { data: hasWallet } = useQuery({
    queryKey: SHARED_QUERY_KEYS.walletPresent(),
    queryFn: () => hasWalletInTheBrowser(config),
    staleTime: Infinity,
  });
  return hasWallet ?? false;
}
