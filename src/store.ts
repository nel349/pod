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
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import type { Tile } from "./gallery.ts";
import type { Approval } from "./jobpage.ts";
import type { SignedReceipt } from "./receipt.ts";
import { isSafeName } from "./routes.ts";

/**
 * What an open job tells a pod, and tells a reader, before there is any verdict.
 *
 * The sealed part is deliberately visible as a number: a pod can see that four checks exist and read
 * two of them, which is the whole mechanism said out loud rather than hidden.
 */
export interface Brief {
  /** the idea as posted, once the seal was opened */
  readonly asked: string;
  readonly endsAt: string;
  /** how many checks are sealed until there is a verdict */
  readonly sealedChecks: number;
  readonly seats: readonly { readonly role: string; readonly taken: boolean }[];
}

export interface CheckSaid {
  readonly says: string;
  readonly hidden: boolean;
  /** absent on a job nobody has graded yet: a check with no outcome is not a check that passed */
  readonly exitCode?: number;
}

/**
 * Where the job is on the chain, so a reader can go from the page to the transaction.
 *
 * Every one of these is looked up, never typed: the on-chain job is matched to this record by the
 * seal it was posted under, which is the one thing both sides hold.
 */
export interface OnChain {
  readonly network: "monad-testnet";
  /** the job's number in the contract */
  readonly jobId: string;
  readonly jobs: string;
  readonly settled?: string;
  readonly minted?: string;
  readonly tokenId?: string;
}

/** One graded job, as the runner leaves it behind. */
export interface JobRecord {
  readonly jobId: string;
  readonly seal: Hex;
  readonly tile: Tile;
  readonly checksSaid: readonly CheckSaid[];
  readonly approvals: readonly Approval[];
  /** present while the job is open. A graded job is described by its receipt instead */
  readonly brief?: Brief;
  /** where this job is on the chain, once it has been settled there */
  readonly chain?: OnChain;
  readonly signed?: SignedReceipt;
  readonly repository?: string;
  readonly podHolder?: string;
}

const RECORD = "job.json";
const CHECKS = "checks";
const HISTORY = "history.bundle";

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

  /**
   * What is happening now, then what happened, newest first.
   *
   * A job still running has no finish time, and sorting on that alone buried it under everything
   * that had already ended, which is exactly backwards: the running ones are the reason to look.
   */
  async tiles(): Promise<readonly Tile[]> {
    const records = await this.all();
    return [...records]
      .sort((a, b) => {
        const running = Number(b.tile.verdict === "running") - Number(a.tile.verdict === "running");
        if (running !== 0) return running;
        return (b.tile.finishedAt ?? "").localeCompare(a.tile.finishedAt ?? "");
      })
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

  /**
   * The job's history as one file, if it has one.
   *
   * Written when the job is graded, so it holds exactly what was graded and the attempts before it.
   */
  async bundle(jobId: string): Promise<Blob | undefined> {
    if (!isSafeName(jobId)) return undefined;
    const file = Bun.file(join(this.root, jobId, HISTORY));
    return (await file.exists()) ? file : undefined;
  }

  /** Every job an agent sat on, whichever seat it held. */
  async sat(agent: Address): Promise<readonly Tile[]> {
    const wanted = agent.toLowerCase();
    return (await this.tiles()).filter((tile) =>
      tile.pod.some((seat) => seat.agent.toLowerCase() === wanted));
  }

  /**
   * Write the job, and the checks it was graded against.
   *
   * A job graded a second time can have a different set of checks, and a check left behind from the
   * first run would be published as if it had produced this verdict. So a save that carries checks
   * replaces the set: anything in the job's own checks directory that is not in it goes. A save with
   * no checks at all, which is how an open job is written, leaves the directory alone.
   */
  async save(record: JobRecord, checks: Readonly<Record<string, string>> = {}): Promise<void> {
    if (!isSafeName(record.jobId)) throw new Error(`a job id has to be a safe name: ${record.jobId}`);
    const directory = join(this.root, record.jobId);
    await mkdir(join(directory, CHECKS), { recursive: true });
    await writeFile(join(directory, RECORD), encode(record));

    const names = Object.keys(checks);
    for (const name of names) {
      if (!isSafeName(name)) throw new Error(`a check's filename has to be a safe name: ${name}`);
      await writeFile(join(directory, CHECKS, name), checks[name]!);
    }
    if (names.length === 0) return;

    for (const existing of await readdir(join(directory, CHECKS))) {
      if (!names.includes(existing)) await rm(join(directory, CHECKS, existing), { force: true });
    }
  }
}
