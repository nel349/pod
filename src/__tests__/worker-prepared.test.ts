import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestClient, http, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { agentEmail, branchFor } from "../door/index.ts";
import { sealSpec, type Role, type Spec } from "../job.ts";
import { approve, readJob, readSeats, seatDeposit, takeSeat, type Contract } from "../jobs.ts";
import { checksDigest, podJobsV2Abi, readReport } from "../jobsV2.ts";
import { openJob } from "../publish.ts";
import { signReceipt, type SignedReceipt } from "../receipt.ts";
import { commitToBytes32, commitWork, openRepository } from "../repo.ts";
import { IMAGE } from "../sandbox.ts";
import { SEATS } from "../seal.ts";
import { JobStore, type JobRecord } from "../store.ts";
import { ApprovalSchema, PreparingStore } from "../preparing/index.ts";
import { sealWritten } from "../checkwriting/sealWritten.ts";
import type { Written } from "../checkwriting/index.ts";
import { specToTheWire } from "../specWire.ts";
import { mintPod, tokenOfJob } from "../token.ts";
import { Worker } from "../worker/index.ts";
import { ANVIL_KEYS, anvilAvailable, startAnvil, type Anvil } from "./support/anvil.ts";
import { COAT_IDEA, DRY, good, serverSaying, WET, WORKING } from "./support/coat.ts";
import { aPod, type Agent } from "./support/podServer.ts";
import { dockerAvailable } from "./support/tools.ts";

/**
 * The worker, on the contract that prepares jobs before a pod can start: a verdict says whether a
 * check the pod could see failed, which is what costs the seats that approved; a job it holds or cannot
 * grade is let go once; and a window that ends with nobody done is closed. Everything is real: the
 * contract on a local chain, the title contract, the grading boxes, the job's repository.
 */
const available = (await anvilAvailable()) && (await dockerAvailable());

const POSTER = ANVIL_KEYS[1];
const WRITER = ANVIL_KEYS[2];
const VALIDATOR = ANVIL_KEYS[6];
const PRICE = parseEther("1");
const WRITING = parseEther("0.05");
const HOUR = 3600n;
/** Says no coat in the rain: fails the check the pod could see */
const NEVER_A_COAT = serverSaying("false", "false");
/** Says take a coat whatever the weather: passes the visible check, fails the hidden one */
const ALWAYS_A_COAT = serverSaying("true", "true");
/** an image Docker refuses outright, so every grading fails on our side without asking any registry */
const NO_SUCH_IMAGE = "POD/NOT A VALID IMAGE";
/** the roles whose approval the policy asks for: the builder builds, and does not approve */
const APPROVERS: readonly Role[] = ["lead", "reviewer", "qa", "security"];

let anvil: Anvil;
/** the contract jobs were posted on before they were prepared first, which the worker still reads */
let earlierJobs: Address;
let jobs: Address;
let token: Address;
let store: JobStore;
let repositories: string;

const contractAs = (key: Hex): Contract => ({ address: jobs, publicClient: anvil.publicClient, wallet: anvil.wallet(key) });
const tokenAs = (key: Hex): Contract => ({ address: token, publicClient: anvil.publicClient, wallet: anvil.wallet(key) });
const balance = (address: Address) => anvil.publicClient.getBalance({ address });

beforeAll(async () => {
  if (!available) return;
  anvil = await startAnvil();
  const validator = privateKeyToAccount(VALIDATOR).address;
  earlierJobs = await anvil.deploy("PodJobs", [validator]);
  // an old contract's worth of numbers already given out, as on Monad: this one starts at 10
  jobs = await anvil.deploy("PodJobsV2", [validator, privateKeyToAccount(WRITER).address, 10n, WRITING, 100_000n]);
  token = await anvil.deploy("PodToken", [validator]);
  store = new JobStore(await mkdtemp(join(tmpdir(), "pod-prepared-jobs-")));
  repositories = await mkdtemp(join(tmpdir(), "pod-prepared-repositories-"));
}, 120_000);

