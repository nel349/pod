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
  securityHeldByUs: false,
  finishedAt: "2026-10-01T12:37:00.000Z",
  ...over,
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
    expect(renderTile(tile())).toContain("Open it");
  });

  test("an archived job says so instead of offering a dead link", () => {
    const archived = renderTile(tile({ open: undefined }));
    expect(archived).toContain("archived, code still claimable");
    expect(archived).not.toContain("Open it");
  });

  test("links the receipt, so a stranger can check the verdict themselves", () => {
    expect(renderTile(tile())).toContain("https://pod.example/r/7");
  });

  test("says plainly when we are still holding the security seat", () => {
    expect(renderTile(tile({ securityHeldByUs: true }))).toContain("security seat held by the platform");
    expect(renderTile(tile())).not.toContain("security seat held by the platform");
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
    expect(html).toContain("1 passed");
    expect(html).toContain("1 failed");
    expect(html).toContain("1 could not be reproduced");
  });

  test("says where it runs and what the money is", () => {
    expect(renderWall([tile()])).toContain("test money");
  });

  test("an empty wall is still a page, and says nothing false", () => {
    const html = renderWall([]);
    expect(html).toContain("0 passed");
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
