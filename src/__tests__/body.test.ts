import { describe, expect, test } from "bun:test";
import { bodyWithin } from "../body.ts";

/**
 * How much of a body is read before it is refused. A server test cannot see this: Bun refuses a body
 * past its own limit of 128 MB either way, so a reader that held all 128 MB in memory for a note of a
 * few thousand characters would pass it. What decides it is how far the stream was read, counted here.
 */

const CHUNK = 1024;

/** A body that never ends, which counts how many pieces were taken from it. */
function endless(): { readonly request: Request; readonly taken: () => number } {
  let taken = 0;
  const piece = new Uint8Array(CHUNK).fill(120);
  const body = new ReadableStream<Uint8Array>({ pull: (controller) => { taken++; controller.enqueue(piece); } });
  return { request: new Request("http://pod.test/", { method: "POST", body, duplex: "half" } as RequestInit), taken: () => taken };
}

describe("a body within a limit", () => {
  test("a body with no length declared is read only until it passes the limit, then refused", async () => {
    const sent = endless();
    expect(await bodyWithin(sent.request, 16 * CHUNK)).toBeUndefined();
    // what is taken past the limit is at most what the stream had ready: a few pieces, not the rest
    expect(sent.taken()).toBeLessThanOrEqual(16 + 4);
  });

  test("a declared length over the limit is refused before anything is read", async () => {
    const sent = endless();
    const declared = new Request("http://pod.test/", { method: "POST", body: sent.request.body, duplex: "half", headers: { "content-length": String(1_000_000) } } as RequestInit);
    expect(await bodyWithin(declared, 16 * CHUNK)).toBeUndefined();
    expect(sent.taken()).toBeLessThanOrEqual(2);
  });

  test("a body within the limit comes back whole, counted in bytes rather than characters", async () => {
    const accented = "é".repeat(10);
    expect(await bodyWithin(new Request("http://pod.test/", { method: "POST", body: accented }), 20)).toBe(accented);
    expect(await bodyWithin(new Request("http://pod.test/", { method: "POST", body: accented }), 19)).toBeUndefined();
  });
});