afterAll(() => anvil?.stop());

interface MadeJob {
  readonly jobId: string;
  readonly onChainId: bigint;
  readonly pod: Readonly<Record<Role, Agent>>;
  readonly commit: string;
  readonly spec: Spec;
}

/**
 * A job paid for, its checks approved by its poster with the writer's signature, on the wall as the
 * worker leaves it on approval, a pod seated, the work on the lead's branch, and approved.
 */
async function aJob(jobId: string, work: string, options: { readonly approved?: boolean; readonly poster?: Hex } = {}): Promise<MadeJob> {
  const spec: Spec = {
    idea: COAT_IDEA, kind: "service", mode: "flash", price: PRICE,
    checks: [
      { says: WET, run: "node check-1.mjs", hidden: false, file: "check-1.mjs" },
      { says: DRY, run: "node check-2.mjs", hidden: true, file: "check-2.mjs" },
    ],
    allowed: [], salt: jobId,
  };
  const posterKey = options.poster ?? POSTER;
  const poster = contractAs(posterKey);
  const { request, result: onChainId } = await anvil.publicClient.simulateContract({
    address: jobs, abi: podJobsV2Abi, functionName: "post", args: [HOUR, 1], value: PRICE + 3n * WRITING, account: privateKeyToAccount(posterKey),
  });
  await anvil.publicClient.waitForTransactionReceipt({ hash: await poster.wallet.writeContract(request) });
  const seal = await sealSpec(spec);
  const writer = anvil.wallet(WRITER);
  const signature = await writer.signMessage({ account: writer.account, message: { raw: checksDigest({ jobs, chainId: 31337, jobId: onChainId, seal }) } });
  const opening = await anvil.publicClient.simulateContract({
    address: jobs, abi: podJobsV2Abi, functionName: "approveChecks", args: [onChainId, seal, signature], account: privateKeyToAccount(posterKey),
  });
  await anvil.publicClient.waitForTransactionReceipt({ hash: await poster.wallet.writeContract(opening.request) });

  const onChain = await readJob(poster, onChainId);
  const opened = await openJob(store, { jobId, seal, spec, endsAt: new Date(Number(onChain.endsAt) * 1000), seats: [] });
  await store.save({ ...opened, chain: { network: "monad-testnet", jobId: String(onChainId), jobs }, poster: privateKeyToAccount(posterKey).address }, {
    "check-1.mjs": good(0).check, "check-2.mjs": good(1).check,
  });
  await store.saveSpec(jobId, spec);

  const pod = aPod();
  for (const agent of Object.values(pod)) await anvil.fund(agent.address);
  for (const role of SEATS) await takeSeat(contractAs(pod[role].key), onChainId, role, pod[role].address);
  const commit = await onTheLeadsBranch(jobId, work, pod);
  if (options.approved !== false) await approveAll({ jobId, onChainId, pod, commit, spec });
  return { jobId, onChainId, pod, commit, spec };
}

async function approveAll(job: MadeJob): Promise<void> {
  for (const role of APPROVERS) await approve(contractAs(job.pod[role].key), job.onChainId, role, commitToBytes32(job.commit));
}

async function onTheLeadsBranch(jobId: string, work: string, pod: Readonly<Record<Role, Agent>>): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "pod-prepared-work-"));
  await writeFile(join(workspace, "server.js"), `${work}\n`);
  const repo = await openRepository(repositories, jobId);
  const commit = await commitWork(repo, { workspace, message: "the work", agent: "builder", email: agentEmail(pod.builder.address) });
  for (const role of ["builder", "lead"] as const) {
    const child = Bun.spawn(["git", "--git-dir", repo.path, "update-ref", `refs/heads/${branchFor(role, pod[role].address)}`, commit], { stdout: "ignore", stderr: "pipe" });
    if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text());
  }
  return commit;
}

