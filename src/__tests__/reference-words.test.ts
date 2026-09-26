import { describe, expect, test } from "bun:test";
import { verdictFrom } from "../reference/index.ts";
import { whatItSaid } from "../reference/roles/judgements.ts";
import { briefFor } from "../reference/Seated.ts";
import type { ListedJob } from "../door/index.ts";

/**
 * The words the reference agents read and write: a model's verdict, and the line of a failed check
 * that says why. Both were first written wrong, and seen wrong only when the real model ran them.
 */
describe("a model's verdict", () => {
  test("APPROVE and REFUSE are read with their reasons, whatever the model put between", () => {
    expect(verdictFrom("APPROVE: it answers the question")).toEqual({ approve: true, why: "it answers the question" });
    expect(verdictFrom("Approve — it answers the question")).toEqual({ approve: true, why: "it answers the question" });
    expect(verdictFrom("REFUSE - it never says take a coat\nand more")).toEqual({ approve: false, why: "it never says take a coat" });
    expect(verdictFrom("REFUSE")).toEqual({ approve: false, why: "it does not do what was asked" });
  });

  test("anything but a clear yes is a refusal", () => {
    expect(verdictFrom("It looks fine to me").approve).toBe(false);
    expect(verdictFrom("Approved, mostly").approve).toBe(false);
    expect(verdictFrom("").approve).toBe(false);
  });
});

describe("what a failed check said", () => {
  test("the error, not node's stack or its version", () => {
    const thrown = [
      "node:internal/deps/undici/undici:13510",
      "      Error.captureStackTrace(err);",
      "            ^",
      "",
      "TypeError: fetch failed",
      "    at node:internal/deps/undici/undici:13510:13",
      "    at async file:///checks/check-1.mjs:1:23",
      "",
      "Node.js v22.14.0",
    ].join("\n");
    expect(whatItSaid(thrown)).toBe("TypeError: fetch failed");
  });

  test("a check's own last word, when it said one", () => {
    expect(whatItSaid("rain=yes said coat=false\n")).toBe("rain=yes said coat=false");
    expect(whatItSaid("")).toBeUndefined();
  });
});

describe("the brief a seat's model reads", () => {
  const listed: ListedJob = {
    jobId: "faces-by-the-hour", at: { page: "/", git: "/", notes: "/" }, contract: { address: "0x1111111111111111111111111111111111111111", jobId: "1" },
    price: "1", endsAt: "2026-10-13T00:00:00.000Z", idea: "A page that shows awake faces by day and sleeping faces at night", mode: "flash",
    allowedHosts: [], visibleChecks: [{ says: "When it is day, it shows awake faces", run: "node check-1.mjs" }], sealedChecks: 1,
    seats: [], owners: [], free: [],
  };

  test("tells the builder exactly how the checks ask, since the sealed ones ask the same way", () => {
    const exactly = "The page accepts hour=0 to 23 in its address, and uses the server's clock when none is given.";
    expect(briefFor({ ...listed, howItIsAsked: { plainly: "The checks ask for a chosen hour", exactly } })).toContain(exactly);
    expect(briefFor(listed)).not.toContain("How every check asks");
  });
});
