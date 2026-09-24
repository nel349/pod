import { describe, expect, test } from "bun:test";
import { filesMatchSeal, sealSpec, type Spec } from "../job.ts";
import { refusalOf } from "../checkwriting/request.ts";
import { PostingSchema } from "../posting.ts";
import type { TriedCheck, Written } from "../checkwriting/written.ts";
import {
  asSentence, canPress, COPY, cutTheSeal, isFresh, nextPosting, paymentWords, PostFormSchema, priceInWei, progressOf, requestKey, sealJob,
  stepId, stepNumber, STEPS, toWriteRequest, trialsOf, verdictOn, whatIsMissing, windowInWords, writingLine,
  type PostForm, type WrittenFor,
} from "../web/post/state/index.ts";
import { COAT_IDEA, DRY, WET } from "./support/coat.ts";

/**
 * The rules the posting page runs by, without a browser: what goes to the check writer, when checks
 * are out of date, and that the job the page seals is the job the server will rebuild.
 */

const FORM: PostForm = {
  idea: COAT_IDEA, kind: "service",
  brief: [{ says: WET }, { says: "  " }], exam: [{ says: DRY }],
  price: "0.1", mode: "flash", name: "a-coat-or-not",
};

const triedCheck = (says: string, secret: boolean, file: string, proof = { working: true, nearMiss: true, nothing: true }): TriedCheck => ({
  checkable: true, says, secret, asks: "asks", expects: "expects", nearMiss: "It never says take a coat.",
  file, source: `// ${says}\nprocess.exit(0);\n`,
  proof,
  saw: { working: "ok", nearMiss: "it let the near miss through", nothing: "caught" },
});

const WET_CHECK = triedCheck(WET, false, "check-1.mjs");
const DRY_CHECK = triedCheck(DRY, true, "check-2.mjs");
const SHAKY_DRY_CHECK = triedCheck(DRY, true, "check-2.mjs", { working: true, nearMiss: false, nothing: true });
const CHECKS: readonly Written[] = [WET_CHECK, DRY_CHECK];
const writtenFor = (form: PostForm, checks: readonly Written[] = CHECKS): WrittenFor =>
  ({ key: requestKey(toWriteRequest(form)), checks, writtenAt: 1 });

describe("what goes to the check writer", () => {
  test("the brief comes first, the exam is marked secret, and empty lines are left out", () => {
    expect(toWriteRequest(FORM).statements).toEqual([{ says: WET, secret: false }, { says: DRY, secret: true }]);
  });
});

describe("what stands between the poster and paying", () => {
  test("nothing written yet: write the checks first", () => {
    expect(whatIsMissing(undefined, toWriteRequest(FORM))).toBe(COPY.problems.notWritten);
  });

  test("a line changed after the checks were written makes them out of date, and stops the payment", () => {
    const written = writtenFor(FORM);
    const changed = toWriteRequest({ ...FORM, exam: [{ says: "When it is dry, it says leave the coat" }] });
    expect(isFresh(written, changed)).toBe(false);
    expect(whatIsMissing(written, changed)).toBe(COPY.problems.stale);
  });

  test("moving a line from the exam to the brief is a change too, because who can read it changed", () => {
    const moved = toWriteRequest({ ...FORM, brief: [{ says: WET }, { says: DRY }], exam: [] });
    expect(isFresh(writtenFor(FORM), moved)).toBe(false);
  });

  test("a check that failed a trial stops the payment", () => {
    expect(whatIsMissing(writtenFor(FORM, [WET_CHECK, SHAKY_DRY_CHECK]), toWriteRequest(FORM))).toBe(COPY.problems.notProven);
  });

  test("fresh, proven checks leave nothing missing", () => {
    expect(whatIsMissing(writtenFor(FORM), toWriteRequest(FORM))).toBeUndefined();
  });

  test("a price of nothing is refused with the words the page shows", () => {
    const parsed = PostFormSchema.safeParse({ ...FORM, price: "0" });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.message)).toEqual([COPY.problems.price]);
  });
});

