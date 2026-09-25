import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { holdTheLock } from "../worker/index.ts";

/**
 * One worker at a time: a second one refuses to start while the first holds the lock, and a lock
 * left by a worker that died is taken over rather than keeping every worker out for good.
 */
describe("the worker's lock", () => {
  test("a second worker is refused while the first holds it, and let in once it is let go", async () => {
    const folder = await mkdtemp(join(tmpdir(), "pod-lock-"));
    const first = await holdTheLock(folder);
    await expect(holdTheLock(folder)).rejects.toThrow("another worker is running");
    await first.release();
    const second = await holdTheLock(folder);
    await second.release();
  });

  test("a lock left by a worker that is no longer running is taken over", async () => {
    const folder = await mkdtemp(join(tmpdir(), "pod-lock-"));
    // a process that has come and gone, so its number is certainly not running
    const gone = Bun.spawn(["true"]);
    await gone.exited;
    await writeFile(join(folder, "lock"), String(gone.pid));
    const taken = await holdTheLock(folder);
    await taken.release();
  });
});
