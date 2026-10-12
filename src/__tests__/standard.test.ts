import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { SEATS } from "../seal.ts";
import { DUTIES, STANDARD } from "../standard.ts";

/**
 * The standard a seat is held to is written once, in src/standard.ts, and said word for word wherever
 * an agent reads it: the guide every agent is sent to, the skill an agent installs, and what our own
 * seats are told. Written by hand in each place it drifted, and seats here were told a mock-up was
 * acceptable while the guide said to build the real thing. So each place is held to the source here.
 */
const GUIDE = await readFile(new URL("../../public/llms.txt", import.meta.url), "utf8");
const SKILL = await readFile(new URL("../../skills/pod/SKILL.md", import.meta.url), "utf8");
const JUDGEMENTS = await readFile(new URL("../reference/roles/judgements.ts", import.meta.url), "utf8");
const BUILDER = await readFile(new URL("../reference/roles/Builder.ts", import.meta.url), "utf8");

describe("the standard a seat is held to", () => {
  test("the guide and the skill each say every sentence of it, word for word", () => {
    expect(STANDARD.length).toBeGreaterThan(0);
    for (const sentence of STANDARD) {
      expect(GUIDE).toContain(`- ${sentence}`);
      expect(SKILL).toContain(`- ${sentence}`);
    }
  });

  test("the guide and the skill each say what every seat is for, word for word", () => {
    for (const seat of SEATS) {
      expect(GUIDE).toContain(`- ${DUTIES[seat]}`);
      expect(SKILL).toContain(`| ${seat} | ${DUTIES[seat]} |`);
    }
  });

  test("our own seats are given it from the source, and none is told a mock-up will do", () => {
    // the judging seats and the builder read the sentences from the one module, never a copy of their own
    expect(JUDGEMENTS).toContain('from "../../standard.ts"');
    expect(JUDGEMENTS).toContain("...STANDARD.map(");
    expect(BUILDER).toContain('from "../../standard.ts"');
    expect(BUILDER).toContain("...STANDARD.map(");
    for (const said of [GUIDE, SKILL, JUDGEMENTS, BUILDER]) {
      expect(said).not.toMatch(/say plainly on the page that (this|the) part is a mock-up/);
      expect(said).not.toContain("has told them the truth: approve it");
      expect(said).not.toContain("can be stood behind");
    }
  });

  test("it says the four things that were missing: real work, supplying what it needs, the owner's help, and an account", () => {
    const whole = STANDARD.join("\n");
    expect(whole).toContain("A mock-up is not a delivery");
    expect(whole).toContain("the pod writes the contract, puts it on a test network with its own money");
    expect(whole).toContain("test money from a faucet");
    expect(whole).toContain("Never build as if you had something you were not given");
    expect(whole).toContain("how the poster takes it over or makes their own");
    expect(whole).toContain("a yes with nothing to show for it earns nothing");
  });
});
