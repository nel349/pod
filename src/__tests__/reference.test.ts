import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parseEther } from "viem";
import type { Model } from "../broker.ts";
import { agentEmail, branchFor } from "../door/index.ts";
import type { Role, Spec } from "../job.ts";
import { policyMet, readJob, readSeats } from "../jobs.ts";
import { APPROVED, REFUSED, runReferenceAgent, type Finished } from "../reference/index.ts";
import { commitToBytes32 } from "../repo.ts";
import { IMAGE } from "../sandbox.ts";
import { anvilAvailable } from "./support/anvil.ts";
import { COAT_IDEA, dockerAvailable, DRY, good, serverSaying, WET, WORKING } from "./support/coat.ts";
import { aPod, aPodServer, untilThePolicyIsMet, VALIDATOR, type Agent, type RunningPodServer } from "./support/podServer.ts";
import { tokenOfJob } from "../token.ts";
import { Worker } from "../worker/index.ts";

/**
 * A whole pod of reference agents, through the public doors only, against a real chain, from a
 * posted job to the pod paid and the poster holding the title.
 *
 * Five keys, five agents, one freshly posted job. Nobody tells them what to do: each finds the job
 * in the list, takes its seat on the contract, and works until the contract says every approval the
 * policy asks for is on one commit. The builder's model gets it wrong the first time, on purpose, so
 * what is shown is the loop and not only a pass: QA runs the visible check for real, refuses, says
 * why in a note, and the builder answers it.
 *
 * The models are scripted, because what is under test is the agents and the doors, not Claude. QA
 * uses no model at all; it runs the checks in the same sealed box a verdict does.
 */

const available = (await anvilAvailable()) && (await dockerAvailable());

const JOB = "a-coat-given-the-rain";
/** Never says take a coat: what the builder's model writes the first time */
const NEVER_A_COAT = serverSaying("false", "false");

const SPEC: Spec = {
  idea: COAT_IDEA, kind: "service", mode: "flash", price: parseEther("1"),
  checks: [
    { says: WET, run: "node check-1.mjs", hidden: false, file: "check-1.mjs" },
    { says: DRY, run: "node check-2.mjs", hidden: true, file: "check-2.mjs" },
  ],
  allowed: [], salt: "a-number-nobody-can-guess",
};

const pod = aPod();
let running: RunningPodServer | undefined;

beforeAll(async () => {
  if (!available) return;
  running = await aPodServer({
    jobId: JOB, spec: SPEC, files: { "check-1.mjs": good(0).check, "check-2.mjs": good(1).check }, fund: Object.values(pod),
  });
}, 120_000);

afterAll(() => running?.stop());

/** A model that answers in turn, repeating its last answer, and keeps what it was asked. */
function scripted(...answers: readonly string[]): { readonly model: Model; readonly prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    model: async (prompt) => {
      prompts.push(prompt);
      return answers[Math.min(prompts.length, answers.length) - 1]!;
    },
  };
}

const fenced = (code: string): string => `\`\`\`js\n${code}\n\`\`\``;

