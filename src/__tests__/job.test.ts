import { describe, expect, test } from "bun:test";
import {
  MODES, SHARES, deadlines, publicSpec, sealSpec, shareOf, specMatchesSeal, verdictKey,
  type Spec,
} from "../job.ts";

const spec = (over: Partial<Spec> = {}): Spec => ({
  idea: "a site that rates my excuses",
  mode: "flash",
  price: 20_000_000n,
  checks: [
    { says: "the page loads", run: "curl -fs $TARGET", hidden: false },
    { says: "a weak excuse scores under 3", run: "node checks/weak.js", hidden: true },
  ],
  allowed: [],
  salt: "8f3c1b",
  ...over,
});

describe("sealing a job", () => {
  test("the same job always seals to the same value", async () => {
    expect(await sealSpec(spec())).toBe(await sealSpec(spec()));
  });

  test("key order does not change the seal", async () => {
    const written = spec();
    // the same job, typed in a different order, as a different tool would serialise it
    const reordered: Spec = {
      salt: written.salt,
      allowed: written.allowed,
      checks: written.checks,
      price: written.price,
      mode: written.mode,
      idea: written.idea,
    };
    expect(await sealSpec(reordered)).toBe(await sealSpec(written));
  });

  test("changing anything at all changes the seal", async () => {
    const before = await sealSpec(spec());
    expect(await sealSpec(spec({ idea: "a site that rates my excuses " }))).not.toBe(before);
    expect(await sealSpec(spec({ price: 20_000_001n }))).not.toBe(before);
    expect(await sealSpec(spec({ mode: "sprint" }))).not.toBe(before);
  });

  test("the text can be checked against the seal afterwards", async () => {
    const seal = await sealSpec(spec());
    expect(await specMatchesSeal(spec(), seal)).toBe(true);
    expect(await specMatchesSeal(spec({ idea: "something else" }), seal)).toBe(false);
  });

  test("a salt is part of the seal, so a short idea cannot be guessed back out of it", async () => {
    expect(await sealSpec(spec({ salt: "aaaa" }))).not.toBe(await sealSpec(spec({ salt: "bbbb" })));
  });
});

describe("what the pod may see", () => {
  test("hidden checks are withheld, visible ones are not", () => {
    const shown = publicSpec(spec());
    expect(shown.checks).toHaveLength(1);
    expect(shown.checks[0]?.says).toBe("the page loads");
  });

  test("the salt stays behind", () => {
    expect("salt" in publicSpec(spec())).toBe(false);
  });
});

describe("the key a verdict is filed under", () => {
  const base = { seal: "0xabc" as const, commit: "c0ffee", runner: "0xRunner" };

  test("two runners answering the same work get two keys", async () => {
    const one = await verdictKey(base);
    const two = await verdictKey({ ...base, runner: "0xOther" });
    expect(one).not.toBe(two);
  });

  test("the same runner on the same commit gets the same key, so it cannot answer twice", async () => {
    expect(await verdictKey(base)).toBe(await verdictKey({ ...base, runner: "0xRUNNER" }));
  });

  test("a different commit is a different verdict", async () => {
    expect(await verdictKey(base)).not.toBe(await verdictKey({ ...base, commit: "deadbee" }));
  });
});

describe("shares", () => {
  test("the seats add up to the whole price", () => {
    expect(Object.values(SHARES).reduce((a, b) => a + b, 0)).toBe(100);
  });

  test("a share is a slice of the price", () => {
    expect(shareOf(20_000_000n, "builder")).toBe(8_000_000n);
    expect(shareOf(20_000_000n, "security")).toBe(2_000_000n);
  });

  test("nothing is lost to rounding on a price that divides cleanly", () => {
    const price = 20_000_000n;
    const total = (Object.keys(SHARES) as (keyof typeof SHARES)[])
      .map((role) => shareOf(price, role))
      .reduce((a, b) => a + b, 0n);
    expect(total).toBe(price);
  });
});

describe("deadlines", () => {
  test("flash is two hours, and goes quiet after ten minutes", () => {
    const started = new Date("2026-10-01T12:00:00Z");
    const { endsAt, idleBy } = deadlines(spec(), started);
    expect(endsAt.toISOString()).toBe("2026-10-01T14:00:00.000Z");
    expect(idleBy.toISOString()).toBe("2026-10-01T12:10:00.000Z");
  });

  test("every mode has a window longer than its idle limit", () => {
    for (const mode of Object.values(MODES)) expect(mode.windowMinutes).toBeGreaterThan(mode.idleMinutes);
  });
});
