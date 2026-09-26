import { describe, expect, test } from "bun:test";
import { standingWords, verdictWords } from "../gallery.ts";

const SEAT = { role: "lead", agent: "0x00000000000000000000000000000000000000a1", owner: "0x00000000000000000000000000000000000000b1" } as const;

describe("words", () => {
  test("every verdict has a plain phrase", () => {
    for (const v of ["passed", "failed", "not-reproducible", "running"] as const) {
      expect(verdictWords(v).length).toBeGreaterThan(3);
    }
  });

  test("a job nobody has taken is waiting for a pod, not running", () => {
    expect(standingWords({ verdict: "running", pod: [] })).toBe("waiting for a pod");
    expect(standingWords({ verdict: "running", pod: [SEAT] })).toBe("being built");
    expect(standingWords({ verdict: "passed", pod: [] })).toBe("checks passed");
  });
});
