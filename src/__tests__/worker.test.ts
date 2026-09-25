import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEther, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { agentEmail, branchFor } from "../door/index.ts";
import { sealSpec, type Role, type Spec } from "../job.ts";
import { approve, post, readJob, takeSeat } from "../jobs.ts";
import { openJob } from "../publish.ts";
import { commitToBytes32, commitWork, head, openRepository } from "../repo.ts";
import { record, registerAgent, requestValidation, verdictOnChain, type Registries } from "../registry.ts";
import { receiptPath } from "../routes.ts";
import { IMAGE } from "../sandbox.ts";
import { JobStore } from "../store.ts";
import { podTokenAbi, tokenOfJob } from "../token.ts";
import { Worker } from "../worker/index.ts";
import { ANVIL_KEYS, anvilAvailable, startAnvil, type Anvil } from "./support/anvil.ts";
import { COAT_IDEA, dockerAvailable, DRY, good, serverSaying, WET, WORKING } from "./support/coat.ts";
import { aPod, type Agent } from "./support/podServer.ts";
import { deployRegistries } from "./support/registries.ts";

/**
 * The worker, against a real chain, a real token and real grading.
 *
 * The pods here are made by hand, straight onto the contract and into the repository, so what is
 * under test is only the worker: that it grades what the chain says is ready and nothing else, that
 * the money moves the way the verdict says, once, that a worker that dies half way is picked up by
 * the next one without anybody being paid twice, and that each agent that asks has its verdict
 * recorded in ERC-8004, on the ERC-8004 team's own registries, deployed here.
 */

const available = (await anvilAvailable()) && (await dockerAvailable());

let anvil: Anvil;
let jobs: Address;
let token: Address;
let store: JobStore;
let repositories: string;
let registries: Registries;
/** where the workers here keep how far they have read the registry: shared, as a restarted worker's would be */
let workerState: string;

const POSTER = ANVIL_KEYS[1];
const POSTER_ADDRESS = privateKeyToAccount(POSTER).address;
const VALIDATOR = ANVIL_KEYS[6];
const NOT_THE_VALIDATOR = ANVIL_KEYS[5];
const PRICE = parseEther("1");

const SPEC: Spec = {
  idea: COAT_IDEA, kind: "service", mode: "flash", price: PRICE,
  checks: [
    { says: WET, run: "node check-1.mjs", hidden: false, file: "check-1.mjs" },
    { says: DRY, run: "node check-2.mjs", hidden: true, file: "check-2.mjs" },
  ],
  allowed: [], salt: "a-number-nobody-can-guess",
};

/** Passes the visible check and fails the sealed one: work built to the brief and not to the idea */
const ALWAYS_A_COAT = serverSaying("true", "true");

const contractAs = (key: Hex) => ({ address: jobs, publicClient: anvil.publicClient, wallet: anvil.wallet(key) });
const tokenAs = (key: Hex) => ({ address: token, publicClient: anvil.publicClient, wallet: anvil.wallet(key) });
const reading = () => ({ address: jobs, publicClient: anvil.publicClient });

beforeAll(async () => {
  if (!available) return;
  anvil = await startAnvil();
  const validator = privateKeyToAccount(VALIDATOR).address;
  jobs = await anvil.deploy("PodJobs", [validator]);
  token = await anvil.deploy("PodToken", [validator]);
  store = new JobStore(await mkdtemp(join(tmpdir(), "pod-worker-jobs-")));
  repositories = await mkdtemp(join(tmpdir(), "pod-worker-repositories-"));
  registries = await deployRegistries(anvil);
  workerState = await mkdtemp(join(tmpdir(), "pod-worker-state-"));
}, 120_000);

afterAll(() => anvil?.stop());

interface MadeJob {
  readonly jobId: string;
  readonly onChainId: bigint;
  readonly pod: Readonly<Record<Role, Agent>>;
  readonly commit: string;
}

async function fundAgent(agent: Agent): Promise<void> {
  const payer = anvil.wallet(ANVIL_KEYS[0]);
  await anvil.publicClient.waitForTransactionReceipt({
    hash: await payer.sendTransaction({ to: agent.address, value: parseEther("10"), account: payer.account!, chain: payer.chain }),
  });
}

/**
 * A job posted, a pod seated, the work committed into the job's repository by the builder, and
 * approvals given by whichever seats are named. `pushed: false` approves a commit that is not there.
 */
