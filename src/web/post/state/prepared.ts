/**
 * A job paid for, while its checks are written, read and approved: the rules of its page.
 *
 * The chain says where the job stands (still preparing, approved, taken back) and the server says what
 * was written. The poster approves only a set the page can seal again from what it shows, with the
 * salt they chose: the seal the writer signed must be the seal of these checks (F10), or the page
 * refuses, whatever the server sent.
 */
import { isAddressEqual, type Address, type Hex } from "viem";
import { readyToSeal } from "../../../checkwriting/written.ts";
import { sealWritten } from "../../../checkwriting/sealWritten.ts";
import { MODE_NAMES, MODES, type Mode } from "../../../job.ts";
import type { JobV2, WritingMoney } from "../../../jobsV2.ts";
import { ON_CHAIN_NUMBER, type Approval, type Finished, type Now, type PreparingView } from "../../../preparing/records.ts";
import { ROUTES } from "../../../routes.ts";
import { asClock, verdictOn, type Verdict, type WritingLine } from "./checks.ts";
import { COPY } from "./copy.ts";
import { requestKey, type DraftRequest } from "./form.ts";
import { progressIn, type Progress } from "./progress.ts";
import { PAY_FIRST_STEPS, type StepName } from "./steps.ts";

/** The job's number, when this page's address is a paid job's own: /post/<number>. */
export function preparedNumberIn(pathname: string): string | undefined {
  const number = pathname.startsWith(`${ROUTES.post}/`) ? pathname.slice(ROUTES.post.length + 1) : undefined;
  return number !== undefined && ON_CHAIN_NUMBER.test(number) ? number : undefined;
}

/** Where a paid job stands, as its poster's page sees it. */
export type Standing = "preparing" | "approved" | "takenBack" | "closed";

const NO_SEAL = /^0x0{64}$/i;

/**
 * Approving fixes the seal: a job taken back with no seal was never approved. One refunded with a seal
 * was approved and then closed with its money gone back: taken back with nobody seated, closed after its
 * window, or refunded by a failing verdict.
 */
export function standingOf(job: Pick<JobV2, "state" | "seal">): Standing {
  if (job.state === "preparing") return "preparing";
  if (job.state === "refunded") return NO_SEAL.test(job.seal) ? "takenBack" : "closed";
  return "approved";
}

/** How long builders have once it opens, from the window the poster paid for, as a mode. */
export const modeOfWindow = (window: bigint): Mode | undefined =>
  MODE_NAMES.find((mode) => BigInt(MODES[mode].windowMinutes * 60) === window);

/** Whether this wallet is the one that paid for the job. */
export const isThePoster = (job: Pick<JobV2, "poster">, wallet: Address | undefined): boolean =>
  wallet !== undefined && isAddressEqual(job.poster, wallet);

/** How many writings are paid for and not yet started. */
export const writingsLeft = (money: WritingMoney & { readonly writingPrice: bigint }): number =>
  money.writingPrice === 0n ? 0 : Number(money.balance / money.writingPrice);

/** Whether another writing needs paying for first: what is left, the one under way included, is less than one. */
export const needsTopUp = (money: WritingMoney & { readonly writingPrice: bigint }): boolean =>
  money.balance + money.reserved < money.writingPrice;

/**
 * Whether a writing is waiting, under way, or still asked for between tries: the page asks again until
 * none is, and nothing can be approved or written again meanwhile.
 */
export const isWritingAsked = (view: Pick<PreparingView, "now" | "asked">): boolean => view.now.kind !== "idle" || view.asked !== undefined;

/** The last writing that finished, which is the set the poster reads. */
export const latestWriting = (view: PreparingView): Finished | undefined => view.writings[view.writings.length - 1];

/** The request a poster last asked for: the one waiting or under way, or the last one written. */
export const lastAsked = (view: PreparingView): Finished["request"] | undefined => view.asked ?? latestWriting(view)?.request;

/** The line under the buttons: where the writing is now, while it happens. */
export function nowLine(now: Now, seconds: number): WritingLine {
  if (now.kind === "waiting") return { state: "busy", text: COPY.prepared.waiting(now.place), clock: asClock(seconds) };
  if (now.kind === "writing" || now.kind === "trying") {
    return { state: "busy", text: `${COPY.checks.stages[now.kind]}. ${COPY.checks.patience}`, clock: asClock(seconds) };
  }
  return { state: "quiet", text: "" };
}

/** What the poster is told about the last writing: its verdict, or why it was not written. */
export type WritingVerdict = Verdict | { readonly state: "failed"; readonly shout: string; readonly says: string };

export function writingVerdict(writing: Finished, request: DraftRequest): WritingVerdict {
  if (writing.outcome.kind === "failed") {
    return { state: "failed", shout: COPY.checks.failed(writing.outcome.why), says: COPY.prepared.failedWriting(writing.outcome.why, writing.isCharged) };
  }
  return verdictOn(writing.outcome.checks, requestKey(request) === requestKey(writing.request));
}

/** Why the shown set cannot be approved, or nothing when it can be. */
export function whyNotApprove(writing: Finished | undefined, request: DraftRequest): string | undefined {
  if (!writing || writing.outcome.kind !== "written") return COPY.prepared.none;
  if (requestKey(request) !== requestKey(writing.request)) return COPY.prepared.stale;
  if (!writing.outcome.ready || !readyToSeal(writing.outcome.checks)) return COPY.problems.notProven;
  if (!writing.outcome.approval) return writing.outcome.whyNoApproval ?? COPY.problems.notProven;
  return undefined;
}

/**
 * The seal of what the page shows, built here as the server built it, which must be the seal the
 * writer signed. The approval goes to the chain with this seal; if the two differ, it does not go.
 */
export async function sealToApprove(input: {
  readonly writing: Finished;
  readonly view: Pick<PreparingView, "mode" | "salt">;
  /** the job's price as the chain holds it */
  readonly price: bigint;
}): Promise<{ readonly ok: true; readonly seal: Hex; readonly approval: Approval } | { readonly ok: false; readonly why: string }> {
  const { writing, view, price } = input;
  const outcome = writing.outcome;
  if (outcome.kind !== "written" || !outcome.approval) return { ok: false, why: COPY.problems.notProven };
  const shown = await sealWritten({
    idea: writing.request.idea, kind: writing.request.kind, mode: view.mode, price, checks: outcome.checks,
    ...(outcome.howItIsAsked ? { howItIsAsked: outcome.howItIsAsked } : {}), salt: view.salt,
  });
  return shown.seal.toLowerCase() === outcome.approval.seal.toLowerCase()
    ? { ok: true, seal: shown.seal, approval: outcome.approval }
    : { ok: false, why: COPY.prepared.mismatch };
}

/** How far along: everything up to paying is done; approving puts the centre in place. */
export function preparedProgressOf(standing: Standing): Progress {
  const placed = new Set<StepName>(["idea", "brief", "exam", "terms", "pay"]);
  if (standing === "approved" || standing === "closed") placed.add("approve");
  const progress = progressIn(PAY_FIRST_STEPS, placed, COPY.payFirst.next);
  // a job taken back or closed is not waiting for anything: the line under the seal says what became of it
  return standing === "takenBack" || standing === "closed" ? { ...progress, nextSays: COPY.payFirst.ended[standing] } : progress;
}
