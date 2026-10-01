import { describe, expect, test } from "bun:test";
import { preparingPagePath, refundByNumberPath } from "../routes.ts";
import { canTake, COPY, refusalWords, standingOf, targetFrom, wayOut, type OnChainNow } from "../web/refund/state/index.ts";

/**
 * The refund page's rules on the contract that prepares jobs, without a browser: which way out a job's
 * contract has, where its money stands, and what the page's address names.
 */

const FIRST = "0x00000000000000000000000000000000000000a1";
const PREPARES = "0x00000000000000000000000000000000000000b2";
const MARKET = { jobs: PREPARES, writing: { price: "50000000000000000", included: 3 } } as const;

const job = (state: OnChainNow["state"], now: bigint, endsAt = 100n): OnChainNow =>
  ({ poster: "0x00000000000000000000000000000000000000c3", price: 10n, endsAt, state, now });

describe("taking the money back on the contract that prepares jobs", () => {
  test("a job's way out is its own contract's: the one that prepares jobs only when the market says it does", () => {
    expect(wayOut(PREPARES, MARKET)).toBe("prepares");
    expect(wayOut(FIRST, MARKET)).toBe("first");
    expect(wayOut(PREPARES, { jobs: PREPARES })).toBe("first");
  });

  test("open with nobody seated, it can be taken back now; once a seat is taken, only after the window", () => {
    expect(standingOf(job("open", 50n), "prepares")).toEqual({ kind: "take back now" });
    expect(standingOf(job("working", 50n), "prepares")).toEqual({ kind: "too early", endsAt: 100n });
    expect(standingOf(job("open", 150n), "prepares")).toEqual({ kind: "ready" });
    expect(standingOf(job("working", 150n), "prepares")).toEqual({ kind: "ready" });
    // the first contract never let a poster take it back early
    expect(standingOf(job("open", 50n), "first")).toEqual({ kind: "too early", endsAt: 100n });
    expect(canTake({ kind: "take back now" })).toBe(true);
    expect(canTake({ kind: "too early", endsAt: 1n })).toBe(false);
  });

  test("still preparing, it is taken back on its own page, where its checks are", () => {
    expect(standingOf(job("preparing", 50n), "prepares", "12")).toEqual({ kind: "preparing", page: preparingPagePath("12") });
    expect(canTake({ kind: "preparing", page: preparingPagePath("12") })).toBe(false);
  });

  test("the address names a job by name, by number on a contract, or no job at all", () => {
    expect(targetFrom("/refund/a-coat", "")).toEqual({ by: "name", jobId: "a-coat" });
    const byNumber = new URL(`http://pod.test${refundByNumberPath("12", PREPARES)}`);
    expect(targetFrom(byNumber.pathname, byNumber.search)).toEqual({ by: "number", onChainId: "12", jobs: PREPARES });
    expect(targetFrom("/refund/", "?job=12")).toEqual({ by: "number", onChainId: "12" });
    expect(targetFrom("/refund/", "?job=12&jobs=not-an-address")).toEqual({ by: "number", onChainId: "12" });
    expect(targetFrom("/refund/", "")).toEqual({ by: "none" });
  });

  test("a refusal is said for the contract it came from", () => {
    expect(refusalWords("WrongState", "prepares")).toBe(COPY.take.refusedPrepared.WrongState);
    expect(refusalWords("WrongState", "first")).toBe(COPY.take.refused.WrongState);
    expect(refusalWords("NotPoster", "prepares")).toBe(COPY.take.refused.NotPoster);
  });
});
