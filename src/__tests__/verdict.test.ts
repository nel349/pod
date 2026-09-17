import { describe, expect, test } from "bun:test";
import { reachVerdict, registryResponse, registryTag, resultDigest, type RunResult } from "../verdict.ts";

const pass = (): RunResult => ({ exitCode: 0, summary: "# pass 4 # fail 0" });
const fail = (): RunResult => ({ exitCode: 1, summary: "# pass 1 # fail 3" });

describe("resultDigest", () => {
  test("two identical runs fingerprint the same", () => {
    expect(resultDigest(pass())).toBe(resultDigest(pass()));
  });

  test("whitespace in the summary does not change the answer", () => {
    expect(resultDigest({ exitCode: 0, summary: "# pass 4   # fail 0\n" })).toBe(resultDigest(pass()));
  });

  test("a different result fingerprints differently", () => {
    expect(resultDigest(pass())).not.toBe(resultDigest(fail()));
  });
});

describe("reachVerdict", () => {
  test("agreeing passes are a pass", () => {
    expect(reachVerdict([pass(), pass(), pass()])).toMatchObject({ kind: "passed", runs: 3 });
  });

  test("agreeing failures are a failure", () => {
    expect(reachVerdict([fail(), fail(), fail()])).toMatchObject({ kind: "failed", runs: 3 });
  });

  test("runs that disagree reach no verdict at all", () => {
    const verdict = reachVerdict([pass(), fail(), pass()]);
    expect(verdict.kind).toBe("not-reproducible");
    if (verdict.kind === "not-reproducible") expect(verdict.answers).toHaveLength(2);
  });

  test("a single run is never enough", () => {
    expect(() => reachVerdict([pass()])).toThrow("at least two runs");
  });

  test("the same exit code with a different summary still disagrees", () => {
    const a: RunResult = { exitCode: 1, summary: "# pass 1 # fail 1" };
    const b: RunResult = { exitCode: 1, summary: "# pass 0 # fail 2" };
    expect(reachVerdict([a, b]).kind).toBe("not-reproducible");
  });
});

describe("what goes on chain", () => {
  test("only a clean pass earns 100", () => {
    expect(registryResponse(reachVerdict([pass(), pass()]))).toBe(100);
    expect(registryResponse(reachVerdict([fail(), fail()]))).toBe(0);
    expect(registryResponse(reachVerdict([pass(), fail()]))).toBe(0);
  });

  test("an unreproducible run is filed under its own tag, not as a failure", () => {
    expect(registryTag(reachVerdict([pass(), pass()]), "tests")).toBe("pod.tests");
    expect(registryTag(reachVerdict([pass(), fail()]), "tests")).toBe("pod.tests.unreproducible");
  });
});
