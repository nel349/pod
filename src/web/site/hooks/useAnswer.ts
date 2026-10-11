import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { BaseError, ContractFunctionRevertedError, isAddress, type Hex } from "viem";
import { useConfig } from "wagmi";
import { getConnection, simulateContract, switchChain, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { firstLine } from "../../../errors.ts";
import { podJobsV3Abi } from "../../../jobsV3.ts";
import type { MarketConfig } from "../../../market.ts";
import { connected, withStatedGas } from "../../shared/index.ts";
import { SITE } from "../copy.ts";
import { SITE_QUERY_KEYS } from "./queryKeys.ts";

/** What a poster says to a delivery: yes, or no. */
export type Saying = "accept" | "refuse";
export type AnswerStep = keyof typeof SITE.job.answer.working;

export type AnswerStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "working"; readonly saying: Saying; readonly step: AnswerStep }
  | { readonly kind: "sent"; readonly saying: Saying; readonly hash: Hex }
  | { readonly kind: "stopped"; readonly why: string };

const REFUSED: ReadonlyMap<string, string> = new Map(Object.entries(SITE.job.answer.refused));

/** Why it did not go, in words: the contract's refusal by name when it gave one, otherwise what was said. */
function whyNot(error: unknown): string {
  if (error instanceof BaseError) {
    const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
    const name = reverted instanceof ContractFunctionRevertedError ? reverted.data?.errorName : undefined;
    const words = name ? REFUSED.get(name) : undefined;
    if (words) return words;
  }
  return firstLine(error);
}

/**
 * A poster's answer to a delivery, sent by their own wallet to the contract the job is on. The
 * contract checks everything (that it is the poster, that the job is delivered, that a refusal is in
 * time) and its refusal is said by name. Either answer pays whoever sends it, so its gas is stated.
 */
export function useAnswer(job: { readonly jobId: string; readonly onChainId: string; readonly jobs: string }, market: MarketConfig): {
  readonly status: AnswerStatus;
  readonly say: (saying: Saying) => void;
} {
  const config = useConfig();
  const client = useQueryClient();
  const [status, setStatus] = useState<AnswerStatus>({ kind: "idle" });
  const saying = useRef<Saying>("accept");
  const doing = (step: AnswerStep): void => setStatus({ kind: "working", saying: saying.current, step });

  const answering = useMutation({
    mutationFn: async (said: Saying) => {
      saying.current = said;
      if (!isAddress(job.jobs)) throw new Error("this job names no contract to answer on");
      doing("wallet");
      const account = await connected(config);
      if (getConnection(config).chainId !== market.chainId) await switchChain(config, { chainId: market.chainId });
      doing("send");
      // asked first without sending, so a refusal comes back with the contract's reason, not a failed transaction
      const { request } = await simulateContract(config, {
        account, address: job.jobs, abi: podJobsV3Abi, functionName: said, args: [BigInt(job.onChainId)], chainId: market.chainId,
      });
      const hash = await writeContract(config, await withStatedGas(config, market.chainId, request));
      doing("confirm");
      const receipt = await waitForTransactionReceipt(config, { hash, chainId: market.chainId });
      if (receipt.status !== "success") throw new Error("the chain refused it, so no money moved");
      return hash;
    },
    onSuccess: (hash) => {
      setStatus({ kind: "sent", saying: saying.current, hash });
      void client.invalidateQueries({ queryKey: SITE_QUERY_KEYS.job(job.jobId) });
    },
    onError: (error) => setStatus({ kind: "stopped", why: whyNot(error) }),
  });

  return { status, say: (said) => answering.mutate(said) };
}
