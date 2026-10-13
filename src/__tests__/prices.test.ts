import { describe, expect, test } from "bun:test";
import { A_RATE_IS_KEPT_FOR_MS, ratesFromCoinGecko } from "../prices.ts";
import { coinsForDollars, isBeyondAFaucet, priceInWei } from "../web/post/state/form.ts";
import { MONAD_TESTNET } from "../registry.ts";
import { COPY } from "../web/post/state/copy.ts";

/**
 * What the chain's coin is worth, and the prices a poster is offered because of it.
 *
 * A price in dollars is only a label: the amount paid is the coin amount shown beside it, and the
 * contract takes that. So the dollars are never written anywhere that moves money, and a page with
 * no rate asks in the coin, as it always did.
 */
const answering = (body: unknown, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

describe("what the coin is worth", () => {
  test("the endpoint's answer for this coin becomes the rate, with who said so", async () => {
    const rates = ratesFromCoinGecko("monad", answering({ monad: { usd: 0.0242 } }));
    const rate = await rates.now();
    expect(rate?.usd).toBe(0.0242);
    expect(rate?.from).toBe("CoinGecko");
    expect(new Date(rate?.at ?? "").getTime()).toBeGreaterThan(Date.now() - 10_000);
  });

  test("one answer is kept, so a hundred pages are not a hundred asks", async () => {
    let asked = 0;
    const rates = ratesFromCoinGecko("monad", (async () => {
      asked += 1;
      return new Response(JSON.stringify({ monad: { usd: 1 } }), { status: 200 });
    }) as unknown as typeof fetch);
    await Promise.all([rates.now(), rates.now(), rates.now()]);
    await rates.now();
    expect(asked).toBe(1);
    expect(A_RATE_IS_KEPT_FOR_MS).toBeGreaterThan(60_000);
  });

  test("nothing is invented: a refusal, a shape it does not know, a price of zero or a dead network are all no rate", async () => {
    const noRate = [
      answering({ monad: { usd: 0.02 } }, 503),
      answering({ monad: { usd: "two cents" } }),
      answering({ ethereum: { usd: 2000 } }),
      answering({ monad: { usd: 0 } }),
      (async () => { throw new Error("no network"); }) as unknown as typeof fetch,
    ];
    for (const ask of noRate) expect(await ratesFromCoinGecko("monad", ask).now()).toBeUndefined();
  });

  test("the coin the live chain's prices are read for is the one CoinGecko answered for", () => {
    expect(MONAD_TESTNET.coinId).toBe("monad");
  });
});

describe("the prices a poster is offered", () => {
  test("each is a round-looking amount of the coin, which is what is paid", () => {
    // a cent or two a coin, as MON was in October 2026
    expect(COPY.terms.priceChoices.map((choice) => coinsForDollars(choice.usd, 0.0242))).toEqual(["410", "1000", "4100"]);
    // and a coin worth dollars, where the same prices are a handful of them
    expect(COPY.terms.priceChoices.map((choice) => coinsForDollars(choice.usd, 2.5))).toEqual(["4", "10", "40"]);
    // and whatever one coin is worth, every price offered is an amount the form and the chain take:
    // a plain number, never a power of ten, and never nothing
    for (const perCoin of [0.0242, 0.5, 2.5, 123.456, 0.0000001, 1_000_000]) {
      for (const choice of COPY.terms.priceChoices) {
        const amount = coinsForDollars(choice.usd, perCoin);
        expect(amount, `$${choice.usd} at ${perCoin}`).toMatch(/^[0-9]+(\.[0-9]+)?$/);
        expect(priceInWei(amount), `$${choice.usd} at ${perCoin}`).toBeGreaterThan(0n);
      }
    }
  });

  test("three prices, in dollars, each saying what it buys", () => {
    expect(COPY.terms.priceChoices).toHaveLength(3);
    expect(COPY.terms.priceChoices.map((choice) => choice.usd)).toEqual([10, 25, 100]);
    for (const choice of COPY.terms.priceChoices) expect(choice.buys.length).toBeGreaterThan(2);
    expect(COPY.terms.priceInDollars(25)).toBe("$25");
    // the coin amount is exactly what is charged, so nothing in front of it says otherwise
    expect(COPY.terms.priceInCoins("1,000", "MON")).toBe("1,000 MON");
  });

  test("what the dollars leave out on a test network is said: the coin is handed out, and only so much of it", () => {
    const says = COPY.terms.testMoney("MON", 5);
    expect(says).toContain("test money");
    expect(says).toContain("about 5 MON a day");
    // the dollar sizes are not called wrong, they are placed: what the work is worth, not what a wallet here holds
    expect(says).toContain("real network");
    expect(says).toContain(COPY.terms.anotherAmount);
  });

  test("an amount beyond a faucet is named as such, with the amount and what a faucet gives", () => {
    expect(isBeyondAFaucet("400", 5)).toBe(true);
    expect(isBeyondAFaucet("5", 5)).toBe(false);
    expect(isBeyondAFaucet("1", 5)).toBe(false);
    // a chain with no faucet is not a test one, and nothing is said about it
    expect(isBeyondAFaucet("400", undefined)).toBe(false);
    // half written, or not a number at all: the page says nothing rather than guessing
    expect(isBeyondAFaucet("", 5)).toBe(false);
    expect(isBeyondAFaucet("0.", 5)).toBe(false);
    expect(isBeyondAFaucet("lots", 5)).toBe(false);
    const says = COPY.terms.beyondAFaucet("400", "MON", 5);
    expect(says).toContain("400 MON");
    expect(says).toContain("about 5 MON a day");
  });

  test("a rate that cannot be had is said, and the page asks in the coin", () => {
    expect(COPY.terms.noRate("MON")).toContain("asks in MON");
    expect(COPY.terms.rateSays("CoinGecko", "MON")).toContain("CoinGecko");
    expect(COPY.terms.rateSays("CoinGecko", "MON")).toContain("What you pay is the MON amount shown, exactly");
    expect(COPY.terms.anotherAmount).toBe("Another amount");
  });
});
