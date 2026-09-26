import { useQuery } from "@tanstack/react-query";
import { MarketConfigSchema, type MarketConfig } from "../../market.ts";
import { ROUTES } from "../../routes.ts";
import { SHARED_QUERY_KEYS } from "./queryKeys.ts";
import { readAnswer } from "./readAnswer.ts";

/**
 * Whether this server takes postings, and where to. A server with no contract answers 404, which is a
 * fact about the server rather than a failure, so it is a state of its own and not an error.
 */
export type MarketState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly why: string }
  | { readonly kind: "closed" }
  | { readonly kind: "open"; readonly market: MarketConfig };

type Answer = { readonly isOpen: false } | { readonly isOpen: true; readonly market: MarketConfig };

async function fetchMarket(): Promise<Answer> {
  const response = await fetch(ROUTES.market);
  if (response.status === 404) return { isOpen: false };
  if (!response.ok) throw new Error(`the server said ${response.status}`);
  return { isOpen: true, market: await readAnswer(response, MarketConfigSchema) };
}

export function useMarket(): MarketState {
  const answer = useQuery({ queryKey: SHARED_QUERY_KEYS.market(), queryFn: fetchMarket, staleTime: Infinity });
  if (answer.isPending) return { kind: "loading" };
  if (answer.isError) return { kind: "failed", why: answer.error.message };
  return answer.data.isOpen ? { kind: "open", market: answer.data.market } : { kind: "closed" };
}
