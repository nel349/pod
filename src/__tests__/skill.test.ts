import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { notTheSeatsKey, MOST_A_STATEMENT_MAY_LAST_SECONDS } from "../door/index.ts";
import { PORT, SHARES, START, WORK_FILE } from "../job.ts";
import { ROUTES } from "../routes.ts";
import { SEATS } from "../seal.ts";

/**
 * POD's skill, which is what an agent is taught before it ever reads the protocol.
 *
 * A skill that says a share, a limit or a refusal of its own goes stale the moment the code moves,
 * and an agent taught a stale number stops for no reason. So every figure in it is read here from
 * the constant that enforces it, and every refusal it tells an agent to read is one the code can
 * actually produce. The protocol itself stays in the guide; this checks the skill never contradicts it.
 */

const SKILL = await readFile(new URL("../../skills/pod/SKILL.md", import.meta.url), "utf8");

describe("the skill an agent is taught", () => {
  test("it is a skill, named, and says when to reach for it", () => {
    expect(SKILL.startsWith("---\n")).toBe(true);
    const front = SKILL.slice(4, SKILL.indexOf("\n---", 4));
    expect(front).toContain("name: pod");
    expect(front).toMatch(/description: .{80,}/);
  });

  test("it sends the agent to the guide for the protocol, rather than restating a signed sentence", () => {
    expect(SKILL).toContain(ROUTES.guide.replace("/", ""));
    // the sentences an agent signs are built by the code and shown in the guide; a copy here would drift
    expect(SKILL).not.toContain("Let me into the repository of");
    expect(SKILL).not.toContain("I hold the");
  });

  test("every seat, share and deposit it names is the one the contract pays", async () => {
    for (const seat of SEATS) expect(SKILL).toContain(`| ${seat} |`);
    for (const [seat, share] of Object.entries(SHARES)) {
      const row = SKILL.split("\n").find((line) => line.startsWith(`| ${seat} |`));
      expect(row).toContain(`${share}%`);
    }
    // the deposit is the contract's own figure, read from the contract, as the guide's is
    const contract = await readFile(new URL("../../contracts/src/PodJobs.sol", import.meta.url), "utf8");
    const deposit = /DEPOSIT_PERCENT = (\d+);/.exec(contract)?.[1];
    expect(deposit).toBeString();
    expect(SKILL).toContain(`${deposit}% of the seat's pay`);
  });

  test("the work it describes is the work the grader starts, on the port the checks reach", () => {
    expect(SKILL).toContain(WORK_FILE);
    expect(SKILL).toContain(`\`${START}\``);
    expect(SKILL).toContain(`port ${PORT}`);
  });

  test("how long a statement lasts is what the doors allow", () => {
    expect(MOST_A_STATEMENT_MAY_LAST_SECONDS).toBe(60 * 60);
    expect(SKILL).toContain("good for an hour at most");
  });

  test("every refusal it tells an agent to read is one the doors say", async () => {
    const preReceive = await readFile(new URL("../door/preReceive.ts", import.meta.url), "utf8");
    const doorkeeper = await readFile(new URL("../door/Doorkeeper.ts", import.meta.url), "utf8");
    const credentials = await readFile(new URL("../door/credentials.ts", import.meta.url), "utf8");
    const said = [
      { words: "that key holds no seat on job", from: doorkeeper },
      { words: "that key holds the ", from: doorkeeper },
      { words: "that statement has run out", from: credentials },
      { words: "that key's grant has run out", from: credentials },
      { words: "history is never rewritten here", from: preReceive },
      { words: "window closed", from: doorkeeper },
    ];
    for (const { words, from } of said) {
      expect(SKILL).toContain(words);
      expect(from).toContain(words);
    }
    // the one refusal built from its parts, which the skill quotes without the clause naming what was signed
    const whose = "the address in the name";
    const over = "over the statement for this job and this seat";
    expect(doorkeeper).toContain(`whose: "${whose}"`);
    expect(doorkeeper).toContain(`over: "${over}"`);
    const built = notTheSeatsKey({ whose, over });
    expect(SKILL).toContain(built.slice(0, built.indexOf(`, ${over}`)));
  });

  test("every route it names is written as the server's routes are", () => {
    // the doors an agent uses; the page its owner reads is the site's, and the site's own tests pin that
    for (const route of [ROUTES.jobList, ROUTES.market, ROUTES.notes, ROUTES.git]) {
      expect(SKILL).toContain(route);
    }
  });
});
