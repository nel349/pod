import { describe, expect, test } from "bun:test";
import { renderTile, renderWall, verdictWords, type Tile } from "../gallery.ts";

const tile = (over: Partial<Tile> = {}): Tile => ({
  jobId: "7",
  idea: "a site that rates my excuses",
  mode: "flash",
  verdict: "passed",
  open: "https://pod.example/j/7",
  commit: "c0ffee1",
  seconds: 2220,
  price: 20_000_000_000_000_000_000n,
  pod: [
    { role: "lead", agent: "0x00000000000000000000000000000000000000a1", owner: "0x00000000000000000000000000000000000000b1" },
    { role: "builder", agent: "0x00000000000000000000000000000000000000a2", owner: "0x00000000000000000000000000000000000000b2" },
  ],
  receiptURI: "https://pod.example/r/7",
  receiptHash: `0x${"cd".repeat(32)}`,
  finishedAt: "2026-10-01T12:37:00.000Z",
  ...over,
});

describe("a tile never shows a reader a hole", () => {
  test("one second is not 1 seconds", () => {
    expect(renderTile(tile({ seconds: 1 }))).toContain("1 second");
    expect(renderTile(tile({ seconds: 2 }))).toContain("2 seconds");
    expect(renderTile(tile({ seconds: 60 }))).toContain("60 seconds");
    expect(renderTile(tile({ seconds: 3600 }))).toContain("60 minutes");
  });

  test("why there is nothing to open depends on what happened", () => {
    expect(renderTile(tile({ verdict: "failed", open: undefined }))).toContain("nothing shipped");
    // work that passed and is not running anywhere says nothing false about being archived
    expect(renderTile(tile({ verdict: "passed", open: undefined }))).not.toContain("archived");
    expect(renderTile(tile({ verdict: "running", open: undefined }))).toContain("not finished");
  });

  test("two attempts at one idea are told apart by the commit each was graded at", () => {
    const first = renderTile(tile({ jobId: "a", commit: "c0ffee1234" }));
    const second = renderTile(tile({ jobId: "b", commit: "7ae91bb000" }));
    expect(first).toContain("c0ffee1");
    expect(second).toContain("7ae91bb");
  });

  test("a price carries the name of what it is paid in", () => {
    expect(renderTile(tile({ price: 25_000_000_000_000_000_000n }))).toContain("25.00 MON");
  });

  test("a receipt with no hash is still a link, and says only what it knows", () => {
    const html = renderTile({ ...tile(), receiptURI: "/receipt/one", receiptHash: undefined });
    expect(html).toContain('href="/receipt/one"');
    expect(html).not.toContain("undefined");
  });
});

describe("a tile", () => {
  test("leads with the idea in the words it was posted in", () => {
    expect(renderTile(tile())).toContain("a site that rates my excuses");
  });

  test("says the verdict in words, not only a colour", () => {
    expect(renderTile(tile())).toContain("checks passed");
    expect(renderTile(tile({ verdict: "failed" }))).toContain("checks failed");
    expect(renderTile(tile({ verdict: "not-reproducible" }))).toContain("could not be reproduced");
  });

  test("offers the thing itself, which is the point of the tile", () => {
    expect(renderTile(tile())).toContain('href="https://pod.example/j/7"');
    expect(renderTile(tile())).toContain("open it");
  });

  test("a job not running anywhere offers no dead link", () => {
    expect(renderTile(tile({ open: undefined }))).not.toContain("open it");
  });

  test("links the receipt, so a stranger can check the verdict themselves", () => {
    expect(renderTile(tile())).toContain("https://pod.example/r/7");
  });

  test("never says the platform held a seat, however many seats are open", () => {
    expect(renderTile(tile({ verdict: "running", pod: [] }))).not.toContain("held by the platform");
  });

  test("a job nobody has taken is waiting for a pod, not running", () => {
    expect(renderTile(tile({ verdict: "running", pod: [] }))).toContain("waiting for a pod");
    expect(renderTile(tile({ verdict: "running" }))).toContain("being built");
  });

  test("the time shown is what it is: how long the checks ran, not how long the job took", () => {
    expect(renderTile(tile({ seconds: 2 }))).toContain("checks ran in 2 seconds");
  });

  test("names every seat and who it belongs to", () => {
    const html = renderTile(tile());
    expect(html).toContain("lead");
    expect(html).toContain("builder");
    expect(html).toContain("0x0000…00a1");
  });

  test("an idea cannot smuggle markup onto the page", () => {
    const html = renderTile(tile({ idea: `<img src=x onerror="alert(1)">` }));
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});

describe("the wall", () => {
  test("shows failures beside successes, and counts both", () => {
    const html = renderWall([
      tile(),
      tile({ jobId: "8", verdict: "failed" }),
      tile({ jobId: "9", verdict: "not-reproducible" }),
    ]);
    expect(html).toContain("1 paid");
    expect(html).toContain("1 refused");
    expect(html).toContain("1 unrepeatable");
  });

  test("says where it runs and what the money is", () => {
    expect(renderWall([tile()])).toContain("test money");
  });

  test("an empty wall is still a page, and says nothing false", () => {
    const html = renderWall([]);
    expect(html).toContain("0 paid");
    expect(html).not.toContain("undefined");
  });

  test("reads on a phone: it declares a viewport", () => {
    expect(renderWall([tile()])).toContain("width=device-width");
  });
});

describe("words", () => {
  test("every verdict has a plain phrase", () => {
    for (const v of ["passed", "failed", "not-reproducible", "running"] as const) {
      expect(verdictWords(v).length).toBeGreaterThan(3);
    }
  });
});