async function aJob(jobId: string, work: string, approving: readonly Role[], pushed = true): Promise<MadeJob> {
  const pod = aPod();
  for (const agent of Object.values(pod)) await fundAgent(agent);
  const now = (await anvil.publicClient.getBlock()).timestamp;
  const seal = await sealSpec(SPEC);
  const onChainId = await post(contractAs(POSTER), { seal, endsAt: now + 3600n, reviewers: 1, price: PRICE });
  const opened = await openJob(store, { jobId, seal, spec: SPEC, endsAt: new Date(Number(now + 3600n) * 1000), seats: [] });
  await store.save({ ...opened, chain: { network: "monad-testnet", jobId: String(onChainId), jobs } }, {
    "check-1.mjs": good(0).check, "check-2.mjs": good(1).check,
  });
  await store.saveSpec(jobId, SPEC);
  for (const [role, agent] of Object.entries(pod) as [Role, Agent][]) await takeSeat(contractAs(agent.key), onChainId, role, agent.address);

  const workspace = await mkdtemp(join(tmpdir(), "pod-worker-work-"));
  await writeFile(join(workspace, "server.js"), `${work}\n`);
  const commit = pushed ? await onTheBuildersBranch(jobId, workspace, pod.builder.address) : "ab".repeat(20);
  for (const role of approving) await approve(contractAs(pod[role].key), onChainId, role, commitToBytes32(commit));
  return { jobId, onChainId, pod, commit };
}

/**
 * Commit the work where a builder would have pushed it, its own branch, and leave main empty: main is
 * the worker's alone to write, which is part of what is under test.
 */
async function onTheBuildersBranch(jobId: string, workspace: string, builder: Address): Promise<string> {
  const repo = await openRepository(repositories, jobId);
  const commit = await commitWork(repo, { workspace, message: "the work", agent: "builder", email: agentEmail(builder) });
  const git = async (args: readonly string[]): Promise<void> => {
    const child = Bun.spawn(["git", "--git-dir", repo.path, ...args], { stdout: "ignore", stderr: "pipe" });
    if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text());
  };
  await git(["update-ref", `refs/heads/${branchFor("builder", builder)}`, commit]);
  await git(["update-ref", "-d", "refs/heads/main"]);
  return commit;
}

const EVERY_SEAT: readonly Role[] = ["lead", "builder", "reviewer", "qa", "security"];

function aWorker(jobsKey: Hex = VALIDATOR, said: string[] = []): Worker {
  return new Worker({
    store, repositories, jobs: contractAs(jobsKey), token: tokenAs(VALIDATOR), runnerKey: VALIDATOR, image: IMAGE, times: 2,
    site: SITE, registry: { registries, stateFolder: workerState },
    say: (what) => said.push(what),
  });
}

/** Look, and let what the look started finish, until nothing more changes or the time is up. */
async function untilSettled(worker: Worker, done: () => Promise<boolean>, seconds = 180): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    await worker.tick();
    await worker.whenIdle();
    if (await done()) return;
  }
  throw new Error("the worker never finished");
}

const balance = (address: Address) => anvil.publicClient.getBalance({ address });

const SITE = "http://pod.test";
const sender = (key: Hex) => ({ publicClient: anvil.publicClient, wallet: anvil.wallet(key) });

/** An agent's own identity in the registry, registered with its own key, so the key owns it. */
async function anIdentity(agent: Agent): Promise<bigint> {
  return (await registerAgent(sender(agent.key), registries)).agentId;
}

/** What an agent sends to have its verdict recorded: its own request, naming the validator, pointing at the receipt. */
async function asksForItsVerdict(agent: Agent, agentId: bigint, jobId: string, key: Hex = toHex(crypto.getRandomValues(new Uint8Array(32)))): Promise<Hex> {
  await requestValidation(sender(agent.key), {
    runner: privateKeyToAccount(VALIDATOR).address, agentId, evidenceURI: `${SITE}${receiptPath(jobId)}`, key,
  }, registries);
  return key;
}

const answerTo = (key: Hex) => verdictOnChain(anvil.publicClient, key, registries);

