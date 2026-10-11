import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestClient, http, parseEther } from "viem";
import type { Model } from "../broker.ts";
import type { Role, Spec } from "../job.ts";
import { readJob, readSeats, seatDeposit, seatPay, takeSeat } from "../jobs.ts";
import { readAgentRecord, readReviewBy, refuse, REFUSAL_SHARE_PERCENT } from "../jobsV3.ts";
import { runReferenceAgent, type Finished } from "../reference/index.ts";
import { IMAGE } from "../sandbox.ts";
import { Worker } from "../worker/index.ts";
import { ANVIL_KEYS, anvilAvailable } from "./support/anvil.ts";
import { COAT_IDEA, DRY, good, WET, WORKING } from "./support/coat.ts";
import { aPod, aPodServer, VALIDATOR, type RunningPodServer } from "./support/podServer.ts";
import { dockerAvailable } from "./support/tools.ts";

/**
 * No seat can stop a delivery, shown with the real agents through the public doors.
 *
 * A poster's second wallet takes the security seat, where it can read whatever the pod writes, and
 * then says nothing, to let the window run out and take the money back with the work in hand. On the
 * contracts before this one that worked: nothing was graded without security's approval. Here the
 * builder puts its own work forward, the seats that judge it stand behind it, the time for reviewing
 * runs out, and the work is graded and delivered all the same. The poster then refuses work whose
 * checks passed, which costs them a quarter of what the seats behind it would have been paid, and the
 * silent seat gets back what it put down and nothing else.
 *
 * The models are scripted; everything else is real: the contract on a local chain, the doors, git,
 * the worker and the boxes it grades in.
 */
const available = (await anvilAvailable()) && (await dockerAvailable());

const JOB = "a-coat-with-a-seat-that-says-nothing";
const POSTER = ANVIL_KEYS[1];
const HOUR = 3600n;
/** a review is a quarter of the job's window, which is an hour here: waited out on the chain's clock, not on the wall's */
const REVIEW_SECONDS = HOUR / 4n;
const SPEC: Spec = {
  idea: COAT_IDEA, kind: "service", mode: "flash", price: parseEther("1"),
  checks: [
    { says: WET, run: "node check-1.mjs", hidden: false, file: "check-1.mjs" },
    { says: DRY, run: "node check-2.mjs", hidden: true, file: "check-2.mjs" },
  ],
  allowed: [], salt: "a-number-nobody-can-guess-for-a-silent-seat",
};
/** the seats run by agents that do their work; security is the wallet that only sits */
const WORKING_SEATS: readonly Role[] = ["lead", "builder", "reviewer", "qa"];

const pod = aPod();
let running: RunningPodServer | undefined;

beforeAll(async () => {
  if (!available) return;
  running = await aPodServer({
    jobId: JOB, spec: SPEC, files: { "check-1.mjs": good(0).check, "check-2.mjs": good(1).check },
    fund: Object.values(pod), lastWordWithin: 4n * HOUR,
  });
}, 120_000);

afterAll(() => running?.stop());

const answering = (answer: string): Model => async () => answer;

async function until(what: string, said: readonly string[], done: () => Promise<boolean>, seconds = 240): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await done()) return;
    await Bun.sleep(250);
  }
  throw new Error(`never ${what}. What was said:\n${said.join("\n")}`);
}