describe("the job the page seals", () => {
  test("is the job the server rebuilds: sent as the page sends it, read as the server reads it, same seal", async () => {
    const sealed = await sealJob(FORM, CHECKS, "a-salt");
    // the trip it really makes: to JSON with the price as a string, then through the server's schema
    const wire = JSON.parse(JSON.stringify({ ...sealed.spec, price: sealed.spec.price.toString() }));
    const arrived = PostingSchema.shape.spec.parse(wire);
    const rebuilt: Spec = { ...arrived, price: BigInt(arrived.price) };
    expect(await sealSpec(rebuilt)).toBe(sealed.seal);
    expect(await filesMatchSeal(rebuilt, sealed.files)).toEqual({ ok: true });
    expect(sealed.spec.checks.map((check) => [check.says, check.hidden, check.run])).toEqual([
      [WET, false, "node check-1.mjs"],
      [DRY, true, "node check-2.mjs"],
    ]);
  });

  test("seals what it is, so a page cannot be sealed as a service", async () => {
    const asPage = await sealJob({ ...FORM, kind: "page" }, CHECKS, "a-salt");
    const asService = await sealJob(FORM, CHECKS, "a-salt");
    expect(asPage.seal).not.toBe(asService.seal);
  });
});

describe("what the checks step says", () => {
  test("proven checks are ready to seal, and the shout says how many", () => {
    expect(verdictOn(CHECKS, true)).toEqual({ state: "ready", ...COPY.checks.verdict.ready(2) });
  });

  test("one weak check out of two is counted, and the poster is told to reword it", () => {
    expect(verdictOn([WET_CHECK, SHAKY_DRY_CHECK], true)).toEqual({ state: "short", ...COPY.checks.verdict.short(1, 2) });
  });

  test("a failed trial shows what the check printed, and a passed one shows nothing extra", () => {
    const [working, nearMiss, nothing] = trialsOf(SHAKY_DRY_CHECK);
    expect(working).toEqual({ name: "working", hasHeld: true, says: COPY.checks.trials.working.held, saw: undefined });
    expect(nearMiss).toEqual({
      name: "nearMiss", hasHeld: false,
      says: "Let a near miss through: it never says take a coat.",
      saw: COPY.checks.trials.saw("it let the near miss through"),
    });
    expect(nothing).toEqual({ name: "nothing", hasHeld: true, says: COPY.checks.trials.nothing.held, saw: undefined });
  });

  test("out of date wins over everything else, because those checks are for a different job", () => {
    expect(verdictOn([WET_CHECK, SHAKY_DRY_CHECK], false)).toEqual({ state: "stale", ...COPY.checks.verdict.stale });
  });

  test("while writing, the line gives the stage, with the clock kept apart so it is not read aloud each second", () => {
    expect(writingLine({ stage: "trying", seconds: 65, error: undefined, refusal: undefined }))
      .toEqual({ state: "busy", text: `${COPY.checks.stages.trying}. ${COPY.checks.patience}`, clock: "1:05" });
  });

  test("a failure says why, and outranks a refusal from an earlier press", () => {
    expect(writingLine({ stage: undefined, seconds: 0, error: "the model would not answer", refusal: "Say more." }))
      .toEqual({ state: "failed", text: COPY.checks.failed("the model would not answer") });
    expect(writingLine({ stage: undefined, seconds: 0, error: undefined, refusal: "Say more." }))
      .toEqual({ state: "failed", text: "Say more." });
  });

  test("the same line twice is refused, by the rule the server holds too", () => {
    const twice = toWriteRequest({ ...FORM, exam: [{ says: WET.toUpperCase() }] });
    expect(refusalOf(twice)).toBe("each line says something different: the same line twice would only be checked twice");
  });
});

