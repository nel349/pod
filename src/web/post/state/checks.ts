/**
 * What the checks step says, as rules rather than markup: the line under the button, and the verdict
 * under the checks. Kept out of the component so they can be tested without a browser.
 */
import { isProven, type Stage, type TriedCheck, type Written } from "../../../checkwriting/written.ts";
import { COPY } from "./copy.ts";

/** One of the three ways a check was tried, as the poster reads it. */
export interface TrialView {
  readonly name: "working" | "nearMiss" | "nothing";
  readonly hasHeld: boolean;
  /** what is said: the trial as passed, or as failed */
  readonly says: string;
  /** what the check printed, shown only when the trial failed, because then it is the explanation */
  readonly saw: string | undefined;
}

/** The three trials of a written check, in the order they are run. */
export function trialsOf(check: TriedCheck): readonly TrialView[] {
  const words = COPY.checks.trials;
  const view = (name: TrialView["name"], hasHeld: boolean, held: string, broke: string): TrialView =>
    ({ name, hasHeld, says: hasHeld ? held : broke, saw: hasHeld ? undefined : words.saw(check.saw[name]) });
  return [
    view("working", check.proof.working, words.working.held, words.working.broke),
    view("nearMiss", check.proof.nearMiss, words.nearMiss.held(check.nearMiss), words.nearMiss.broke(check.nearMiss)),
    view("nothing", check.proof.nothing, words.nothing.held, words.nothing.broke),
  ];
}

export type VerdictState = "ready" | "short" | "stale";

export interface Verdict {
  readonly state: VerdictState;
  /** a few words to shout */
  readonly shout: string;
  /** a sentence to read under them */
  readonly says: string;
}

/** What the poster is told about a set of checks once it is back. */
export function verdictOn(checks: readonly Written[], isFresh: boolean): Verdict {
  if (!isFresh) return { state: "stale", ...COPY.checks.verdict.stale };
  const shaky = checks.filter((check) => !isProven(check)).length;
  return shaky === 0
    ? { state: "ready", ...COPY.checks.verdict.ready(checks.length) }
    : { state: "short", ...COPY.checks.verdict.short(shaky, checks.length) };
}

/** A clock, the way a stopwatch shows it: 1:05. */
export const asClock = (seconds: number): string =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

/**
 * The line under the button. The clock is kept apart from the words: the words are announced to a
 * screen reader when they change, and a clock that changes every second would be read out every
 * second, for minutes.
 */
export type WritingLine =
  | { readonly state: "busy"; readonly text: string; readonly clock: string }
  | { readonly state: "failed"; readonly text: string }
  | { readonly state: "quiet"; readonly text: "" };

/**
 * The line under the button: where the writing is while it happens, why it stopped if it did, or why
 * pressing the button did not start it. Only one of them at a time, in that order.
 */
export function writingLine(input: {
  readonly stage: Stage | undefined;
  readonly seconds: number;
  readonly error: string | undefined;
  readonly refusal: string | undefined;
}): WritingLine {
  if (input.stage) {
    return { state: "busy", text: `${COPY.checks.stages[input.stage]}. ${COPY.checks.patience}`, clock: asClock(input.seconds) };
  }
  if (input.error) return { state: "failed", text: COPY.checks.failed(input.error) };
  if (input.refusal) return { state: "failed", text: input.refusal };
  return { state: "quiet", text: "" };
}
