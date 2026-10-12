import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createTestClient, http, parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { agentEmail, branchFor } from "../door/index.ts";
import { netlify } from "../hosting/index.ts";
import { sealSpec, SERVE_THE_SITE, type Role, type Spec } from "../job.ts";
import { approve, readJob, readSeats, seatDeposit, seatPay, takeSeat, type Contract } from "../jobs.ts";
import { checksDigest, podJobsV2Abi, readReport, releaseLock } from "../jobsV2.ts";
import { accept, putForward, readAgentRecord, readAnswerBy, readHowItEnded, readPosterRecord, readReviewBy, refuse } from "../jobsV3.ts";
import { brevo, whenInAMail } from "../mail/index.ts";
import { PreparingStore } from "../preparing/index.ts";
import { openJob } from "../publish.ts";
import { feedbackFrom, registerAgent, type Registries } from "../registry.ts";
import { commitToBytes32, commitWork, openRepository } from "../repo.ts";
import { IMAGE } from "../sandbox.ts";
import { SEATS } from "../seal.ts";
import { isCodePublic, isPublished, JobStore, type JobRecord } from "../store.ts";
import { tokenOfJob } from "../token.ts";
import { Worker, type WorkerOptions } from "../worker/index.ts";
import { ANVIL_KEYS, anvilAvailable, startAnvil, type Anvil } from "./support/anvil.ts";
import { brevoSaying } from "./support/brevo.ts";
import { COAT_IDEA, DRY, good, serverSaying, WET, WORKING } from "./support/coat.ts";
import { netlifySaying, type NetlifySaying } from "./support/netlify.ts";
import { aPod, type Agent } from "./support/podServer.ts";
import { deployRegistries } from "./support/registries.ts";
import { dockerAvailable } from "./support/tools.ts";

/**
 * The worker, on the contract where the poster has the last word: it reports what the checks found
 * and moves no money; the job waits for its poster, who accepts or refuses with their own wallet;
 * when they say nothing in their time the worker settles it as the checks found; and however it
 * ends, that is written down, with a title minted when the pod was paid. Everything is real: the
 * contract on a local chain, the title contract, the grading boxes, the job's repository.
 */
const available = (await anvilAvailable()) && (await dockerAvailable());

const WRITER = ANVIL_KEYS[2];
const VALIDATOR = ANVIL_KEYS[6];
const PRICE = parseEther("1");
const WRITING = parseEther("0.05");
const HOUR = 3600n;
/** how long a poster has to answer here: longer than the window, so a job's delivery never depends on the clock a test moved */
const ANSWER_SECONDS = 4n * HOUR;
/** how long the other seats have to say whether they stand behind what the builder put forward: a quarter of the hour every job here is posted for */
const REVIEW_SECONDS = HOUR / 4n;
/** what the contract leaves a pod of each seat's pay when its poster refuses work that passed */
const REFUSAL_SHARE = 25n;
/** Says no coat in the rain: fails the check the pod could see */
const NEVER_A_COAT = serverSaying("false", "false");
/** the roles whose approval the policy asks for: the builder builds, and does not approve */
const APPROVERS: readonly Role[] = ["lead", "reviewer", "qa", "security"];

let anvil: Anvil;
let firstJobs: Address;
let jobs: Address;
let token: Address;
let registries: Registries;
let store: JobStore;
let repositories: string;

const contractAs = (key: Hex): Contract => ({ address: jobs, publicClient: anvil.publicClient, wallet: anvil.wallet(key) });
const tokenAs = (key: Hex): Contract => ({ address: token, publicClient: anvil.publicClient, wallet: anvil.wallet(key) });
const reader = (): Contract => contractAs(VALIDATOR);
const balance = (address: Address): Promise<bigint> => anvil.publicClient.getBalance({ address });
const addressOf = (key: Hex): Address => privateKeyToAccount(key).address;

beforeAll(async () => {
  if (!available) return;
  anvil = await startAnvil();
  firstJobs = await anvil.deploy("PodJobs", [addressOf(VALIDATOR)]);
  // two contracts' worth of numbers already given out, as on Monad: this one starts at 20
  jobs = await anvil.deploy("PodJobsV3", [addressOf(VALIDATOR), addressOf(WRITER), 20n, WRITING, 100_000n, ANSWER_SECONDS]);
  token = await anvil.deploy("PodToken", [addressOf(VALIDATOR)]);
  registries = await deployRegistries(anvil);
  store = new JobStore(await mkdtemp(join(tmpdir(), "pod-last-word-jobs-")));
  repositories = await mkdtemp(join(tmpdir(), "pod-last-word-repositories-"));
}, 120_000);

afterAll(() => anvil?.stop());

/** A website as a pod hands one in: a front page and a card's page, in the folder a website is. */
const A_WEBSITE = {
  "site/index.html": "<h1>Pokemon cards</h1><a href=\"/cards/mewtwo\">Mewtwo</a>",
  "site/cards/mewtwo.html": "<h1>Mewtwo</h1><button>Mint for 1 MON</button>",
} as const;
/** A check that the address answers and its page holds the words, written as the writer writes one. */
const pageHolds = (address: string, words: string): string => `const answer = await fetch(process.env.TARGET + ${JSON.stringify(address)});
const page = await answer.text();
if (!answer.ok || !page.includes(${JSON.stringify(words)})) { console.log(${JSON.stringify(address)} + " answered " + answer.status + " without ${words}"); process.exit(1); }
console.log(${JSON.stringify(address)} + " holds ${words}");`;
const WEBSITE_CHECKS = { "check-1.mjs": pageHolds("/", "Pokemon cards"), "check-2.mjs": pageHolds("/cards/mewtwo", "Mint for") } as const;

