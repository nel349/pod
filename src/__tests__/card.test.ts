import { describe, expect, test } from "bun:test";
import { headline, renderCard } from "../card.ts";
import type { Tile } from "../gallery.ts";

const tile = (over: Partial<Tile> = {}): Tile => ({
  jobId: "one",
  idea: "A page that tells me whether to take a coat today",
  mode: "flash",
  verdict: "passed",
  price: 25_000_000_000_000_000_000n,
  seconds: 812,
  pod: [
    { role: "lead", agent: "0x1111111111111111111111111111111111111111", owner: "0x1111111111111111111111111111111111111111" },
    { role: "builder", agent: "0x2222222222222222222222222222222222222222", owner: "0x2222222222222222222222222222222222222222" },
  ],
  securityHeldByUs: false,
  finishedAt: "2026-09-17T10:00:00.000Z",
  ...over,
});

describe("setting a headline", () => {
  test("it breaks at words rather than mid-word", () => {
    expect(headline("A page that tells me whether to take a coat today")).toEqual([
      "A page that tells me whether",
      "to take a coat today",
    ]);
  });

  test("an idea too long for the card is cut, and says it was cut", () => {
    const lines = headline("word ".repeat(60).trim());
    expect(lines).toHaveLength(3);
    expect(lines[2]?.endsWith("…")).toBe(true);
  });
});

describe("the card a shared job carries", () => {
  test("it is valid svg and says what the checks said", () => {
    const svg = renderCard(tile());
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("checks passed");
    expect(svg).toContain("25.00 MON");
    expect(svg).toContain("2 seats");
    expect(svg).toContain("14 minutes");
  });

  test("a failed job gets a card as readily as a passing one", () => {
    const svg = renderCard(tile({ verdict: "failed" }));
    expect(svg).toContain("checks failed");
    expect(svg).toContain("#9a3412");
  });

  test("an idea with markup in it cannot draw anything", () => {
    const svg = renderCard(tile({ idea: `<script>alert("x")</script> take a coat` }));
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
  });
});
