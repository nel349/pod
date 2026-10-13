import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parseEther } from "viem";
import type { Spec } from "../job.ts";
import { readSeats } from "../jobs.ts";
import { runReferenceAgent, type Finished } from "../reference/index.ts";
import { anvilAvailable } from "./support/anvil.ts";
import { COAT_IDEA, DRY, good, WET } from "./support/coat.ts";
import { aPod, aPodServer, type RunningPodServer } from "./support/podServer.ts";

/**
 * A seat is held by a key, not by a process.
 *
 * An agent that is stopped and started again has to carry on with the seat it already holds. Before
 * it did, a restarted agent looked for a free seat, found its own taken, and waited for one that
 * could never come free: the seat sat there doing nothing and the job's time ran out with the work
 * unbuilt. It is the quietest way to lose a job, since every seat looks taken and nothing is wrong.
 *
 * Only the chain and the doors are real here; no model and no boxes are needed to take a seat.
 */
const available = await anvilAvailable();

const JOB = "a-coat-whose-agent-was-stopped";
const HOUR = 3600n;
const SPEC: Spec = {
  idea: COAT_IDEA, kind: "service", mode: "flash", price: parseEther("1"),
  checks: [
    { says: WET, run: "node check-1.mjs", hidden: false, file: "check-1.mjs" },
    { says: DRY, run: "node check-2.mjs", hidden: true, file: "check-2.mjs" },
  ],
  allowed: [], salt: "a-number-nobody-can-guess-for-a-stopped-agent",
};

const pod = aPod();
let running: RunningPodServer | undefined;

beforeAll(async () => {
  if (!available) return;
  running = await aPodServer({
    jobId: JOB, spec: SPEC, files: { "check-1.mjs": good(0).check, "check-2.mjs": good(1).check },
    fund: Object.values(pod), lastWordWithin: 4n * HOUR, leadNames: true,
  });
}, 120_000);

afterAll(() => running?.stop());

/** Run one seat until it says something that means it is seated, then stop it, as a restart does. */
async function seatedThenStopped(key: `0x${string}`, said: string[]): Promise<Finished> {
  const pod$ = running!;
  const stop = new AbortController();
  const agent = runReferenceAgent({
    server: pod$.base, key, role: "qa", every: 200, signal: stop.signal,
    say: (what) => {
      said.push(what);
      if (/holds the qa seat/.test(what)) stop.abort();
    },
  });
  const finished = await agent;
  return finished;
}

describe.skipIf(!available)("an agent that is started again", () => {
  test("carries on with the seat it already holds, takes no second seat, and says so", async () => {
    const pod$ = running!;
    const first: string[] = [];
    await seatedThenStopped(pod.qa.key, first);
    expect(first.some((line) => line.includes("holds the qa seat"))).toBe(true);
    expect(first.some((line) => line.includes("already holds"))).toBe(false);
    const taken = await readSeats(pod$.reading, pod$.onChainId);
    expect(taken.filter((seat) => seat.role === "qa")).toHaveLength(1);
    const deposit = await pod$.anvil.publicClient.getBalance({ address: pod.qa.address });

    // started again with the same key: it finds its own seat rather than waiting for a free one
    const again: string[] = [];
    await seatedThenStopped(pod.qa.key, again);
    expect(again.some((line) => line.includes("already holds the qa seat on a-coat-whose-agent-was-stopped, from before it was stopped"))).toBe(true);
    // and nothing was taken or paid for twice: one seat, and the deposit only went down by gas
    const after = await readSeats(pod$.reading, pod$.onChainId);
    expect(after.filter((seat) => seat.role === "qa")).toHaveLength(1);
    expect(await pod$.anvil.publicClient.getBalance({ address: pod.qa.address })).toBe(deposit);
  }, 120_000);

  test("an agent holding no seat still waits for a free one, and says nothing about holding one", async () => {
    const pod$ = running!;
    const stop = new AbortController();
    const said: string[] = [];
    // this agent holds nothing, and is told to wait for a job that is not there
    const finished = await runReferenceAgent({
      server: pod$.base, key: pod.lead.key, role: "qa", jobId: "a-job-nobody-posted", every: 200,
      signal: AbortSignal.any([stop.signal, AbortSignal.timeout(4_000)]),
      say: (what) => said.push(what),
    });
    expect(finished.why).toBe("stopped before a seat was free");
    expect(said.some((line) => line.includes("already holds"))).toBe(false);
    // and the qa seat on the job that does exist is still the one agent's, not this one's
    const seats = await readSeats(pod$.reading, pod$.onChainId);
    expect(seats.filter((seat) => seat.role === "qa")).toHaveLength(1);
    expect(seats.some((seat) => seat.agent.toLowerCase() === pod.lead.address.toLowerCase())).toBe(false);
  }, 60_000);
});