describe.skipIf(!available)("a pod of reference agents", () => {
  test("five agents with five keys take the seats, get it wrong, are told why, fix it, and meet the policy on one commit", async () => {
    const pod$ = running!;
    const builder = scripted(fenced(NEVER_A_COAT), fenced(WORKING));
    const reviewer = scripted("APPROVE it answers whether to take a coat, from whether it is raining");
    const security = scripted("APPROVE it reaches no network, reads nothing outside itself and starts nothing");
    const models: Partial<Record<Role, Model>> = { builder: builder.model, reviewer: reviewer.model, security: security.model };

    const said: string[] = [];
    const stop = new AbortController();
    const agents: Promise<Finished>[] = (Object.entries(pod) as [Role, Agent][]).map(([role, agent]) => runReferenceAgent({
      server: pod$.base, key: agent.key, role, model: models[role], image: IMAGE, every: 250, signal: stop.signal,
      say: (what) => said.push(what),
    }));

    // what the test waits for is the contract's own word, not anything an agent says
    let candidate: string | undefined;
    try {
      candidate = await untilThePolicyIsMet(pod$, 240);
    } finally {
      stop.abort();
      await Promise.all(agents);
    }
    if (!candidate) throw new Error(`the policy was never met. What the agents said:\n${said.join("\n")}`);

    // what they agreed on is the work that answers the brief, from the builder's second try
    expect(await pod$.git(["show", `${candidate}:server.js`])).toBe(`${WORKING}\n`);
    expect(await policyMet(pod$.reading, pod$.onChainId, commitToBytes32(candidate))).toBe(true);

    // every seat is held by its own key
    const seats = await readSeats(pod$.reading, pod$.onChainId);
    for (const [role, agent] of Object.entries(pod) as [Role, Agent][]) {
      expect(seats.find((seat) => seat.role === role)?.agent).toBe(agent.address);
    }

    // QA ran the visible check against the first try and said why it failed; the builder read it
    const notes = await pod$.store.notes(JOB);
    const refusal = notes.find((note) => note.role === "qa" && note.says.startsWith(REFUSED));
    expect(refusal?.says).toContain(WET);
    expect(builder.prompts).toHaveLength(2);
    expect(builder.prompts[1]).toContain("qa: ");
    expect(builder.prompts[1]).toContain(WET);
    for (const role of ["reviewer", "qa", "security"] as const) {
      expect(notes.some((note) => note.role === role && note.about === candidate && note.says.startsWith(APPROVED))).toBe(true);
    }

    // and every commit in the job's repository was written by a seat of this pod
    const seatEmails = Object.values(pod).map((agent) => agentEmail(agent.address));
    const authors = (await pod$.git(["log", "--all", "--format=%ae"])).trim().split("\n");
    expect(authors.length).toBeGreaterThanOrEqual(2);
    for (const author of authors) expect(seatEmails).toContain(author);
    expect((await pod$.git(["branch", "--list"])).split("\n").map((line) => line.replace("*", "").trim()).filter(Boolean).sort())
      .toEqual([branchFor("builder", pod.builder.address), branchFor("lead", pod.lead.address)].sort());

    // and from there to payment, with nobody asking: the worker grades what they agreed on, against
    // the sealed exam as well, pays the pod, titles the poster and puts the work on main
    const builderBefore = await pod$.anvil.publicClient.getBalance({ address: pod.builder.address });
    const worker = new Worker({
      store: pod$.store, repositories: pod$.repositories, image: IMAGE, runnerKey: VALIDATOR, times: 2,
      jobs: { address: pod$.jobs, publicClient: pod$.anvil.publicClient, wallet: pod$.anvil.wallet(VALIDATOR) },
      token: { address: pod$.token, publicClient: pod$.anvil.publicClient, wallet: pod$.anvil.wallet(VALIDATOR) },
      say: (what) => said.push(what),
    });
    const tokenReading = { address: pod$.token, publicClient: pod$.anvil.publicClient };
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline && (await tokenOfJob(tokenReading, pod$.onChainId)) === 0n) {
      await worker.tick();
      await worker.whenIdle();
    }
    const record = (await pod$.store.read(JOB))!;
    expect(record.tile.verdict).toBe("passed");
    expect(record.checksSaid.find((check) => check.says === DRY)?.exitCode).toBe(0);
    expect((await readJob(pod$.reading, pod$.onChainId)).state).toBe("settled");
    expect(await pod$.anvil.publicClient.getBalance({ address: pod.builder.address })).toBeGreaterThan(builderBefore);
    expect(await tokenOfJob(tokenReading, pod$.onChainId)).not.toBe(0n);
    await worker.tick();
    expect((await pod$.git(["rev-parse", "refs/heads/main"])).trim()).toBe(candidate);
  }, 480_000);
});
