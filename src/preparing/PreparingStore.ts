/**
 * Jobs that are paid for and still preparing, on disk.
 *
 * Kept by the job's number on the chain, never its name, so a name freed later can never receive a
 * set written for another job. Every file is written whole or not at all, since the server can stop
 * at any moment and a preparing job can wait days. Only the server writes here; the worker reads the
 * finished writings to publish a job once its poster has approved one.
 *
 *   <number>/setup.json            how the job was set up: its name, poster, mode and salt
 *   <number>/asked.json            the writing waiting its turn or under way, if there is one
 *   <number>/writings/<n>.json     every writing of its checks, finished one way or the other
 *   names/<name>                   which job number holds a name
 *   names/.released/<name>.<id>    a name given up by a job taken back before approval, kept, not deleted
 *
 * Only a file that is not there reads as nothing. Any other failure to read the disk is thrown: read
 * as nothing, it would make a job vanish from a restart, or a held name look free.
 */
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import { AskedSchema, FinishedSchema, ON_CHAIN_NUMBER, SetUpSchema, type Asked, type Finished, type SetUp } from "./records.ts";

const SETUP_FILE = "setup.json";
const ASKED_FILE = "asked.json";
const WRITINGS_FOLDER = "writings";
const NAMES_FOLDER = "names";
const RELEASED_FOLDER = ".released";
const WRITING_FILE = /^([0-9]+)\.json$/;

export class PreparingStore {
  constructor(private readonly folder: string) {}

  /** Every job number with something kept here. */
  async all(): Promise<readonly string[]> {
    const found = await ifThere(readdir(this.folder), []);
    return found.filter((name) => ON_CHAIN_NUMBER.test(name));
  }

  /**
   * Hold a name for a job. Refused, with the holder's number, when another job holds it: two jobs
   * asking at once cannot both have it, since the file is created only if it is not there.
   */
  async claimName(name: string, onChainId: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly heldBy: string }> {
    await mkdir(join(this.folder, NAMES_FOLDER), { recursive: true });
    try {
      await writeFile(join(this.folder, NAMES_FOLDER, name), onChainId, { flag: "wx" });
      return { ok: true };
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      const heldBy = (await this.nameHolder(name)) ?? "";
      return heldBy === onChainId ? { ok: true } : { ok: false, heldBy };
    }
  }

  /**
   * Hand a name held by a job taken back before approval to another job. The old holding is moved
   * aside, not deleted, and only one move can happen, so of two jobs asking at once only one has it.
   */
  async takeOverName(name: string, from: string, to: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly heldBy: string }> {
    if ((await this.nameHolder(name)) === from) {
      await mkdir(join(this.folder, NAMES_FOLDER, RELEASED_FOLDER), { recursive: true });
      try {
        await rename(join(this.folder, NAMES_FOLDER, name), join(this.folder, NAMES_FOLDER, RELEASED_FOLDER, `${name}.${crypto.randomUUID()}`));
      } catch (error) {
        // somebody else moved it first; whoever claims it next has it
        if (!hasCode(error, "ENOENT")) throw error;
      }
    }
    return this.claimName(name, to);
  }

  async nameHolder(name: string): Promise<string | undefined> {
    const held = await ifThere(readFile(join(this.folder, NAMES_FOLDER, name), "utf8"), undefined);
    return held !== undefined && ON_CHAIN_NUMBER.test(held) ? held : undefined;
  }

  async saveSetUp(setUp: SetUp): Promise<void> {
    await this.writeWhole(join(this.folder, setUp.onChainId, SETUP_FILE), setUp);
  }

  readSetUp(onChainId: string): Promise<SetUp | undefined> {
    return this.readThrough(join(this.folder, onChainId, SETUP_FILE), SetUpSchema);
  }

  async ask(onChainId: string, asked: Asked): Promise<void> {
    await this.writeWhole(join(this.folder, onChainId, ASKED_FILE), asked);
  }

  readAsked(onChainId: string): Promise<Asked | undefined> {
    return this.readThrough(join(this.folder, onChainId, ASKED_FILE), AskedSchema);
  }

  async clearAsked(onChainId: string): Promise<void> {
    await rm(join(this.folder, onChainId, ASKED_FILE), { force: true });
  }

  async saveWriting(onChainId: string, writing: Finished): Promise<void> {
    await this.writeWhole(join(this.folder, onChainId, WRITINGS_FOLDER, `${writing.number}.json`), writing);
  }

  /** Every finished writing of a job's checks, first to last. */
  async writings(onChainId: string): Promise<readonly Finished[]> {
    const folder = join(this.folder, onChainId, WRITINGS_FOLDER);
    const names = (await ifThere(readdir(folder), [])).filter((name) => WRITING_FILE.test(name));
    const read = await Promise.all(names.map((name) => this.readThrough(join(folder, name), FinishedSchema)));
    return read.filter((writing): writing is Finished => writing !== undefined).sort((a, b) => a.number - b.number);
  }

  /** The number the next writing is kept under: one past the highest, so none is ever written over. */
  async nextWritingNumber(onChainId: string): Promise<number> {
    const names = await ifThere(readdir(join(this.folder, onChainId, WRITINGS_FOLDER)), []);
    const numbers = names.map((name) => Number(WRITING_FILE.exec(name)?.[1] ?? 0));
    return Math.max(0, ...numbers) + 1;
  }

  /** Written to a file beside it and moved into place, so a stop half way leaves the old file or none. */
  private async writeWhole(path: string, value: unknown): Promise<void> {
    await mkdir(join(path, ".."), { recursive: true });
    const beside = `${path}.${crypto.randomUUID()}.part`;
    await writeFile(beside, JSON.stringify(value, null, 2));
    await rename(beside, path);
  }

  private async readThrough<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
    const text = await ifThere(readFile(path, "utf8"), undefined);
    if (text === undefined) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${path} is not whole: it cannot be read as JSON`);
    }
    const read = schema.safeParse(parsed);
    if (!read.success) throw new Error(`${path} is not what it should be: ${read.error.issues[0]?.message ?? "unreadable"}`);
    return read.data;
  }
}

/** What was read, or the fallback when the file or folder is not there; any other failure is thrown. */
async function ifThere<T, F>(reading: Promise<T>, fallback: F): Promise<T | F> {
  try {
    return await reading;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return fallback;
    throw error;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
