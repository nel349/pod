import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useConfig } from "wagmi";
import { getPublicClient } from "wagmi/actions";
import { readJobV2, type JobV2 } from "../../../jobsV2.ts";
import type { MarketConfig } from "../../../market.ts";
import { QUERY_KEYS } from "./queryKeys.ts";

/** how often the chain is asked whether the job has moved on, since another tab or the poster's wallet may move it */
const CHAIN_EVERY_MS = 4000;

/** The job as the chain has it now, asked again every few seconds. */
export function useChainJobV2(market: MarketConfig, onChainId: string): UseQueryResult<JobV2 | null, Error> {
  const config = useConfig();
  return useQuery({
    queryKey: QUERY_KEYS.chainJob(market.jobs, onChainId),
    queryFn: async (): Promise<JobV2 | null> => {
      const publicClient = getPublicClient(config, { chainId: market.chainId });
      if (!publicClient) throw new Error(`this page cannot reach ${market.chainName}`);
      return (await readJobV2({ address: market.jobs, publicClient }, BigInt(onChainId))) ?? null;
    },
    refetchInterval: CHAIN_EVERY_MS,
  });
}
