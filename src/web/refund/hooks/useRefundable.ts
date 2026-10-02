import { useQuery } from "@tanstack/react-query";
import { isAddressEqual } from "viem";
import { ChainJobSchema } from "../../../chainJob.ts";
import type { MarketConfig } from "../../../market.ts";
import { chainJobPath, refundApiPath } from "../../../routes.ts";
import { readAnswer } from "../../shared/index.ts";
import { COPY, type OnChainNow, type Refundable, RefundableSchema, type RefundTarget, WhySchema } from "../state/index.ts";
import { REFUND_QUERY_KEYS } from "./queryKeys.ts";

export type RefundableState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly why: string }
  | { readonly kind: "ready"; readonly job: Refundable; readonly onChain: OnChainNow };

/**
 * The job, and where it stands on the contract it is on, both as the server reads them: it reads
 * Monad with the patience the public node needs. The refund itself goes from the wallet to the
 * contract, which is what decides whether it is allowed.
 */
export function useRefundable(target: Exclude<RefundTarget, { readonly by: "none" }>, market: MarketConfig): RefundableState {
  const jobId = target.by === "name" ? target.jobId : `#${target.onChainId}`;
  const job = useQuery({
    queryKey: REFUND_QUERY_KEYS.refundable(jobId),
    queryFn: async (): Promise<Refundable> => {
      // a job never published is on the chain only: its number, and its contract, are all there is to go on
      if (target.by === "number") return { jobId, idea: COPY.unpublished(target.onChainId), onChainId: target.onChainId, jobs: target.jobs ?? market.jobs };
      const response = await fetch(refundApiPath(target.jobId), { cache: "no-store" });
      if (!response.ok) throw new Error((await readAnswer(response, WhySchema)).why);
      return readAnswer(response, RefundableSchema);
    },
    retry: false,
  });
  const found = job.data;
  const onChain = useQuery({
    queryKey: REFUND_QUERY_KEYS.onChain(jobId),
    enabled: found !== undefined,
    queryFn: async (): Promise<OnChainNow> => {
      // a number with no contract named is looked for on the one jobs are posted to now, then the one before
      const named = target.by === "name" || target.jobs !== undefined ? found?.jobs : undefined;
      const response = await fetch(chainJobPath(found?.onChainId ?? "", named), { cache: "no-store" });
      if (!response.ok) throw new Error((await readAnswer(response, WhySchema)).why);
      return readAnswer(response, ChainJobSchema);
    },
  });
  if (job.isError) return { kind: "failed", why: job.error.message };
  if (onChain.isError) return { kind: "failed", why: onChain.error.message };
  if (!job.data || !onChain.data) return { kind: "loading" };
  // the job is acted on where it was read, and only there: a link naming one contract never moves money on another
  const isNamed = target.by === "name" || target.jobs !== undefined;
  if (isNamed && !isAddressEqual(job.data.jobs, onChain.data.jobs)) return { kind: "failed", why: COPY.notThisContract(job.data.jobs) };
  return { kind: "ready", job: { ...job.data, jobs: onChain.data.jobs }, onChain: onChain.data };
}
