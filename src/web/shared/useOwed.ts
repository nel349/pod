import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useConfig } from "wagmi";
import { getConnection, getPublicClient, simulateContract, switchChain, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import type { Address } from "viem";
import { firstLine } from "../../errors.ts";
import { podJobsV2Abi } from "../../jobsV2.ts";
import type { MarketConfig } from "../../market.ts";
import { SHARED_QUERY_KEYS } from "./queryKeys.ts";

export type WithdrawStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "working" }
  | { readonly kind: "done" }
  | { readonly kind: "stopped"; readonly why: string };

/**
 * What a payment could not deliver to this wallet, which the contract that prepares jobs keeps for it
 * (V4), and withdrawing it to the same wallet. On the first contract nothing is ever kept back.
 */
export function useOwed(market: MarketConfig, wallet: Address | undefined): {
  readonly owed: bigint | undefined;
  readonly status: WithdrawStatus;
  readonly withdraw: () => void;
} {
  const config = useConfig();
  const client = useQueryClient();
  const [status, setStatus] = useState<WithdrawStatus>({ kind: "idle" });
  const owed = useQuery({
    queryKey: SHARED_QUERY_KEYS.owed(market.jobs, wallet ?? ""),
    enabled: wallet !== undefined && market.writing !== undefined,
    queryFn: async (): Promise<bigint> => {
      const publicClient = getPublicClient(config, { chainId: market.chainId });
      if (!publicClient || !wallet) return 0n;
      return publicClient.readContract({ address: market.jobs, abi: podJobsV2Abi, functionName: "owed", args: [wallet] });
    },
  });
  const withdrawing = useMutation({
    mutationFn: async () => {
      if (!wallet) throw new Error("connect the wallet it is waiting for");
      if (getConnection(config).chainId !== market.chainId) await switchChain(config, { chainId: market.chainId });
      const { request } = await simulateContract(config, {
        account: wallet, address: market.jobs, abi: podJobsV2Abi, functionName: "withdraw", args: [wallet], chainId: market.chainId,
      });
      const receipt = await waitForTransactionReceipt(config, { hash: await writeContract(config, request), chainId: market.chainId });
      if (receipt.status !== "success") throw new Error("the chain refused it, so nothing moved");
    },
    onMutate: () => setStatus({ kind: "working" }),
    onSuccess: () => setStatus({ kind: "done" }),
    onError: (error) => setStatus({ kind: "stopped", why: firstLine(error) }),
    onSettled: () => void client.invalidateQueries({ queryKey: SHARED_QUERY_KEYS.owed(market.jobs, wallet ?? "") }),
  });
  return { owed: owed.data, status, withdraw: () => withdrawing.mutate() };
}
