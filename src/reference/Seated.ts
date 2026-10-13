/**
 * What a reference agent has once it holds a seat, and the few things every seat reads the same way.
 */
import { zeroHash, type Hex } from "viem";
import type { Model } from "../broker.ts";
import { plainDashes } from "../checkwriting/fromTheBox.ts";
import type { ListedJob } from "../door/index.ts";
import { branchFor } from "../door/seat.ts";
import type { Role } from "../job.ts";
import type { HeldSeat } from "../jobs.ts";
import { LONGEST_NOTE } from "../note.ts";
import { bytes32ToCommit } from "../repo.ts";
import { secondsNow } from "../clock.ts";
import { hasTriage, isWaiting, questionNote, raisedNote, settledAs } from "../triage.ts";
import type { Identity, JobRef } from "./Identity.ts";
import type { PodServer } from "./PodServer.ts";
import type { WorkingCopy } from "./WorkingCopy.ts";

export interface Seated {
  readonly job: JobRef;
  readonly role: Role;
  /** the job as the list described it when the seat was taken: its brief does not change */
  readonly listed: ListedJob;
  /** what the poster pointed the pod at, as this agent read it when it took the seat */
  readonly references: readonly ReadReference[];
  readonly identity: Identity;
  readonly server: PodServer;
  readonly copy: WorkingCopy;
  /** the owner's model. The lead and QA never ask it anything */
  readonly model?: Model;
  /** the image a verdict runs in, which QA runs the visible checks in too */
  readonly image: string;
  /**
   * Whether the builder names the candidate here, by putting its own work forward, rather than the
   * lead by bringing it into its branch: the contract's rule, read from it when the seat was taken
   */
  readonly builderNames: boolean;
  /**
   * Whether the lead names who is paid here: each seat then binds its account to its yes, and the lead
   * stands behind the work by concluding its review. The contract's rule, read from it when the seat was taken
   */
  readonly leadNames: boolean;
  /** how long a builder on a job long enough for questions leaves its lead to ask the poster before it builds; left out, the usual */
  readonly askingGraceSeconds?: number;
  /** how long a lead leaves the other seats to raise their questions before it puts the pod's list to the poster; left out, the usual */
  readonly gatheringSeconds?: number;
  readonly say: (what: string) => void;
}

/** How long a lead leaves the other seats to raise their questions, on a job long enough for them, before it puts the pod's list to the poster. */
export const GATHERING_SECONDS = 10 * 60;
/**
 * How long a builder waits for its lead to put the pod's questions to the poster, or to say it has
 * none, before it builds from what it has: the lead's gathering and its thinking, and no longer, so a
 * lead that never comes holds nothing up.
 */
export const ASKING_GRACE_SECONDS = 30 * 60;

/** A seat's question for the poster, raised with its lead: a note to the pod in the form a lead gathers them by. */
export async function raiseWithTheLead(seated: Seated, asks: string, assumes: string): Promise<void> {
  await seated.server.writeNote(seated.job, await seated.identity.note(seated.job, seated.role, raisedNote(plainDashes(asks), plainDashes(assumes))));
}

/** The lead's question to whoever posted the job, signed and sent as a note in the form every door reads as one. */
export async function askThePoster(seated: Seated, asks: string, assumes: string): Promise<void> {
  await seated.server.writeNote(seated.job, await seated.identity.note(seated.job, seated.role, questionNote(plainDashes(asks), plainDashes(assumes))));
}

/**
 * What the pod's questions came to, for a brief: each answer the poster gave, and for each question
 * nobody answered in its day, what its seat said it would assume. A question still waiting is left
 * out: nobody builds on an answer that has not come.
 */
export async function settledFor(seated: Seated): Promise<readonly string[]> {
  if (!hasTriage(seated.listed.mode)) return [];
  const now = secondsNow();
  return (await seated.server.questions(seated.job)).filter((question) => !isWaiting(question, now)).map(settledAs);
}

