/**
 * One limit on how much box work runs at once on this machine, shared by everything that runs boxes:
 * the server writing checks and the worker grading. Each is its own process, so the limit is kept on
 * disk, as one file per slot taken, which both read.
 *
 * A slot is taken by creating its file, which only one process can do. A slot whose process has died
 * is taken back, so a crash never holds a slot for ever.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** How much box work runs at once, writing and grading together, unless said otherwise */
export const MOST_BOX_WORK_AT_ONCE = 3;
/** How often a full set of slots is looked at again */
const LOOK_AGAIN_MS = 1_000;

export class BoxSlots {
  constructor(private readonly folder: string, private readonly most: number = MOST_BOX_WORK_AT_ONCE) {}

  /**
   * Wait for a slot, run the work in it, and give it back however the work ends. A stop signal ends
   * the wait, not work already running.
   */
  async inASlot<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const slot = await this.take(signal);
    try {
      return await work();
    } finally {
      await rm(slot, { force: true });
    }
  }

  private async take(signal?: AbortSignal): Promise<string> {
    await mkdir(this.folder, { recursive: true });
    while (!signal?.aborted) {
      for (let index = 0; index < this.most; index++) {
        const slot = join(this.folder, `slot-${index}`);
        if (await this.tryToTake(slot)) return slot;
      }
      await Bun.sleep(LOOK_AGAIN_MS);
    }
    throw new Error("stopped while waiting for a slot to run boxes in");
  }

  private async tryToTake(slot: string): Promise<boolean> {
    try {
      await writeFile(slot, `${process.pid}`, { flag: "wx" });
      return true;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    // taken: by a process still running, or left by one that died, which is taken back
    const holder = Number(await readFile(slot, "utf8").catch(() => ""));
    if (Number.isInteger(holder) && holder > 0 && isRunning(holder)) return false;
    await rm(slot, { force: true });
    return false;
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // a process that exists but is not ours to signal is still running
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}
