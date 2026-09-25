import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parseEther } from "viem";
import { claudeOnThisMachine } from "../broker.ts";
import type { Spec } from "../job.ts";
import { APPROVED, NEEDS_A_MODEL, runReferenceAgent, type Finished } from "../reference/index.ts";
import { IMAGE } from "../sandbox.ts";
import { SEATS } from "../seal.ts";
import { anvilAvailable } from "./support/anvil.ts";
import { COAT_IDEA, DRY, good, WET } from "./support/coat.ts";
import { aPod, aPodServer, untilThePolicyIsMet, type RunningPodServer } from "./support/podServer.ts";
import { dockerAvailable } from "./support/tools.ts";

/**
 * The same pod as reference.test.ts, with the real model.
 *
 * Claude, through the CLI signed in on this machine and locked to answering text, writes the work,
 * reviews it and reads it for security; QA runs the visible check in the sealed box. Nothing is
 * scripted, so this shows the reference agent does the job it exists for, not only that its loop
 * turns. It runs only where the CLI is signed in and Docker is up, and never in CI: there is no model
 * there, and faking one here would prove nothing the scripted test does not.
 */

const cliAvailable = await (async () => {
  try {
    return (await Bun.spawn(["claude", "--version"], { stdout: "ignore", stderr: "ignore" }).exited) === 0;
  } catch {
    return false;
  }
})();
const available = cliAvailable && process.env.CI !== "true" && (await anvilAvailable()) && (await dockerAvailable());

const JOB = "a-coat-given-the-rain";
const SPEC: Spec = {
  idea: COAT_IDEA, kind: "service", mode: "flash", price: parseEther("1"),
  checks: [
    { says: WET, run: "node check-1.mjs", hidden: false, file: "check-1.mjs" },
    { says: DRY, run: "node check-2.mjs", hidden: true, file: "check-2.mjs" },
  ],
  allowed: [], salt: "a-number-nobody-can-guess",
};

/** A real model writes and reads the work, so a pod is given minutes, not seconds */
const A_POD_MAY_TAKE_SECONDS = 15 * 60;

const pod = aPod();
let running: RunningPodServer | undefined;

beforeAll(async () => {
  if (!available) return;
  running = await aPodServer({
    jobId: JOB, spec: SPEC, files: { "check-1.mjs": good(0).check, "check-2.mjs": good(1).check }, fund: Object.values(pod),
  });
}, 120_000);

afterAll(() => running?.stop());

describe.skipIf(!available)("a pod of reference agents, thinking with the real model", () => {
  test("five agents build the work from the brief, judge it, and meet the policy on one commit", async () => {
    const server = running!;
    const model = claudeOnThisMachine();
    const said: string[] = [];
    const stop = new AbortController();
    const agents: Promise<Finished>[] = SEATS.map((role) => runReferenceAgent({
      server: server.base, key: pod[role].key, role, image: IMAGE, every: 1_000, signal: stop.signal,
      ...(NEEDS_A_MODEL.includes(role) ? { model } : {}),
      say: (what) => said.push(what),
    }));

    let candidate: string | undefined;
    try {
      candidate = await untilThePolicyIsMet(server, A_POD_MAY_TAKE_SECONDS);
    } finally {
      stop.abort();
      await Promise.all(agents);
    }
    if (!candidate) throw new Error(`the policy was never met. What the agents said:\n${said.join("\n")}`);

    // QA ran the visible check against what they agreed on, for real, and it passed
    const notes = await server.store.notes(JOB);
    expect(notes.some((note) => note.role === "qa" && note.about === candidate && note.says.startsWith(APPROVED))).toBe(true);
    expect(await server.git(["show", `${candidate}:server.js`])).toContain("3000");
  }, (A_POD_MAY_TAKE_SECONDS + 120) * 1000);
});
