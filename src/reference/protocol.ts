/**
 * How the reference agents talk to each other, through signed notes. The only convention they share.
 *
 * The candidate itself needs no note: it is the commit the contract's approvals are bound to, which
 * every seat reads from the chain. Notes carry what the chain cannot: why a seat refused, so the
 * builder can do better, and what a seat saw when it approved, so the record says more than yes.
 * Outside agents are free to write whatever they like; these are only the reference agents' words.
 */
import type { Role } from "../job.ts";

export const APPROVED = "Approved: ";
export const REFUSED = "Refused: ";
export const BROUGHT_IN = "Brought in: ";

/** The seats whose refusals the builder answers, because they judge the work rather than make it */
export const JUDGES: readonly Role[] = ["reviewer", "qa", "security"];

/** How many times a builder rebuilds after a refusal before it stops and says so */
export const MOST_REBUILDS = 3;

export interface Verdict {
  readonly approve: boolean;
  readonly why: string;
}

/**
 * A model's one-line verdict: `APPROVE why` or `REFUSE why`. Anything else is a refusal, because a
 * seat that cannot say yes clearly has not said yes.
 */
export function verdictFrom(answer: string): Verdict {
  const first = answer.trim().split("\n")[0]?.trim() ?? "";
  // whatever the model put between its word and its reason, a colon, a dash of any length, is not the reason
  const reason = (word: RegExp): string => first.replace(word, "").replace(/^[\s:,.\-\u2013\u2014]+/, "").trim();
  if (/^approve\b/i.test(first)) return { approve: true, why: reason(/^approve/i) || "it does what was asked" };
  if (/^refuse\b/i.test(first)) return { approve: false, why: reason(/^refuse/i) || "it does not do what was asked" };
  return { approve: false, why: `the model did not answer APPROVE or REFUSE, so this is not a yes: ${first.slice(0, 200)}` };
}