interface MadeJob {
  readonly jobId: string;
  readonly onChainId: bigint;
  readonly poster: Hex;
  readonly pod: Readonly<Record<Role, Agent>>;
  readonly commit: string;
}

/** A commit placed on a seat's branch in the job's repository, as that seat's push through the door leaves it. */
async function onTheBranchOf(role: Role, agent: Agent, repository: string, commit: string): Promise<void> {
  const child = Bun.spawn(["git", "--git-dir", repository, "update-ref", `refs/heads/${branchFor(role, agent.address)}`, commit], { stdout: "ignore", stderr: "pipe" });
  if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text());
}

/**
 * A job paid for by a poster of its own, its checks approved with the writer's signature, on the wall
 * as the worker leaves it on approval, a pod seated, the work on the builder's branch and put forward
 * by its builder, and the seats named standing behind it: all of them, unless told otherwise.
 */
/** A job paid for and opened on the contract by its poster, with its checks approved and every seat free. */
async function paidForAndOpened(posterKey: Hex, seal: Hex): Promise<bigint> {
  const poster = contractAs(posterKey);
  const { request, result: onChainId } = await anvil.publicClient.simulateContract({
    address: jobs, abi: podJobsV2Abi, functionName: "post", args: [HOUR, 1], value: PRICE + 3n * WRITING, account: privateKeyToAccount(posterKey),
  });
  await anvil.publicClient.waitForTransactionReceipt({ hash: await poster.wallet.writeContract(request) });
  const writer = anvil.wallet(WRITER);
  const signature = await writer.signMessage({ account: writer.account, message: { raw: checksDigest({ jobs, chainId: 31337, jobId: onChainId, seal }) } });
  const opening = await anvil.publicClient.simulateContract({
    address: jobs, abi: podJobsV2Abi, functionName: "approveChecks", args: [onChainId, seal, signature], account: privateKeyToAccount(posterKey),
  });
  await anvil.publicClient.waitForTransactionReceipt({ hash: await poster.wallet.writeContract(opening.request) });
  return onChainId;
}

async function aJob(
  jobId: string, work: string | Readonly<Record<string, string>>, posterKey: Hex, behindIt: readonly Role[] = APPROVERS, pushedBy: Role = "builder",
): Promise<MadeJob> {
  const isWebsite = typeof work !== "string";
  const spec: Spec = {
    idea: COAT_IDEA, kind: isWebsite ? "site" : "service", mode: "flash", price: PRICE,
    checks: [
      { says: WET, run: "node check-1.mjs", hidden: false, file: "check-1.mjs" },
      { says: DRY, run: "node check-2.mjs", hidden: true, file: "check-2.mjs" },
    ],
    allowed: [], salt: jobId,
  };
  const poster = contractAs(posterKey);
  const seal = await sealSpec(spec);
  const onChainId = await paidForAndOpened(posterKey, seal);

  const onChain = await readJob(poster, onChainId);
  const opened = await openJob(store, { jobId, seal, spec, endsAt: new Date(Number(onChain.endsAt) * 1000), seats: [] });
  // as the worker leaves a job it puts on the wall from this contract: its poster has the last word
  await store.save({ ...opened, chain: { network: "monad-testnet", jobId: String(onChainId), jobs, lastWord: true }, poster: addressOf(posterKey) },
    isWebsite ? WEBSITE_CHECKS : { "check-1.mjs": good(0).check, "check-2.mjs": good(1).check });
  await store.saveSpec(jobId, spec);

  const pod = aPod();
  for (const agent of Object.values(pod)) await anvil.fund(agent.address);
  for (const role of SEATS) await takeSeat(contractAs(pod[role].key), onChainId, role, pod[role].address);
  const workspace = await mkdtemp(join(tmpdir(), "pod-last-word-work-"));
  for (const [name, contents] of Object.entries(isWebsite ? work : { "server.js": work })) {
    await mkdir(dirname(join(workspace, name)), { recursive: true });
    await writeFile(join(workspace, name), `${contents}\n`);
  }
  const repo = await openRepository(repositories, jobId);
  const commit = await commitWork(repo, { workspace, message: "the work", agent: "builder", email: agentEmail(pod.builder.address) });
  await onTheBranchOf(pushedBy, pod[pushedBy], repo.path, commit);
  await putForward(contractAs(pod.builder.key), onChainId, commitToBytes32(commit));
  for (const role of behindIt) await approve(contractAs(pod[role].key), onChainId, role, commitToBytes32(commit));
  return { jobId, onChainId, poster: posterKey, pod, commit };
}

/** The chain's own clock moved on by so many seconds, as a wait would move it. */
async function theClockMovesOn(seconds: bigint): Promise<void> {
  const clock = createTestClient({ mode: "anvil", transport: http(anvil.rpc) });
  await clock.increaseTime({ seconds: Number(seconds) });
  await clock.mine({ blocks: 1 });
}

