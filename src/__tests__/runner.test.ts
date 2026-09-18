import { describe, expect, test } from "bun:test";
import { moneyMove } from "../runner.ts";

/**
 * What the money does, given a verdict.
 *
 * Three verdicts, three answers, and the third one is the decision: a run nobody could reproduce
 * holds the job rather than ending it. The contract is not asked to do anything at all in that case.
 */
describe("what the money does", () => {
  test("work that passed is paid", () => {
    expect(moneyMove("passed")).toBe("pay");
  });

  test("work that failed sends the money back", () => {
    expect(moneyMove("failed")).toBe("refund");
  });

  test("runs that disagreed hold the job: nobody is paid and nobody is refunded", () => {
    expect(moneyMove("not-reproducible")).toBe("hold");
  });

  test("a runner that would rather end it can say so, and nothing says it for them", () => {
    expect(moneyMove("not-reproducible", "refund")).toBe("refund");
    expect(moneyMove("not-reproducible", "hold")).toBe("hold");
    // the policy never changes what a clear verdict does
    expect(moneyMove("passed", "refund")).toBe("pay");
  });
});
