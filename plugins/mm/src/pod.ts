/**
 * POD, as the plugin reads it: only its public doors, and no further than it can check.
 *
 * Which chain and contract a site answers to, the jobs a seat can still be taken on, and one job by
 * its name. Everything that comes back is read through a schema: the site is somebody else's server.
 */
import { getAddress, isAddress, type Address } from "viem";
import { z } from "zod";
import { JobListingSchema, type ListedJob } from "../../../src/door/JobList.ts";
import { MarketConfigSchema, type MarketConfig } from "../../../src/market.ts";
import { jobApiPath, ROUTES } from "../../../src/routes.ts";

/** where POD is, unless a command is told another site */
export const POD_SITE = "https://vps-39a35c60.vps.ovh.us";

/** A job as a seat names it once it holds one: its name on the site, its number and its contract. */
export interface SeatedJob {
  readonly jobId: string;
  readonly onChainId: bigint;
  readonly jobs: Address;
}

const AddressSchema = z.string().refine((value) => isAddress(value, { strict: false }), "not an address").transform((value) => getAddress(value));
/** what the site says of one job, as far as a seat needs it: where it is on the chain */
const OneJobSchema = z.object({
  jobId: z.string(),
  chain: z.object({ jobId: z.string().regex(/^[0-9]+$/), jobs: AddressSchema }),
});
const WhySchema = z.object({ why: z.string() });

/** Why reading POD came to nothing: it has no such job, it said no, or it could not be reached at all. */
export type PodProblem = "NO_SUCH_JOB" | "POD_SAID_NO" | "POD_UNREACHABLE";

/** POD did not give what was asked of it, with which of the three ways it went wrong. */
export class PodDidNotAnswer extends Error {
  constructor(readonly problem: PodProblem, message: string) {
    super(message);
  }
}

/** The jobs among these that still have a seat nobody holds: a full pod stays listed until its work is settled. */
export function withASeatToTake(jobs: readonly ListedJob[]): readonly ListedJob[] {
  return jobs.filter((job) => job.free.length > 0);
}

/** The site's refusal, in its own words when it gave any. */
async function whyNot(answer: Response): Promise<string> {
  const text = await answer.text();
  const said = WhySchema.safeParse(safelyParsed(text));
  return said.success ? said.data.why : text.trim().slice(0, 200) || String(answer.status);
}

function safelyParsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export class Pod {
  constructor(readonly site: string) {}

  url(path: string): string {
    return new URL(path, this.site).toString();
  }

  /** The chain, the contract and the coin this site answers to. */
  async market(): Promise<MarketConfig> {
    return MarketConfigSchema.parse(await this.json(ROUTES.market));
  }

  /** Every job a seat can still be taken on. */
  async openJobs(): Promise<readonly ListedJob[]> {
    return JobListingSchema.parse(await this.json(ROUTES.jobList)).jobs;
  }

  /** One job by its name, wherever it has got to: a job whose seats are all taken has left the open list. */
  async job(jobId: string): Promise<SeatedJob> {
    const answer = await this.reached(jobApiPath(jobId));
    if (answer.status === 404) throw new PodDidNotAnswer("NO_SUCH_JOB", `${this.site} has no job called "${jobId}"`);
    if (!answer.ok) throw new PodDidNotAnswer("POD_SAID_NO", `${this.site} would not say where "${jobId}" is: ${await whyNot(answer)}`);
    const { chain } = OneJobSchema.parse(await answer.json());
    return { jobId, onChainId: BigInt(chain.jobId), jobs: chain.jobs };
  }

  /** Hand a signed note to the job's notes. */
  async writeNote(jobId: string, note: object): Promise<void> {
    const answer = await this.reached(`${ROUTES.notes}${jobId}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(note),
    });
    if (answer.status !== 201) throw new PodDidNotAnswer("POD_SAID_NO", `the note was not taken: ${await whyNot(answer)}`);
  }

  private async json(path: string): Promise<unknown> {
    const answer = await this.reached(path);
    if (!answer.ok) throw new PodDidNotAnswer("POD_SAID_NO", `${path} answered ${answer.status}: ${await whyNot(answer)}`);
    return answer.json();
  }

  /** An answer from the site, whatever it says. A site that gives none is said so by its address, not as "fetch failed". */
  private async reached(path: string, asked: RequestInit = {}): Promise<Response> {
    try {
      return await fetch(this.url(path), { ...asked, headers: { accept: "application/json", ...asked.headers } });
    } catch (error) {
      throw new PodDidNotAnswer("POD_UNREACHABLE", `${this.site} could not be reached: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