/** One of a job's references as an agent that reads only text can use it: its words, or that it is not words. */
export interface ReadReference {
  readonly name: string;
  readonly type: string;
  /** what it says, when it is text and held against its fingerprint; absent for a picture or a PDF, which this agent cannot read */
  readonly text?: string;
}

/** How much of one reference's text is put in front of the model */
export const MOST_REFERENCE_TEXT = 40_000;

/** What one seat does each time it looks: whatever it is its turn to do, and nothing when it is not. */
export interface SeatWork {
  step(): Promise<void>;
}

/** The pod's candidate: the commit the contract's approvals are bound to, or nothing until one is named. */
export async function candidateOf(seated: Seated): Promise<string | undefined> {
  const onChain = await seated.identity.readJob(seated.job);
  return onChain.commit === zeroHash ? undefined : bytes32ToCommit(onChain.commit);
}

/**
 * The branch every candidate is on: the builder's own, where a builder puts its work forward, and the
 * lead's on the contracts before, where the lead names a candidate by bringing it in.
 */
export function candidateBranchOf(seated: Seated, seats: readonly HeldSeat[]): string | undefined {
  const namedBy = seated.builderNames ? "builder" : "lead";
  const seat = seats.find((one) => one.role === namedBy);
  return seat ? branchFor(namedBy, seat.agent) : undefined;
}

/** The signed password the doors take, as a seat. */
export function passwordFor(seated: Seated): Promise<string> {
  return seated.identity.doorPassword(seated.job, seated.role);
}

/**
 * The seat's notes to its pod, signed and sent. Much of what they say is the model's words, and notes
 * are published with the job, so the dashes a model likes are taken out as they are for the checks.
 * Comes back with the note's fingerprint, which is what a seat binds to its yes where a contract takes one.
 */
export async function tellThePod(seated: Seated, says: string, about?: string): Promise<Hex> {
  // tidied first and cut after: taking out a dash puts a comma and a space in its place, so a note
  // cut to the limit and tidied afterwards can come back over it, and the door would refuse it
  const note = await seated.identity.note(seated.job, seated.role, plainDashes(says).slice(0, LONGEST_NOTE), about);
  await seated.server.writeNote(seated.job, note);
  return seated.identity.accountOf(seated.job, note);
}

/** The brief as the model reads it: the idea, what the visible checks ask, and where the work may reach. */
/**
 * @param settled what the pod asked the poster and what came of each, from `settledFor`: an answer
 *                counts as much as the person's first words, and an assumption only until they say otherwise
 */
export function briefFor(listed: ListedJob, references: readonly ReadReference[] = [], settled: readonly string[] = []): string {
  return [
    listed.idea,
    "",
    ...references.flatMap((one) => (one.text === undefined
      ? [`The person also pointed at ${one.name} (${one.type}), which you cannot see. Do not guess what it shows: say on the work, and in your reason, that it was not read.`, ""]
      : [`The person also pointed at ${one.name}, which says:`, one.text, ""])),
    ...(settled.length > 0
      ? ["The pod asked the person before building. Hold the work to their answers as to their first words; where they did not answer, to what was assumed:", ...settled.flatMap((one) => [one, ""])]
      : []),
    "What will be checked, in the open (there are more checks, sealed until the verdict):",
    ...listed.visibleChecks.map((check) => `- ${check.says}`),
    // lines no program can decide: nothing is run for them, and the person who posted the job judges them
    ...(listed.mine?.length
      ? ["", "These lines no check decides. Whoever posted the job judges them when the work is delivered, so build to them as to any other line:", ...listed.mine.map((says) => `- ${says}`)]
      : []),
    ...(listed.howItIsAsked ? ["", `How every check asks, the sealed ones too, which the work must accept: ${listed.howItIsAsked.exactly}`] : []),
    "",
    listed.allowedHosts.length === 0
      ? "It may not open a connection out to any other host."
      : `It may open connections out only to: ${listed.allowedHosts.map((allowed) => `${allowed.host} (${allowed.why})`).join(", ")}.`,
  ].join("\n");
}
