import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { parseEther } from "viem";
import type { Model } from "../broker.ts";
import { agentEmail, branchFor } from "../door/index.ts";
import type { Role, Spec } from "../job.ts";
import { readJob, readSeats } from "../jobs.ts";
import { APPROVED, REFUSED, runReferenceAgent, type Finished } from "../reference/index.ts";
import { bytes32ToCommit } from "../repo.ts";
import { record, registerAgent } from "../registry.ts";
import { IMAGE } from "../sandbox.ts";
import { anvilAvailable } from "./support/anvil.ts";
import { COAT_IDEA, dockerAvailable, DRY, good, serverSaying, WET, WORKING } from "./support/coat.ts";
import { aPod, aPodServer, VALIDATOR, type Agent, type RunningPodServer } from "./support/podServer.ts";
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
  test("five agents take the seats of a posted job, get it wrong, fix it, are paid, and each has its verdict in ERC-8004", async () => {
    const pod$ = running!;
    const builder = scripted(fenced(NEVER_A_COAT), fenced(WORKING));
    const reviewer = scripted("APPROVE it answers whether to take a coat, from whether it is raining");
    const security = scripted("APPROVE it reaches no network, reads nothing outside itself and starts nothing");
    const models: Partial<Record<Role, Model>> = { builder: builder.model, reviewer: reviewer.model, security: security.model };

    // each agent's own identity, registered with its own key, which is what lets it ask for its record
    const identities = {} as Record<Role, bigint>;
    for (const [role, agent] of Object.entries(pod) as [Role, Agent][]) {
      identities[role] = (await registerAgent({ publicClient: pod$.anvil.publicClient, wallet: pod$.anvil.wallet(agent.key) }, pod$.registries)).agentId;
    }

    // the worker runs beside the pod from the start, as it will beside a server: nobody tells it when
    const said: string[] = [];
    const stopWorker = new AbortController();
    const worker = new Worker({
      store: pod$.store, repositories: pod$.repositories, image: IMAGE, runnerKey: VALIDATOR, times: 2,
      jobs: { address: pod$.jobs, publicClient: pod$.anvil.publicClient, wallet: pod$.anvil.wallet(VALIDATOR) },
      token: { address: pod$.token, publicClient: pod$.anvil.publicClient, wallet: pod$.anvil.wallet(VALIDATOR) },
      registry: { registries: pod$.registries, stateFolder: await mkdtemp(join(tmpdir(), "pod-reference-worker-")) },
      say: (what) => said.push(what),
    });
    const working = worker.run(stopWorker.signal, 250);
    const builderBefore = await pod$.anvil.publicClient.getBalance({ address: pod.builder.address });

    // and the agents run until their job is over, which they see for themselves on the chain
    const outOfTime = AbortSignal.timeout(360_000);
    const agents: Promise<Finished>[] = (Object.entries(pod) as [Role, Agent][]).map(([role, agent]) => runReferenceAgent({
      server: pod$.base, key: agent.key, role, model: models[role], image: IMAGE, every: 250, signal: outOfTime,
      agentId: identities[role], say: (what) => said.push(what),
    }));
    const runner = privateKeyToAccount(VALIDATOR).address;
    // what the test waits for is every end the worker is responsible for: a title, main, and each record
    const everyRecord = async (): Promise<boolean> => {
      if ((await tokenOfJob({ address: pod$.token, publicClient: pod$.anvil.publicClient }, pod$.onChainId)) === 0n) return false;
      for (const role of Object.keys(pod) as Role[]) {
        if ((await record(pod$.anvil.publicClient, identities[role], `pod.${role}`, [runner], pod$.registries)).count === 0) return false;
      }
      return true;
    };
    let finished: Finished[] = [];
    try {
      finished = await Promise.all(agents);
      while (!outOfTime.aborted && !(await everyRecord())) await Bun.sleep(250);
      // hundreds of looks on one stop each, and nothing left listening on either: a loop that runs for days must not collect them
      expect(getEventListeners(outOfTime, "abort")).toHaveLength(0);
      expect(getEventListeners(stopWorker.signal, "abort").length).toBeLessThanOrEqual(1);
    } finally {
      stopWorker.abort();
      await working;
    }
    if (!(await everyRecord())) throw new Error(`not every agent's verdict was recorded. What was said:\n${said.join("\n")}`);
    for (const done of finished) expect(done.why).toBe("the job is settled");

    // the pod agreed on the builder's second try, which answers the brief and passes the sealed exam
    const onChain = await readJob(pod$.reading, pod$.onChainId);
    const candidate = bytes32ToCommit(onChain.commit);
    expect(await pod$.git(["show", `${candidate}:server.js`])).toBe(`${WORKING}\n`);
    expect(onChain.state).toBe("settled");
    const graded = (await pod$.store.read(JOB))!;
    expect(graded.tile.verdict).toBe("passed");
    expect(graded.signed?.receipt.commit).toBe(candidate);
    expect(graded.checksSaid.find((check) => check.says === DRY)?.exitCode).toBe(0);

    // every seat is held by its own key, and the pod was paid
    const seats = await readSeats(pod$.reading, pod$.onChainId);
    for (const [role, agent] of Object.entries(pod) as [Role, Agent][]) {
      expect(seats.find((seat) => seat.role === role)?.agent).toBe(agent.address);
    }
    expect(await pod$.anvil.publicClient.getBalance({ address: pod.builder.address })).toBeGreaterThan(builderBefore);

    // QA ran the visible check against the first try and said why it failed; the builder read it
    const notes = await pod$.store.notes(JOB);
    expect(notes.find((note) => note.role === "qa" && note.says.startsWith(REFUSED))?.says).toContain(WET);
    expect(builder.prompts).toHaveLength(2);
    expect(builder.prompts[1]).toContain("qa: ");
    expect(builder.prompts[1]).toContain(WET);
    for (const role of ["reviewer", "qa", "security"] as const) {
      expect(notes.some((note) => note.role === role && note.about === candidate && note.says.startsWith(APPROVED))).toBe(true);
    }

    // the poster holds the title, main is the work, and every commit was written by a seat of this pod
    expect(await tokenOfJob({ address: pod$.token, publicClient: pod$.anvil.publicClient }, pod$.onChainId)).not.toBe(0n);
    expect((await pod$.git(["rev-parse", "refs/heads/main"])).trim()).toBe(candidate);
    const seatEmails = Object.values(pod).map((agent) => agentEmail(agent.address));
    for (const author of (await pod$.git(["log", "--all", "--format=%ae"])).trim().split("\n")) expect(seatEmails).toContain(author);
    expect((await pod$.git(["branch", "--list"])).split("\n").map((line) => line.replace("*", "").trim()).filter(Boolean).sort())
      .toEqual([branchFor("builder", pod.builder.address), branchFor("lead", pod.lead.address), "main"].sort());

    // and each agent's record in ERC-8004 has this job, passed, under its own role
    for (const role of Object.keys(pod) as Role[]) {
      expect(await record(pod$.anvil.publicClient, identities[role], `pod.${role}`, [runner], pod$.registries)).toEqual({ count: 1, average: 100 });
    }
  }, 480_000);
});
