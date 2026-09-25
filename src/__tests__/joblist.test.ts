import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { doorChainFor, Doorkeeper, JOB_LIST_VERSION, JobList, JobListingSchema, LIST_FRESH_FOR_MS, type JobListing, type ListedJob } from "../door/index.ts";
import { sealSpec, type Role, type Spec } from "../job.ts";
import { podJobsAbi, post, readJob, readSeats, readTerms, seatDeposit, seatPay, takeSeat } from "../jobs.ts";
import { openJob } from "../publish.ts";
import { checksPath, ROUTES } from "../routes.ts";
import { serve } from "../server.ts";
import { JobStore } from "../store.ts";
import { ANVIL_KEYS, anvilAvailable, startAnvil, type Anvil } from "./support/anvil.ts";

/**
 * Where an outside agent finds work, and what it can rely on there.
 *
 * The agent here uses only what any agent has: the list, the checks it points to, and the contract,
 * with its own key. Nothing of ours sits between it and its transaction. And the exam never appears,
 * in the list or anywhere the list points.
 */

const available = await anvilAvailable();

let anvil: Anvil;
let jobs: Address;
let store: JobStore;
let base = "";
let server: { stop: () => void } | undefined;

const POSTER = ANVIL_KEYS[1];
const PRICE = parseEther("1");

/** words that are only in the exam, so finding them anywhere public is finding the exam */
const EXAM_SAYS = "When it is dry, it says the umbrella can stay at home";
const EXAM_PROGRAM = "// the sealed check: it asks while it is dry, and wants no coat";
const VISIBLE_SAYS = "When it is raining, it says to take a coat";
const VISIBLE_PROGRAM = "// the visible check: it asks while it is raining, and wants a coat";

const SPEC: Spec = {
  idea: "A service that says whether to take a coat", kind: "service", mode: "flash", price: PRICE,
  checks: [
    { says: VISIBLE_SAYS, run: "node check-1.mjs", hidden: false, file: "check-1.mjs" },
    { says: EXAM_SAYS, run: "node check-2.mjs", hidden: true, file: "check-2.mjs" },
  ],
  allowed: [], salt: "a-number-nobody-can-guess",
};

interface Agent {
  readonly key: Hex;
  readonly address: Address;
}

function anAgent(): Agent {
  const key = generatePrivateKey();
  return { key, address: privateKeyToAccount(key).address };
}

const finder = anAgent();

const contractAs = (key: Hex) => ({ address: jobs, publicClient: anvil.publicClient, wallet: anvil.wallet(key) });
const reading = () => ({ address: jobs, publicClient: anvil.publicClient });

async function fund(to: Address): Promise<void> {
  const payer = anvil.wallet(ANVIL_KEYS[0]);
  await anvil.publicClient.waitForTransactionReceipt({
    hash: await payer.sendTransaction({ to, value: parseEther("10"), account: payer.account!, chain: payer.chain }),
  });
}

/** A job posted, paid for and published the way the posting page leaves one: record, check files and spec. */
async function aPostedJob(jobId: string, reviewers = 1): Promise<bigint> {
  const now = (await anvil.publicClient.getBlock()).timestamp;
  const seal = await sealSpec(SPEC);
  const onChainId = await post(contractAs(POSTER), { seal, endsAt: now + 3600n, reviewers, price: PRICE });
  const opened = await openJob(store, { jobId, seal, spec: SPEC, endsAt: new Date(Number(now + 3600n) * 1000), seats: [] });
  await store.save({ ...opened, chain: { network: "monad-testnet", jobId: String(onChainId), jobs } }, {
    "check-1.mjs": VISIBLE_PROGRAM, "check-2.mjs": EXAM_PROGRAM,
  });
  await store.saveSpec(jobId, SPEC);
  return onChainId;
}

beforeAll(async () => {
  if (!available) return;
  anvil = await startAnvil();
  jobs = await anvil.deploy("PodJobs", [privateKeyToAccount(ANVIL_KEYS[6]).address]);
  await fund(finder.address);
  store = new JobStore(await mkdtemp(join(tmpdir(), "pod-joblist-")));
  const keeper = new Doorkeeper({
    store,
    chain: doorChainFor({
      jobs,
      readJob: (id) => readJob(reading(), id),
      readSeats: (id) => readSeats(reading(), id),
      readTerms: (id) => readTerms(reading(), id),
      latestBlockTime: async () => (await anvil.publicClient.getBlock()).timestamp,
    }),
  });
  const serving = serve(store, 0, { jobList: new JobList({ keeper, store }) });
  server = serving;
  base = `http://127.0.0.1:${serving.port}`;
}, 120_000);

