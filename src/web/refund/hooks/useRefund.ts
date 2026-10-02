import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useConfig } from "wagmi";
import { BaseError, ContractFunctionRevertedError } from "viem";
import { getConnection, simulateContract, switchChain, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { firstLine } from "../../../errors.ts";
import { podJobsAbi } from "../../../jobs.ts";
import { podJobsV2Abi } from "../../../jobsV2.ts";
import type { MarketConfig } from "../../../market.ts";
import { connected, SHARED_QUERY_KEYS } from "../../shared/index.ts";
import { refusalWords, type Refundable, type RefundStatus, type RefundStep, type Standing, type Way } from "../state/index.ts";
import { REFUND_QUERY_KEYS } from "./queryKeys.ts";

/**
 * Taking the money back: the poster's wallet asks the contract the job is on, and the page waits for
 * the chain. On the first contract that is reclaiming after the window; on the one that prepares jobs,
 * taking it back while nobody is seated, or closing it once the window has closed. The contract checks
 * everything (the poster, the window, the state), and its refusal is said by name.
 */
export function useRefund(job: Refundable, market: MarketConfig, way: Way, standing: Standing): { readonly status: RefundStatus; readonly refund: () => void } {
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
      const at = { account, address: job.jobs, args: [BigInt(job.onChainId)] as const, chainId: market.chainId };
      const hash = way === "first"
        ? await writeContract(config, (await simulateContract(config, { ...at, abi: podJobsAbi, functionName: "reclaim" })).request)
        : standing.kind === "take back now"
          ? await writeContract(config, (await simulateContract(config, { ...at, abi: podJobsV2Abi, functionName: "takeBack" })).request)
          : await writeContract(config, (await simulateContract(config, { ...at, abi: podJobsV2Abi, functionName: "close" })).request);
      doing("confirm");
      const receipt = await waitForTransactionReceipt(config, { hash, chainId: market.chainId });
      if (receipt.status !== "success") throw new Error("the chain refused it, so no money moved");
      return hash;
    },
    onSuccess: (hash) => {
      setStatus({ kind: "sent", hash });
      void client.invalidateQueries({ queryKey: REFUND_QUERY_KEYS.onChain(job.jobId) });
      // a payment the poster's wallet could not take is kept for it, which the page then offers to withdraw
      void client.invalidateQueries({ queryKey: SHARED_QUERY_KEYS.owed(market.jobs, getConnection(config).address ?? "") });
    },
    onError: (error) => setStatus({ kind: "stopped", step: step.current, why: refusalOf(error, way) }),
  });

  return { status, refund: () => refunding.mutate() };
}

/** Why it did not go, in words: the contract's refusal by name when it gave one, otherwise what was said. */
function refusalOf(error: unknown, way: Way): string {
  if (error instanceof BaseError) {
    const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
    const name = reverted instanceof ContractFunctionRevertedError ? reverted.data?.errorName : undefined;
    const words = name ? refusalWords(name, way) : undefined;
    if (words) return words;
  }
  return firstLine(error);
}
