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
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import type { Invitation } from "./claims.ts";
import type { Tile } from "./gallery.ts";
import type { Approval } from "./jobpage.ts";
import type { SignedReceipt } from "./receipt.ts";
import type { Spec } from "./job.ts";
import { NoteSchema, type Note } from "./note.ts";
import { isSafeName } from "./routes.ts";
import { specFromTheWire, SpecOnTheWireSchema, specToTheWire } from "./specWire.ts";

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
  /** how the checks ask for what the poster's words left open, in plain words, when they had to */
  readonly howItIsAsked?: string;
  readonly seats: readonly { readonly role: string; readonly taken: boolean }[];
}

export type { Note } from "./note.ts";

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
  readonly jobs: Address;
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
  /** who paid for it, as the chain said when it was posted. Older jobs are asked of the chain instead */
  readonly poster?: Address;
  /** where the job's repository is published for anybody to fetch */
  readonly repository?: string;
  /** the published repository opens on the work that passed, which is where GitHub counts it */
  readonly opensOnMain?: boolean;
  readonly podHolder?: string;
  /** the last invitation GitHub sent to hand the repository to the title's holder */
  readonly invited?: Invitation;
  /** why the worker has not graded it although the pod says it is done, such as the approved commit never having been pushed */
  readonly waitingBecause?: string;
  /** the verdicts recorded in ERC-8004 for this job's seats: one per seat, and which request it answered */
  readonly recorded?: readonly RecordedVerdict[];
}

/** A seat's verdict in ERC-8004: whose seat, which identity asked, and which of its requests was answered. */
export interface RecordedVerdict {
  readonly role: string;
  readonly agent: Address;
  readonly agentId: string;
  readonly key: Hex;
}