describe.skipIf(!available)("a seat that says nothing, among agents that do their work", () => {
  test("the work is delivered without it, the seats behind it keep their quarter when it is refused, and the silent seat gets its deposit and no more", async () => {
    const pod$ = running!;
    const reading = { address: pod$.jobs, publicClient: pod$.anvil.publicClient };
    const balance = (role: Role): Promise<bigint> => pod$.anvil.publicClient.getBalance({ address: pod[role].address });

    // the wallet that only sits: it holds the seat nothing used to be graded without
    await takeSeat({ ...reading, wallet: pod$.anvil.wallet(pod.security.key) }, pod$.onChainId, "security", pod.security.address);

    const models: Partial<Record<Role, Model>> = {
      builder: answering(`\`\`\`js\n${WORKING}\n\`\`\``),
      lead: answering("APPROVE it says to take a coat when it rains and not when it is dry"),
      reviewer: answering("APPROVE it answers both questions as asked"),
    };
    const said: string[] = [];
    const outOfTime = AbortSignal.timeout(400_000);
    const seated = (role: Role): Promise<Finished> => runReferenceAgent({
      server: pod$.base, key: pod[role].key, role, model: models[role], image: IMAGE, every: 250, signal: outOfTime,
      say: (what) => said.push(what),
    });
    // the seats that judge sit down while the work is still to be built: once it is put forward and
    // everybody seated stands behind it, no seat is taken any more
    const judges = WORKING_SEATS.filter((role) => role !== "builder").map(seated);
    await until("the judging seats being taken", said, async () => (await readSeats(reading, pod$.onChainId)).length === WORKING_SEATS.length);
    const agents: Promise<Finished>[] = [...judges, seated("builder")];

    const stop = new AbortController();
    const worker = new Worker({
      store: pod$.store, repositories: pod$.repositories, image: IMAGE, runnerKey: VALIDATOR, times: 2,
      jobs: { address: pod$.earlierJobs, publicClient: pod$.anvil.publicClient, wallet: pod$.anvil.wallet(VALIDATOR) },
      prepared: { ...reading, wallet: pod$.anvil.wallet(VALIDATOR) }, hasTheLastWord: true,
      say: (what) => said.push(what),
    });
    const working = worker.run(stop.signal, 250);
    try {
      // the builder put its work forward, and every seat that does its work stands behind it
      await until("the three judging seats standing behind the work", said, async () =>
        (await readSeats(reading, pod$.onChainId)).filter((seat) => seat.approved).length === WORKING_SEATS.length);
      const reviewBy = await readReviewBy(reading, pod$.onChainId);
      if (reviewBy === undefined) throw new Error("the work was put forward, and its review has no end");

      // security has said nothing, so the pod has not agreed as one: nothing is graded while the review runs
      expect((await pod$.store.read(JOB))?.signed).toBeUndefined();
      expect((await readJob(reading, pod$.onChainId)).state).toBe("working");
      expect(said.some((line) => line.includes("grading"))).toBe(false);

      // the time for reviewing runs out, on the chain's own clock
      const clock = createTestClient({ mode: "anvil", transport: http(pod$.anvil.rpc) });
      await clock.increaseTime({ seconds: Number(REVIEW_SECONDS) + 1 });
      await clock.mine({ blocks: 1 });

      // and the work is graded and delivered, with whoever stood behind it
      const finished = await Promise.all(agents);
      for (const done of finished) expect(done.why).toBe("the job is delivered, and waits for its poster's answer");
      const delivered = await pod$.store.read(JOB);
      expect(delivered?.signed?.receipt.verdict).toBe("passed");
      expect(delivered?.approvals.map((one) => one.role).sort()).toEqual(["builder", "lead", "qa", "reviewer"]);

      // the poster has the work, and it passed: refusing it leaves each seat behind it a quarter of its pay
      const before = { builder: await balance("builder"), lead: await balance("lead"), security: await balance("security") };
      await refuse({ ...reading, wallet: pod$.anvil.wallet(POSTER) }, pod$.onChainId);
      const quarterOf = async (role: Role): Promise<bigint> => ((await seatPay(reading, pod$.onChainId, role)) * BigInt(REFUSAL_SHARE_PERCENT)) / 100n;
      expect(await balance("builder")).toBe(before.builder + (await quarterOf("builder")) + (await seatDeposit(reading, pod$.onChainId, "builder")));
      expect(await balance("lead")).toBe(before.lead + (await quarterOf("lead")) + (await seatDeposit(reading, pod$.onChainId, "lead")));
      expect(await balance("security")).toBe(before.security + (await seatDeposit(reading, pod$.onChainId, "security")));

      // and the records say who stood behind work that was refused although it passed, and nothing of the seat that did not
      expect(await readAgentRecord(reading, pod.builder.address)).toMatchObject({ refusedPassed: 1, undelivered: 0 });
      expect(await readAgentRecord(reading, pod.security.address)).toEqual({ accepted: 0, paidUnanswered: 0, refusedPassed: 0, failed: 0, undelivered: 0 });
    } finally {
      stop.abort();
      await working;
    }
  }, 480_000);
});
