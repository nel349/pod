import { useQuery } from "@tanstack/react-query";
import { ChainJobSchema } from "../../../chainJob.ts";
import { chainJobPath, refundApiPath } from "../../../routes.ts";
import { readAnswer } from "../../shared/index.ts";
import { COPY, type OnChainNow, type Refundable, RefundableSchema, type RefundTarget, WhySchema } from "../state/index.ts";
import { REFUND_QUERY_KEYS } from "./queryKeys.ts";

export type RefundableState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly why: string }
  | { readonly kind: "ready"; readonly job: Refundable; readonly onChain: OnChainNow };

/**
 * The job, and where it stands on the chain, both as the server reads them: it reads Monad with the
 * patience the public node needs. The refund itself goes from the wallet to the contract, which is
 * what decides whether it is allowed.
 */
export function useRefundable(target: RefundTarget): RefundableState {
  const jobId = target.by === "name" ? target.jobId : `#${target.onChainId}`;
  const job = useQuery({
    queryKey: REFUND_QUERY_KEYS.refundable(jobId),
    queryFn: async (): Promise<Refundable> => {
      // a job never published is on the chain only: its number is all there is to go on
      if (target.by === "number") return { jobId, idea: COPY.unpublished(target.onChainId), onChainId: target.onChainId };
      const response = await fetch(refundApiPath(target.jobId), { cache: "no-store" });
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
      const response = await fetch(chainJobPath(onChainId ?? ""), { cache: "no-store" });
      if (!response.ok) throw new Error((await readAnswer(response, WhySchema)).why);
      return readAnswer(response, ChainJobSchema);
    },
  });
  if (job.isError) return { kind: "failed", why: job.error.message };
  if (onChain.isError) return { kind: "failed", why: onChain.error.message };
  if (!job.data || !onChain.data) return { kind: "loading" };
  return { kind: "ready", job: job.data, onChain: onChain.data };
}
