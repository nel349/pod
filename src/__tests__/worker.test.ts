import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEther, toHex, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { agentEmail, branchFor } from "../door/index.ts";
import { sealSpec, type Role, type Spec } from "../job.ts";
import { approve, MOST_BLOCKS_A_LOG_READ_COVERS, post, readJob, takeSeat } from "../jobs.ts";
import { openJob } from "../publish.ts";
import { commitToBytes32, commitWork, head, openRepository } from "../repo.ts";
import { record, registerAgent, requestValidation, verdictOnChain, type Registries } from "../registry.ts";
import { receiptPath } from "../routes.ts";
import { IMAGE } from "../sandbox.ts";
import { SEATS } from "../seal.ts";
import { JobStore } from "../store.ts";
import { podTokenAbi, tokenOfJob } from "../token.ts";
import { Worker } from "../worker/index.ts";
import { ANVIL_KEYS, anvilAvailable, startAnvil, type Anvil } from "./support/anvil.ts";
import { COAT_IDEA, dockerAvailable, DRY, good, serverSaying, WET, WORKING } from "./support/coat.ts";
import { aPod, anAgent, type Agent } from "./support/podServer.ts";
import { deployRegistries } from "./support/registries.ts";

/**
 * The worker, against a real chain, a real token and real grading.
 *
 * The pods here are made by hand, straight onto the contract and into the repository, so what is
 * under test is only the worker: that it grades what the chain says is ready and nothing else, that
 * the money moves the way the verdict says, once, that a worker that dies half way is picked up by
 * the next one without anybody being paid twice, and that each agent that asks has its verdict
 * recorded in ERC-8004, on the ERC-8004 team's own registries, deployed here.
 *
 * The worker reads the chain through a client that refuses what Monad's public node refuses: a
 * reading of events more than a hundred blocks wide. A local chain allows anything, and a worker
 * tested only against that was one that could never grade a job on Monad.
 */

const available = (await anvilAvailable()) && (await dockerAvailable());

let anvil: Anvil;
let jobs: Address;
let token: Address;
let store: JobStore;
/** the folder the store keeps its jobs in, which a test reaches into to break a job on purpose */
let storeFolder: string;
let repositories: string;
let registries: Registries;
/** where the workers here keep how far they have read the registry: shared, as a restarted worker's would be */
let workerState: string;
/** the chain as the worker reads it: Monad's limits, and a count of what it asked about each job */
let monad: PublicClient;
const jobReads: bigint[] = [];

const POSTER = ANVIL_KEYS[1];
const POSTER_ADDRESS = privateKeyToAccount(POSTER).address;
const VALIDATOR = ANVIL_KEYS[6];
const NOT_THE_VALIDATOR = ANVIL_KEYS[5];
const PRICE = parseEther("1");
const SITE = "http://pod.test";
const NOTHING: Hex = `0x${"0".repeat(64)}`;

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

/**
 * The chain as Monad's public node serves it: a reading of events more than a hundred blocks wide is
 * refused, as Monad refuses it. And every read of a job is counted, so a test can see which were made.
 */
