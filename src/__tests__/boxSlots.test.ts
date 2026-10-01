import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoxSlots } from "../docker/index.ts";

/**
 * One limit on box work, kept on disk so the server and the worker both keep to it. Two processes are
 * stood in for by two BoxSlots on one folder, which is all the server and the worker share.
 */
describe("box slots shared on disk", () => {
  test("no more work runs at once than there are slots, across everything sharing the folder", async () => {
    const folder = await mkdtemp(join(tmpdir(), "pod-slots-"));
    const server = new BoxSlots(folder, 2);
    const worker = new BoxSlots(folder, 2);
    let running = 0;
    let most = 0;
    const work = async (): Promise<void> => {
      running++;
      most = Math.max(most, running);
      await Bun.sleep(150);
      running--;
    };
    await Promise.all([
      server.inASlot(work), server.inASlot(work), worker.inASlot(work), worker.inASlot(work), worker.inASlot(work),
    ]);
    expect(most).toBe(2);
    expect(await readdir(folder)).toEqual([]);
  }, 30_000);

  test("a slot is given back however the work ends", async () => {
    const folder = await mkdtemp(join(tmpdir(), "pod-slots-"));
    const slots = new BoxSlots(folder, 1);
    await expect(slots.inASlot(async () => { throw new Error("the work failed"); })).rejects.toThrow("the work failed");
    expect(await slots.inASlot(async () => "next")).toBe("next");
  });

  test("a slot left by a process that died is taken back", async () => {
    const folder = await mkdtemp(join(tmpdir(), "pod-slots-"));
    // a process number nothing runs as
    await writeFile(join(folder, "slot-0"), "2147483646");
    expect(await new BoxSlots(folder, 1).inASlot(async () => "ran")).toBe("ran");
  });

  test("a stop ends the wait for a slot", async () => {
    const folder = await mkdtemp(join(tmpdir(), "pod-slots-"));
    const slots = new BoxSlots(folder, 1);
    const gate = Promise.withResolvers<void>();
    const holding = slots.inASlot(() => gate.promise);
    // the one slot is taken before the second asks
    while ((await readdir(folder)).length === 0) await Bun.sleep(10);
    const stop = new AbortController();
    const waiting = slots.inASlot(async () => "never", stop.signal);
    stop.abort();
    await expect(waiting).rejects.toThrow("stopped while waiting");
    gate.resolve();
    await holding;
  });
});
