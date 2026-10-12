import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parseEther } from "viem";
import { JobListingSchema, LIST_FRESH_FOR_MS, type ListedJob } from "../door/index.ts";
import type { Spec } from "../job.ts";
import { seatDeposit, takeSeat } from "../jobs.ts";
import { isLocked } from "../jobsV2.ts";
import { putForward } from "../jobsV3.ts";
import { commitToBytes32 } from "../repo.ts";
import { ROUTES } from "../routes.ts";
import { anvilAvailable } from "./support/anvil.ts";
import { COAT_IDEA, DRY, good, WET } from "./support/coat.ts";
import { aPod, aPodServer, type RunningPodServer } from "./support/podServer.ts";

/**
 * The list of open jobs, where a builder puts its own work forward and it is graded as soon as every
 * seat that is taken stands behind it. A job can then be locked for grading with seats still empty,
 * which never happened where every seat had to be filled first: the list must stop offering them, or
 * an agent would knock on a job the contract has closed to newcomers, every few seconds, for nothing.
 */
const available = await anvilAvailable();

const JOB = "a-coat-built-by-one-agent";
const HOUR = 3600n;
const SPEC: Spec = {
  idea: COAT_IDEA, kind: "service", mode: "flash", price: parseEther("1"),
  checks: [
    { says: WET, run: "node check-1.mjs", hidden: false, file: "check-1.mjs" },
    { says: DRY, run: "node check-2.mjs", hidden: true, file: "check-2.mjs" },
  ],
  allowed: [], salt: "a-number-nobody-can-guess-for-a-lone-builder",
};
const A_COMMIT = "1cede02ebf88bf81bfcd556351dc6fa8bdb74a5d";

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

async function listedIn(base: string, jobId: string): Promise<ListedJob> {
  const listing = JobListingSchema.parse(await (await fetch(base + ROUTES.jobList)).json());
  const job = listing.jobs.find((one) => one.jobId === jobId);
  if (!job) throw new Error(`${jobId} is not in the list`);
  return job;
}

const listed = (base: string): Promise<ListedJob> => listedIn(base, JOB);

describe.skipIf(!available)("the list of open jobs, once a job is locked for grading", () => {
  test("a builder alone puts its work forward, and the list offers no seat on the job, though four stand empty", async () => {
    const pod$ = running!;
    const asTheBuilder = { address: pod$.jobs, publicClient: pod$.anvil.publicClient, wallet: pod$.anvil.wallet(pod.builder.key) };
    await takeSeat(asTheBuilder, pod$.onChainId, "builder", pod.builder.address);
    await Bun.sleep(LIST_FRESH_FOR_MS + 200);
    // being built: the four seats that judge are there to be taken
    expect((await listed(pod$.base)).free).toEqual(["lead", "reviewer", "qa", "security"]);

    await putForward(asTheBuilder, pod$.onChainId, commitToBytes32(A_COMMIT));
    expect(await isLocked(pod$.reading, pod$.onChainId), "nobody waits for a seat nobody took").toBe(true);
    await Bun.sleep(LIST_FRESH_FOR_MS + 200);

    const job = await listed(pod$.base);
    expect(job.free).toEqual([]);
    // the seats are shown as they are, empty: it is taking one that is over
    expect(job.seats.filter((seat) => !seat.heldBy).map((seat) => seat.role)).toEqual(["lead", "reviewer", "qa", "security"]);
    // and the contract says the same to anybody who tries all the same
    const asALatecomer = { address: pod$.jobs, publicClient: pod$.anvil.publicClient, wallet: pod$.anvil.wallet(pod.qa.key) };
    expect(await seatDeposit(pod$.reading, pod$.onChainId, "qa")).toBeGreaterThan(0n);
    await expect(takeSeat(asALatecomer, pod$.onChainId, "qa", pod.qa.address)).rejects.toThrow("Locked");
  }, 120_000);
});

/**
 * Where the lead names who is paid, its seat is not to be had once work is put forward: a lead that
 * sat down afterwards would be judging work it never watched being made, and could keep every seat
 * behind it from its pay. The list stops offering that one seat, and goes on offering the others.
 */
describe.skipIf(!available)("the list of open jobs, where the lead names who is paid", () => {
  const JOB_NAMED = "a-coat-whose-lead-comes-first";
  const named = aPod();
  let naming: RunningPodServer | undefined;

  beforeAll(async () => {
    naming = await aPodServer({
      jobId: JOB_NAMED, spec: { ...SPEC, salt: "a-number-nobody-can-guess-for-a-lead-that-comes-first" },
      files: { "check-1.mjs": good(0).check, "check-2.mjs": good(1).check },
      fund: Object.values(named), lastWordWithin: 4n * HOUR, leadNames: true,
    });
  }, 120_000);

  afterAll(() => naming?.stop());

  test("once a builder has put work forward the list offers no lead's seat, the contract refuses one, and the other seats are still offered", async () => {
    const pod$ = naming!;
    const asTheBuilder = { address: pod$.jobs, publicClient: pod$.anvil.publicClient, wallet: pod$.anvil.wallet(named.builder.key) };
    await takeSeat(asTheBuilder, pod$.onChainId, "builder", named.builder.address);
    // a seat is taken and silent, so putting work forward does not lock the job: there is a review to sit in
    const asQA = { address: pod$.jobs, publicClient: pod$.anvil.publicClient, wallet: pod$.anvil.wallet(named.qa.key) };
    await takeSeat(asQA, pod$.onChainId, "qa", named.qa.address);
    await Bun.sleep(LIST_FRESH_FOR_MS + 200);
    const listing = (await listedIn(pod$.base, JOB_NAMED)).free;
    expect(listing).toEqual(["lead", "reviewer", "security"]);

    await putForward(asTheBuilder, pod$.onChainId, commitToBytes32(A_COMMIT));
    expect(await isLocked(pod$.reading, pod$.onChainId), "a seat that is taken has its review").toBe(false);
    await Bun.sleep(LIST_FRESH_FOR_MS + 200);

    const job = await listedIn(pod$.base, JOB_NAMED);
    expect(job.free).toEqual(["reviewer", "security"]);
    // the lead's seat is shown as it is, empty, and the contract says the same to anybody who tries
    expect(job.seats.find((seat) => seat.role === "lead")?.heldBy).toBeUndefined();
    const asALateLead = { address: pod$.jobs, publicClient: pod$.anvil.publicClient, wallet: pod$.anvil.wallet(named.lead.key) };
    await expect(takeSeat(asALateLead, pod$.onChainId, "lead", named.lead.address)).rejects.toThrow("LeadComesFirst");
    // and a seat that is nobody's to judge from is still taken, as the list says
    await takeSeat({ address: pod$.jobs, publicClient: pod$.anvil.publicClient, wallet: pod$.anvil.wallet(named.security.key) }, pod$.onChainId, "security", named.security.address);
  }, 120_000);
});