function likeMonad(client: PublicClient): PublicClient {
  return new Proxy(client, {
    get(target, name, receiver) {
      if (name === "getContractEvents" || name === "getLogs") {
        return (args: { fromBlock?: unknown; toBlock?: unknown }) => {
          if (typeof args.fromBlock !== "bigint" || typeof args.toBlock !== "bigint" || args.toBlock - args.fromBlock >= MOST_BLOCKS_A_LOG_READ_COVERS) {
            throw new Error("eth_getLogs is limited to a 100 range");
          }
          return (target[name] as (a: unknown) => unknown)(args);
        };
      }
      if (name === "readContract") {
        return (args: { functionName: string; args?: readonly unknown[] }) => {
          if (args.functionName === "jobs" && typeof args.args?.[0] === "bigint") jobReads.push(args.args[0]);
          return target.readContract(args as never);
        };
      }
      const value: unknown = Reflect.get(target, name, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const contractAs = (key: Hex) => ({ address: jobs, publicClient: monad, wallet: anvil.wallet(key) });
const tokenAs = (key: Hex) => ({ address: token, publicClient: monad, wallet: anvil.wallet(key) });
const reading = () => ({ address: jobs, publicClient: anvil.publicClient });

beforeAll(async () => {
  if (!available) return;
  anvil = await startAnvil();
  monad = likeMonad(anvil.publicClient);
  const validator = privateKeyToAccount(VALIDATOR).address;
  jobs = await anvil.deploy("PodJobs", [validator]);
  token = await anvil.deploy("PodToken", [validator]);
  storeFolder = await mkdtemp(join(tmpdir(), "pod-worker-jobs-"));
  store = new JobStore(storeFolder);
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

async function mine(blocks: number): Promise<void> {
  await anvil.publicClient.request({ method: "anvil_mine" as never, params: [toHex(blocks)] as never });
}

interface JobShape {
  /** approve a commit that is not in the repository at all */
  readonly pushed?: boolean;
  /** leave the work on the builder's branch only, as if the lead never brought it in */
  readonly onTheLeadsBranch?: boolean;
  /** somebody other than the seat's key named as a seat's owner, as `takeSeat` lets anybody do */
  readonly owners?: Partial<Record<Role, Address>>;
}

/**
 * A job posted, a pod seated, the work committed by the builder on its branch and brought into the
 * lead's, and approvals given by whichever seats are named.
 */
async function aJob(jobId: string, work: string, approving: readonly Role[], shape: JobShape = {}): Promise<MadeJob> {
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
  for (const [role, agent] of Object.entries(pod) as [Role, Agent][]) {
    await takeSeat(contractAs(agent.key), onChainId, role, shape.owners?.[role] ?? agent.address);
  }

  const workspace = await mkdtemp(join(tmpdir(), "pod-worker-work-"));
  await writeFile(join(workspace, "server.js"), `${work}\n`);
  const commit = shape.pushed === false
    ? "ab".repeat(20)
    : await onTheSeatsBranches(jobId, workspace, pod, shape.onTheLeadsBranch !== false);
  for (const role of approving) await approve(contractAs(pod[role].key), onChainId, role, commitToBytes32(commit));
  return { jobId, onChainId, pod, commit };
}

/**
 * Commit the work where a pod would have put it: the builder's branch, and the lead's, which is where
 * a candidate is. Main is left empty: it is the worker's alone to write, which is part of what is under test.
 */
async function onTheSeatsBranches(jobId: string, workspace: string, pod: Readonly<Record<Role, Agent>>, leadBroughtItIn: boolean): Promise<string> {
  const repo = await openRepository(repositories, jobId);
  const commit = await commitWork(repo, { workspace, message: "the work", agent: "builder", email: agentEmail(pod.builder.address) });
  const git = async (args: readonly string[]): Promise<void> => {
    const child = Bun.spawn(["git", "--git-dir", repo.path, ...args], { stdout: "ignore", stderr: "pipe" });
    if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text());
  };
  await git(["update-ref", `refs/heads/${branchFor("builder", pod.builder.address)}`, commit]);
  if (leadBroughtItIn) await git(["update-ref", `refs/heads/${branchFor("lead", pod.lead.address)}`, commit]);
  await git(["update-ref", "-d", "refs/heads/main"]);
  return commit;
}

function aWorker(said: string[] = [], jobsKey: Hex = VALIDATOR, gradeAgainAfterMs?: number): Worker {
  return new Worker({
    store, repositories, jobs: contractAs(jobsKey), token: tokenAs(VALIDATOR), runnerKey: VALIDATOR, image: IMAGE, times: 2,
    site: SITE, registry: { registries, stateFolder: workerState },
    ...(gradeAgainAfterMs === undefined ? {} : { gradeAgainAfterMs }),
    say: (what) => said.push(what),
  });
}

/** How often a test looks again while it waits for the worker */
const LOOK_AGAIN_MS = 200;

/** Look, and let what the look started finish, until the chain says it is done, or say what the worker said. */
async function untilSettled(worker: Worker, said: readonly string[], done: () => Promise<boolean>, seconds = 180): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    await worker.tick();
    await worker.whenIdle();
    if (await done()) return;
    await Bun.sleep(LOOK_AGAIN_MS);
  }
  throw new Error(`the worker never finished. It said:\n${said.join("\n")}`);
}

const balance = (address: Address) => anvil.publicClient.getBalance({ address });
const sender = (key: Hex) => ({ publicClient: anvil.publicClient, wallet: anvil.wallet(key) });

/** An agent's own identity in the registry, registered with its own key, so the key owns it. */
async function anIdentity(agent: Agent): Promise<bigint> {
  return (await registerAgent(sender(agent.key), registries)).agentId;
}

/** What an agent sends to have its verdict recorded: its own request, naming the validator, pointing at the receipt. */
async function asksForItsVerdict(agent: Agent, agentId: bigint, jobId: string): Promise<Hex> {
  const key = toHex(crypto.getRandomValues(new Uint8Array(32)));
  await requestValidation(sender(agent.key), {
    runner: privateKeyToAccount(VALIDATOR).address, agentId, evidenceURI: `${SITE}${receiptPath(jobId)}`, key,
  }, registries);
  return key;
}

const answerTo = (key: Hex) => verdictOnChain(anvil.publicClient, key, registries);
const recordsSaid = (said: readonly string[]) => said.filter((line) => line.startsWith("[worker] recorded "));

describe.skipIf(!available)("the worker", () => {
  test("several jobs at once: each is graded, published and settled its own way, and only work that passed is titled and put on main", async () => {
    const passing = await aJob("a-coat-when-it-rains", WORKING, SEATS);
    const failing = await aJob("a-coat-whatever-the-weather", ALWAYS_A_COAT, SEATS);
    // the approvals are left well behind, more than any one reading of events Monad allows
    await mine(350);
    const builderBefore = await balance(passing.pod.builder.address);
    const posterBefore = await balance(POSTER_ADDRESS);

    const said: string[] = [];
    const worker = aWorker(said);
    await untilSettled(worker, said, async () =>
      (await readJob(reading(), passing.onChainId)).state === "settled"
      && (await readJob(reading(), failing.onChainId)).state === "refunded"
      && (await tokenOfJob(tokenAs(VALIDATOR), passing.onChainId)) !== 0n
      && (await head(await openRepository(repositories, passing.jobId))) === passing.commit);

    // the one that passed: its evidence is published, the pod is paid, the title is the poster's, and main is the work
    const passed = (await store.read(passing.jobId))!;
    expect(passed.tile.verdict).toBe("passed");
    expect(passed.signed?.receipt.commit).toBe(passing.commit);
    expect(passed.chain?.settled).toMatch(/^0x[0-9a-f]{64}$/);
    // each approval with the time the contract recorded, found across more blocks than one reading covers
    expect(passed.approvals.map((approval) => approval.role).sort()).toEqual([...SEATS].sort());
    for (const approval of passed.approvals) expect(approval.at).toMatch(/^\d{4}-\d\d-\d\dT/);
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
  }, 300_000);

  test("a job it has finished is not read from the chain again", async () => {
    const finished = (await store.read("a-coat-when-it-rains"))!;
    const onChainId = BigInt(finished.chain!.jobId);
    jobReads.length = 0;
    await aWorker().tick();
    expect(jobReads).not.toContain(onChainId);
  }, 60_000);

  test("each agent that asks has the verdict on its seat recorded in ERC-8004, once per seat, and nobody else does", async () => {
    const job = await aJob("a-coat-with-a-record", WORKING, SEATS);
    const builderId = await anIdentity(job.pod.builder);
    const reviewerId = await anIdentity(job.pod.reviewer);
    const stranger = anAgent();
    await fundAgent(stranger);
    const strangerId = await anIdentity(stranger);

    // the builder asks before there is a verdict; it is held, and answered once the job is settled
    const early = await asksForItsVerdict(job.pod.builder, builderId, job.jobId);
    const first: string[] = [];
    const worker = aWorker(first);
    await worker.tick();
    expect((await answerTo(early)).responseHash).toBe(NOTHING);
    await untilSettled(worker, first, async () => (await answerTo(early)).response === 100);
    const answered = await answerTo(early);
    expect(answered.tag).toBe("pod.builder");
    expect(answered.responseHash).toBe((await store.read(job.jobId))!.signed!.hash);
    const runner = privateKeyToAccount(VALIDATOR).address;
    expect(await record(anvil.publicClient, builderId, "pod.builder", [runner], registries)).toEqual({ count: 1, average: 100 });

    // an identity with no seat on the job asks too, and nothing is recorded for it
    const uninvited = await asksForItsVerdict(stranger, strangerId, job.jobId);
    await worker.tick();
    expect((await answerTo(uninvited)).responseHash).toBe(NOTHING);
    expect(first.some((line) => line.includes(`#${strangerId}`) && line.includes("is not the key that held a seat"))).toBe(true);

    // the builder asks again, and with a second identity its key registered: its seat is recorded once
    const again = await asksForItsVerdict(job.pod.builder, builderId, job.jobId);
    const secondId = await anIdentity(job.pod.builder);
    const twin = await asksForItsVerdict(job.pod.builder, secondId, job.jobId);
    await worker.tick();
    expect((await answerTo(again)).responseHash).toBe(NOTHING);
    expect((await answerTo(twin)).responseHash).toBe(NOTHING);
    expect(await record(anvil.publicClient, builderId, "pod.builder", [runner], registries)).toEqual({ count: 1, average: 100 });
    expect(await record(anvil.publicClient, secondId, "pod.builder", [runner], registries)).toEqual({ count: 0, average: 0 });

    // the reviewer asks while no worker is running; the next one, reading on from where the last stopped, answers it
    const whileDown = await asksForItsVerdict(job.pod.reviewer, reviewerId, job.jobId);
    const second: string[] = [];
    await aWorker(second).tick();
    expect((await answerTo(whileDown)).tag).toBe("pod.reviewer");
    // and nothing it had already answered is answered again
    expect(recordsSaid(second)).toEqual([`[worker] recorded passed for agent #${reviewerId}, the reviewer on ${job.jobId}`]);

    // a worker that has lost its place reads every request again from the start, and answers none twice
    await writeFile(join(workerState, "registry.json"), JSON.stringify({ readTo: "0", holding: [] }));
    const third: string[] = [];
    await aWorker(third).tick();
    expect(recordsSaid(third)).toEqual([]);
  }, 300_000);

  test("somebody a seat names as its owner is not the seat: only the key that held it has its verdict recorded", async () => {
    const friend = anAgent();
    await fundAgent(friend);
    const job = await aJob("a-coat-with-a-friend", WORKING, SEATS, { owners: { builder: friend.address } });
    const friendId = await anIdentity(friend);
    const said: string[] = [];
    const worker = aWorker(said);
    await untilSettled(worker, said, async () => (await readJob(reading(), job.onChainId)).state === "settled");
    const asked = await asksForItsVerdict(friend, friendId, job.jobId);
    await worker.tick();
    expect((await answerTo(asked)).responseHash).toBe(NOTHING);
    expect(said.some((line) => line.includes(`#${friendId}`) && line.includes("is not the key that held a seat"))).toBe(true);
  }, 300_000);

  test("a job that failed is recorded as a failure, under the seat's role", async () => {
    const job = await aJob("a-coat-recorded-as-failed", ALWAYS_A_COAT, SEATS);
    const qaId = await anIdentity(job.pod.qa);
    const said: string[] = [];
    const worker = aWorker(said);
    await untilSettled(worker, said, async () => (await readJob(reading(), job.onChainId)).state === "refunded");
    const key = await asksForItsVerdict(job.pod.qa, qaId, job.jobId);
    await worker.tick();
    const answered = await answerTo(key);
    expect(answered.tag).toBe("pod.qa");
    expect(answered.response).toBe(0);
    expect(answered.responseHash).not.toBe(NOTHING);
  }, 300_000);

  test("what the worker kept of the registry, if it cannot be read, stops it rather than starting again from now", async () => {
    // one look, so there is a place kept to break
    await aWorker().tick();
    const kept = join(workerState, "registry.json");
    const before = await readFile(kept, "utf8");
    // half written, and whole but not what the worker writes: neither is a place to start again from
    for (const broken of ["{ this is not what was kept", JSON.stringify({ readTo: "not a block", holding: [] })]) {
      await writeFile(kept, broken);
      const said: string[] = [];
      await aWorker(said).tick();
      expect(said.some((line) => line.startsWith("[worker] the registry could not be read"))).toBe(true);
      expect(await readFile(kept, "utf8")).toBe(broken);
    }
    await writeFile(kept, before);
  }, 60_000);

  test("the look that settles work that passed also titles it and puts it on main, so a worker stopped then leaves nothing half done", async () => {
    const job = await aJob("a-coat-finished-in-one-look", WORKING, SEATS);
    const worker = aWorker();
    await worker.tick();
    await worker.whenIdle();
    expect((await store.read(job.jobId))!.tile.verdict).toBe("passed");
    expect((await readJob(reading(), job.onChainId)).state).toBe("working");

    await worker.tick();
    expect((await readJob(reading(), job.onChainId)).state).toBe("settled");
    expect(await tokenOfJob(tokenAs(VALIDATOR), job.onChainId)).not.toBe(0n);
    expect(await head(await openRepository(repositories, job.jobId))).toBe(job.commit);
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
    const phantom = await aJob("a-coat-nobody-pushed", WORKING, SEATS, { pushed: false });
    const worker = aWorker();
    await worker.tick();
    await worker.whenIdle();
    const record = (await store.read(phantom.jobId))!;
    expect(record.signed).toBeUndefined();
    expect(record.waitingBecause).toContain(`${phantom.commit}, which was never pushed`);
  }, 120_000);

  test("a commit that is in the repository but not on the lead's branch is not graded: no branch rule ever checked it", async () => {
    const hidden = await aJob("a-coat-nobody-brought-in", WORKING, SEATS, { onTheLeadsBranch: false });
    const worker = aWorker();
    await worker.tick();
    await worker.whenIdle();
    const record = (await store.read(hidden.jobId))!;
    expect(record.signed).toBeUndefined();
    expect(record.waitingBecause).toContain("not on the lead's branch");
  }, 120_000);

  test("a grading that fails is said, keeps the worker alive, and is tried again", async () => {
    const job = await aJob("a-coat-that-fails-to-grade", WORKING, SEATS);
    const spec = join(storeFolder, job.jobId, "spec.json");
    const good = await readFile(spec, "utf8");
    await writeFile(spec, "{ not a spec");
    const said: string[] = [];
    const worker = aWorker(said, VALIDATOR, 0);
    await worker.tick();
    await worker.whenIdle();
    expect(said.some((line) => line.startsWith(`[worker] ${job.jobId}: the grading failed`))).toBe(true);
    expect((await store.read(job.jobId))!.signed).toBeUndefined();

    await writeFile(spec, good);
    await untilSettled(worker, said, async () => (await store.read(job.jobId))!.tile.verdict === "passed");
  }, 300_000);

  test("a worker that dies after grading is picked up by the next, and nothing is paid or minted twice", async () => {
    const interrupted = await aJob("a-coat-interrupted", WORKING, SEATS);

    // this one grades and publishes, and cannot settle: its key is not the one the contract answers to
    const dying = aWorker([], NOT_THE_VALIDATOR);
    await dying.tick();
    await dying.whenIdle();
    await dying.tick();
    const graded = (await store.read(interrupted.jobId))!;
    expect(graded.tile.verdict).toBe("passed");
    expect(graded.chain?.settled).toBeUndefined();
    expect((await readJob(reading(), interrupted.onChainId)).state).toBe("working");

    // the next one finishes the job without grading it again, even looking twice at the same moment
    const second: string[] = [];
    const next = aWorker(second);
    await Promise.all([next.tick(), next.tick()]);
    await untilSettled(next, second, async () => (await tokenOfJob(tokenAs(VALIDATOR), interrupted.onChainId)) !== 0n);
    // a worker looks at every job in the store: what it said about this one is what is counted
    const aboutIt = second.filter((line) => line.includes(interrupted.jobId));
    expect(aboutIt.some((line) => line.includes("grading"))).toBe(false);
    expect(aboutIt.filter((line) => line.includes("settled"))).toHaveLength(1);
    expect(aboutIt.filter((line) => line.includes("minted"))).toHaveLength(1);
    expect(aboutIt.filter((line) => !/settled|minted/.test(line))).toEqual([]);
    const finished = (await store.read(interrupted.jobId))!;
    expect(finished.signed?.hash).toBe(graded.signed?.hash);

    // a worker that died between minting and writing it down: the chain knows, the record does not
    const { minted: _minted, tokenId: _tokenId, ...forgotten } = finished.chain!;
    await store.save({ ...finished, chain: forgotten });
    const leadAfter = await balance(interrupted.pod.lead.address);
    const tokenAfter = await tokenOfJob(tokenAs(VALIDATOR), interrupted.onChainId);
    const third: string[] = [];
    const again = aWorker(third);
    await again.tick();
    await again.whenIdle();
    await again.tick();
    // it reads the chain rather than the record: nothing is paid or minted again, and the title is remembered
    expect(third.filter((line) => line.includes(interrupted.jobId))).toEqual([]);
    expect(await balance(interrupted.pod.lead.address)).toBe(leadAfter);
    expect(await tokenOfJob(tokenAs(VALIDATOR), interrupted.onChainId)).toBe(tokenAfter);
    expect((await store.read(interrupted.jobId))!.chain?.tokenId).toBe(tokenAfter.toString());
  }, 300_000);

  // last, because it moves the chain's clock past every job's window
  test("a verdict that comes after the window is said and not sent, and records nothing in ERC-8004", async () => {
    const late = await aJob("a-coat-graded-too-late", WORKING, SEATS);
    const said: string[] = [];
    const worker = aWorker(said);
    await worker.tick();
    await worker.whenIdle();
    expect((await store.read(late.jobId))!.tile.verdict).toBe("passed");

    const job = await readJob(reading(), late.onChainId);
    const now = (await anvil.publicClient.getBlock()).timestamp;
    await anvil.publicClient.request({ method: "evm_increaseTime" as never, params: [Number(job.endsAt - now) + 1] as never });
    await mine(1);
    await worker.tick();
    await worker.tick();
    expect((await readJob(reading(), late.onChainId)).state).toBe("working");
    expect((await store.read(late.jobId))!.waitingBecause).toContain("came after the job's window closed");
    expect(said.some((line) => line.includes("TooLate"))).toBe(false);

    // the poster takes the money back, and an agent asking for its record of the job is not given one
    const poster = { address: jobs, publicClient: anvil.publicClient, wallet: anvil.wallet(POSTER) };
    const { request } = await anvil.publicClient.simulateContract({
      address: jobs, abi: [{ type: "function", name: "reclaim", inputs: [{ name: "jobId", type: "uint256" }], outputs: [], stateMutability: "nonpayable" }],
      functionName: "reclaim", args: [late.onChainId], account: poster.wallet.account!,
    });
    await anvil.publicClient.waitForTransactionReceipt({ hash: await poster.wallet.writeContract(request) });
    const builderId = await anIdentity(late.pod.builder);
    const asked = await asksForItsVerdict(late.pod.builder, builderId, late.jobId);
    await worker.tick();
    expect((await answerTo(asked)).responseHash).toBe(NOTHING);
    expect(said.some((line) => line.includes("never settled"))).toBe(true);
  }, 300_000);
});
