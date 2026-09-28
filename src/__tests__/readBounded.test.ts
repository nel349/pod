import { describe, expect, test } from "bun:test";
import { MOST_KEPT_BYTES, readBounded } from "../docker/index.ts";

/** A real stream of what a box might print, handed over in chunks the way a pipe hands them. */
function printed(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("reading what a box printed", () => {
  test("something short comes back whole", async () => {
    expect(await readBounded(printed(["listening\n", "answered\n"]))).toBe("listening\nanswered\n");
  });

  test("a flood keeps its start and its end, and says how much was let go", async () => {
    const line = `${"x".repeat(1023)}\n`;
    const flood = ["the start\n", ...Array.from({ length: 10 * 1024 }, () => line), "the reason it failed\n"];
    const total = flood.reduce((sum, chunk) => sum + chunk.length, 0);

    const kept = await readBounded(printed(flood));

    expect(kept.startsWith("the start\n")).toBe(true);
    expect(kept.endsWith("the reason it failed\n")).toBe(true);
    expect(kept).toContain(`[${total - MOST_KEPT_BYTES} bytes not kept]`);
    expect(kept.length).toBeLessThan(MOST_KEPT_BYTES + 100);
  });

  test("one chunk larger than everything kept is still cut to size", async () => {
    const kept = await readBounded(printed([`A${"y".repeat(10 * MOST_KEPT_BYTES)}Z`]));
    expect(kept.startsWith("A")).toBe(true);
    expect(kept.endsWith("Z")).toBe(true);
    expect(kept.length).toBeLessThan(MOST_KEPT_BYTES + 100);
  });

  test("exactly as much as is kept loses nothing, even a character split across chunks and halves", async () => {
    // one byte, then two-byte characters: the halves meet in the middle of one of them
    const whole = `a${"é".repeat(MOST_KEPT_BYTES / 2 - 1)}b`;
    const bytes = new TextEncoder().encode(whole);
    const split = new ReadableStream<Uint8Array>({
      start(controller) {
        // cut in the middle of the two bytes of one "é"
        controller.enqueue(bytes.slice(0, 1001));
        controller.enqueue(bytes.slice(1001));
        controller.close();
      },
    });
    expect(await readBounded(split)).toBe(whole);
  });
});
