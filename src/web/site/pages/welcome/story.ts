/**
 * The story the welcome page tells, as plain state: the six steps of a job in its poster's order, the
 * beats the film plays them in, and what every prop on the stage looks like at each beat. Nothing here
 * draws or keeps time: the film draws from it, and the player moves through it.
 */
import { shareOf, type Role } from "../../../../job.ts";
import { SEATS } from "../../../../seal.ts";

/** A job as its poster lives it: each step is a line in the list and a scene of the film. */
export const STEPS = ["say", "checks", "pod", "forward", "delivered", "lastWord"] as const;
export type Step = (typeof STEPS)[number];

/** The three ways the last step ends, played one after another. */
export const ENDINGS = ["accept", "refuse", "silence"] as const;
export type Ending = (typeof ENDINGS)[number];

/** What the film plays, in order: a beat for each step, and one for each ending of the last. */
export const BEATS = ["say", "checks", "pod", "forward", "delivered", ...ENDINGS] as const;
export type Beat = (typeof BEATS)[number];

const isEnding = (beat: Beat): beat is Ending => ENDINGS.some((ending) => ending === beat);

export const stepOf = (beat: Beat): Step => (isEnding(beat) ? "lastWord" : beat);
export const endingOf = (beat: Beat): Ending | undefined => (isEnding(beat) ? beat : undefined);
/** the beat a step starts at: the last step starts at its first ending */
export const firstBeatOf = (step: Step): Beat => (step === "lastWord" ? ENDINGS[0] : step);
/** the beat after this one, round to the first again after the last */
export const beatAfter = (beat: Beat): Beat => BEATS[(BEATS.indexOf(beat) + 1) % BEATS.length] ?? BEATS[0];

/** How long each beat is held: long enough to read its line and watch it happen. */
export const BEAT_MS: Record<Beat, number> = {
  say: 7000, checks: 6000, pod: 6000, forward: 6500, delivered: 6500, accept: 6500, refuse: 7000, silence: 7500,
};

/** a line of the job: as its poster wrote it, turned into a check, or run and passed */
export type LineState = "written" | "check" | "passed";
/** the line kept from the builders: written, covered once it is a check, and shown again once it has run */
export type KeptState = "written" | "covered" | "passed";
export type StampState = "approved" | "delivered" | "paid" | "refused";
/** what the poster has done with the two answers: not offered yet, offered and waited on, or pressed */
export type AnswerState = "none" | "accepted" | "refused" | "waiting";
/** a seat: nobody in it, taken, the builder's with its work put forward, behind that work, paid in full, or left with its part */
export type SeatState = "empty" | "seated" | "forward" | "behind" | "paid" | "keptPart";
/** where the money is: on its way in from the poster, held, with the pod, or split between the two */
export type MoneyState = "arriving" | "held" | "paid" | "shared";

/** Everything on the stage at one beat. */
export interface Scene {
  readonly lines: LineState;
  readonly kept: KeptState;
  readonly stamp?: StampState;
  /** whether what the pod built can be opened yet */
  readonly canOpen: boolean;
  readonly answer: AnswerState;
  readonly seats: Readonly<Record<Role, SeatState>>;
  readonly money: MoneyState;
}

const everySeat = (state: SeatState): Record<Role, SeatState> =>
  ({ lead: state, builder: state, reviewer: state, qa: state, security: state });
/** the builder has put its work forward, and every other seat stands behind it */
const BEHIND_THE_WORK: Record<Role, SeatState> = { ...everySeat("behind"), builder: "forward" };

const DELIVERED: Scene = { lines: "passed", kept: "passed", stamp: "delivered", canOpen: true, answer: "none", seats: BEHIND_THE_WORK, money: "held" };

const SCENES: Record<Beat, Scene> = {
  say: { lines: "written", kept: "written", canOpen: false, answer: "none", seats: everySeat("empty"), money: "arriving" },
  checks: { lines: "check", kept: "covered", stamp: "approved", canOpen: false, answer: "none", seats: everySeat("empty"), money: "held" },
  pod: { lines: "check", kept: "covered", stamp: "approved", canOpen: false, answer: "none", seats: everySeat("seated"), money: "held" },
  forward: { lines: "check", kept: "covered", stamp: "approved", canOpen: false, answer: "none", seats: BEHIND_THE_WORK, money: "held" },
  delivered: DELIVERED,
  accept: { ...DELIVERED, stamp: "paid", answer: "accepted", seats: everySeat("paid"), money: "paid" },
  refuse: { ...DELIVERED, stamp: "refused", answer: "refused", seats: everySeat("keptPart"), money: "shared" },
  silence: { ...DELIVERED, stamp: "paid", answer: "waiting", seats: everySeat("paid"), money: "paid" },
};

export const sceneOf = (beat: Beat): Scene => SCENES[beat];

/** What an example job's price comes to, in wei, by the contract's own rule and the seats' own shares. */
export interface ExampleMoney {
  readonly price: bigint;
  /** what each seat is paid when the work is accepted */
  readonly pay: Readonly<Record<Role, bigint>>;
  /** what each seat keeps when work that passed its checks is refused */
  readonly kept: Readonly<Record<Role, bigint>>;
  /** what the whole pod keeps then, and what comes back to the poster */
  readonly podKeeps: bigint;
  readonly comesBack: bigint;
}

/** @param refusalSharePercent what a pod keeps of the price when its poster refuses work that passed */
export function exampleMoney(price: bigint, refusalSharePercent: number): ExampleMoney {
  const each = (of: (role: Role) => bigint): Record<Role, bigint> =>
    ({ lead: of("lead"), builder: of("builder"), reviewer: of("reviewer"), qa: of("qa"), security: of("security") });
  const pay = each((role) => shareOf(price, role));
  const kept = each((role) => (pay[role] * BigInt(refusalSharePercent)) / 100n);
  const podKeeps = SEATS.reduce((sum, role) => sum + kept[role], 0n);
  return { price, pay, kept, podKeeps, comesBack: price - podKeeps };
}