function aWorker(said: string[], options: { readonly image?: string; readonly releaseAfterMs?: number; readonly preparing?: PreparingStore } = {}): Worker {
  return new Worker({
    ...(options.preparing ? { preparing: options.preparing } : {}),
    store, repositories, jobs: { address: earlierJobs, publicClient: anvil.publicClient, wallet: anvil.wallet(VALIDATOR) },
    prepared: contractAs(VALIDATOR), token: tokenAs(VALIDATOR),
    runnerKey: VALIDATOR, image: options.image ?? IMAGE, times: 2, gradeAgainAfterMs: 0,
    releaseAfterMs: options.releaseAfterMs ?? 0, say: (what) => said.push(what),
  });
}

async function until(worker: Worker, said: readonly string[], done: () => Promise<boolean>, seconds = 240): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    await worker.tick();
    await worker.whenIdle();
    if (await done()) return;
    await Bun.sleep(200);
  }
  throw new Error(`the worker never got there. It said:\n${said.join("\n")}`);
}

const stateOf = async (onChainId: bigint) => (await readJob(contractAs(VALIDATOR), onChainId)).state;
const recordOf = async (jobId: string): Promise<JobRecord> => {
  const record = await store.read(jobId);
  if (!record) throw new Error(`${jobId} is not on the wall`);
  return record;
};

/** A verdict whose runs disagreed, on the job's approved commit, as a grading leaves it. */
async function aHeldVerdict(job: MadeJob): Promise<void> {
  const signed: SignedReceipt = await signReceipt({
    version: "pod.receipt.v1", seal: (await recordOf(job.jobId)).seal, commit: job.commit, repository: "held",
    tree: `0x${"0".repeat(64)}`, image: IMAGE, start: "node server.js",
    checks: job.spec.checks.map((check) => ({ says: check.says, command: check.run, exitCode: 0, seconds: 1, hidden: check.hidden })),
    runs: 2, verdict: "not-reproducible", allowedHosts: [], undeclaredCalls: [],
    runner: privateKeyToAccount(VALIDATOR).address, finishedAt: new Date().toISOString(),
  }, VALIDATOR);
  const record = await recordOf(job.jobId);
  await store.save({ ...record, signed, tile: { ...record.tile, verdict: "not-reproducible" } });
}

/** Checks the writer wrote and proved, as a writing keeps them: the rain one visible, the dry one hidden. */
const PROVEN: Written[] = [
  { checkable: true, says: WET, secret: false, asks: "Asks while it is raining", expects: "Take a coat", nearMiss: "It never says take a coat",
    file: "check-1.mjs", source: good(0).check, proof: { working: true, nearMiss: true, nothing: true }, saw: { working: "", nearMiss: "", nothing: "" } },
  { checkable: true, says: DRY, secret: true, asks: "Asks while it is dry", expects: "No coat needed", nearMiss: "It always says take a coat",
    file: "check-2.mjs", source: good(1).check, proof: { working: true, nearMiss: true, nothing: true }, saw: { working: "", nearMiss: "", nothing: "" } },
];

/**
 * A job paid for and set up on the server, with one writing whose set the writer signed, kept in the
 * server's preparing folder as the server leaves it: what the worker publishes from on approval.
 */
