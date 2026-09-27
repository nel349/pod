import { useQuery } from "@tanstack/react-query";
import { claimApiPath } from "../../../routes.ts";
import { readAnswer } from "../../shared/index.ts";
import { ClaimableSchema, NotClaimableSchema, WhySchema, type Claimable } from "../state/index.ts";
import { CLAIM_QUERY_KEYS } from "./queryKeys.ts";

export type ClaimableState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly why: string }
  | { readonly kind: "nothing"; readonly why: string; readonly job?: string }
  | { readonly kind: "ready"; readonly claimable: Claimable };

type Answer = { readonly isClaimable: true; readonly claimable: Claimable } | { readonly isClaimable: false; readonly why: string; readonly job?: string };

/** What there is to claim, or why nothing is, which is an answer and not a failure. */
async function fetchClaimable(jobId: string): Promise<Answer> {
  const response = await fetch(claimApiPath(jobId), { cache: "no-store" });
  if (response.status === 404) return { isClaimable: false, ...(await readAnswer(response, NotClaimableSchema)) };
  if (!response.ok) throw new Error((await readAnswer(response, WhySchema)).why);
  return { isClaimable: true, claimable: await readAnswer(response, ClaimableSchema) };
}

/** What there is to claim on this job, and who holds its title right now. */
export function useClaimable(jobId: string): ClaimableState {
  const answer = useQuery({ queryKey: CLAIM_QUERY_KEYS.claimable(jobId), queryFn: () => fetchClaimable(jobId), retry: false });
  if (answer.isPending) return { kind: "loading" };
  if (answer.isError) return { kind: "failed", why: answer.error.message };
  const found = answer.data;
  if (!found.isClaimable) return { kind: "nothing", why: found.why, ...(found.job ? { job: found.job } : {}) };
  return { kind: "ready", claimable: found.claimable };
}
