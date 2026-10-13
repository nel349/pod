import { describe, expect, test } from "bun:test";
import { LONGEST_NOTE } from "../note.ts";
import { verdictFrom } from "../reference/index.ts";
import { noteOf } from "../reference/protocol.ts";
import { whatItSaid, whatWasRunForTests } from "../reference/roles/judgements.ts";
import { SERVE_THE_SITE } from "../job.ts";
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
    expect(verdictFrom("REFUSE - it never says take a coat").why).toBe("it never says take a coat");
    expect(verdictFrom("REFUSE")).toEqual({ approve: false, why: "it does not do what was asked" });
  });

  test("what follows the first line is the seat's account, kept with its verdict and written under it in its note", () => {
    const verdict = verdictFrom("APPROVE it is a page of cards\n\nRead site/index.html.\nOne card, with a mint button.\n");
    expect(verdict).toEqual({ approve: true, why: "it is a page of cards", account: "Read site/index.html.\nOne card, with a mint button." });
    expect(noteOf(verdict)).toBe("Approved: it is a page of cards\nRead site/index.html.\nOne card, with a mint button.");
    // a verdict of one line has no account, and its note is that line
    expect(verdictFrom("REFUSE it mints nothing").account).toBeUndefined();
    expect(noteOf(verdictFrom("REFUSE it mints nothing"))).toBe("Refused: it mints nothing");
    // an account longer than a note can hold is cut, never refused by the door
    expect(noteOf(verdictFrom(`APPROVE fine\n${"x".repeat(LONGEST_NOTE * 2)}`)).length).toBeLessThanOrEqual(LONGEST_NOTE);
  });

  test("anything but a clear yes is a refusal", () => {
    expect(verdictFrom("It looks fine to me").approve).toBe(false);
    expect(verdictFrom("Approved, mostly").approve).toBe(false);
    expect(verdictFrom("").approve).toBe(false);
  });
});

describe("what QA's account says", () => {
  /** the shape QA writes after really running the checks, with what the grader hands back */
  const anAccount = (): string => whatWasRunForTests(SERVE_THE_SITE, "http://pod-art-7f3:3000", [
    { says: "The page names the cart and lists at least six drinks, each with a price", command: "node check-1.mjs", exitCode: 0, output: "the front page names Corner Cart and lists 8 drinks with prices\n", seconds: 0.42 },
    { says: "The page says the opening hours for each day of the week", command: "node check-2.mjs", exitCode: 1, output: "Saturday is missing from the hours\n", seconds: 0.31 },
  ]);

  test("it says how the work was started, where the checks reached it, and for each one the command, the time, the exit and what it printed", () => {
    const account = anAccount();
    // what only a seat that really ran them can give: the lead cut a seat for leaving these out
    expect(account).toContain(SERVE_THE_SITE);
    expect(account).toContain("TARGET=http://pod-art-7f3:3000");
    expect(account).toContain("ran: node check-1.mjs, 0.4s, exit 0 (passed)");
    expect(account).toContain("ran: node check-2.mjs, 0.3s, exit 1 (failed)");
    expect(account).toContain("it printed: the front page names Corner Cart and lists 8 drinks with prices");
    expect(account).toContain("it printed: Saturday is missing from the hours");
    // and it still says what it did not do, so nobody reads it as more than it is
    expect(account).toContain("Not done by this seat");
  });

  test("a check that printed nothing says so rather than leaving a gap, and a flood is cut", () => {
    const quiet = whatWasRunForTests("node server.js", "http://pod-art-1:3000", [
      { says: "it answers", command: "node check-1.mjs", exitCode: 0, output: "   ", seconds: 0.1 },
    ]);
    expect(quiet).toContain("it printed: nothing");
    const flood = whatWasRunForTests("node server.js", "http://pod-art-1:3000", [
      { says: "it answers", command: "node check-1.mjs", exitCode: 0, output: "x".repeat(5_000), seconds: 0.1 },
    ]);
    expect(flood.length).toBeLessThan(1_000);
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

  test("what the poster pointed at is read to the model when it is words, and named as unread when it is a picture", () => {
    const brief = briefFor(listed, [
      { name: "reference-1.md", type: "text/markdown", text: "Two faces to a row on a phone." },
      { name: "reference-2.png", type: "image/png" },
    ]);
    expect(brief).toContain("The person also pointed at reference-1.md, which says:\nTwo faces to a row on a phone.");
    expect(brief).toContain("reference-2.png (image/png), which you cannot see. Do not guess what it shows");
    expect(briefFor(listed)).not.toContain("also pointed at");
  });

  test("what the pod asked the poster is in it: their answer where they gave one, and what was assumed where they did not", () => {
    const brief = briefFor(listed, [], [
      "Asked: By whose clock is it night?\nThe poster answered: The visitor's own.",
      "Asked: How many faces?\nNot answered, so assumed: Six.",
    ]);
    expect(brief).toContain("Hold the work to their answers as to their first words; where they did not answer, to what was assumed:");
    expect(brief).toContain("The poster answered: The visitor's own.");
    expect(brief).toContain("Not answered, so assumed: Six.");
    expect(briefFor(listed)).not.toContain("The pod asked the person");
  });
});