function aWorker(said: string[], host?: NetlifySaying, more: Partial<WorkerOptions> = {}): Worker {
  return new Worker({
    store, repositories, jobs: { address: firstJobs, publicClient: anvil.publicClient, wallet: anvil.wallet(VALIDATOR) },
    prepared: contractAs(VALIDATOR), hasTheLastWord: true, token: tokenAs(VALIDATOR),
    ...(host ? { siteHost: netlify({ token: "the-token", endpoint: host.endpoint }) } : {}),
    runnerKey: VALIDATOR, image: IMAGE, times: 2, gradeAgainAfterMs: 0, releaseAfterMs: 0, say: (what) => said.push(what), ...more,
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

const stateOf = async (onChainId: bigint) => (await readJob(reader(), onChainId)).state;
const recordOf = async (jobId: string): Promise<JobRecord> => {
  const record = await store.read(jobId);
  if (!record) throw new Error(`${jobId} is not on the wall`);
  return record;
};

/** A poster of their own for a job, with money to post it: what one did never shows in another's balance or record. */
async function aPoster(): Promise<Hex> {
  const key = generatePrivateKey();
  await anvil.fund(addressOf(key));
  return key;
}

/** What every seat and the poster hold, to see who a step paid. */
async function held(job: MadeJob): Promise<Readonly<Record<Role | "poster", bigint>>> {
  const seats = await Promise.all(SEATS.map(async (role) => [role, await balance(job.pod[role].address)] as const));
  return { ...Object.fromEntries(seats), poster: await balance(addressOf(job.poster)) } as Record<Role | "poster", bigint>;
}

/** A job walked to its delivery: graded, reported, and waiting for its poster. */
async function delivered(jobId: string, work: string | Readonly<Record<string, string>>, posterKey: Hex, said: string[], host?: NetlifySaying): Promise<MadeJob> {
  const job = await aJob(jobId, work, posterKey);
  await until(aWorker(said, host), said, async () => (await stateOf(job.onChainId)) === "delivered");
  return job;
}

/** What a transaction cost whoever sent it, which a balance compared before and after has to allow for. */
async function gasOf(hash: Hex): Promise<bigint> {
  const receipt = await anvil.publicClient.getTransactionReceipt({ hash });
  return receipt.gasUsed * receipt.effectiveGasPrice;
}

describe.skipIf(!available)("the worker, where the poster has the last word", () => {
  test("a job's own poster is refused a seat on it, as the agent or as an agent's owner, and sits on somebody else's like anybody", async () => {
    const posterKey = await aPoster();
    const poster = addressOf(posterKey);
    const onChainId = await paidForAndOpened(posterKey, `0x${"5e".repeat(32)}`);
    // with their own key, in the cheapest seat
    await expect(takeSeat(contractAs(posterKey), onChainId, "security", poster)).rejects.toThrow("PosterTakesNoSeat");
    // and behind somebody else's key, named as its owner
    const agent = await aPoster();
    await expect(takeSeat(contractAs(agent), onChainId, "security", poster)).rejects.toThrow("PosterTakesNoSeat");
    expect(await readSeats(reader(), onChainId)).toEqual([]);
    // the same agent, owned by itself, is seated; and the poster takes a seat on that agent's own job
    await takeSeat(contractAs(agent), onChainId, "security", addressOf(agent));
    expect((await readSeats(reader(), onChainId)).map((seat) => seat.role)).toEqual(["security"]);
    const theirs = await paidForAndOpened(agent, `0x${"5f".repeat(32)}`);
    await takeSeat(contractAs(posterKey), theirs, "qa", poster);
    expect((await readSeats(reader(), theirs)).map((seat) => seat.agent)).toEqual([poster]);
  }, 120_000);

  test("work that passes is reported and nobody is paid: the job waits for its poster, with its evidence public", async () => {
    const said: string[] = [];
    const job = await aJob("last-word-delivered", WORKING, await aPoster());
    const before = await held(job);
    await until(aWorker(said), said, async () => (await stateOf(job.onChainId)) === "delivered");

    expect(await held(job)).toEqual(before);
    const record = await recordOf(job.jobId);
    const report = await readReport(reader(), job.onChainId);
    expect(report.verdict).toBe("passed");
    expect(record.signed?.hash).toBe(report.receiptHash);
    expect(record.chain?.reported).toMatch(/^0x[0-9a-f]{64}$/);
    const answerBy = await readAnswerBy(reader(), job.onChainId);
    expect(record.chain?.answerBy).toBe(new Date(Number(answerBy) * 1000).toISOString());
    // the poster decides from the evidence, so it is public from the delivery on, hidden checks included
    expect(isPublished(record)).toBe(true);
    expect(record.chain?.answer).toBeUndefined();
    expect(record.chain?.tokenId).toBeUndefined();

    // and it stays that way however often the worker looks, while the poster's time runs
    const worker = aWorker(said);
    await worker.tick();
    await worker.whenIdle();
    expect(await stateOf(job.onChainId)).toBe("delivered");
    expect(await held(job)).toEqual(before);
  }, 300_000);

  test("the poster accepts: the pod is paid by their own transaction, and the worker writes it down and mints the title", async () => {
    const said: string[] = [];
    const job = await delivered("last-word-accepted", WORKING, await aPoster(), said);
    const before = await held(job);
    const leadPay = await seatPay(reader(), job.onChainId, "lead");
    const leadDeposit = await seatDeposit(reader(), job.onChainId, "lead");

    const hash = await accept(contractAs(job.poster), job.onChainId);
    expect(await stateOf(job.onChainId)).toBe("settled");
    expect(await balance(job.pod.lead.address)).toBe(before.lead + leadPay + leadDeposit);

    await until(aWorker(said), said, async () => (await recordOf(job.jobId)).chain?.tokenId !== undefined);
    const record = await recordOf(job.jobId);
    expect(record.chain?.answer?.how).toBe("accepted");
    expect(record.chain?.answer?.hash).toBe(hash);
    expect(record.chain?.tokenId).toBe(`${await tokenOfJob(tokenAs(VALIDATOR), job.onChainId)}`);
    expect(await readHowItEnded(reader(), job.onChainId)).toBe("accepted");
  }, 300_000);

  test("the poster refuses work that passed: the pod keeps a quarter, the rest goes back, and no title is minted", async () => {
    const said: string[] = [];
    const job = await delivered("last-word-refused", WORKING, await aPoster(), said);
    const before = await held(job);
    const shares = await Promise.all(SEATS.map(async (role) => ((await seatPay(reader(), job.onChainId, role)) * REFUSAL_SHARE) / 100n));
    const kept = shares.reduce((sum, share) => sum + share, 0n);
    const leadDeposit = await seatDeposit(reader(), job.onChainId, "lead");

    const hash = await refuse(contractAs(job.poster), job.onChainId);
    expect(await stateOf(job.onChainId)).toBe("refunded");
    expect(await balance(job.pod.lead.address)).toBe(before.lead + shares[SEATS.indexOf("lead")]! + leadDeposit);
    expect(await balance(addressOf(job.poster))).toBe(before.poster + PRICE - kept - (await gasOf(hash)));
    expect(kept).toBe(PRICE / 4n);

    await until(aWorker(said), said, async () => (await recordOf(job.jobId)).chain?.answer !== undefined);
    const record = await recordOf(job.jobId);
    expect(record.chain?.answer).toMatchObject({ how: "refused", hash, keptByThePod: kept.toString() });
    // the checks' verdict stands as what the checks found, whatever the poster said
    expect(record.tile.verdict).toBe("passed");
    expect(record.chain?.tokenId).toBeUndefined();
    expect(await tokenOfJob(tokenAs(VALIDATOR), job.onChainId)).toBe(0n);

    // counted where an agent can read it before taking this poster's next job
    expect(await readPosterRecord(reader(), addressOf(job.poster))).toEqual({ posted: 1, accepted: 0, refusedPassed: 1, refusedFailed: 0, unanswered: 0 });
    expect(await readAgentRecord(reader(), job.pod.lead.address)).toEqual({ accepted: 0, paidUnanswered: 0, refusedPassed: 1, failed: 0, undelivered: 0 });
  }, 300_000);

  test("the poster accepts work whose checks failed: the pod is paid all the same, and the title is minted", async () => {
    const said: string[] = [];
    const job = await delivered("last-word-accepted-though-failed", NEVER_A_COAT, await aPoster(), said);
    expect((await readReport(reader(), job.onChainId)).verdict).toBe("visible-failed");
    const leadBefore = await balance(job.pod.lead.address);
    const leadPay = await seatPay(reader(), job.onChainId, "lead");
    const leadDeposit = await seatDeposit(reader(), job.onChainId, "lead");

    await accept(contractAs(job.poster), job.onChainId);
    expect(await balance(job.pod.lead.address)).toBe(leadBefore + leadPay + leadDeposit);

    await until(aWorker(said), said, async () => (await recordOf(job.jobId)).chain?.tokenId !== undefined);
    const record = await recordOf(job.jobId);
    expect(record.chain?.answer?.how).toBe("accepted");
    // what the checks found is still what the page says they found
    expect(record.tile.verdict).toBe("failed");
  }, 300_000);

  test("the poster refuses work whose checks failed: everything goes back, and every seat that stood behind it loses its deposit, the builder who put it forward too", async () => {
    const said: string[] = [];
    const job = await delivered("last-word-refused-after-failing", NEVER_A_COAT, await aPoster(), said);
    const before = await held(job);
    const forfeited = (await Promise.all(SEATS.map((role) => seatDeposit(reader(), job.onChainId, role)))).reduce((sum, deposit) => sum + deposit, 0n);

    const hash = await refuse(contractAs(job.poster), job.onChainId);
    expect(await balance(job.pod.lead.address)).toBe(before.lead);
    expect(await balance(job.pod.builder.address)).toBe(before.builder);
    expect(await balance(addressOf(job.poster))).toBe(before.poster + PRICE + forfeited - (await gasOf(hash)));

    await until(aWorker(said), said, async () => (await recordOf(job.jobId)).chain?.answer !== undefined);
    const answer = (await recordOf(job.jobId)).chain?.answer;
    expect(answer?.how).toBe("refused");
    expect(answer?.keptByThePod).toBe("0");
  }, 300_000);

  test("a worker stopped between reporting and writing it down finds the delivery on the chain", async () => {
    const said: string[] = [];
    const job = await delivered("last-word-report-not-written-down", WORKING, await aPoster(), said);
    const record = await recordOf(job.jobId);
    if (!record.chain) throw new Error("the job has no place on the chain");
    const { reported: _reported, answerBy: _answerBy, ...chain } = record.chain;
    await store.save({ ...record, chain });

    const worker = aWorker(said);
    await worker.tick();
    await worker.whenIdle();
    const answerBy = await readAnswerBy(reader(), job.onChainId);
    expect((await recordOf(job.jobId)).chain?.answerBy).toBe(new Date(Number(answerBy) * 1000).toISOString());
    expect(await stateOf(job.onChainId)).toBe("delivered");
  }, 300_000);

  test("a website is graded from its files as they are served, and put live at delivery, exactly as it was graded", async () => {
    const said: string[] = [];
    const host = netlifySaying();
    try {
      const job = await delivered("last-word-website", A_WEBSITE, await aPoster(), said, host);
      await until(aWorker(said, host), said, async () => (await recordOf(job.jobId)).live !== undefined);

      const record = await recordOf(job.jobId);
      expect(record.signed?.receipt.verdict).toBe("passed");
      // no program of the pod's ran: its files were served by ours, and the receipt says how, for anybody repeating it
      expect(record.signed?.receipt.start).toBe(SERVE_THE_SITE);
      expect(record.live).toMatchObject({ host: "Netlify", siteId: "site-1", url: expect.stringContaining(host.addressOf("pod-last-word-website")) });
      expect(Object.fromEntries(host.files)).toEqual({
        "/index.html": `${A_WEBSITE["site/index.html"]}\n`, "/cards/mewtwo.html": `${A_WEBSITE["site/cards/mewtwo.html"]}\n`,
      });
      // put live once, however often the worker looks
      const worker = aWorker(said, host);
      await worker.tick();
      await worker.whenIdle();
      expect(host.asked.filter((one) => one.method === "POST" && one.path.endsWith("/sites"))).toHaveLength(1);
      expect(await stateOf(job.onChainId)).toBe("delivered");
    } finally {
      host.stop();
    }
  }, 300_000);

  test("a website its poster refuses is taken down, and its code stays the pod's; one they accept stays up, and its code opens", async () => {
    const said: string[] = [];
    const host = netlifySaying();
    try {
      const refused = await delivered("last-word-website-refused", A_WEBSITE, await aPoster(), said, host);
      await until(aWorker(said, host), said, async () => (await recordOf(refused.jobId)).live !== undefined);
      // delivered, and nobody can fetch what the pod wrote: the receipt names this server's copy, which is shut
      expect(isCodePublic(await recordOf(refused.jobId))).toBe(false);
      expect((await recordOf(refused.jobId)).repository).toBeUndefined();

      await refuse(contractAs(refused.poster), refused.onChainId);
      await until(aWorker(said, host), said, async () => (await recordOf(refused.jobId)).live?.removedAt !== undefined);
      expect(host.removed).toEqual(["site-1"]);
      expect(isCodePublic(await recordOf(refused.jobId))).toBe(false);

      const accepted = await delivered("last-word-website-accepted", A_WEBSITE, await aPoster(), said, host);
      await until(aWorker(said, host), said, async () => (await recordOf(accepted.jobId)).live !== undefined);
      await accept(contractAs(accepted.poster), accepted.onChainId);
      await until(aWorker(said, host), said, async () => (await recordOf(accepted.jobId)).chain?.tokenId !== undefined);
      const kept = await recordOf(accepted.jobId);
      expect(kept.live?.removedAt).toBeUndefined();
      expect(host.removed).toEqual(["site-1"]);
      expect(isCodePublic(kept)).toBe(true);
    } finally {
      host.stop();
    }
  }, 420_000);

  test("a host that fails is not asked again on every look: the wait doubles, and the website goes live once the host is well", async () => {
    const said: string[] = [];
    // Netlify makes the site and then cannot take its files, which is what would count against a day's deploys
    const host = netlifySaying({ refuses: { path: /\/deploys$/, status: 500, body: "the deploy could not start" } });
    const deploysAsked = (): number => host.asked.filter((one) => one.method === "POST" && one.path.endsWith("/deploys")).length;
    try {
      // delivered with no host at all, so that every asking below is this worker's own
      const job = await delivered("last-word-website-on-a-bad-day", A_WEBSITE, await aPoster(), said);
      const worker = aWorker(said, host, { hostAgainAfterMs: 1_500 });
      const look = async (): Promise<void> => { await worker.tick(); await worker.whenIdle(); };

      await look();
      expect(deploysAsked()).toBe(1);
      expect(said.some((line) => line.includes("could not be put live, and is tried again later: Netlify would not take the site's files: 500"))).toBe(true);
      // the delivery itself is not held up by its host
      expect(await stateOf(job.onChainId)).toBe("delivered");
      // looked at again and again inside the wait: the host hears nothing
      for (let looks = 0; looks < 3; looks++) await look();
      expect(deploysAsked()).toBe(1);

      // once the wait is over it is asked once more, fails again, and the wait is now twice as long
      await Bun.sleep(1_600);
      await look();
      expect(deploysAsked()).toBe(2);
      await Bun.sleep(1_600);
      await look();
      expect(deploysAsked()).toBe(2);

      // the host is well again: the next asking lands, exactly what was graded
      host.recover();
      await Bun.sleep(1_500);
      await look();
      expect(deploysAsked()).toBe(3);
      expect((await recordOf(job.jobId)).live).toMatchObject({ host: "Netlify", url: expect.stringContaining(host.addressOf("pod-last-word-website-on-a-bad-day")) });
      expect(host.files.get("/index.html")).toBe(`${A_WEBSITE["site/index.html"]}\n`);
    } finally {
      host.stop();
    }
  }, 300_000);

  test("work that is no website to publish is delivered all the same, and says once why it is not live", async () => {
    const said: string[] = [];
    const host = netlifySaying();
    try {
      // a website with no front page at its top: its checks fail on that, and there is nothing to open
      const job = await delivered("last-word-website-with-no-front-page", { "site/cards/mewtwo.html": "<h1>Mewtwo</h1>" }, await aPoster(), said, host);
      await until(aWorker(said, host), said, async () => (await recordOf(job.jobId)).notLiveBecause !== undefined);
      expect((await recordOf(job.jobId)).notLiveBecause).toContain("no index.html at its top");
      expect((await recordOf(job.jobId)).live).toBeUndefined();
      expect(host.asked).toHaveLength(0);
    } finally {
      host.stop();
    }
  }, 300_000);

  test("a seat that says nothing holds nothing back: once its review has run out the work is graded, and only the seats behind it are paid or recorded", async () => {
    const said: string[] = [];
    // security never says whether it stands behind the work: the seat a poster's own wallet would take to hold it back
    const job = await aJob("last-word-a-silent-seat", WORKING, await aPoster(), ["lead", "reviewer", "qa"]);
    const stateFolder = await mkdtemp(join(tmpdir(), "pod-last-word-registry-"));
    const worker = aWorker(said, undefined, { registry: { registries, stateFolder } });
    const look = async (): Promise<void> => { await worker.tick(); await worker.whenIdle(); };

    // while its review runs it is not graded: a seat may yet sign on, or the builder put something better forward
    await look();
    await look();
    expect(await stateOf(job.onChainId)).toBe("working");
    expect((await recordOf(job.jobId)).signed).toBeUndefined();
    // yet its record already names who sat down, which is what its page, the wall and each agent's page
    // read: a job being built is never shown as one nobody took
    const waiting = (await recordOf(job.jobId)).tile;
    expect(waiting.verdict).toBe("running");
    expect(waiting.pod.map((seat) => `${seat.role} ${seat.agent.toLowerCase()}`).sort())
      .toEqual(SEATS.map((role) => `${role} ${job.pod[role].address.toLowerCase()}`).sort());
    expect(said.filter((line) => line.includes("seated so far")), "written down once, not on every look").toHaveLength(1);

    const reviewBy = await readReviewBy(reader(), job.onChainId);
    if (reviewBy === undefined) throw new Error("the work was put forward, and its review has no end");
    // and what is under review, as the contract has it: which commit, until when, and who stands behind it so far
    const review = (await recordOf(job.jobId)).review;
    expect(review?.commit).toBe(job.commit);
    expect(review?.reviewBy).toBe(new Date(Number(reviewBy) * 1000).toISOString());
    expect(review?.behind).toEqual(["lead", "builder", "reviewer", "qa"]);
    expect(review?.putForwardAt, "when its builder put it forward, from the chain's own event").toMatch(/^\d{4}-/);
    await theClockMovesOn(REVIEW_SECONDS + 1n);
    await until(worker, said, async () => (await stateOf(job.onChainId)) === "delivered");

    // the record says who stood behind what was graded: its builder, and the three that said yes
    const record = await recordOf(job.jobId);
    expect(record.signed?.receipt.verdict).toBe("passed");
    expect(record.signed?.receipt.commit).toBe(job.commit);
    expect(record.review, "graded, so nothing is under review any more").toBeUndefined();
    expect(record.approvals.map((one) => one.role).sort()).toEqual(["builder", "lead", "qa", "reviewer"]);
    expect(record.approvals.every((one) => /^\d{4}-/.test(one.at)), "each with the time the contract recorded").toBe(true);

    // both name the identity their key owns, as a seat does at any time before or after the verdict
    const identity = async (agent: Agent): Promise<bigint> => (await registerAgent({ publicClient: anvil.publicClient, wallet: anvil.wallet(agent.key) }, registries)).agentId;
    const [qaId, securityId] = [await identity(job.pod.qa), await identity(job.pod.security)];
    await store.save({ ...(await recordOf(job.jobId)), identities: [
      { role: "qa", agent: job.pod.qa.address, agentId: qaId.toString() },
      { role: "security", agent: job.pod.security.address, agentId: securityId.toString() },
    ] });

    const before = await held(job);
    const terms = { qa: await seatPay(reader(), job.onChainId, "qa"), security: await seatPay(reader(), job.onChainId, "security"), builder: await seatPay(reader(), job.onChainId, "builder") };
    const deposit = async (role: Role): Promise<bigint> => seatDeposit(reader(), job.onChainId, role);
    const hash = await accept(contractAs(job.poster), job.onChainId);

    expect(await balance(job.pod.qa.address)).toBe(before.qa + terms.qa + (await deposit("qa")));
    expect(await balance(job.pod.builder.address)).toBe(before.builder + terms.builder + (await deposit("builder")));
    // its deposit home, no pay for work it did not stand behind, and its share back with whoever paid it
    expect(await balance(job.pod.security.address)).toBe(before.security + (await deposit("security")));
    expect(await balance(addressOf(job.poster))).toBe(before.poster + terms.security - (await gasOf(hash)));
    expect(await readAgentRecord(reader(), job.pod.qa.address)).toMatchObject({ accepted: 1 });
    expect(await readAgentRecord(reader(), job.pod.security.address)).toEqual({ accepted: 0, paidUnanswered: 0, refusedPassed: 0, failed: 0, undelivered: 0 });

    // its verdict is written to the identity of a seat that stood behind it, and not to the one that did not
    await until(worker, said, async () => (await recordOf(job.jobId)).chain?.tokenId !== undefined
      && (await feedbackFrom(anvil.publicClient, qaId, addressOf(VALIDATOR), registries)).length > 0
      && ((await recordOf(job.jobId)).identities ?? []).every((named) => named.role !== "security"));
    expect((await feedbackFrom(anvil.publicClient, qaId, addressOf(VALIDATOR), registries)).map((entry) => entry.tag)).toEqual(["pod.qa"]);
    expect(await feedbackFrom(anvil.publicClient, securityId, addressOf(VALIDATOR), registries)).toEqual([]);
    expect(said.some((line) => line.includes("the security did not stand behind the work"))).toBe(true);
  }, 420_000);

  test("work the validator let go of is graded again as soon as its builder puts the same commit forward, with the same seats behind it", async () => {
    const said: string[] = [];
    // security says nothing, so only the review running out sends it to grading
    const job = await aJob("last-word-let-go-and-put-forward-again", WORKING, await aPoster(), ["lead", "reviewer", "qa"]);
    await theClockMovesOn(REVIEW_SECONDS + 1n);
    // the validator lets go of it, as the worker does once when it cannot grade work or its runs disagree
    await releaseLock(contractAs(VALIDATOR), job.onChainId);
    const worker = aWorker(said);
    const look = async (): Promise<void> => { await worker.tick(); await worker.whenIdle(); };
    await look();
    expect((await recordOf(job.jobId)).signed, "nothing is graded while nothing is put forward").toBeUndefined();

    // the builder puts the same commit forward: it has had its review, and no second one is waited out
    await putForward(contractAs(job.pod.builder.key), job.onChainId, commitToBytes32(job.commit));
    expect(await readReviewBy(reader(), job.onChainId)).toBe((await anvil.publicClient.getBlock()).timestamp);
    await until(worker, said, async () => (await stateOf(job.onChainId)) === "delivered");
    const record = await recordOf(job.jobId);
    expect(record.signed?.receipt.verdict).toBe("passed");
    expect(record.approvals.map((one) => one.role).sort()).toEqual(["builder", "lead", "qa", "reviewer"]);
  }, 420_000);

  test("what a builder puts forward is graded from its own branch, and from nowhere else", async () => {
    const said: string[] = [];
    // the commit exists in the job's repository, on the lead's branch: the builder never pushed it
    const job = await aJob("last-word-not-the-builders-push", WORKING, await aPoster(), APPROVERS, "lead");
    const worker = aWorker(said);
    await until(worker, said, async () => (await recordOf(job.jobId)).waitingBecause !== undefined);
    expect((await recordOf(job.jobId)).waitingBecause).toContain("is not on the builder's own branch");
    expect(await stateOf(job.onChainId)).toBe("working");
    expect((await recordOf(job.jobId)).signed).toBeUndefined();
  }, 300_000);

  // last, since moving the chain's clock ends the window of every job still open here
  test("a poster who left an address is told by mail that their job is delivered: once, with where to answer and until when; one who left none is told nothing", async () => {
    const said: string[] = [];
    const mail = brevoSaying();
    const preparing = new PreparingStore(await mkdtemp(join(tmpdir(), "pod-last-word-preparing-")));
    const told = (more: Partial<WorkerOptions> = {}): Worker => aWorker(said, undefined, {
      preparing, site: "https://pod.example", mailer: brevo({ key: "a-key", from: "pod@example.org", endpoint: mail.endpoint }), mailAgainAfterMs: 0, ...more,
    });
    /** as the server leaves a job its poster set up, with the address they asked to be told at when they left one */
    const setUp = async (job: MadeJob, tell?: string): Promise<void> => preparing.saveSetUp({
      onChainId: String(job.onChainId), jobs, name: job.jobId, poster: addressOf(job.poster), mode: "flash", salt: "0".repeat(32),
      setUpAt: new Date().toISOString(), ...(tell ? { tell } : {}),
    });
    try {
      const job = await aJob("last-word-told-by-mail", WORKING, await aPoster());
      await setUp(job, "the-poster@example.com");
      const worker = told();
      await until(worker, said, async () => mail.sent.length > 0);
      for (let look = 0; look < 3; look += 1) { await worker.tick(); await worker.whenIdle(); }

      expect(mail.sent, "one message, however many times the worker looks").toHaveLength(1);
      const [message] = mail.sent;
      expect(message?.to).toBe("the-poster@example.com");
      expect(message?.subject).toStartWith("Your job is delivered: ");
      expect(message?.text).toContain("https://pod.example/job/last-word-told-by-mail");
      // counted from the signed receipt: the job has two checks, one of them hidden from its pod
      expect(message?.text).toContain("Both of its checks passed.");
      expect(message?.html).toContain("Both of its checks passed.");
      const answerBy = await readAnswerBy(reader(), job.onChainId);
      if (answerBy === undefined) throw new Error("a delivered job has no time to answer by");
      expect(message?.text).toContain(whenInAMail(new Date(Number(answerBy) * 1000)));
      expect((await recordOf(job.jobId)).told?.delivered, "written down with the job, so a worker that starts again does not send it twice").toMatch(/^\d{4}-/);
      // the address is the set-up's alone: nothing of it is in the record a page is drawn from
      expect(JSON.stringify(await recordOf(job.jobId), (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value))).not.toContain("the-poster@example.com");
      await until(told(), said, async () => true);
      expect(mail.sent).toHaveLength(1);

      // a poster who left no address: delivered all the same, and the mail service is never asked
      const asked = mail.asked();
      const quiet = await aJob("last-word-told-nothing", WORKING, await aPoster());
      await setUp(quiet);
      const forQuiet = told();
      await until(forQuiet, said, async () => (await stateOf(quiet.onChainId)) === "delivered");
      for (let look = 0; look < 3; look += 1) { await forQuiet.tick(); await forQuiet.whenIdle(); }
      expect(mail.asked()).toBe(asked);
      expect((await recordOf(quiet.jobId)).told).toBeUndefined();
    } finally {
      mail.stop();
    }
  }, 600_000);

  test("mail the service will not take is said once and tried again; the delivery waits on none of it, and the message goes out once the service is well", async () => {
    const said: string[] = [];
    const mail = brevoSaying();
    const preparing = new PreparingStore(await mkdtemp(join(tmpdir(), "pod-last-word-preparing-")));
    try {
      const job = await aJob("last-word-mail-refused", WORKING, await aPoster());
      await preparing.saveSetUp({
        onChainId: String(job.onChainId), jobs, name: job.jobId, poster: addressOf(job.poster), mode: "flash", salt: "0".repeat(32),
        setUpAt: new Date().toISOString(), tell: "gone@example.com",
      });
      mail.refuse(503, "the service is having a bad moment for gone@example.com");
      const worker = aWorker(said, undefined, {
        preparing, site: "https://pod.example", mailer: brevo({ key: "a-key", from: "pod@example.org", endpoint: mail.endpoint }), mailAgainAfterMs: 0,
      });
      await until(worker, said, async () => mail.asked() >= 3);

      expect(mail.sent).toHaveLength(0);
      expect((await recordOf(job.jobId)).told, "nothing is written down as sent that was not").toBeUndefined();
      expect(said.filter((line) => line.includes("could not be told by mail")), "said once, however often it is tried").toHaveLength(1);
      expect(said.join("\n"), "and never with the address, even when the service repeats it").not.toContain("gone@example.com");
      // the job is where it was: delivered, and waiting for its poster
      expect(await stateOf(job.onChainId)).toBe("delivered");

      mail.recover();
      await until(worker, said, async () => mail.sent.length > 0);
      for (let look = 0; look < 3; look += 1) { await worker.tick(); await worker.whenIdle(); }
      expect(mail.sent.map((message) => message.to)).toEqual(["gone@example.com"]);
      expect((await recordOf(job.jobId)).told?.delivered).toMatch(/^\d{4}-/);
    } finally {
      mail.stop();
    }
  }, 600_000);

  test("a poster who says nothing: once their time has run out the worker settles the job as its checks found", async () => {
    const said: string[] = [];
    const passed = await delivered("last-word-silent-pass", WORKING, await aPoster(), said);
    const failed = await delivered("last-word-silent-failure", NEVER_A_COAT, await aPoster(), said);
    const leadBefore = await balance(passed.pod.lead.address);
    const leadPay = await seatPay(reader(), passed.onChainId, "lead");
    const leadDeposit = await seatDeposit(reader(), passed.onChainId, "lead");
    const failedPosterBefore = await balance(addressOf(failed.poster));
    // the whole pod stood behind it, the builder by putting it forward
    const forfeited = (await Promise.all(SEATS.map((role) => seatDeposit(reader(), failed.onChainId, role)))).reduce((sum, deposit) => sum + deposit, 0n);

    await theClockMovesOn(ANSWER_SECONDS + 1n);

    await until(aWorker(said), said, async () =>
      (await recordOf(passed.jobId)).chain?.tokenId !== undefined && (await recordOf(failed.jobId)).chain?.answer !== undefined);

    expect(await stateOf(passed.onChainId)).toBe("settled");
    expect(await balance(passed.pod.lead.address)).toBe(leadBefore + leadPay + leadDeposit);
    expect((await recordOf(passed.jobId)).chain?.answer?.how).toBe("unanswered");

    expect(await stateOf(failed.onChainId)).toBe("refunded");
    // the validator's key deployed nothing here and paid no gas from the poster's wallet: the refund arrives whole
    expect(await balance(addressOf(failed.poster))).toBe(failedPosterBefore + PRICE + forfeited);
    expect((await recordOf(failed.jobId)).chain?.answer?.how).toBe("unanswered");
    expect((await recordOf(failed.jobId)).chain?.tokenId).toBeUndefined();
    expect(await readPosterRecord(reader(), addressOf(passed.poster))).toMatchObject({ posted: 1, unanswered: 1 });
  }, 420_000);
});
