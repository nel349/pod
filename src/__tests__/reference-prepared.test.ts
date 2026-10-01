import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parseEther } from "viem";
import type { Model } from "../broker.ts";
import type { Role, Spec } from "../job.ts";
import { policyMet, readJob } from "../jobs.ts";
import { releaseLock } from "../jobsV2.ts";
import { runReferenceAgent, type Finished } from "../reference/index.ts";
import { IMAGE } from "../sandbox.ts";
import { SEATS } from "../seal.ts";
import { Worker } from "../worker/index.ts";
import { anvilAvailable } from "./support/anvil.ts";
import { COAT_IDEA, DRY, good, WET, WORKING } from "./support/coat.ts";
import { aPod, aPodServer, VALIDATOR, type RunningPodServer } from "./support/podServer.ts";
import { dockerAvailable } from "./support/tools.ts";

/**
 * A pod of reference agents on the contract that prepares jobs. Once every approval is in, the job is
 * locked while it is graded: the lead brings nothing new in. When the grader lets it go, the approvals
 * are cleared, and the pod approves its candidate again rather than taking it as already judged; then
 * it is graded, and the pod is paid. The model is scripted; everything else is real.
 */
const available = (await anvilAvailable()) && (await dockerAvailable());

const JOB = "a-coat-prepared-first";
const SPEC: Spec = {
  idea: COAT_IDEA, kind: "service", mode: "flash", price: parseEther("1"),
  checks: [
    { says: WET, run: "node check-1.mjs", hidden: false, file: "check-1.mjs" },
    { says: DRY, run: "node check-2.mjs", hidden: true, file: "check-2.mjs" },
  ],
  allowed: [], salt: "a-number-nobody-can-guess-either",
};

const pod = aPod();
let running: RunningPodServer | undefined;

beforeAll(async () => {
  if (!available) return;
  running = await aPodServer({
    jobId: JOB, spec: SPEC, files: { "check-1.mjs": good(0).check, "check-2.mjs": good(1).check }, fund: Object.values(pod), prepared: true,
  });
}, 120_000);

afterAll(() => running?.stop());

const fenced = (code: string): string => `\`\`\`js\n${code}\n\`\`\``;
const answering = (answer: string): Model => async () => answer;

async function until(what: string, said: readonly string[], done: () => Promise<boolean>, seconds = 240): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await done()) return;
    await Bun.sleep(250);
  }
  throw new Error(`never ${what}. What was said:\n${said.join("\n")}`);
}

describe.skipIf(!available)("a pod of reference agents, on the contract that prepares jobs", () => {
  test("locked while graded, let go once, its candidate approved again, then graded and paid", async () => {
    const pod$ = running!;
    const reading = { address: pod$.jobs, publicClient: pod$.anvil.publicClient };
    const models: Partial<Record<Role, Model>> = {
      builder: answering(fenced(WORKING)),
      reviewer: answering("APPROVE it answers whether to take a coat, from whether it is raining"),
      security: answering("APPROVE it reaches no network, reads nothing outside itself and starts nothing"),
    };
    const said: string[] = [];
    const outOfTime = AbortSignal.timeout(400_000);
    const agents: Promise<Finished>[] = SEATS.map((role) => runReferenceAgent({
      server: pod$.base, key: pod[role].key, role, model: models[role], image: IMAGE, every: 250, signal: outOfTime,
      say: (what) => said.push(what),
    }));
    const isLocked = async (): Promise<boolean> => {
      const { commit } = await readJob(reading, pod$.onChainId);
      return commit !== `0x${"0".repeat(64)}` && policyMet(reading, pod$.onChainId, commit);
    };

    // every approval in, and nothing to grade it yet: the lead sees the lock and brings nothing new in
    await until("locked", said, isLocked);
    await until("the lead seeing the lock", said, async () => said.some((line) => line.includes("[lead] the candidate is being graded")));
    const candidate = (await readJob(reading, pod$.onChainId)).commit;

    // the grader lets it go, as it would after runs that disagreed: every approval is cleared
    await releaseLock({ ...reading, wallet: pod$.anvil.wallet(VALIDATOR) }, pod$.onChainId);
    expect(await isLocked()).toBe(false);

    // the pod approves the same candidate again, the judges too, rather than taking it as judged
    await until("locked again", said, isLocked);
    expect((await readJob(reading, pod$.onChainId)).commit).toBe(candidate);
    expect(said.filter((line) => line.includes("approved again")).length).toBeGreaterThanOrEqual(3);

    // now it is graded and settled, and the pod is paid
    const stop = new AbortController();
    const worker = new Worker({
      store: pod$.store, repositories: pod$.repositories, image: IMAGE, runnerKey: VALIDATOR, times: 2,
      jobs: { address: pod$.earlierJobs, publicClient: pod$.anvil.publicClient, wallet: pod$.anvil.wallet(VALIDATOR) },
      prepared: { ...reading, wallet: pod$.anvil.wallet(VALIDATOR) },
      token: { address: pod$.token, publicClient: pod$.anvil.publicClient, wallet: pod$.anvil.wallet(VALIDATOR) },
      say: (what) => said.push(what),
    });
    const working = worker.run(stop.signal, 250);
    try {
      const finished = await Promise.all(agents);
      for (const done of finished) expect(done.why).toBe("the job is settled");
    } finally {
      stop.abort();
      await working;
    }
    expect((await readJob(reading, pod$.onChainId)).state).toBe("settled");
    expect(said.some((line) => line.includes("[worker] a-coat-prepared-first: settled, the pod is paid"))).toBe(true);
  }, 480_000);
});
