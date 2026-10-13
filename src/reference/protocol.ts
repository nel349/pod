/**
 * How the reference agents talk to each other, through signed notes. The only convention they share.
 *
 * The candidate itself needs no note: it is the commit the contract's approvals are bound to, which
 * every seat reads from the chain, whoever named it there. Notes carry what the chain cannot: why a seat refused, so the
 * builder can do better, and what a seat saw when it approved, so the record says more than yes.
 * Outside agents are free to write whatever they like; these are only the reference agents' words.
 */
import type { Role } from "../job.ts";

export const APPROVED = "Approved: ";
export const REFUSED = "Refused: ";
export const BROUGHT_IN = "Brought in: ";
/** What a reviewer says at the start of a job: what it will look at on this one */
export const LOOKING_AT = "On this job the reviewer looks at: ";
/** The lead's conclusion of a review: who it names for pay, and why */
export const CONCLUDED = "Concluded: ";
/** In a lead's conclusion, a seat that earned its pay, and one kept from it */
export const EARNED = "EARNED";
export const KEPT = "KEPT";

/**
 * The seats whose refusals the builder answers, because they judge the work rather than make it. The
 * lead is one of them where a builder puts its own work forward; where the lead names the candidate
 * instead, it refuses nothing in a note, so naming it here changes nothing there
 */
export const JUDGES: readonly Role[] = ["lead", "reviewer", "qa", "security"];

/** How many times a builder rebuilds after a refusal before it stops and says so */
export const MOST_REBUILDS = 3;

export interface Verdict {
  readonly approve: boolean;
  readonly why: string;
  /** the rest of the seat's account, after its one line: what it looked at and found, which the reviewer, the lead and the poster read */
  readonly account?: string;
}

/** How much of a seat's account goes into its note, which a note's own limit leaves room for beside its first line */
export const LONGEST_ACCOUNT = 3_000;

/**
 * A seat's note on a candidate: its yes or no with why, and under it the account of what it did.
 * What is sent is cut to a note's limit by tellThePod, after the dashes are taken out.
 */
export function noteOf(verdict: Verdict): string {
  return `${verdict.approve ? APPROVED : REFUSED}${verdict.why}${verdict.account ? `\n${verdict.account}` : ""}`;
}

/** What a model wrote after its word, without whatever it put between the two: a colon, a comma, a dash of any length. */
export function afterTheWord(said: string): string {
  return said.replace(/^[\s:,.\-\u2013\u2014]+/, "").trim();
}

/**
 * A model's verdict: a first line, `APPROVE why` or `REFUSE why`, and under it whatever account the
 * seat was asked for. Anything else on the first line is a refusal, because a seat that cannot say
 * yes clearly has not said yes.
 */
export function verdictFrom(answer: string): Verdict {
  const [firstLine, ...rest] = answer.trim().split("\n");
  const first = firstLine?.trim() ?? "";
  const account = rest.join("\n").trim().slice(0, LONGEST_ACCOUNT);
  const withAccount = (verdict: Verdict): Verdict => (account ? { ...verdict, account } : verdict);
  // whatever the model put between its word and its reason, a colon, a dash of any length, is not the reason
  const reason = (word: RegExp): string => afterTheWord(first.replace(word, ""));
  if (/^approve\b/i.test(first)) return withAccount({ approve: true, why: reason(/^approve/i) || "it does what was asked" });
  if (/^refuse\b/i.test(first)) return withAccount({ approve: false, why: reason(/^refuse/i) || "it does not do what was asked" });
  return { approve: false, why: `the model did not answer APPROVE or REFUSE, so this is not a yes: ${first.slice(0, 200)}` };
}
