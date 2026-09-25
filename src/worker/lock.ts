/**
 * One worker at a time. Two would grade the same job twice, and the second grading would overwrite
 * the first's record under a title already minted against the first's receipt; the contract keeps the
 * money safe, but not the record. So a worker holds a lock beside the jobs, and a second one refuses to
 * start while the first is alive. A lock left by a worker that died is taken over.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const LOCK = "lock";

export interface Held {
  release(): Promise<void>;
}

export async function holdTheLock(folder: string): Promise<Held> {
  await mkdir(folder, { recursive: true });
  const path = join(folder, LOCK);
  try {
    await writeFile(path, String(process.pid), { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const holder = Number((await readFile(path, "utf8")).trim());
    if (Number.isInteger(holder) && holder > 0 && isAlive(holder)) {
      throw new Error(`another worker is running (process ${holder}); only one may, or jobs are graded twice`);
    }
    // left by a worker that is gone
    await writeFile(path, String(process.pid));
  }
  return { release: () => rm(path, { force: true }) };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it is alive, and somebody else's
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
