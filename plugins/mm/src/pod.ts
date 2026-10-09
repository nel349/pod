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
    const answer = await fetch(this.url(jobApiPath(jobId)), { headers: { accept: "application/json" } });
    if (answer.status === 404) throw new Error(`${this.site} has no job called "${jobId}"`);
    if (!answer.ok) throw new Error(`${this.site} would not say where "${jobId}" is: ${await whyNot(answer)}`);
    const { chain } = OneJobSchema.parse(await answer.json());
    return { jobId, onChainId: BigInt(chain.jobId), jobs: chain.jobs };
  }

  /** Hand a signed note to the job's notes. */
  async writeNote(jobId: string, note: object): Promise<void> {
    const answer = await fetch(this.url(`${ROUTES.notes}${jobId}`), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(note),
    });
    if (answer.status !== 201) throw new Error(`the note was not taken: ${await whyNot(answer)}`);
  }

  private async json(path: string): Promise<unknown> {
    const answer = await fetch(this.url(path), { headers: { accept: "application/json" } });
    if (!answer.ok) throw new Error(`${path} answered ${answer.status}: ${await whyNot(answer)}`);
    return answer.json();
  }
}
