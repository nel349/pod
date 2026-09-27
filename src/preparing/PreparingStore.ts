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
 */
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import { AskedSchema, FinishedSchema, SetUpSchema, type Asked, type Finished, type SetUp } from "./records.ts";

const WRITINGS = "writings";
const NAMES = "names";
const NUMBER = /^[0-9]+$/;

export class PreparingStore {
  constructor(private readonly folder: string) {}

  /** Every job number with something kept here. */
  async all(): Promise<readonly string[]> {
    const found = await readdir(this.folder).catch(() => []);
    return found.filter((name) => NUMBER.test(name));
  }

  /**
   * Hold a name for a job. Refused, with the holder's number, when another job holds it: two jobs
   * asking at once cannot both have it, since the file is created only if it is not there.
   */
  async claimName(name: string, onChainId: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly heldBy: string }> {
    await mkdir(join(this.folder, NAMES), { recursive: true });
    try {
      await writeFile(join(this.folder, NAMES, name), onChainId, { flag: "wx" });
      return { ok: true };
    } catch (error) {
      if (!isAlreadyThere(error)) throw error;
      const heldBy = (await this.nameHolder(name)) ?? "";
      return heldBy === onChainId ? { ok: true } : { ok: false, heldBy };
    }
  }

  async nameHolder(name: string): Promise<string | undefined> {
    const held = await readFile(join(this.folder, NAMES, name), "utf8").catch(() => undefined);
    return held !== undefined && NUMBER.test(held) ? held : undefined;
  }

  async saveSetUp(setUp: SetUp): Promise<void> {
    await this.writeWhole(join(this.folder, setUp.onChainId, "setup.json"), setUp);
  }

  readSetUp(onChainId: string): Promise<SetUp | undefined> {
    return this.readThrough(join(this.folder, onChainId, "setup.json"), SetUpSchema);
  }

  async ask(onChainId: string, asked: Asked): Promise<void> {
    await this.writeWhole(join(this.folder, onChainId, "asked.json"), asked);
  }

  readAsked(onChainId: string): Promise<Asked | undefined> {
    return this.readThrough(join(this.folder, onChainId, "asked.json"), AskedSchema);
  }

  async clearAsked(onChainId: string): Promise<void> {
    await rm(join(this.folder, onChainId, "asked.json"), { force: true });
  }

  async saveWriting(onChainId: string, writing: Finished): Promise<void> {
    await this.writeWhole(join(this.folder, onChainId, WRITINGS, `${writing.number}.json`), writing);
  }

  /** Every finished writing of a job's checks, first to last. */
  async writings(onChainId: string): Promise<readonly Finished[]> {
    const folder = join(this.folder, onChainId, WRITINGS);
    const names = (await readdir(folder).catch(() => [])).filter((name) => /^[0-9]+\.json$/.test(name));
    const read = await Promise.all(names.map((name) => this.readThrough(join(folder, name), FinishedSchema)));
    return read.filter((writing): writing is Finished => writing !== undefined).sort((a, b) => a.number - b.number);
  }

  /** Written to a file beside it and moved into place, so a stop half way leaves the old file or none. */
  private async writeWhole(path: string, value: unknown): Promise<void> {
    await mkdir(join(path, ".."), { recursive: true });
    const beside = `${path}.${crypto.randomUUID()}.part`;
    await writeFile(beside, JSON.stringify(value, null, 2));
    await rename(beside, path);
  }

  private async readThrough<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
    const text = await readFile(path, "utf8").catch(() => undefined);
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

function isAlreadyThere(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