afterAll(() => {
  server?.stop();
  anvil?.stop();
});

async function theList(): Promise<JobListing> {
  const answer = await fetch(`${base}${ROUTES.jobList}`);
  expect(answer.status).toBe(200);
  return (await answer.json()) as JobListing;
}

async function listed(jobId: string): Promise<ListedJob | undefined> {
  return (await theList()).jobs.find((job) => job.jobId === jobId);
}

/**
 * The job as the list shows it once it shows what is wanted. The list is served from a copy up to
 * LIST_FRESH_FOR_MS old, so a seat taken a moment ago shows a moment later, which is what an agent sees.
 */
async function listedOnce(jobId: string, shows: (job: ListedJob | undefined) => boolean): Promise<ListedJob | undefined> {
  const deadline = Date.now() + LIST_FRESH_FOR_MS * 5;
  let job = await listed(jobId);
  while (!shows(job) && Date.now() < deadline) {
    await Bun.sleep(LIST_FRESH_FOR_MS / 4);
    job = await listed(jobId);
  }
  return job;
}

describe.skipIf(!available)("the job list, as an outside agent reads it", () => {
  test("an open job is there, with what each seat pays and costs read from the contract", async () => {
    const onChainId = await aPostedJob("a-coat-given-the-rain");
    const listing = await theList();
    // what the server writes is what an agent reading it through the schema will accept
    expect(JobListingSchema.safeParse(listing).success).toBe(true);
    expect(listing.version).toBe(JOB_LIST_VERSION);
    expect(listing.guide).toBe(ROUTES.guide);
    expect(listing.market).toBe(ROUTES.market);

    const job = listing.jobs.find((one) => one.jobId === "a-coat-given-the-rain")!;
    expect(job.contract).toEqual({ address: jobs, jobId: onChainId.toString() });
    expect(job.price).toBe(PRICE.toString());
    expect(job.idea).toBe(SPEC.idea);
    expect(job.visibleChecks).toEqual([{ says: VISIBLE_SAYS, run: "node check-1.mjs", file: "check-1.mjs", url: `${checksPath("a-coat-given-the-rain")}/check-1.mjs` }]);
    expect(job.sealedChecks).toBe(1);
    expect(job.allowedHosts).toEqual([]);

    for (const role of ["lead", "builder", "reviewer", "qa", "security"] as const satisfies readonly Role[]) {
      const seat = job.seats.find((one) => one.role === role)!;
      expect(seat.pay).toBe((await seatPay(reading(), onChainId, role)).toString());
      expect(seat.deposit).toBe((await seatDeposit(reading(), onChainId, role)).toString());
      expect(seat.heldBy).toBeUndefined();
    }
    expect(job.free).toEqual(["lead", "builder", "reviewer", "qa", "security"]);
    expect(job.owners).toEqual([]);
  }, 60_000);

  test("an agent takes a seat with its own key, using only what the list says, and the list then shows it held", async () => {
    const job = (await listed("a-coat-given-the-rain"))!;
    const seat = job.seats.find((one) => one.role === "builder" && !one.heldBy)!;
    const before = await anvil.publicClient.getBalance({ address: jobs });

    await takeSeat(contractAs(finder.key), BigInt(job.contract.jobId), seat.role, finder.address);

    expect(await anvil.publicClient.getBalance({ address: jobs })).toBe(before + BigInt(seat.deposit));
    const after = (await listedOnce("a-coat-given-the-rain", (job) => job?.owners.length === 1))!;
    expect(after.seats.find((one) => one.role === "builder")!.heldBy).toEqual({ agent: finder.address, owner: finder.address });
    expect(after.owners).toEqual([finder.address]);
    expect(after.free).not.toContain("builder");
  }, 60_000);

  test("an owner already in a pod can see so before spending anything, and the contract would refuse it anyway", async () => {
    const job = (await listed("a-coat-given-the-rain"))!;
    expect(job.owners).toContain(finder.address);
    // what the list saves the agent from: a transaction the contract reverts
    await expect(takeSeat(contractAs(finder.key), BigInt(job.contract.jobId), "qa", finder.address)).rejects.toThrow("OwnerAlreadySeated");
  }, 60_000);

  test("a job with two reviewer seats lists two", async () => {
    await aPostedJob("an-umbrella-with-two-reviewers", 2);
    const job = (await listedOnce("an-umbrella-with-two-reviewers", (found) => found !== undefined))!;
    expect(job.seats.filter((seat) => seat.role === "reviewer")).toHaveLength(2);
    expect(job.seats).toHaveLength(6);
  }, 60_000);

  test("the exam is nowhere in the list, and nowhere the list points", async () => {
    const everything = JSON.stringify(await theList());
    expect(everything).toContain(VISIBLE_SAYS);
    expect(everything).not.toContain(EXAM_SAYS);
    expect(everything).not.toContain("check-2.mjs");

    const index = await (await fetch(`${base}${checksPath("a-coat-given-the-rain")}`)).text();
    expect(index).toContain("check-1.mjs");
    expect(index).not.toContain("check-2.mjs");
    expect(await (await fetch(`${base}${checksPath("a-coat-given-the-rain")}/check-1.mjs`)).text()).toBe(VISIBLE_PROGRAM);
    const exam = await fetch(`${base}${checksPath("a-coat-given-the-rain")}/check-2.mjs`);
    expect(exam.status).toBe(404);
    expect(await exam.text()).not.toContain(EXAM_PROGRAM);
  }, 60_000);

  test("every refusal the contract can make is one an agent reads by name", async () => {
    const built = await Bun.file(new URL("../../contracts/out/PodJobs.sol/PodJobs.json", import.meta.url)).json() as { abi: { type: string; name: string }[] };
    const theContracts = built.abi.filter((entry) => entry.type === "error").map((entry) => entry.name).sort();
    const ours: string[] = podJobsAbi.filter((entry) => entry.type === "error").map((entry) => entry.name).sort();
    expect(theContracts.length).toBeGreaterThan(0);
    expect(ours).toEqual(theContracts);
  });

  test("however often anybody asks, the chain is read once every little while, not once an ask", async () => {
    let reads = 0;
    const counting = new Doorkeeper({
      store,
      chain: doorChainFor({
        jobs,
        readJob: (id) => { reads++; return readJob(reading(), id); },
        readSeats: (id) => readSeats(reading(), id),
        readTerms: (id) => readTerms(reading(), id),
        latestBlockTime: async () => (await anvil.publicClient.getBlock()).timestamp,
      }),
    });
    const list = new JobList({ keeper: counting, store });
    await list.handle();
    const once = reads;
    expect(once).toBeGreaterThan(0);
    await Promise.all(Array.from({ length: 20 }, () => list.handle()));
    expect(reads).toBe(once);
  }, 60_000);

  test("a knock from a key nobody has seen is not a read of the chain each time", async () => {
    let seatReads = 0;
    const chain = doorChainFor({
      jobs,
      readJob: (id) => readJob(reading(), id),
      readSeats: (id) => { seatReads++; return readSeats(reading(), id); },
      readTerms: (id) => readTerms(reading(), id),
      latestBlockTime: async () => (await anvil.publicClient.getBlock()).timestamp,
    });
    const keeper = new Doorkeeper({ store, chain });
    const job = await keeper.job("a-coat-given-the-rain");
    if (!job.ok) throw new Error(job.why);
    for (let i = 0; i < 20; i++) expect(await keeper.notSeated(anAgent().address, "builder", job.value.onChainId)).toContain("holds no seat");
    expect(seatReads).toBe(1);
  }, 60_000);

  // last, because it moves the chain's clock past every job's window
  test("a job whose window has closed is no longer listed", async () => {
    const job = await readJob(reading(), BigInt((await listed("a-coat-given-the-rain"))!.contract.jobId));
    const now = (await anvil.publicClient.getBlock()).timestamp;
    await anvil.publicClient.request({ method: "evm_increaseTime" as never, params: [Number(job.endsAt - now) + 1] as never });
    await anvil.publicClient.request({ method: "evm_mine" as never, params: [] as never });
    expect(await listedOnce("a-coat-given-the-rain", (job) => job === undefined)).toBeUndefined();
  }, 60_000);
});