describe("the words the page uses", () => {
  test("a price is more than zero and a number, or it is not a price", () => {
    expect(priceInWei("0.1")).toBe(100_000_000_000_000_000n);
    expect(priceInWei("0")).toBeUndefined();
    expect(priceInWei("a lot")).toBeUndefined();
  });

  test("a reason becomes a sentence, and the time the builders have reads mid-sentence", () => {
    expect(asSentence("the price is more than nothing")).toBe("The price is more than nothing.");
    expect(windowInWords("flash")).toBe("two hours");
  });

  test("the pay button offers to connect with no wallet, to pay with one, and says so once posted", () => {
    const base = { price: 100_000_000_000_000_000n, coin: "MON", mode: "sprint" as const, payment: undefined };
    expect(paymentWords({ ...base, status: { kind: "idle" }, hasWallet: false }).button).toBe(COPY.pay.connect);
    expect(paymentWords({ ...base, status: { kind: "idle" }, hasWallet: true }).button).toBe(COPY.pay.payAndPost("0.1 MON"));
    expect(paymentWords({ ...base, status: { kind: "posted", url: "/job/x" }, hasWallet: true }).button).toBe(COPY.pay.posted);
    expect(paymentWords({ ...base, status: { kind: "idle" }, hasWallet: true }).terms).toBe(COPY.pay.plain("0.1 MON", "a day"));
  });

  test("once paid, the button finishes that job, and the terms are what was paid, not the form as it is now", async () => {
    const sealed = await sealJob({ ...FORM, price: "0.1", mode: "flash" }, CHECKS, "a-salt");
    const payment = { hash: "0xabc" as const, poster: "0x0000000000000000000000000000000000000001" as const, sealed, onChainId: "7" };
    // the poster has since typed a different price and window into the form
    const words = paymentWords({ price: 5n * 10n ** 18n, coin: "MON", mode: "project", status: { kind: "idle" }, hasWallet: true, payment });
    expect(words.button).toBe(COPY.pay.finish);
    expect(words.terms).toBe(COPY.pay.plain("0.1 MON", "two hours"));
    expect(words.paid).toBe(COPY.pay.paidAs("7", "0xabc"));
  });

  test("a job already paid for is finished, never paid for again, even when the form has changed", async () => {
    const before = await sealJob(FORM, CHECKS, "a-salt");
    const after = await sealJob({ ...FORM, idea: "Something the poster typed after paying" }, CHECKS, "a-salt");
    const payment = { hash: "0xabc" as const, poster: "0x0000000000000000000000000000000000000001" as const, sealed: before };
    expect(nextPosting(undefined, after)).toEqual({ kind: "pay", sealed: after });
    expect(nextPosting(payment, after)).toEqual({ kind: "finish", payment });
  });

  test("the button can be pressed except while posting and once posted; a stopped payment can be finished", () => {
    expect(canPress({ kind: "idle" })).toBe(true);
    expect(canPress({ kind: "stopped", why: "the wallet said no", hasPaid: false })).toBe(true);
    expect(canPress({ kind: "stopped", why: "the server said 500", hasPaid: true })).toBe(true);
    expect(canPress({ kind: "posting" })).toBe(false);
    expect(canPress({ kind: "posted", url: "/job/x" })).toBe(false);
  });

  test("steps are numbered from the one list, so the stamps and the seal agree", () => {
    expect(STEPS.map(stepNumber)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(stepId("checks")).toBe("step-checks");
  });
});

describe("the seal, as the poster fills in the form", () => {
  test("each finished step places one piece, and nothing is placed that was not earned", () => {
    const blank = progressOf({ form: {}, areChecksReady: false, isPosted: false });
    expect([...blank.placed]).toEqual([]);
    expect(blank.next).toBe("idea");

    const filled = progressOf({ form: FORM, areChecksReady: false, isPosted: false });
    expect([...filled.placed]).toEqual(["idea", "brief", "exam", "terms"]);
    expect(filled.next).toBe("checks");

    const posted = progressOf({ form: FORM, areChecksReady: true, isPosted: true });
    expect(posted.isComplete).toBe(true);
    expect(posted.next).toBeUndefined();
  });

  test("an exam is a piece of its own: a job with none leaves that wedge out", () => {
    expect(progressOf({ form: { ...FORM, exam: [] }, areChecksReady: false, isPosted: false }).placed.has("exam")).toBe(false);
  });

  test("the scatter is the same every time, and no loose shard lies outside the drawing", () => {
    expect(cutTheSeal()).toEqual(cutTheSeal());
    for (const shard of cutTheSeal()) {
      const corners = shard.points.split(" ").map((corner) => corner.split(",").map(Number));
      const cx = corners.reduce((sum, [x]) => sum + x!, 0) / 3;
      const cy = corners.reduce((sum, [, y]) => sum + y!, 0) / 3;
      // the drawing is -60..260 on each side; a loose shard's centre lies at least 20 inside that edge,
      // so a turned shard still stays within the picture and off the words beside it
      expect(cx + shard.scatter.x).toBeGreaterThanOrEqual(-40);
      expect(cx + shard.scatter.x).toBeLessThanOrEqual(240);
      expect(cy + shard.scatter.y).toBeGreaterThanOrEqual(-40);
      expect(cy + shard.scatter.y).toBeLessThanOrEqual(240);
    }
  });
});
