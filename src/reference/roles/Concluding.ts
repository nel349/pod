/**
 * The lead, where the lead names who is paid.
 *
 * It does two things with a candidate, in this order. First it holds the work to what the poster
 * asked, as it does on the contract before, and says what it found in a note the whole pod reads: a
 * refusal is the builder's to answer. Then, once the work holds, it waits for the other seats, reads
 * the account each bound to its yes, and concludes the review on the contract: it stands behind the
 * work, names the seats that earned their pay, and binds its reasons.
 *
 * It waits only as long as the contract makes it: until every other seat taken has said yes, or half
 * the time for reviewing has gone. A seat that had not said yes by then is not behind the work. A
 * seat that said yes and published no account matching the fingerprint it bound has shown nothing,
 * and is not named: that much is decided here without a model, because it is a fact. Whether an
 * account that is there shows the seat did its work is the model's to read, seat by seat, and a seat
 * the model says nothing clear about holds the conclusion up, rather than being cut by a slip.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAddressEqual, type Hex } from "viem";
import { NAMED_BY_THE_LEAD, type NamedByTheLead, type NamedSeat } from "../../jobsV4.ts";
import { SEATS } from "../../seal.ts";
import type { HeldSeat } from "../../jobs.ts";
import type { Note } from "../../note.ts";
import { shortCommit } from "../../repo.ts";
import { DUTIES } from "../../standard.ts";
import { afterTheWord, CONCLUDED, EARNED, KEPT, noteOf, type Verdict } from "../protocol.ts";
import { candidateBranchOf, candidateOf, passwordFor, tellThePod, type Seated, type SeatWork } from "../Seated.ts";
import type { Judgement } from "./Judge.ts";

/** How much of a review the other seats have to themselves before the lead may conclude without them, as the contract has it */
const THE_OTHER_SEATS_OWN = 0.5;
/** How long the lead waits for its model to say who earned their pay */
const NAMING_MAY_TAKE_MS = 3 * 60_000;
/** How much of one seat's reason goes into the lead's conclusion */
const LONGEST_REASON = 300;

/** A seat behind the work, as the lead weighs it: which seat, and the account it published, if the one it bound is among its notes. */
interface Weighed {
  readonly seat: NamedSeat;
  readonly agent: HeldSeat["agent"];
  readonly account?: string;
}

/** What the lead says of one seat: whether it earned its pay, and why. */
interface Finding {
  readonly seat: NamedSeat;
  readonly earned: boolean;
  readonly why: string;
}

const nameOf = (seat: NamedSeat): string => `${seat.role} ${seat.index + 1}`;

export class Concluding implements SeatWork {
  private readonly verdicts = new Map<string, Verdict>();
  private readonly told = new Set<string>();
  /** the conclusion written for a candidate, kept so a send that failed is tried again and not written afresh */
  private readonly concluded = new Map<string, { readonly named: readonly NamedSeat[]; readonly account: Hex; readonly said: string }>();
  private readonly refused = new Set<string>();
  /** candidates this lead has said it is waiting on the other seats for, so it is said once */
  private readonly saidWaiting = new Set<string>();
  private readonly saidOver = new Set<string>();

  constructor(private readonly seated: Seated, private readonly judgement: Judgement) {}

  async step(): Promise<void> {
    const { seated } = this;
    const candidate = await candidateOf(seated);
    if (!candidate || this.refused.has(candidate)) return;
    if (await seated.identity.isConcluded(seated.job)) return;
    if (await seated.identity.isReviewOver(seated.job)) {
      if (!this.saidOver.has(candidate)) seated.say(`the review of ${shortCommit(candidate)} ran out before the lead concluded it, so every seat behind it is paid and the lead is not`);
      this.saidOver.add(candidate);
      return;
    }

    const verdict = this.verdicts.get(candidate) ?? await this.judge(candidate);
    if (!verdict) return;
    this.verdicts.set(candidate, verdict);
    if (!this.told.has(candidate)) {
      await tellThePod(seated, noteOf(verdict), candidate);
      this.told.add(candidate);
    }
    if (!verdict.approve) {
      this.refused.add(candidate);
      seated.say(`refused ${shortCommit(candidate)}: ${verdict.why}`);
      return;
    }

    const seats = await seated.identity.readSeats(seated.job);
    const others = seats.filter((seat): seat is HeldSeat & { role: NamedByTheLead } => (NAMED_BY_THE_LEAD as readonly string[]).includes(seat.role));
    const gone = await seated.identity.reviewGone(seated.job);
    if (others.some((seat) => !seat.approved) && (gone === undefined || gone < THE_OTHER_SEATS_OWN)) {
      if (!this.saidWaiting.has(candidate)) seated.say(`the work holds; waiting for the other seats to say whether they stand behind ${shortCommit(candidate)} before concluding`);
      this.saidWaiting.add(candidate);
      return;
    }
    if ((await candidateOf(seated)) !== candidate) return;

    const written = this.concluded.get(candidate) ?? await this.writeTheConclusion(candidate, verdict, seats, others.filter((seat) => seat.approved));
    this.concluded.set(candidate, written);
    // only the sending is tried again: what was found and what was written of it stand
    await seated.identity.conclude(seated.job, candidate, written.named, written.account);
    seated.say(`concluded the review of ${shortCommit(candidate)}: ${written.said}`);
  }

