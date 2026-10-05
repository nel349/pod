import { useQuery } from "@tanstack/react-query";
import { ChainJobSchema } from "../../../chainJob.ts";
import type { MarketConfig } from "../../../market.ts";
import { chainJobPath } from "../../../routes.ts";
import { readAnswer } from "../../shared/index.ts";
import { QUERY_KEYS } from "./queryKeys.ts";

/** how often the server is asked whether an approved job has reached the wall yet */
const WALL_EVERY_MS = 5000;

/**
 * Where a paid job is on the wall, once its poster approved it and the server put it there: asked of
 * the server, which is the one that puts it there, until it says. Nothing is asked before approval.
 */
export function useWallPage(market: MarketConfig, onChainId: string, isApproved: boolean): string | undefined {
  const answer = useQuery({
    queryKey: QUERY_KEYS.wallPage(market.jobs, onChainId),
    queryFn: async () => (await readAnswer(await fetch(chainJobPath(onChainId, market.jobs), { cache: "no-store" }), ChainJobSchema)).page ?? null,
    enabled: isApproved,
    refetchInterval: (query) => (query.state.data ? false : WALL_EVERY_MS),
  });
  return answer.data ?? undefined;
}
