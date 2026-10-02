import { describe, expect, test } from "bun:test";
import { parseEther } from "viem";
import type { TriedCheck, Written } from "../checkwriting/written.ts";
import { sealWritten } from "../checkwriting/sealWritten.ts";
import { MODES } from "../job.ts";
import { ApprovalSchema, type Finished, type Outcome, type PreparingView } from "../preparing/records.ts";
import { specToTheWire } from "../specWire.ts";
import {
  COPY, cutTheSeal, formOfKeptSetUp, isSealed, isWritingAsked, keepSetUp, modeOfWindow, needsTopUp, nowLine, PAY_FIRST_STEPS, payFirstProgressOf,
  payFirstWords, preparedNumberIn, preparedProgressOf, readKeptSetUp, sealToApprove, standingOf, stepNumber, toWriteRequest,
  whatIsPaid, whyNotApprove, writingsLeft, writingVerdict, type DraftForm, type KeptSetUp,
} from "../web/post/state/index.ts";
import { COAT_IDEA, COAT_REQUEST, DRY, WET } from "./support/coat.ts";

/**
 * The rules of posting on a contract that prepares jobs, without a browser: what paying covers, the
 * payment kept until the job is set up (R13), where a paid job stands, and the page refusing to approve
 * a seal that is not the seal of what it shows (F10).
 */

const WRITING = { price: `${parseEther("0.05")}`, included: 3 };
const SALT = "0123456789abcdef0123456789abcdef";
const PRICE = parseEther("0.1");
const ZERO_SEAL = `0x${"0".repeat(64)}` as const;

const triedCheck = (says: string, secret: boolean, file: string, nearMiss = true): TriedCheck => ({
  checkable: true, says, secret, asks: "asks", expects: "expects", nearMiss: "It never says take a coat.",
  file, source: `// ${says}\nprocess.exit(0);\n`, proof: { working: true, nearMiss, nothing: true },
  saw: { working: "ok", nearMiss: "caught", nothing: "caught" },
});
const CHECKS: readonly Written[] = [triedCheck(WET, false, "check-1.mjs"), triedCheck(DRY, true, "check-2.mjs")];

/** a writing as the server keeps it, with the approval it builds and signs for a ready set */
async function aWriting(checks: readonly Written[] = CHECKS): Promise<Finished> {
  const sealed = await sealWritten({ idea: COAT_REQUEST.idea, kind: COAT_REQUEST.kind, mode: "flash", price: PRICE, checks, salt: SALT });
  return {
    number: 1, request: COAT_REQUEST, askedAt: "2026-10-01T00:00:00Z", finishedAt: "2026-10-01T00:01:00Z", isCharged: true, isSettled: true,
    outcome: {
      kind: "written", checks: [...checks], ready: true,
      approval: ApprovalSchema.parse({ spec: specToTheWire(sealed.spec), files: { ...sealed.files }, seal: sealed.seal, signature: `0x${"ab".repeat(65)}` }),
    },
  };
}

type WrittenOutcome = Extract<Outcome, { kind: "written" }>;

/** The same writing, with something about what was written changed. */
function changed(writing: Finished, change: (outcome: WrittenOutcome) => Partial<WrittenOutcome>): Finished {
  if (writing.outcome.kind !== "written") throw new Error("only a written set can be changed");
  return { ...writing, outcome: { ...writing.outcome, ...change(writing.outcome) } };
}

const VIEW: Pick<PreparingView, "mode" | "salt"> = { mode: "flash", salt: SALT };
const MONEY = { balance: 2n * BigInt(WRITING.price), reserved: 0n, kept: 1, writingPrice: BigInt(WRITING.price) };

