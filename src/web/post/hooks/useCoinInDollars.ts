import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { ROUTES } from "../../../routes.ts";
import { QUERY_KEYS } from "./queryKeys.ts";

/** What the server says one of the chain's coins is worth in dollars, and when it read it. */
const RateSchema = z.object({ usd: z.number().positive(), at: z.string(), from: z.string() });
export type Rate = z.infer<typeof RateSchema>;

/** how long the page keeps the rate before asking again: the server keeps one for five minutes anyway */
const A_RATE_LASTS_MS = 5 * 60_000;

/**
 * What one coin is worth in dollars, asked of this server, which reads it from a free price endpoint.
 *
 * Nothing waits for it and nothing breaks without it: a page that has no rate asks for a price in the
 * coin, as it always did. It is never asked again after a failure, since a poster is not kept waiting
 * on a price feed, and the server answers from one reading for minutes at a time.
 */
export function useCoinInDollars(): Rate | undefined {
  const answer = useQuery({
    queryKey: QUERY_KEYS.coinInDollars(),
    queryFn: async () => {
      const said = await fetch(ROUTES.price, { cache: "no-store" });
      if (!said.ok) return null;
      const read = RateSchema.safeParse(await said.json());
      return read.success ? read.data : null;
    },
    staleTime: A_RATE_LASTS_MS,
    retry: false,
  });
  return answer.data ?? undefined;
}
