import { useQuery } from "@tanstack/react-query";
import { claimApiPath } from "../../../routes.ts";
import { readAnswer } from "../../post/hooks/index.ts";
import { ClaimableSchema, WhySchema, type Claimable } from "../state/index.ts";
import { CLAIM_QUERY_KEYS } from "./queryKeys.ts";

export type ClaimableState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly why: string }
  | { readonly kind: "ready"; readonly claimable: Claimable };

async function fetchClaimable(jobId: string): Promise<Claimable> {
  const response = await fetch(claimApiPath(jobId), { cache: "no-store" });
  if (!response.ok) throw new Error((await readAnswer(response, WhySchema)).why);
  return readAnswer(response, ClaimableSchema);
}

/** What there is to claim on this job, and who holds its title right now. */
export function useClaimable(jobId: string): ClaimableState {
  const answer = useQuery({ queryKey: CLAIM_QUERY_KEYS.claimable(jobId), queryFn: () => fetchClaimable(jobId), retry: false });
  if (answer.isPending) return { kind: "loading" };
  if (answer.isError) return { kind: "failed", why: answer.error.message };
  return { kind: "ready", claimable: answer.data };
}
