import { useQuery } from "@tanstack/react-query";
import { useConfig } from "wagmi";
import { getBlock, readContract } from "wagmi/actions";
import { podJobsAbi, stateOf } from "../../../jobs.ts";
import type { MarketConfig } from "../../../market.ts";
import { refundApiPath } from "../../../routes.ts";
import { readAnswer } from "../../post/hooks/index.ts";
import { RefundableSchema, WhySchema, type OnChainNow, type Refundable } from "../state/index.ts";
import { REFUND_QUERY_KEYS } from "./queryKeys.ts";

export type RefundableState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly why: string }
  | { readonly kind: "ready"; readonly job: Refundable; readonly onChain: OnChainNow };

/** The job, from the server, and where it stands, from the chain itself: the chain is what decides. */
export function useRefundable(jobId: string, market: MarketConfig): RefundableState {
  const config = useConfig();
  const job = useQuery({
    queryKey: REFUND_QUERY_KEYS.refundable(jobId),
    queryFn: async () => {
      const response = await fetch(refundApiPath(jobId), { cache: "no-store" });
      if (!response.ok) throw new Error((await readAnswer(response, WhySchema)).why);
      return readAnswer(response, RefundableSchema);
    },
    retry: false,
  });
  const onChainId = job.data?.onChainId;
  const onChain = useQuery({
    queryKey: REFUND_QUERY_KEYS.onChain(jobId),
    enabled: onChainId !== undefined,
    queryFn: async (): Promise<OnChainNow> => {
      const [poster, price, , endsAt, state] = await readContract(config, {
        address: market.jobs, abi: podJobsAbi, functionName: "jobs", args: [BigInt(onChainId ?? "0")], chainId: market.chainId,
      });
      const block = await getBlock(config, { chainId: market.chainId });
      return { poster, price, endsAt, state: stateOf(state), now: block.timestamp };
    },
  });
  if (job.isError) return { kind: "failed", why: job.error.message };
  if (onChain.isError) return { kind: "failed", why: onChain.error.message };
  if (!job.data || !onChain.data) return { kind: "loading" };
  return { kind: "ready", job: job.data, onChain: onChain.data };
}