const RECORD = "job.json";
const CHECKS = "checks";
/** one note to a line, in the order they arrived */
const NOTES = "notes.jsonl";
/** the spec as it was posted and sealed, hidden checks and salt included, so it is never served whole while the job runs */
const SPEC = "spec.json";
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
    return (await this.inWallOrder()).map((record) => record.tile);
  }

  /** Every record, in the order `tiles` gives: what is happening now, then what happened, newest first. */
  async inWallOrder(): Promise<readonly JobRecord[]> {
    return [...(await this.all())].sort((a, b) => {
      const running = Number(b.tile.verdict === "running") - Number(a.tile.verdict === "running");
      if (running !== 0) return running;
      return (b.tile.finishedAt ?? "").localeCompare(a.tile.finishedAt ?? "");
    });
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

  /**
   * The names of the checks anybody may read: every one once the job has a verdict, and while it
   * runs only the visible ones, which are the pod's to build against. A job with no spec kept has
   * no way to tell which are which, so while it runs it shows none.
   */
  async checkNames(jobId: string): Promise<readonly string[]> {
    const record = await this.read(jobId);
    if (!record) return [];
    let names: string[];
    try {
      names = (await readdir(join(this.root, jobId, CHECKS))).filter(isSafeName);
    } catch {
      return [];
    }
    if (checksArePublished(record)) return names.sort();
    const visible = await this.visibleCheckFiles(jobId);
    return names.filter((name) => visible.includes(name)).sort();
  }

  async checkFile(jobId: string, name: string): Promise<string | undefined> {
    if (!isSafeName(jobId) || !isSafeName(name)) return undefined;
    if (!(await this.checkNames(jobId)).includes(name)) return undefined;
    try {
      return await readFile(join(this.root, jobId, CHECKS, name), "utf8");
    } catch {
      return undefined;
    }
  }

  /**
   * Every check file, sealed ones included, for grading. The server's own use and nothing else:
   * nothing that answers a request may call this while the job runs.
   */
  async allCheckFiles(jobId: string): Promise<Readonly<Record<string, string>>> {
    if (!isSafeName(jobId)) return {};
    const directory = join(this.root, jobId, CHECKS);
    let names: string[];
    try {
      names = (await readdir(directory)).filter(isSafeName);
    } catch {
      return {};
    }
    const files: Record<string, string> = {};
    for (const name of names) files[name] = await readFile(join(directory, name), "utf8");
    return files;
  }

  /** The files of the checks the pod may see, by the spec that was sealed. */
  private async visibleCheckFiles(jobId: string): Promise<readonly string[]> {
    const spec = await this.spec(jobId);
    return (spec?.checks ?? []).filter((check) => !check.hidden && check.file !== undefined).map((check) => check.file!);
  }

  /** Keep the spec a job was posted and sealed under. Nothing serves it whole: see `spec` */
  async saveSpec(jobId: string, spec: Spec): Promise<void> {
    if (!(await this.read(jobId))) throw new Error(`there is no job called ${jobId} to keep a spec for`);
    await writeFile(join(this.root, jobId, SPEC), JSON.stringify(specToTheWire(spec), null, 2));
  }

  /**
   * The spec a job was sealed under, hidden checks and salt included. For the server's own use:
   * grading, and showing a pod the parts that are its to see. Never for sending as it is.
   */
  async spec(jobId: string): Promise<Spec | undefined> {
    if (!isSafeName(jobId)) return undefined;
    let text: string;
    try {
      text = await readFile(join(this.root, jobId, SPEC), "utf8");
    } catch {
      return undefined;
    }
    const parsed = SpecOnTheWireSchema.safeParse(JSON.parse(text));
    if (!parsed.success) throw new Error(`the spec kept for ${jobId} cannot be read: ${parsed.error.issues[0]?.message}`);
    return specFromTheWire(parsed.data);
  }

  /**
   * The job's history as one file, if it has one.
   *
   * Written when the job is graded, so it holds exactly what was graded and the attempts before it.
   */
  /** Where the job's history is kept as one file, for the worker to write it to when it grades. */
  historyFileOf(jobId: string): string {
    if (!isSafeName(jobId)) throw new Error(`${jobId} is not a name a job can have`);
    return join(this.root, jobId, HISTORY);
  }

  async bundle(jobId: string): Promise<Blob | undefined> {
    if (!isSafeName(jobId)) return undefined;
    const file = Bun.file(join(this.root, jobId, HISTORY));
    return (await file.exists()) ? file : undefined;
  }

  /** Add a note to a job that exists. The doors decide who may; this only keeps it. */
  async addNote(jobId: string, note: Note): Promise<void> {
    if (!(await this.read(jobId))) throw new Error(`there is no job called ${jobId} to add a note to`);
    await appendFile(join(this.root, jobId, NOTES), `${JSON.stringify(note)}\n`);
  }

  /** Whether a note with this signature is already kept: each is said once. */
  async hasNote(jobId: string, signature: string): Promise<boolean> {
    return (await this.notes(jobId)).some((note) => note.signature.toLowerCase() === signature.toLowerCase());
  }

  /** A job's notes, oldest first. Who may read them is the doors' to decide, as with adding them. */
  async notes(jobId: string): Promise<readonly Note[]> {
    if (!isSafeName(jobId)) return [];
    let text: string;
    try {
      text = await readFile(join(this.root, jobId, NOTES), "utf8");
    } catch {
      return [];
    }
    // written only by addNote, after the door checked every field; read through the same shape all the same
    return text.split("\n").filter(Boolean).map((line) => NoteSchema.parse(JSON.parse(line)));
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
    // every name is checked before anything is written, so a refusal leaves nothing half saved behind
    const names = Object.keys(checks);
    const unsafe = names.find((name) => !isSafeName(name));
    if (unsafe !== undefined) throw new Error(`a check's filename has to be a safe name: ${unsafe}`);

    const directory = join(this.root, record.jobId);
    await mkdir(join(directory, CHECKS), { recursive: true });
    await writeFile(join(directory, RECORD), encode(record));
    for (const [name, contents] of Object.entries(checks)) {
      await writeFile(join(directory, CHECKS, name), contents);
    }
    if (names.length === 0) return;

    for (const existing of await readdir(join(directory, CHECKS))) {
      if (!names.includes(existing)) await rm(join(directory, CHECKS, existing), { force: true });
    }
  }
}