describe("paying first", () => {
  test("the payment is the price and the writings it covers, and the page says both before anybody pays", () => {
    const paid = whatIsPaid(PRICE, WRITING);
    expect(paid.total).toBe(PRICE + 3n * parseEther("0.05"));
    const words = payFirstWords(paid, "MON", "flash");
    expect(words.button).toBe("Pay 0.25 MON");
    expect(words.terms).toContain("0.1 MON for the job");
    expect(words.terms).toContain("0.15 MON to have its checks written up to 3 times");
    expect(words.terms).toContain("take it all back");
  });

  test("the seal fills as the form does, paying is the fifth wedge, and only approving puts the centre in", () => {
    const form: DraftForm = { idea: COAT_IDEA, kind: "service", brief: [{ says: WET }], exam: [{ says: DRY }], price: "0.1", mode: "flash", name: "a-coat" };
    const before = payFirstProgressOf(form, false);
    expect([...before.placed].sort()).toEqual(["brief", "exam", "idea", "terms"]);
    expect(before.next).toBe("pay");
    expect(before.nextSays).toBe(COPY.payFirst.next.pay);
    const paid = payFirstProgressOf(form, true);
    expect(paid.next).toBe("approve");
    expect(isSealed(paid)).toBe(false);
    expect(isSealed(preparedProgressOf("approved"))).toBe(true);
    expect(preparedProgressOf("approved").nextSays).toBe(COPY.payFirst.next.done);

    // the centre of the pay-first seal is approving, its wedges the five steps before it
    const shards = cutTheSeal(undefined, PAY_FIRST_STEPS);
    expect(new Set(shards.filter((shard) => shard.isCentre).map((shard) => shard.piece))).toEqual(new Set(["approve"]));
    expect(new Set(shards.filter((shard) => !shard.isCentre).map((shard) => shard.piece))).toEqual(new Set(["idea", "brief", "exam", "terms", "pay"]));
    expect(PAY_FIRST_STEPS.map((step) => stepNumber(step, PAY_FIRST_STEPS))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("a payment not yet set up is kept whole and comes back as the form it was, and anything else kept is ignored", () => {
    const kept: KeptSetUp = {
      hash: `0x${"12".repeat(32)}`, poster: "0x1111111111111111111111111111111111111111", onChainId: "10",
      name: "a-coat", price: "0.1", mode: "sprint", salt: SALT, request: COAT_REQUEST,
    };
    expect(readKeptSetUp(keepSetUp(kept))).toEqual(kept);
    const form = formOfKeptSetUp(kept);
    expect(toWriteRequest(form)).toEqual(COAT_REQUEST);
    expect(form).toMatchObject({ price: "0.1", mode: "sprint", name: "a-coat" });

    expect(readKeptSetUp(null)).toBeUndefined();
    expect(readKeptSetUp("not json")).toBeUndefined();
    expect(readKeptSetUp(keepSetUp({ ...kept, salt: "short" }))).toBeUndefined();
    expect(readKeptSetUp(keepSetUp({ ...kept, onChainId: "010" }))).toBeUndefined();
  });
});

describe("a paid job's page", () => {
  test("its address is /post/<number>, written one way only", () => {
    expect(preparedNumberIn("/post/10")).toBe("10");
    expect(preparedNumberIn("/post")).toBeUndefined();
    expect(preparedNumberIn("/post/010")).toBeUndefined();
    expect(preparedNumberIn("/post/ten")).toBeUndefined();
    expect(preparedNumberIn("/postal/10")).toBeUndefined();
  });

  test("where it stands is the chain's to say: preparing, approved once a seal is fixed, closed after that, or taken back with none", () => {
    expect(standingOf({ state: "preparing", seal: ZERO_SEAL })).toBe("preparing");
    expect(standingOf({ state: "open", seal: `0x${"1".repeat(64)}` })).toBe("approved");
    expect(standingOf({ state: "refunded", seal: ZERO_SEAL })).toBe("takenBack");
    // approved and then closed, its money gone back: not "open to builders"
    expect(standingOf({ state: "refunded", seal: `0x${"1".repeat(64)}` })).toBe("closed");
    expect(standingOf({ state: "settled", seal: `0x${"1".repeat(64)}` })).toBe("approved");
    expect(isSealed(preparedProgressOf("closed"))).toBe(true);
    // a job taken back or closed waits for nothing: the line under the seal says what became of it
    expect(preparedProgressOf("closed").nextSays).toBe(COPY.payFirst.ended.closed);
    expect(preparedProgressOf("takenBack").nextSays).toBe(COPY.payFirst.ended.takenBack);
    expect(modeOfWindow(BigInt(MODES.sprint.windowMinutes * 60))).toBe("sprint");
    expect(modeOfWindow(7n)).toBeUndefined();
  });

  test("writings left are those paid for and not started, and one more is paid for only when none is left", () => {
    expect(writingsLeft(MONEY)).toBe(2);
    expect(needsTopUp(MONEY)).toBe(false);
    expect(needsTopUp({ ...MONEY, balance: 0n })).toBe(true);
    // the writing under way is paid for already
    expect(needsTopUp({ ...MONEY, balance: 0n, reserved: MONEY.writingPrice })).toBe(false);
  });

  test("the page keeps asking while a writing is waiting, under way, or still asked for between tries", () => {
    expect(isWritingAsked({ now: { kind: "idle" } })).toBe(false);
    expect(isWritingAsked({ now: { kind: "trying" } })).toBe(true);
    // the server between tries: nothing running, but the writing still asked for
    expect(isWritingAsked({ now: { kind: "idle" }, asked: COAT_REQUEST })).toBe(true);
  });

  test("a name already taken is sent back to the sheet it is set on, numbered as this page numbers it", () => {
    expect(COPY.problems.nameTaken("a-coat", stepNumber("terms", PAY_FIRST_STEPS))).toContain("in step 4");
    expect(COPY.problems.nameTaken("a-coat")).toContain("in step 5");
  });

  test("the line under the buttons says where the writing is, its place in line included", () => {
    expect(nowLine({ kind: "waiting", place: 1 }, 5)).toMatchObject({ state: "busy", text: COPY.prepared.waiting(1), clock: "0:05" });
    expect(nowLine({ kind: "waiting", place: 3 }, 0).state === "busy" && nowLine({ kind: "waiting", place: 3 }, 0)).toMatchObject({ text: "Waiting its turn: 2 ahead of yours." });
    expect(nowLine({ kind: "trying" }, 65)).toMatchObject({ state: "busy", clock: "1:05" });
    expect(nowLine({ kind: "idle" }, 0)).toEqual({ state: "quiet", text: "" });
  });

  test("a set is offered for approval only when every check holds and the lines are still the ones it was written for", async () => {
    const writing = await aWriting();
    expect(whyNotApprove(writing, COAT_REQUEST)).toBeUndefined();
    expect(whyNotApprove(undefined, COAT_REQUEST)).toBe(COPY.prepared.none);
    const reworded = { ...COAT_REQUEST, statements: [{ says: "When it pours, it tells me to take a coat", secret: false }] };
    expect(whyNotApprove(writing, reworded)).toBe(COPY.prepared.stale);
    expect(writingVerdict(writing, reworded).state).toBe("stale");
    const shaky = await aWriting([triedCheck(WET, false, "check-1.mjs"), triedCheck(DRY, true, "check-2.mjs", false)]);
    const notReady = changed(shaky, () => ({ ready: false }));
    expect(whyNotApprove(notReady, COAT_REQUEST)).toBe(COPY.problems.notProven);
    const failed: Finished = { ...writing, isCharged: false, outcome: { kind: "failed", why: "the model could not be reached." } };
    expect(writingVerdict(failed, COAT_REQUEST)).toMatchObject({ state: "failed", says: COPY.prepared.failedWriting("the model could not be reached", false) });
  });

  test("the page approves the seal of what it shows, and refuses one that is not (F10)", async () => {
    const writing = await aWriting();
    const approval = writing.outcome.kind === "written" ? writing.outcome.approval : undefined;
    const holds = await sealToApprove({ writing, view: VIEW, price: PRICE });
    expect(holds).toMatchObject({ ok: true, seal: approval?.seal });

    // what is shown changed under a signed seal: a check reworded
    const reworded = changed(writing, ({ checks }) => ({ checks: checks.map((check, index) => (index === 0 ? { ...check, says: "When it pours, it says take a coat" } : check)) }));
    expect(await sealToApprove({ writing: reworded, view: VIEW, price: PRICE })).toEqual({ ok: false, why: COPY.prepared.mismatch });

    // a seal for another price, another salt, or another seal altogether is not the one shown either
    expect((await sealToApprove({ writing, view: VIEW, price: PRICE + 1n })).ok).toBe(false);
    expect((await sealToApprove({ writing, view: { ...VIEW, salt: "f".repeat(32) }, price: PRICE })).ok).toBe(false);
    const otherSeal = changed(writing, (outcome) => (outcome.approval ? { approval: { ...outcome.approval, seal: `0x${"9".repeat(64)}` } } : {}));
    expect((await sealToApprove({ writing: otherSeal, view: VIEW, price: PRICE })).ok).toBe(false);
  });
});
