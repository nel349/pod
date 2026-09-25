/**
 * What a reference agent has once it holds a seat, and the few things every seat reads the same way.
 */
import { zeroHash } from "viem";
import type { Model } from "../broker.ts";
import { plainDashes } from "../checkwriting/fromTheBox.ts";
import type { ListedJob } from "../door/index.ts";
import { branchFor } from "../door/seat.ts";
import type { Role } from "../job.ts";
import type { HeldSeat } from "../jobs.ts";
import { bytes32ToCommit } from "../repo.ts";
import type { Identity, JobRef } from "./Identity.ts";
import type { PodServer } from "./PodServer.ts";
import type { WorkingCopy } from "./WorkingCopy.ts";

export interface Seated {
  readonly job: JobRef;
  readonly role: Role;
  /** the job as the list described it when the seat was taken: its brief does not change */
  readonly listed: ListedJob;
  readonly identity: Identity;
  readonly server: PodServer;
  readonly copy: WorkingCopy;
  /** the owner's model. The lead and QA never ask it anything */
  readonly model?: Model;
  /** the image a verdict runs in, which QA runs the visible checks in too */
  readonly image: string;
  readonly say: (what: string) => void;
}

/** What one seat does each time it looks: whatever it is its turn to do, and nothing when it is not. */
export interface SeatWork {
  step(): Promise<void>;
}

/** The pod's candidate: the commit the contract's approvals are bound to, or nothing until the lead names one. */
export async function candidateOf(seated: Seated): Promise<string | undefined> {
  const onChain = await seated.identity.readJob(seated.job);
  return onChain.commit === zeroHash ? undefined : bytes32ToCommit(onChain.commit);
}

/** The lead's branch, which is where every candidate is. */
export function leadBranchOf(seats: readonly HeldSeat[]): string | undefined {
  const lead = seats.find((seat) => seat.role === "lead");
  return lead ? branchFor("lead", lead.agent) : undefined;
}

/** The signed password the doors take, as a seat. */
export function passwordFor(seated: Seated): Promise<string> {
  return seated.identity.doorPassword(seated.job, seated.role);
}

/**
 * The seat's notes to its pod, signed and sent. Much of what they say is the model's words, and notes
 * are published with the job, so the dashes a model likes are taken out as they are for the checks.
 */
export async function tellThePod(seated: Seated, says: string, about?: string): Promise<void> {
  await seated.server.writeNote(seated.job, await seated.identity.note(seated.job, seated.role, plainDashes(says), about));
}

/** The brief as the model reads it: the idea, what the visible checks ask, and where the work may reach. */
export function briefFor(listed: ListedJob): string {
  return [
    listed.idea,
    "",
    "What will be checked, in the open (there are more checks, sealed until the verdict):",
    ...listed.visibleChecks.map((check) => `- ${check.says}`),
    "",
    listed.allowedHosts.length === 0
      ? "It may not open a connection out to any other host."
      : `It may open connections out only to: ${listed.allowedHosts.map((allowed) => `${allowed.host} (${allowed.why})`).join(", ")}.`,
  ].join("\n");
}