async function aPreparedJob(preparing: PreparingStore, name: string): Promise<{ readonly onChainId: bigint; readonly seal: Hex; readonly signature: Hex }> {
  const poster = contractAs(POSTER);
  const { request, result: onChainId } = await anvil.publicClient.simulateContract({
    address: jobs, abi: podJobsV2Abi, functionName: "post", args: [HOUR, 1], value: PRICE + 3n * WRITING, account: privateKeyToAccount(POSTER),
  });
  await anvil.publicClient.waitForTransactionReceipt({ hash: await poster.wallet.writeContract(request) });
  const salt = "0123456789abcdef0123456789abcdef";
  const sealed = await sealWritten({ idea: COAT_IDEA, kind: "service", mode: "flash", price: PRICE, checks: PROVEN, salt });
  const writer = anvil.wallet(WRITER);
  const signature = await writer.signMessage({ account: writer.account, message: { raw: checksDigest({ jobs, chainId: 31337, jobId: onChainId, seal: sealed.seal }) } });
  await preparing.saveSetUp({ onChainId: `${onChainId}`, jobs, name, poster: privateKeyToAccount(POSTER).address, mode: "flash", salt, setUpAt: new Date().toISOString() });
  await preparing.saveWriting(`${onChainId}`, {
    number: 1, request: { idea: COAT_IDEA, kind: "service", statements: [{ says: WET, secret: false }, { says: DRY, secret: true }] },
    askedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), isCharged: true, isSettled: true,
    outcome: { kind: "written", checks: PROVEN, ready: true, approval: ApprovalSchema.parse({ spec: specToTheWire(sealed.spec), files: { ...sealed.files }, seal: sealed.seal, signature }) },
  });
  return { onChainId, seal: sealed.seal, signature };
}

async function posterApproves(onChainId: bigint, seal: Hex, signature: Hex): Promise<void> {
  const { request } = await anvil.publicClient.simulateContract({
    address: jobs, abi: podJobsV2Abi, functionName: "approveChecks", args: [onChainId, seal, signature], account: privateKeyToAccount(POSTER),
  });
  await anvil.publicClient.waitForTransactionReceipt({ hash: await contractAs(POSTER).wallet.writeContract(request) });
}

