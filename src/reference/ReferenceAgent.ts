/**
 * The reference agent: one of the five seats, run by anybody, through the public doors only.
 *
 * It finds a job with its role free and its owner not already in the pod, takes the seat on the
 * contract with its own key, and then looks at the job every few seconds and does whatever it is its
 * turn to do, until the job is settled, refunded or out of time. Nothing in the platform knows or
 * cares that this is ours: it uses the list, the contract, the git door and the notes exactly as a
 * stranger's agent would, which is what makes it the test of those doors.
 */
import type { Address, Hex } from "viem";
import type { Model } from "../broker.ts";
import type { ListedJob } from "../door/index.ts";
import { agentEmail } from "../door/seat.ts";
import type { Role } from "../job.ts";
import { IMAGE } from "../sandbox.ts";
import { Identity, type JobRef } from "./Identity.ts";
import { PodServer } from "./PodServer.ts";
import { Builder } from "./roles/Builder.ts";
import { Judge } from "./roles/Judge.ts";
import { Lead } from "./roles/Lead.ts";
import { qaRunning, reviewing, securityReading } from "./roles/judgements.ts";
import type { Seated, SeatWork } from "./Seated.ts";
import { WorkingCopy } from "./WorkingCopy.ts";

/** How often a seat looks at its job. Often enough to keep a pod moving, rarely enough to be polite */
export const LOOK_EVERY_MS = 5_000;

/** The seats that think with a model. The lead and QA never ask it anything */
const NEEDS_A_MODEL: readonly Role[] = ["builder", "reviewer", "security"];

export interface ReferenceAgentOptions {
  /** the server's address, where its public doors are */
  readonly server: string;
  readonly key: Hex;
  readonly role: Role;
  /** who is behind the agent, if not the agent itself */
  readonly owner?: Address;
  readonly model?: Model;
  /** the image QA runs the visible checks in: the one a verdict uses, unless told otherwise */
  readonly image?: string;
  readonly every?: number;
  /** take a seat on this job only, rather than the first with the role free */
  readonly jobId?: string;
  readonly signal?: AbortSignal;
  readonly say?: (what: string) => void;
}

export interface Finished {
  readonly jobId?: string;
  readonly why: string;
}

export async function runReferenceAgent(options: ReferenceAgentOptions): Promise<Finished> {
  if (NEEDS_A_MODEL.includes(options.role) && !options.model) throw new Error(`the ${options.role} seat needs a model`);
  const say = (what: string): void => (options.say ?? console.log)(`[${options.role}] ${what}`);
  const every = options.every ?? LOOK_EVERY_MS;
  const server = new PodServer(options.server);
  const identity = new Identity(options.key, await server.market(), options.owner);

  const taken = await takeASeat(server, identity, options, say, every);
  if (!taken) return { why: "stopped before a seat was free" };
  const job: JobRef = { jobId: taken.jobId, onChainId: BigInt(taken.contract.jobId) };
  say(`holds the ${options.role} seat on ${job.jobId} (job ${job.onChainId} on the contract)`);

  const copy = await WorkingCopy.open(
    async () => server.gitRemote(job, identity.address, await identity.doorPassword(job, options.role)),
    { name: `${options.role} ${identity.address.slice(0, 10)}`, email: agentEmail(identity.address) },
  );
  const seated: Seated = {
    job, role: options.role, listed: taken, identity, server, copy,
    model: options.model, image: options.image ?? IMAGE, say,
  };
  const work = workFor(seated);
  try {
    while (!options.signal?.aborted) {
      const over = await whyItIsOver(identity, job);
      if (over) return { jobId: job.jobId, why: over };
      try {
        await work.step();
      } catch (error) {
        // a turn that failed is tried again on the next look: the network, the chain and the model all have bad moments
        say(`this turn failed, and will be tried again: ${(error as Error).message.split("\n")[0]}`);
      }
      await pause(every, options.signal);
    }
    return { jobId: job.jobId, why: "stopped" };
  } finally {
    await copy.close();
  }
}

function workFor(seated: Seated): SeatWork {
  switch (seated.role) {
    case "lead": return new Lead(seated);
    case "builder": return new Builder(seated);
    case "reviewer": return new Judge(seated, reviewing);
    case "qa": return new Judge(seated, qaRunning);
    case "security": return new Judge(seated, securityReading);
  }
}

/** Look for a job with this role free and this owner not in its pod, and take the seat. */
async function takeASeat(
  server: PodServer, identity: Identity, options: ReferenceAgentOptions, say: (what: string) => void, every: number,
): Promise<ListedJob | undefined> {
  const owner = identity.ownerAddress.toLowerCase();
  while (!options.signal?.aborted) {
    const open = (await server.jobs()).jobs.filter((job) =>
      (options.jobId === undefined || job.jobId === options.jobId)
      && job.free.includes(options.role)
      && !job.owners.some((seated) => seated.toLowerCase() === owner));
    for (const job of open) {
      try {
        await identity.takeSeat({ jobId: job.jobId, onChainId: BigInt(job.contract.jobId) }, options.role);
        return job;
      } catch (error) {
        // somebody else took it between the list and the transaction: the contract said so, and nothing was spent but gas
        say(`could not take the ${options.role} seat on ${job.jobId}: ${(error as Error).message.split("\n")[0]}`);
      }
    }
    await pause(every, options.signal);
  }
  return undefined;
}

/** Why there is nothing more to do on this job, or nothing if there still is. */
async function whyItIsOver(identity: Identity, job: JobRef): Promise<string | undefined> {
  const onChain = await identity.readJob(job);
  if (onChain.state === "settled" || onChain.state === "refunded") return `the job is ${onChain.state}`;
  if ((await identity.now()) >= onChain.endsAt) return "the job's window has closed";
  return undefined;
}

/** Wait, unless told to stop. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