  /**
   * What the lead finds of each seat, written to the pod as one note: its fingerprint is what the
   * conclusion binds. Done once for a candidate, however often the sending has to be tried again.
   */
  private async writeTheConclusion(
    candidate: string, verdict: Verdict, seats: readonly HeldSeat[], behind: readonly (HeldSeat & { role: NamedByTheLead })[],
  ): Promise<{ readonly named: readonly NamedSeat[]; readonly account: Hex; readonly said: string }> {
    const { seated } = this;
    const weighed = await this.weigh(candidate, seats, behind);
    const findings = await this.findingsOn(candidate, verdict, weighed);
    const account = await tellThePod(seated, [
      `${CONCLUDED}${verdict.why}`,
      ...findings.map((finding) => `${nameOf(finding.seat)}: ${finding.earned ? EARNED : KEPT}, ${finding.why}`),
      ...(findings.length === 0 ? ["No other seat stands behind this work, so nobody else is named."] : []),
    ].join("\n"), candidate);
    return {
      named: findings.filter((finding) => finding.earned).map((finding) => finding.seat),
      account,
      said: findings.length === 0
        ? "no other seat behind it"
        : findings.map((finding) => `${nameOf(finding.seat)} ${finding.earned ? "earned its pay" : "is kept from the pay"}`).join(", "),
    };
  }

  /** Each seat behind the work with the account it published, when the fingerprint it bound is one of its notes on this candidate. */
  private async weigh(candidate: string, seats: readonly HeldSeat[], behind: readonly (HeldSeat & { role: NamedByTheLead })[]): Promise<readonly Weighed[]> {
    const { seated } = this;
    const notes = await seated.server.notes(seated.job, seated.identity.address, await passwordFor(seated));
    // the contract keeps a row of seats for each role: a seat's place in its row is what names it,
    // and two seats of one role held by one agent are told apart by it where an address could not
    const places = new Map(SEATS.flatMap((role) => seats.filter((seat) => seat.role === role).map((seat, index) => [seat, index] as const)));
    return Promise.all(behind.map(async (held) => {
      const index = places.get(held) ?? 0;
      const bound = await seated.identity.accountBound(seated.job, held.role, index);
      const published = notes.find((note: Note) => note.about === candidate && note.role === held.role && isAddressEqual(note.agent, held.agent)
        && seated.identity.accountOf(seated.job, note).toLowerCase() === bound?.toLowerCase());
      return { seat: { role: held.role, index }, agent: held.agent, ...(published ? { account: published.says } : {}) };
    }));
  }

  /** What the lead finds of each seat behind the work. A seat with no published account is kept from the pay without asking anybody. */
  private async findingsOn(candidate: string, verdict: Verdict, weighed: readonly Weighed[]): Promise<readonly Finding[]> {
    const { seated } = this;
    const shown = weighed.filter((one): one is Weighed & { account: string } => one.account !== undefined);
    const silent: Finding[] = weighed.filter((one) => one.account === undefined)
      .map((one) => ({ seat: one.seat, earned: false, why: "it said yes and published no account matching the one it bound, so there is nothing to show it did its work" }));
    if (shown.length === 0) return silent;
    if (!seated.model) throw new Error("the lead needs a model to read the other seats' accounts with");

    const answer = await seated.model([
      "You are the lead on a small team, and the work is about to be delivered. You have read it and it holds:",
      verdict.why,
      "",
      "Each seat below says it stands behind the work, and has left an account of what it did. You decide, on that account",
      "alone, whether the seat did the work its seat is for, and so whether it is paid. Be fair and be strict: an account",
      "that says what the seat looked at and what it found, in particulars about this work, has earned its pay, whether it",
      "found faults or none. An account that could have been written without opening the work, that only says the work is",
      "good, or that says nothing of what the seat is for, has not.",
      "",
      `Reply with one line for each seat and nothing else, in this form: <seat>: ${EARNED} <why> or <seat>: ${KEPT} <why>.`,
      `The seats are named exactly: ${shown.map((one) => nameOf(one.seat)).join(", ")}.`,
      ...shown.flatMap((one) => ["", `## ${nameOf(one.seat)}`, `What this seat is for: ${DUTIES[one.seat.role]}`, "Its account:", one.account]),
    ].join("\n"), AbortSignal.timeout(NAMING_MAY_TAKE_MS));

    const lines = answer.split("\n").map((line) => line.trim());
    const read = shown.map((one): Finding => {
      const line = lines.find((said) => said.toLowerCase().startsWith(`${nameOf(one.seat)}:`));
      const rest = line?.slice(nameOf(one.seat).length + 1).trim() ?? "";
      const said = [EARNED, KEPT].find((word) => rest.toUpperCase().startsWith(word));
      // a seat is never cut, or paid, on a line the model did not clearly write: the turn fails and is tried again
      if (!said) throw new Error(`the lead's model did not say whether the ${nameOf(one.seat)} seat earned its pay on ${shortCommit(candidate)}`);
      const why = afterTheWord(rest.slice(said.length)).slice(0, LONGEST_REASON);
      return { seat: one.seat, earned: said === EARNED, why: why || (said === EARNED ? "its account shows it did its work" : "its account does not show it did its work") };
    });
    return [...read, ...silent];
  }

  /** The lead's judgement of the work itself, or nothing if the builder's branch does not have the candidate yet. */
  private async judge(candidate: string): Promise<Verdict | undefined> {
    const { seated } = this;
    const itsBranch = candidateBranchOf(seated, await seated.identity.readSeats(seated.job));
    if (!itsBranch || !(await seated.copy.fetch(itsBranch))) return undefined;
    const files = await mkdtemp(join(tmpdir(), "pod-lead-"));
    try {
      await seated.copy.layOut(candidate, files);
      return await this.judgement(seated, files, candidate);
    } finally {
      await rm(files, { recursive: true, force: true });
    }
  }
}
