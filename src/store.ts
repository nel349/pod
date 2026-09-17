/**
 * Where a graded job lands, and what the server is allowed to read back.
 *
 * One directory per job: the job's own record, and the checks it was graded against. The runner
 * writes it when the grading is done; the server only ever reads. Nothing here invents a field. If a
 * job has no receipt, the record has no receipt, and the page says so.
 *
 * The hidden checks are in this directory too, and they are published the moment the job has a
 * verdict. Hiding them during the build is what stops a pod writing to the test; hiding them
 * afterwards would stop a stranger repeating the run, which is the whole promise.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import type { Tile } from "./gallery.ts";
import type { Approval } from "./jobpage.ts";
import type { SignedReceipt } from "./receipt.ts";
import { isSafeName } from "./routes.ts";

export interface CheckSaid {
  readonly says: string;
  readonly hidden: boolean;
  readonly exitCode: number;
}

/** One graded job, as the runner leaves it behind. */
export interface JobRecord {
  readonly jobId: string;
  readonly seal: Hex;
  readonly tile: Tile;
  readonly checksSaid: readonly CheckSaid[];
  readonly approvals: readonly Approval[];
  readonly signed?: SignedReceipt;
  readonly repository?: string;
  readonly podHolder?: string;
}

const RECORD = "job.json";
const CHECKS = "checks";

/** A verdict is what makes the checks publishable: before that, they are the sealed part of the job. */
export function checksArePublished(record: JobRecord): boolean {
  return record.tile.verdict !== "running";
}

/**
 * JSON has no bigint, and the price is money, so it travels as a decimal string and comes back a
 * bigint. Doing it here keeps every other module working in the type it means.
 */
function encode(record: JobRecord): string {
  return JSON.stringify({ ...record, tile: { ...record.tile, price: record.tile.price.toString() } }, null, 2);
}

const VERDICTS: readonly Tile["verdict"][] = ["passed", "failed", "not-reproducible", "running"];

/**
 * A record is checked on the way in, not trusted.
 *
 * The runner writes these files, but a half-written or hand-edited one would otherwise reach a page
 * as a missing field, and a page with a hole in it is exactly what this project cannot ship. Anything
 * that does not survive this function is refused, loudly, and the reader decides what to say.
 */
function decode(text: string, jobId: string): JobRecord {
  const parsed = JSON.parse(text) as JobRecord & { tile: Omit<Tile, "price"> & { price: string } };
  if (parsed.jobId !== jobId) throw new Error(`the record in ${jobId} calls itself ${parsed.jobId}`);
  if (!parsed.tile || parsed.tile.jobId !== jobId) throw new Error(`the record in ${jobId} has no tile of its own`);
  if (!VERDICTS.includes(parsed.tile.verdict)) throw new Error(`${jobId} has a verdict nobody defined: ${parsed.tile.verdict}`);
  if (!Array.isArray(parsed.checksSaid) || !Array.isArray(parsed.approvals)) {
    throw new Error(`${jobId} is missing the checks or the approvals`);
  }
  return { ...parsed, tile: { ...parsed.tile, price: BigInt(parsed.tile.price) } };
}

export class JobStore {
  constructor(private readonly root: string) {}

  /** Newest first, because the wall reads as news. Jobs with no finish time sort last. */
  async tiles(): Promise<readonly Tile[]> {
    const records = await this.all();
    return [...records]
      .sort((a, b) => (b.tile.finishedAt ?? "").localeCompare(a.tile.finishedAt ?? ""))
      .map((r) => r.tile);
  }

  async all(): Promise<readonly JobRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch {
      return [];
    }
    const records: JobRecord[] = [];
    for (const name of names) {
      if (!isSafeName(name)) continue;
      const record = await this.read(name);
      if (record) records.push(record);
    }
    return records;
  }

  async read(jobId: string): Promise<JobRecord | undefined> {
    if (!isSafeName(jobId)) return undefined;
    let text: string;
    try {
      text = await readFile(join(this.root, jobId, RECORD), "utf8");
    } catch {
      return undefined;
    }
    try {
      return decode(text, jobId);
    } catch (error) {
      // A job that exists but cannot be read is an operator's problem, not a visitor's: say it here,
      // where somebody is watching the logs, and let the page report the job as missing.
      console.error(`the record for ${jobId} could not be read: ${(error as Error).message}`);
      return undefined;
    }
  }

  /** The names of the checks this job was graded against, or nothing while it is still running. */
  async checkNames(jobId: string): Promise<readonly string[]> {
    const record = await this.read(jobId);
    if (!record || !checksArePublished(record)) return [];
    try {
      return (await readdir(join(this.root, jobId, CHECKS))).filter(isSafeName).sort();
    } catch {
      return [];
    }
  }

  async checkFile(jobId: string, name: string): Promise<string | undefined> {
    if (!isSafeName(jobId) || !isSafeName(name)) return undefined;
    const record = await this.read(jobId);
    if (!record || !checksArePublished(record)) return undefined;
    try {
      return await readFile(join(this.root, jobId, CHECKS, name), "utf8");
    } catch {
      return undefined;
    }
  }

  /** Every job an agent sat on, whichever seat it held. */
  async sat(agent: Address): Promise<readonly Tile[]> {
    const wanted = agent.toLowerCase();
    return (await this.tiles()).filter((tile) =>
      tile.pod.some((seat) => seat.agent.toLowerCase() === wanted));
  }

  async save(record: JobRecord, checks: Readonly<Record<string, string>> = {}): Promise<void> {
    if (!isSafeName(record.jobId)) throw new Error(`a job id has to be a safe name: ${record.jobId}`);
    const directory = join(this.root, record.jobId);
    await mkdir(join(directory, CHECKS), { recursive: true });
    await writeFile(join(directory, RECORD), encode(record));
    for (const [name, contents] of Object.entries(checks)) {
      if (!isSafeName(name)) throw new Error(`a check's filename has to be a safe name: ${name}`);
      await writeFile(join(directory, CHECKS, name), contents);
    }
  }
}
