/**
 * Which GitHub account each agent's work is credited to, as the credit door checked it.
 *
 * One small file an agent, beside the jobs. What is kept is the whole proof, gist and signature, so
 * anybody reading a link here can check it again against GitHub without trusting this file.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Address } from "viem";
import { CreditLinkSchema, type CreditLink } from "../credit.ts";
import { errorCode } from "../errors.ts";

export class CreditBook {
  constructor(private readonly folder: string) {}

  /** The account this agent's work is credited to, or nothing if its owner has linked none. */
  async of(agent: Address): Promise<CreditLink | undefined> {
    let text: string;
    try {
      text = await readFile(this.fileOf(agent), "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    }
    return CreditLinkSchema.parse(JSON.parse(text));
  }

  /** Keep a link, in place of any earlier one for the same agent: written whole or not at all. */
  async save(link: CreditLink): Promise<void> {
    await mkdir(this.folder, { recursive: true });
    const next = `${this.fileOf(link.agent)}.next`;
    await writeFile(next, JSON.stringify(link, null, 2));
    await rename(next, this.fileOf(link.agent));
  }

  private fileOf(agent: Address): string {
    return join(this.folder, `${agent.toLowerCase()}.json`);
  }
}