describe.skipIf(!available)("the worker, on the contract that prepares jobs", () => {
  test("a job is put on the wall when its poster approves its checks on the chain, from the set they approved, and only then", async () => {
    const said: string[] = [];
    const preparing = new PreparingStore(await mkdtemp(join(tmpdir(), "pod-prepared-preparing-")));
    const worker = aWorker(said, { preparing });
    const name = `prepared-on-approval-${crypto.randomUUID().slice(0, 6)}`;
    const { onChainId, seal, signature } = await aPreparedJob(preparing, name);

    // still preparing: nothing on the wall
    await worker.tick();
    expect(await store.read(name)).toBeUndefined();

    await posterApproves(onChainId, seal, signature);
    await worker.tick();
    const record = await recordOf(name);
    expect(record.seal).toBe(seal);
    expect(record.chain).toMatchObject({ jobId: `${onChainId}`, jobs });
    expect(record.tile.verdict).toBe("running");
    expect((await store.spec(name))?.checks.map((check) => check.hidden)).toEqual([false, true]);
    // the check the pod may see is served; the hidden one is not, until the verdict and the money
    expect(await store.checkNames(name)).toEqual(["check-1.mjs"]);

    // and looking again changes nothing
    await worker.tick();
    expect(said.filter((line) => line.includes(`${name}: its poster approved`))).toHaveLength(1);
  }, 120_000);

  test("a job taken back before any set was approved is never put on the wall", async () => {
    const said: string[] = [];
    const preparing = new PreparingStore(await mkdtemp(join(tmpdir(), "pod-prepared-preparing-")));
    const name = `prepared-taken-back-${crypto.randomUUID().slice(0, 6)}`;
    const { onChainId } = await aPreparedJob(preparing, name);
    const { request } = await anvil.publicClient.simulateContract({ address: jobs, abi: podJobsV2Abi, functionName: "takeBack", args: [onChainId], account: privateKeyToAccount(POSTER) });
    await anvil.publicClient.waitForTransactionReceipt({ hash: await contractAs(POSTER).wallet.writeContract(request) });
    await aWorker(said, { preparing }).tick();
    expect(await store.read(name)).toBeUndefined();
  }, 120_000);

  test("work that passes: the pod is paid, the verdict and its receipt are on the contract, and the title is recorded", async () => {
    const said: string[] = [];
    const job = await aJob("prepared-passes", WORKING);
    const worker = aWorker(said);
    await until(worker, said, async () => (await recordOf(job.jobId)).chain?.tokenId !== undefined);

    expect(await stateOf(job.onChainId)).toBe("settled");
    const record = await recordOf(job.jobId);
    const report = await readReport(contractAs(VALIDATOR), job.onChainId);
    expect(report.verdict).toBe("passed");
    expect(record.signed?.hash).toBe(report.receiptHash);
    expect(record.chain?.tokenId).toBe(`${await tokenOfJob(tokenAs(VALIDATOR), job.onChainId)}`);
  }, 300_000);

  test("a check the pod could see fails: the seats that approved lose their deposits to the poster, the builder's comes home", async () => {
    const said: string[] = [];
    const job = await aJob("prepared-visible-failure", NEVER_A_COAT);
    const reader = contractAs(VALIDATOR);
    const before = {
      poster: await balance(privateKeyToAccount(POSTER).address),
      lead: await balance(job.pod.lead.address), builder: await balance(job.pod.builder.address),
    };
    const leadDeposit = await seatDeposit(reader, job.onChainId, "lead");
    const builderDeposit = await seatDeposit(reader, job.onChainId, "builder");
    const forfeited = (await Promise.all(APPROVERS.map((role) => seatDeposit(reader, job.onChainId, role)))).reduce((a, b) => a + b, 0n);

    await until(aWorker(said), said, async () => (await stateOf(job.onChainId)) === "refunded");
    expect((await readReport(reader, job.onChainId)).verdict).toBe("visible-failed");
    expect(await balance(job.pod.lead.address)).toBe(before.lead);
    expect(leadDeposit).toBeGreaterThan(0n);
    expect(await balance(job.pod.builder.address)).toBe(before.builder + builderDeposit);
    expect(await balance(privateKeyToAccount(POSTER).address)).toBe(before.poster + PRICE + forfeited);
  }, 300_000);

  test("only a hidden check fails: every deposit comes home", async () => {
    const said: string[] = [];
    const job = await aJob("prepared-hidden-failure", ALWAYS_A_COAT);
    const leadBefore = await balance(job.pod.lead.address);
    const leadDeposit = await seatDeposit(contractAs(VALIDATOR), job.onChainId, "lead");
    await until(aWorker(said), said, async () => (await stateOf(job.onChainId)) === "refunded");
    expect((await readReport(contractAs(VALIDATOR), job.onChainId)).verdict).toBe("hidden-failed");
    expect(await balance(job.pod.lead.address)).toBe(leadBefore + leadDeposit);
  }, 300_000);

  test("work that never starts is a verdict failing every check, not a grading tried again for ever", async () => {
    const said: string[] = [];
    const job = await aJob("prepared-never-starts", `console.error("cannot start"); process.exit(3);`);
    await until(aWorker(said), said, async () => (await stateOf(job.onChainId)) === "refunded");
    const record = await recordOf(job.jobId);
    expect(record.signed?.receipt.verdict).toBe("failed");
    expect(record.signed?.receipt.checks.every((check) => check.exitCode !== 0)).toBe(true);
    expect((await readReport(contractAs(VALIDATOR), job.onChainId)).verdict).toBe("visible-failed");
  }, 300_000);

  test("runs that disagreed: the job is let go once and the same commit graded afresh; a second hold stands", async () => {
    const said: string[] = [];
    const job = await aJob("prepared-held", WORKING);
    await aHeldVerdict(job);
    const worker = aWorker(said);

    await until(worker, said, async () => (await recordOf(job.jobId)).tries?.released !== undefined, 60);
    const released = await recordOf(job.jobId);
    expect(released.signed).toBeUndefined();
    expect(released.tile.verdict).toBe("running");
    expect(released.tries?.heldBefore).toHaveLength(1);
    expect((await readJob(contractAs(VALIDATOR), job.onChainId)).commit).toBe(`0x${"0".repeat(64)}`);

    // the pod approves the same commit again: it is graded afresh, as a second hold, which stands
    await approveAll(job);
    await aHeldVerdict(job);
    await worker.tick();
    await worker.whenIdle();
    expect((await recordOf(job.jobId)).waitingBecause).toContain("the hold stands");
    expect(await stateOf(job.onChainId)).toBe("working");
    expect(said.filter((line) => line.includes("let go once"))).toHaveLength(1);
  }, 300_000);

  test("three gradings in a row failing on our side let the job go once, counted with the job across a restart", async () => {
    const said: string[] = [];
    const job = await aJob("prepared-docker-fails", WORKING);
    for (let attempt = 1; attempt <= 2; attempt++) {
      const worker = aWorker(said, { image: NO_SUCH_IMAGE });
      await worker.tick();
      await worker.whenIdle();
      expect((await recordOf(job.jobId)).tries?.failed).toBe(attempt);
    }
    // a worker started afresh remembers the two, and the third lets the job go
    const worker = aWorker(said, { image: NO_SUCH_IMAGE });
    await worker.tick();
    await worker.whenIdle();
    const record = await recordOf(job.jobId);
    expect(record.tries?.released?.why).toContain("3 gradings in a row failed on our side");
    expect((await readJob(contractAs(VALIDATOR), job.onChainId)).commit).toBe(`0x${"0".repeat(64)}`);
    // and never a second time
    await approveAll(job);
    for (let attempt = 0; attempt < 3; attempt++) {
      await worker.tick();
      await worker.whenIdle();
    }
    expect(said.filter((line) => line.includes("let go once"))).toHaveLength(1);
  }, 300_000);

  test("a window that ends with nobody done is closed: the poster's money and every deposit go home", async () => {
    const said: string[] = [];
    // its own poster, since moving the chain's clock ends the window of every job still open here
    const ownPoster = ANVIL_KEYS[3];
    const job = await aJob("prepared-window-ends", WORKING, { approved: false, poster: ownPoster });
    const posterBefore = await balance(privateKeyToAccount(ownPoster).address);
    const leadBefore = await balance(job.pod.lead.address);
    const leadDeposit = await seatDeposit(contractAs(VALIDATOR), job.onChainId, "lead");
    const clock = createTestClient({ mode: "anvil", transport: http(anvil.rpc) });
    await clock.increaseTime({ seconds: Number(HOUR) + 1 });
    await clock.mine({ blocks: 1 });

    await until(aWorker(said), said, async () => (await stateOf(job.onChainId)) === "refunded", 60);
    expect(await balance(privateKeyToAccount(ownPoster).address)).toBe(posterBefore + PRICE);
    expect(await balance(job.pod.lead.address)).toBe(leadBefore + leadDeposit);
    const record = await recordOf(job.jobId);
    expect(record.tile.verdict).toBe("withdrawn");
    expect(record.endedBecause).toContain("window closed with no verdict");
  }, 120_000);

  test("a title minted for this job's number under another seal is not recorded as this job's", async () => {
    const said: string[] = [];
    const job = await aJob("prepared-other-title", WORKING);
    // a title already there for this number, from another job sealed otherwise
    await mintPod(tokenAs(VALIDATOR), {
      jobs: contractAs(VALIDATOR), jobId: job.onChainId, seal: `0x${"ab".repeat(32)}`, commit: commitToBytes32(job.commit),
      receiptHash: `0x${"cd".repeat(32)}`, crew: [], uri: "elsewhere",
    });
    await until(aWorker(said), said, async () => (await recordOf(job.jobId)).waitingBecause?.includes("under another seal") === true);
    expect((await recordOf(job.jobId)).chain?.tokenId).toBeUndefined();
    expect((await readSeats(contractAs(VALIDATOR), job.onChainId)).length).toBe(5);
  }, 300_000);
});