describe.skipIf(!available)("the worker", () => {
  test("several jobs at once: each is graded, published and settled its own way, and only work that passed is titled and put on main", async () => {
    const passing = await aJob("a-coat-when-it-rains", WORKING, EVERY_SEAT);
    const failing = await aJob("a-coat-whatever-the-weather", ALWAYS_A_COAT, EVERY_SEAT);
    const builderBefore = await balance(passing.pod.builder.address);
    const posterBefore = await balance(POSTER_ADDRESS);

    const worker = aWorker();
    await untilSettled(worker, async () =>
      (await readJob(reading(), passing.onChainId)).state === "settled"
      && (await readJob(reading(), failing.onChainId)).state === "refunded"
      && (await tokenOfJob(tokenAs(VALIDATOR), passing.onChainId)) !== 0n
      && (await head(await openRepository(repositories, passing.jobId))) === passing.commit);

    // the one that passed: its evidence is published, the pod is paid, the title is the poster's, and main is the work
    const passed = (await store.read(passing.jobId))!;
    expect(passed.tile.verdict).toBe("passed");
    expect(passed.signed?.receipt.commit).toBe(passing.commit);
    expect(passed.chain?.settled).toMatch(/^0x[0-9a-f]{64}$/);
    expect(passed.approvals.map((approval) => approval.role).sort()).toEqual([...EVERY_SEAT].sort());
    expect(await store.checkNames(passing.jobId)).toEqual(["check-1.mjs", "check-2.mjs"]);
    expect(await balance(passing.pod.builder.address)).toBeGreaterThan(builderBefore);
    const tokenId = await tokenOfJob(tokenAs(VALIDATOR), passing.onChainId);
    expect(passed.chain?.tokenId).toBe(tokenId.toString());
    expect(await anvil.publicClient.readContract({ address: token, abi: podTokenAbi, functionName: "ownerOf", args: [tokenId] })).toBe(POSTER_ADDRESS);

    // the one that failed the exam: refunded, no title, and nothing on main
    const failed = (await store.read(failing.jobId))!;
    expect(failed.tile.verdict).toBe("failed");
    expect(failed.checksSaid.find((check) => check.says === DRY)?.exitCode).not.toBe(0);
    expect(await balance(POSTER_ADDRESS)).toBe(posterBefore + PRICE);
    expect(await tokenOfJob(tokenAs(VALIDATOR), failing.onChainId)).toBe(0n);
    expect(await head(await openRepository(repositories, failing.jobId))).toBeUndefined();
    expect((await store.read(failing.jobId))!.chain?.minted).toBeUndefined();
  }, 300_000);

  test("each agent that asks has the verdict on its seat recorded in ERC-8004, once, and nobody else does", async () => {
    const job = await aJob("a-coat-with-a-record", WORKING, EVERY_SEAT);
    const builderId = await anIdentity(job.pod.builder);
    const reviewerId = await anIdentity(job.pod.reviewer);
    const stranger = aPod().builder;
    await fundAgent(stranger);
    const strangerId = await anIdentity(stranger);

    // the builder asks before there is a verdict; it is held, and answered once there is one
    const early = await asksForItsVerdict(job.pod.builder, builderId, job.jobId);
    const first: string[] = [];
    const worker = aWorker(VALIDATOR, first);
    await worker.tick();
    expect((await answerTo(early)).responseHash).toBe(`0x${"0".repeat(64)}`);
    await untilSettled(worker, async () => (await answerTo(early)).response === 100);
    const answered = await answerTo(early);
    expect(answered.tag).toBe("pod.builder");
    expect(answered.responseHash).toBe((await store.read(job.jobId))!.signed!.hash);
    expect(await record(anvil.publicClient, builderId, "pod.builder", [privateKeyToAccount(VALIDATOR).address], registries)).toEqual({ count: 1, average: 100 });

    // an identity with no seat on the job asks too, and nothing is recorded for it
    const uninvited = await asksForItsVerdict(stranger, strangerId, job.jobId);
    await worker.tick();
    expect((await answerTo(uninvited)).responseHash).toBe(`0x${"0".repeat(64)}`);
    expect(first.some((line) => line.includes(`#${strangerId}`) && line.includes("holds no seat"))).toBe(true);

    // the reviewer asks while no worker is running; the next one, reading on from where the last stopped, answers it
    const whileDown = await asksForItsVerdict(job.pod.reviewer, reviewerId, job.jobId);
    const second: string[] = [];
    const next = aWorker(VALIDATOR, second);
    await next.tick();
    expect((await answerTo(whileDown)).tag).toBe("pod.reviewer");
    // and nothing it had already answered is answered again
    expect(second.filter((line) => line.startsWith("[worker] recorded "))).toEqual([`[worker] recorded passed for agent #${reviewerId}, the reviewer on ${job.jobId}`]);

    // a worker that has lost its place reads every request again from the start, and answers none twice
    await writeFile(join(workerState, "registry.json"), JSON.stringify({ readTo: "0", holding: [] }));
    const third: string[] = [];
    await aWorker(VALIDATOR, third).tick();
    expect(third.filter((line) => line.startsWith("[worker] recorded "))).toEqual([]);
  }, 300_000);

  test("a job that failed is recorded as a failure, under the seat's role", async () => {
    const job = await aJob("a-coat-recorded-as-failed", ALWAYS_A_COAT, EVERY_SEAT);
    const qaId = await anIdentity(job.pod.qa);
    const worker = aWorker();
    await untilSettled(worker, async () => (await readJob(reading(), job.onChainId)).state === "refunded");
    const key = await asksForItsVerdict(job.pod.qa, qaId, job.jobId);
    await worker.tick();
    const answered = await answerTo(key);
    expect(answered.tag).toBe("pod.qa");
    expect(answered.response).toBe(0);
    expect(answered.responseHash).not.toBe(`0x${"0".repeat(64)}`);
  }, 300_000);

  test("a pod that has not met the policy is not graded", async () => {
    const early = await aJob("a-coat-not-yet-agreed", WORKING, ["lead", "builder", "reviewer", "qa"]);
    const worker = aWorker();
    await worker.tick();
    await worker.whenIdle();
    const record = (await store.read(early.jobId))!;
    expect(record.tile.verdict).toBe("running");
    expect(record.signed).toBeUndefined();
  }, 120_000);

  test("a commit approved but never pushed is not graded, and the record says why", async () => {
    const phantom = await aJob("a-coat-nobody-pushed", WORKING, EVERY_SEAT, false);
    const worker = aWorker();
    await worker.tick();
    await worker.whenIdle();
    const record = (await store.read(phantom.jobId))!;
    expect(record.signed).toBeUndefined();
    expect(record.waitingBecause).toContain(`${phantom.commit}, which was never pushed`);
  }, 120_000);

  test("a worker that dies after grading is picked up by the next, and nothing is paid or minted twice", async () => {
    const interrupted = await aJob("a-coat-interrupted", WORKING, EVERY_SEAT);

    // this one grades and publishes, and cannot settle: its key is not the one the contract answers to
    const first: string[] = [];
    const dying = aWorker(NOT_THE_VALIDATOR, first);
    await dying.tick();
    await dying.whenIdle();
    await dying.tick();
    const graded = (await store.read(interrupted.jobId))!;
    expect(graded.tile.verdict).toBe("passed");
    expect(graded.chain?.settled).toBeUndefined();
    expect((await readJob(reading(), interrupted.onChainId)).state).toBe("working");

    // the next one finishes the job without grading it again, even looking twice at the same moment
    const second: string[] = [];
    const next = aWorker(VALIDATOR, second);
    await Promise.all([next.tick(), next.tick()]);
    await untilSettled(next, async () => (await tokenOfJob(tokenAs(VALIDATOR), interrupted.onChainId)) !== 0n);
    expect(second.some((line) => line.includes("grading"))).toBe(false);
    expect(second.filter((line) => line.includes("settled"))).toHaveLength(1);
    expect(second.filter((line) => line.includes("minted"))).toHaveLength(1);
    expect(second.filter((line) => !/settled|minted/.test(line))).toEqual([]);
    const finished = (await store.read(interrupted.jobId))!;
    expect(finished.signed?.hash).toBe(graded.signed?.hash);

    // a worker that died between minting and writing it down: the chain knows, the record does not
    const { minted: _minted, tokenId: _tokenId, ...forgotten } = finished.chain!;
    await store.save({ ...finished, chain: forgotten });
    const leadAfter = await balance(interrupted.pod.lead.address);
    const tokenAfter = await tokenOfJob(tokenAs(VALIDATOR), interrupted.onChainId);
    const third: string[] = [];
    const again = aWorker(VALIDATOR, third);
    await again.tick();
    await again.whenIdle();
    await again.tick();
    // it reads the chain rather than the record: nothing is paid or minted again, and the title is remembered
    expect(third).toEqual([]);
    expect(await balance(interrupted.pod.lead.address)).toBe(leadAfter);
    expect(await tokenOfJob(tokenAs(VALIDATOR), interrupted.onChainId)).toBe(tokenAfter);
    expect((await store.read(interrupted.jobId))!.chain?.tokenId).toBe(tokenAfter.toString());
  }, 300_000);
});
