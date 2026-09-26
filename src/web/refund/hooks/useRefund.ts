import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useConfig } from "wagmi";
import { BaseError, ContractFunctionRevertedError } from "viem";
import { getConnection, simulateContract, switchChain, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { firstLine } from "../../../errors.ts";
import { podJobsAbi } from "../../../jobs.ts";
import type { MarketConfig } from "../../../market.ts";
import { connected } from "../../shared/index.ts";
import { refusalWords, type Refundable, type RefundStatus, type RefundStep } from "../state/index.ts";
import { REFUND_QUERY_KEYS } from "./queryKeys.ts";

/**
 * Taking the money back: the poster's wallet asks the contract, and the page waits for the chain.
 * The contract checks everything (the poster, the window, the state), and its refusal is said by name.
 */
export function useRefund(job: Refundable, market: MarketConfig): { readonly status: RefundStatus; readonly refund: () => void } {
  const config = useConfig();
  const client = useQueryClient();
  const [status, setStatus] = useState<RefundStatus>({ kind: "idle" });
  const step = useRef<RefundStep>("wallet");
  const doing = (next: RefundStep): void => {
    step.current = next;
    setStatus({ kind: "working", step: next });
  };

  const refunding = useMutation({
    mutationFn: async () => {
      doing("wallet");
      const account = await connected(config);
      if (getConnection(config).chainId !== market.chainId) await switchChain(config, { chainId: market.chainId });
      doing("send");
      // asked first without sending, so a refusal comes back with the contract's reason, not a failed transaction
      const { request } = await simulateContract(config, {
        account, address: market.jobs, abi: podJobsAbi, functionName: "reclaim", args: [BigInt(job.onChainId)], chainId: market.chainId,
      });
      const hash = await writeContract(config, request);
      doing("confirm");
      const receipt = await waitForTransactionReceipt(config, { hash, chainId: market.chainId });
      if (receipt.status !== "success") throw new Error("the chain refused it, so no money moved");
      return hash;
    },
    onSuccess: (hash) => {
      setStatus({ kind: "sent", hash });
      void client.invalidateQueries({ queryKey: REFUND_QUERY_KEYS.onChain(job.jobId) });
    },
    onError: (error) => setStatus({ kind: "stopped", step: step.current, why: refusalOf(error) }),
  });

  return { status, refund: () => refunding.mutate() };
}

/** Why it did not go, in words: the contract's refusal by name when it gave one, otherwise what was said. */
function refusalOf(error: unknown): string {
  if (error instanceof BaseError) {
    const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
    const name = reverted instanceof ContractFunctionRevertedError ? reverted.data?.errorName : undefined;
    const words = name ? refusalWords(name) : undefined;
    if (words) return words;
  }
  return firstLine(error);
}
