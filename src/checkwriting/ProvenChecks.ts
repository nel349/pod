/**
 * The checks this server has tried and found usable, by fingerprint.
 *
 * The page will not let a poster pay for a check that has not proved itself, but the page is the
 * poster's to change, and the API can be called without it. So the server keeps its own record: when
 * a check written here fails against nothing built, as it must, its fingerprint is written down here,
 * and a posting whose checks are not all written down is refused.
 *
 * On disk, one empty file per fingerprint, beside the jobs: a poster who paid and then saw the server
 * restart must still be able to publish.
 */
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { digestOf, howItIsAskedDigest } from "../job.ts";
import { isProven, type WrittenSet } from "./written.ts";

const FINGERPRINT = /^0x[0-9a-f]{64}$/;

export class ProvenChecks {
  constructor(private readonly folder: string) {}

  /**
   * Write down the fingerprint of every check in the set that held when it was tried, and of how
   * they ask for what the poster left open: the checks were written to ask that way, so it goes with
   * them, and a posting that says otherwise is refused.
   */
  async remember(set: WrittenSet): Promise<void> {
    const proven = set.checks.filter(isProven);
    if (proven.length === 0) return;
    await mkdir(this.folder, { recursive: true });
    for (const check of proven) {
      await writeFile(join(this.folder, await digestOf(check.source)), "");
    }
    if (set.howItIsAsked) await writeFile(join(this.folder, await howItIsAskedDigest(set.howItIsAsked)), "");
  }

  /** Whether a check with this fingerprint was tried here and held. */
  async has(digest: string): Promise<boolean> {
    if (!FINGERPRINT.test(digest)) return false;
    try {
      return (await stat(join(this.folder, digest))).isFile();
    } catch {
      // not written down: never proven here
      return false;
    }
  }
}
