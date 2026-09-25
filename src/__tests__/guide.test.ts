import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { MOST_A_PUSH_MAY_WEIGH, MOST_A_REPOSITORY_MAY_WEIGH, MOST_A_STATEMENT_MAY_LAST_SECONDS, LONGEST_NOTE, NOTE_CLOCK_SLACK_SECONDS, NOTES_A_SEAT_MAY_WRITE_A_MINUTE, PUSHES_A_SEAT_MAY_MAKE_A_MINUTE, LIST_FRESH_FOR_MS, SEATS_FRESH_FOR_MS, agentEmail, branchFor } from "../door/index.ts";
import { SHARES } from "../job.ts";
import { roleNumber } from "../jobs.ts";
import { doorMessage, noteMessage } from "../messages.ts";
import { ROUTES } from "../routes.ts";
import { SEATS } from "../seal.ts";
import { handle } from "../server.ts";
import { JobStore } from "../store.ts";
import { registryTag } from "../verdict.ts";

/**
 * The guide for outside agents, at /llms.txt, says what the code does.
 *
 * An agent follows it to the letter: a sentence signed with one character different is a refused
 * push, and a limit that is wrong is an agent that stops for no reason. So every sentence it shows is
 * built here by the code the server checks with, every number is read from the constant that
 * enforces it, and every route it names is one the server answers. When the code changes, this fails
 * until the guide says the same.
 */

const GUIDE = await readFile(new URL("../../public/llms.txt", import.meta.url), "utf8");

/** The worked example the guide uses throughout */
const EXAMPLE = {
  jobId: "a-coat-given-the-rain",
  onChainId: "12",
  jobs: "0x1111111111111111111111111111111111111111",
  agent: "0x2222222222222222222222222222222222222222",
  at: 1790000000,
} as const;

describe("the guide for outside agents", () => {
  test("it is served where agents look for it", async () => {
    const answer = await handle(new Request(`http://pod.test${ROUTES.guide}`), new JobStore("/nonexistent"));
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toContain("text/markdown");
    expect(await answer.text()).toBe(GUIDE);
  });

  test("the sentence it shows for the git door is the one the door checks, character for character", () => {
    const sentence = doorMessage({
      jobId: EXAMPLE.jobId, onChainId: EXAMPLE.onChainId, jobs: EXAMPLE.jobs, role: "builder",
      branch: branchFor("builder", EXAMPLE.agent), until: EXAMPLE.at,
    });
    expect(GUIDE).toContain(sentence);
  });

  test("the sentence it shows for a note is the one the notes check, and so is its form for the whole job", () => {
    const aboutACommit = noteMessage({
      jobId: EXAMPLE.jobId, onChainId: EXAMPLE.onChainId, jobs: EXAMPLE.jobs, role: "reviewer",
      about: "9f2c4e1a7b3d5f6071829304a5b6c7d8e9f0a1b2", says: "It says take a coat when the query says rain=yes.", at: EXAMPLE.at,
    });
    expect(GUIDE).toContain(aboutACommit);
    const aboutTheJob = noteMessage({ jobId: EXAMPLE.jobId, onChainId: EXAMPLE.onChainId, jobs: EXAMPLE.jobs, role: "reviewer", says: "x", at: EXAMPLE.at });
    expect(aboutTheJob.split("\n")[1]).toStartWith("about the job,");
    expect(GUIDE).toContain("`about the job,`");
  });

  test("the branch and the commit address it shows are the ones the door enforces", () => {
    expect(GUIDE).toContain(`\`${branchFor("builder", EXAMPLE.agent)}\``);
    expect(GUIDE).toContain(`\`${agentEmail(EXAMPLE.agent)}\``);
  });

  test("every limit it states is the one in force", () => {
    expect(GUIDE).toContain(`at most ${MOST_A_PUSH_MAY_WEIGH / 1024 / 1024} MB a push`);
    expect(GUIDE).toContain(`at most ${PUSHES_A_SEAT_MAY_MAKE_A_MINUTE} pushes a minute`);
    expect(GUIDE).toContain(`at most ${MOST_A_REPOSITORY_MAY_WEIGH / 1024 / 1024} MB in the job's repository`);
    expect(MOST_A_STATEMENT_MAY_LAST_SECONDS).toBe(60 * 60);
    expect(GUIDE).toContain("at most one hour ahead");
    expect(GUIDE).toContain(`at most ${LONGEST_NOTE} characters`);
    expect(NOTE_CLOCK_SLACK_SECONDS).toBe(5 * 60);
    expect(GUIDE).toContain("within five minutes");
    expect(GUIDE).toContain(`At most ${NOTES_A_SEAT_MAY_WRITE_A_MINUTE} notes a minute`);
    expect(GUIDE).toContain(`within ${SEATS_FRESH_FOR_MS / 1000} seconds at the git door, within ${(SEATS_FRESH_FOR_MS + LIST_FRESH_FOR_MS) / 1000} in the list`);
  });

  test("the role numbers, the shares, the deposit and the registry tags are the contract's and the grader's", async () => {
    expect(GUIDE).toContain(SEATS.map((role) => `${role} ${roleNumber(role)}`).join(", "));
    expect(GUIDE).toContain(`lead ${SHARES.lead}%, builder ${SHARES.builder}%, reviewers ${SHARES.reviewer}% between them, QA ${SHARES.qa}%, security ${SHARES.security}%`);
    const contract = await readFile(new URL("../../contracts/src/PodJobs.sol", import.meta.url), "utf8");
    const deposit = /DEPOSIT_PERCENT = (\d+);/.exec(contract)?.[1];
    expect(GUIDE).toContain(`The deposit is ${deposit}% of the seat's pay`);
    expect(GUIDE).toContain(`\`${registryTag({ kind: "passed" }, "<role>")}\``);
    expect(GUIDE).toContain(`\`${registryTag({ kind: "not-reproducible" }, "<role>")}\``);
  });

  test("every route it names is one the server answers", () => {
    for (const route of [ROUTES.jobList, ROUTES.market, ROUTES.git, ROUTES.notes, ROUTES.receipt, ROUTES.agent]) {
      expect(GUIDE).toContain(route.replace(/\/$/, ""));
    }
  });
});
