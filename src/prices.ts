/**
 * What the chain's coin is worth in dollars, asked of CoinGecko's free endpoint.
 *
 * A price in MON means nothing to somebody deciding what a job is worth, so the posting page offers
 * its prices in dollars and says what each is in MON. The dollars are only words on a page: the
 * contract takes MON and nothing else, and the amount a poster pays is the MON amount they see.
 *
 * Nothing is invented. When the endpoint cannot be reached, or answers something this does not
 * recognise, there is no rate and the page asks for MON as it always did. One answer is kept for a
 * few minutes, since a page open for a while asks again and the endpoint is free and rate limited.
 */
import { z } from "zod";

/** Where the free endpoint lives, and the name it knows Monad's coin by */
const COINGECKO = "https://api.coingecko.com/api/v3/simple/price";
/** How long one answer is kept, so a hundred posting pages are a few asks and not a hundred */
export const A_RATE_IS_KEPT_FOR_MS = 5 * 60_000;
/** How long the endpoint has to answer before the page is served without a rate */
const IT_HAS_TO_ANSWER_WITHIN_MS = 3_000;

const AnswerSchema = z.record(z.string(), z.object({ usd: z.number().positive() }));

/** What one of the chain's coins is worth in dollars, and when that was asked. */
export interface Rate {
  /** dollars for one coin */
  readonly usd: number;
  /** when it was read, so a page can say how fresh it is */
  readonly at: string;
  /** who said so, named on the page beside the figure */
  readonly from: string;
}

export interface Rates {
  /** The rate now, or nothing when there is none to be had. Never throws: a page without it is still a page. */
  now(): Promise<Rate | undefined>;
}

/**
 * The rate for one coin as CoinGecko names it ("monad"), kept for a few minutes.
 *
 * @param ask how to ask, which the tests stand in for; the free endpoint by default
 */
export function ratesFromCoinGecko(coinId: string, ask: typeof fetch = fetch): Rates {
  // the asking is kept, not only its answer, so pages that open together are one ask and not many
  let kept: { readonly at: number; readonly rate: Promise<Rate | undefined> } | undefined;
  return {
    now(): Promise<Rate | undefined> {
      if (kept && Date.now() - kept.at < A_RATE_IS_KEPT_FOR_MS) return kept.rate;
      // a rate that could not be read is kept too, so a dead endpoint is asked once every few minutes
      kept = { at: Date.now(), rate: readTheRate(coinId, ask) };
      return kept.rate;
    },
  };
}

async function readTheRate(coinId: string, ask: typeof fetch): Promise<Rate | undefined> {
  try {
    const answer = await ask(`${COINGECKO}?ids=${encodeURIComponent(coinId)}&vs_currencies=usd`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(IT_HAS_TO_ANSWER_WITHIN_MS),
    });
    if (!answer.ok) return undefined;
    const read = AnswerSchema.safeParse(await answer.json());
    const usd = read.success ? read.data[coinId]?.usd : undefined;
    return usd === undefined ? undefined : { usd, at: new Date().toISOString(), from: "CoinGecko" };
  } catch {
    // no network, a timeout, or an answer that is not what this reads: the page goes without a rate
    return undefined;
  }
}
