/**
 * The checks this server has seen pass all three trials, by fingerprint.
 *
 * The page will not let a poster pay for a check that has not proved itself, but the page is the
 * poster's to change, and the API can be called without it. So the server keeps its own record: when
 * a check passes against the working version, fails its near miss and fails against nothing built,
 * its fingerprint is written down here, and a posting whose checks are not all written down is refused.
 *
 * On disk, one empty file per fingerprint, beside the jobs: a poster who paid and then saw the server
 * restart must still be able to publish.
 */
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { digestOf } from "../job.ts";
import { isProven, type Written } from "./written.ts";

const FINGERPRINT = /^0x[0-9a-f]{64}$/;

export class ProvenChecks {
  constructor(private readonly folder: string) {}

  /** Write down the fingerprint of every check in the set that passed all three trials. */
  async remember(checks: readonly Written[]): Promise<void> {
    const proven = checks.filter(isProven);
    if (proven.length === 0) return;
    await mkdir(this.folder, { recursive: true });
    for (const check of proven) {
      await writeFile(join(this.folder, await digestOf(check.source)), "");
    }
  }

  /** Whether a check with this fingerprint passed all three trials here. */
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
