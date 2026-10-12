/**
 * The seats a lead names for pay, as it tells them: "reviewer, qa" or "reviewer 2, security", or
 * "none". Read here, apart from the command, so what a lead may write is plain and tested.
 *
 * Only a reviewer, QA or security seat can be named: the builder's pay follows the work, and the
 * lead's own its conclusion. A job has one seat of each but the reviewer's, so only a reviewer is
 * ever numbered, from 1.
 */
import { NAMED_BY_THE_LEAD, type NamedByTheLead, type NamedSeat } from "../../../src/jobsV4.ts";

export type SeatsNamed =
  | { readonly ok: true; readonly seats: readonly NamedSeat[] }
  | { readonly ok: false; readonly code: "NOT_A_SEAT_TO_NAME"; readonly why: string; readonly hint: string };

/** The word a lead writes to name nobody, which has to be said rather than left out by a slip */
export const NOBODY = "none";
const HINT = `Name seats as "reviewer, qa, security", a second reviewer seat as "reviewer 2", or nobody as "${NOBODY}".`;
/** the most reviewer seats a job can have, as the contract has it */
const MOST_REVIEWERS = 5;

export function seatsNamed(told: string): SeatsNamed {
  const words = told.split(",").map((word) => word.trim().toLowerCase()).filter((word) => word !== "");
  if (words.length === 0) return { ok: false, code: "NOT_A_SEAT_TO_NAME", why: "No seat is named, and nobody is said to be.", hint: HINT };
  if (words.length === 1 && words[0] === NOBODY) return { ok: true, seats: [] };
  const seats: NamedSeat[] = [];
  for (const word of words) {
    const [, role, number] = /^([a-z]+)(?:\s+(\d+))?$/.exec(word) ?? [];
    const named = NAMED_BY_THE_LEAD.find((one): one is NamedByTheLead => one === role);
    if (!named) return { ok: false, code: "NOT_A_SEAT_TO_NAME", why: `"${word}" is not a seat a lead names.`, hint: HINT };
    const index = number === undefined ? 0 : Number(number) - 1;
    if (index < 0 || index >= (named === "reviewer" ? MOST_REVIEWERS : 1)) {
      return { ok: false, code: "NOT_A_SEAT_TO_NAME", why: `There is no "${word}" seat.`, hint: HINT };
    }
    if (seats.some((seat) => seat.role === named && seat.index === index)) continue;
    seats.push({ role: named, index });
  }
  return { ok: true, seats };
}

/** The fingerprint of an account as a command is told it: 32 bytes, in hex. */
export const AN_ACCOUNT = /^0x[0-9a-f]{64}$/;
