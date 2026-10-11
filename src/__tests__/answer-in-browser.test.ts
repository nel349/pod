import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestClient, http, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sealSpec, type Role, type Spec } from "../job.ts";
import { approve, readJob, seatDeposit, seatPay, takeSeat, type Contract } from "../jobs.ts";
import { checksDigest, podJobsV2Abi } from "../jobsV2.ts";
import { putForward, readAnswerBy, readHowItEnded, report, REFUSAL_SHARE_PERCENT, REVIEW_SHARE_PERCENT, readRefusalShare, readReviewShare } from "../jobsV3.ts";
import { openJob } from "../publish.ts";
import { signReceipt } from "../receipt.ts";
import { commitToBytes32 } from "../repo.ts";
import { JobListingSchema } from "../door/index.ts";
import { jobPath, ROUTES } from "../routes.ts";
import { IMAGE } from "../sandbox.ts";
import { SEATS } from "../seal.ts";
import { serve } from "../server.ts";
import { servicesFor } from "../services.ts";
import type { Services } from "../server.ts";
import { JobStore } from "../store.ts";
import { agentAnsweredWords, agentRecordWords, inCoins, posterRecordWords, SITE } from "../web/site/copy.ts";
import { keptOnRefusal, paidOnAcceptance } from "../web/site/views/index.ts";
import { shortAddress } from "../web/shared/copy.ts";
import { ANVIL_KEYS, anvilAvailable, startAnvil, type Anvil } from "./support/anvil.ts";
import { Browser, browserAvailable } from "./support/browser.ts";
import { COAT_IDEA, DRY, GOOD_REPLY, replying, WET, writerWith } from "./support/coat.ts";
import { aPod } from "./support/podServer.ts";
import { deployRegistries } from "./support/registries.ts";
import { walletInThePage } from "./support/wallet.ts";

/**
 * A poster answers a delivery from a browser, with their own wallet: yes, and the pod is paid; no, and
 * the pod keeps a quarter of work whose checks passed. Everything is real: the page, the server built
 * as it is from its settings, the contract and its money. The wallet is the standard browser interface
 * backed by a chain whose accounts sign for themselves. The work itself is not graded here: the
 * validator's report is sent as the worker sends one, which is what the worker's own tests are about.
 *
 * SCREENSHOTS, when set, names a folder the page is photographed into at each state, for a person to look at.
 */
const available = (await anvilAvailable()) && (await browserAvailable());

const [DEPLOYER, VALIDATOR, WRITER, POSTER, STRANGER] = [ANVIL_KEYS[0], ANVIL_KEYS[6], ANVIL_KEYS[4], ANVIL_KEYS[1], ANVIL_KEYS[3]];
const POSTED_BY = privateKeyToAccount(POSTER).address;
const PRICE = parseEther("1");
const WRITING = parseEther("0.05");
const HOUR = 3600n;
const COMMIT = "c0ffee1234abcdef0123456789abcdef01234567";
/** the roles whose approval the policy asks for: the builder builds, and does not approve */
const APPROVERS: readonly Role[] = ["lead", "reviewer", "qa", "security"];
/** how long the other seats have to say whether they stand behind what the builder put forward: a quarter of the hour every job here is posted for */
const REVIEW_SECONDS = HOUR / 4n;
const SPEC: Spec = {
  idea: COAT_IDEA, kind: "service", mode: "flash", price: PRICE,
  checks: [
    { says: WET, run: "node check-1.mjs", hidden: false, file: "check-1.mjs" },
    { says: DRY, run: "node check-2.mjs", hidden: true, file: "check-2.mjs" },
  ],
  allowed: [], salt: "set for each job",
};

let anvil: Anvil;
let jobs: Address;
let store: JobStore;
let services: Services;
let base = "";
let server: { stop: () => void } | undefined;
let browser: Browser | undefined;

const contractAs = (key: Hex): Contract => ({ address: jobs, publicClient: anvil.publicClient, wallet: anvil.wallet(key) });
const balance = (address: Address): Promise<bigint> => anvil.publicClient.getBalance({ address });

beforeAll(async () => {
  if (!available) return;
  anvil = await startAnvil();
  const validator = privateKeyToAccount(VALIDATOR).address;
  const old = await anvil.deploy("PodJobs", [validator], DEPLOYER);
  jobs = await anvil.deploy("PodJobsV3", [validator, privateKeyToAccount(WRITER).address, 20n, WRITING, 100_000n, 4n * HOUR], DEPLOYER);
  const registries = await deployRegistries(anvil);
  const directory = await mkdtemp(join(tmpdir(), "pod-answer-page-"));
  store = new JobStore(directory);
  services = await servicesFor({
    store, directory, publicClient: anvil.publicClient,
    page: { chainId: 31337, chainName: "a local chain", rpc: anvil.rpc, explorer: "http://explorer.invalid", coin: "ETH", registries },
    registries, jobs, earlier: old, writer: anvil.wallet(WRITER), checkWriter: writerWith(replying(GOOD_REPLY).model),
  });
  const serving = serve(store, 0, services);
  server = serving;
  base = `http://127.0.0.1:${serving.port}`;
}, 120_000);

afterEach(async () => {
  await browser?.stop();
  browser = undefined;
});

afterAll(async () => {
  server?.stop();
  await services?.preparing?.whenIdle();
  anvil?.stop();
});

/** A job paid for and approved, on the wall and open to a pod, with nobody seated: what an agent looking for work finds. */
async function anOpenJob(jobId: string): Promise<{ readonly jobId: string; readonly onChainId: bigint }> {
  const { onChainId, seal, spec } = await paidAndApproved(jobId);
  const onChain = await readJob(contractAs(POSTER), onChainId);
  const opened = await openJob(store, { jobId, seal, spec, endsAt: new Date(Number(onChain.endsAt) * 1000), seats: SEATS.map((role) => ({ role })) });
  await store.save({ ...opened, chain: { network: "monad-testnet", jobId: String(onChainId), jobs }, poster: POSTED_BY });
  await store.saveSpec(jobId, spec);
  return { jobId, onChainId };
}

/** A job its poster paid for and whose checks they approved, with the writer's signature, as the page does it. */
async function paidAndApproved(jobId: string): Promise<{ readonly onChainId: bigint; readonly seal: Hex; readonly spec: Spec }> {
  const spec: Spec = { ...SPEC, salt: jobId };
  const poster = contractAs(POSTER);
  const { request, result: onChainId } = await anvil.publicClient.simulateContract({
    address: jobs, abi: podJobsV2Abi, functionName: "post", args: [HOUR, 1], value: PRICE + 3n * WRITING, account: privateKeyToAccount(POSTER),
  });
  await anvil.publicClient.waitForTransactionReceipt({ hash: await poster.wallet.writeContract(request) });
  const seal = await sealSpec(spec);
  const writer = anvil.wallet(WRITER);
  const signature = await writer.signMessage({ account: writer.account, message: { raw: checksDigest({ jobs, chainId: 31337, jobId: onChainId, seal }) } });
  const opening = await anvil.publicClient.simulateContract({
    address: jobs, abi: podJobsV2Abi, functionName: "approveChecks", args: [onChainId, seal, signature], account: privateKeyToAccount(POSTER),
  });
  await anvil.publicClient.waitForTransactionReceipt({ hash: await poster.wallet.writeContract(opening.request) });
  return { onChainId, seal, spec };
}

interface Delivered {
  readonly jobId: string;
  readonly onChainId: bigint;
  readonly lead: Address;
  readonly security: Address;
}

/**
 * A job as the worker leaves it at delivery: paid for, its checks approved, a pod seated and agreed on
 * a commit, the validator's report on the chain, and its record saying what the checks found.
 */
async function aDeliveredJob(jobId: string, passed: boolean, behindIt: readonly Role[] = APPROVERS): Promise<Delivered> {
  const { onChainId, seal, spec } = await paidAndApproved(jobId);
  const poster = contractAs(POSTER);

  const pod = aPod();
  for (const agent of Object.values(pod)) await anvil.fund(agent.address);
  for (const role of SEATS) await takeSeat(contractAs(pod[role].key), onChainId, role, pod[role].address);
  await putForward(contractAs(pod.builder.key), onChainId, commitToBytes32(COMMIT));
  for (const role of behindIt) await approve(contractAs(pod[role].key), onChainId, role, commitToBytes32(COMMIT));
  // short of the whole pod, it is graded once the time for reviewing it has run out, on the chain's own clock
  if (behindIt.length < APPROVERS.length) {
    const clock = createTestClient({ mode: "anvil", transport: http(anvil.rpc) });
    await clock.increaseTime({ seconds: Number(REVIEW_SECONDS) + 1 });
    await clock.mine({ blocks: 1 });
  }
  // who stands behind it, as the worker writes it down from the contract when it grades: the builder, and the seats that said yes
  const behind = SEATS.filter((role) => role === "builder" || behindIt.includes(role));

  const signed = await signReceipt({
    version: "pod.receipt.v1", seal, commit: COMMIT, repository: "https://example.invalid/the-work",
    tree: `0x${"0".repeat(64)}`, image: IMAGE, start: "node server.js",
    checks: spec.checks.map((check) => ({ says: check.says, command: check.run, exitCode: passed || !check.hidden ? 0 : 1, seconds: 1, hidden: check.hidden })),
    runs: 2, verdict: passed ? "passed" : "failed", allowedHosts: [], undeclaredCalls: [],
    runner: privateKeyToAccount(VALIDATOR).address, finishedAt: new Date().toISOString(),
  }, VALIDATOR);
  const reported = await report(contractAs(VALIDATOR), onChainId, commitToBytes32(COMMIT), passed ? "passed" : "hidden-failed", signed.hash);
  const answerBy = await readAnswerBy(contractAs(VALIDATOR), onChainId);
  if (answerBy === undefined) throw new Error("the report gave the poster no time to answer");

  const onChain = await readJob(poster, onChainId);
  const opened = await openJob(store, { jobId, seal, spec, endsAt: new Date(Number(onChain.endsAt) * 1000), seats: [] });
  const { brief: _brief, ...rest } = opened;
  await store.save({
    ...rest,
    tile: {
      ...opened.tile, verdict: passed ? "passed" : "failed", commit: COMMIT, seconds: 2, finishedAt: signed.receipt.finishedAt,
      pod: SEATS.map((role) => ({ role, agent: pod[role].address, owner: pod[role].address })),
    },
    checksSaid: signed.receipt.checks.map((check) => ({ says: check.says, hidden: check.hidden, exitCode: check.exitCode })),
    approvals: behind.map((role) => ({ role, agent: pod[role].address, commit: COMMIT, at: new Date().toISOString() })),
    signed, poster: POSTED_BY,
    chain: { network: "monad-testnet", jobId: String(onChainId), jobs, reported, answerBy: new Date(Number(answerBy) * 1000).toISOString() },
  });
  return { jobId, onChainId, lead: pod.lead.address, security: pod.security.address };
}

async function openTheJob(jobId: string, as: Address): Promise<Browser> {
  browser = await Browser.start();
  await browser.resize(1440, 1100);
  await browser.beforeEveryPage(walletInThePage({ rpc: anvil.rpc, address: as, chainId: 31337 }));
  await browser.open(base + jobPath(jobId));
  await browser.until(`document.querySelector("#stands")`, "the job's page to appear");
  // the wallet's panel, and in it the wallet already in the browser, as a person would pick it
  await browser.until(`document.querySelector("#connect-wallet")`, "the button that connects a wallet");
  await browser.click("#connect-wallet");
  await browser.until(`document.querySelector("#browser-wallet")`, "the wallet's panel to open");
  await browser.click("#browser-wallet");
  await browser.until(`document.querySelector(".wallet .who")`, "the wallet to connect");
  return browser;
}

async function photograph(page: Browser, name: string): Promise<void> {
  const folder = process.env.SCREENSHOTS;
  if (folder) await page.screenshot(join(folder, `answer-${name}.png`));
}

const SAID = `document.querySelector("#answer-said")?.textContent ?? ""`;
/** what the page was drawn from and what it shows, for when it never offers what a test waits for */
const DRAWN = `(document.querySelector("#stands")?.innerText ?? "") + " | " + JSON.stringify((({ poster, chain, delivery, answer }) => ({ poster, chain, delivery, answer }))(JSON.parse(document.querySelector("#pod-data").textContent).job ?? {})) + " | market " + (JSON.parse(document.querySelector("#pod-data").textContent).market !== undefined)`;
const text = (page: Browser, selector: string): Promise<string> => page.evaluate<string>(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ""`);
const stateOf = async (onChainId: bigint) => (await readJob(contractAs(VALIDATOR), onChainId)).state;
const coins = (wei: bigint): string => inCoins(wei.toString(), "ETH");

describe.skipIf(!available)("a poster answers a delivery from a browser", () => {
  test("what a page says a refusal leaves the pod is what the contract leaves it", async () => {
    expect(await readRefusalShare(contractAs(VALIDATOR))).toBe(REFUSAL_SHARE_PERCENT);
    // and how long a review is said to be is what the contract makes it: that share of a job's window
    expect(await readReviewShare(contractAs(VALIDATOR))).toBe(REVIEW_SHARE_PERCENT);
  });

  test("the poster is offered both answers, with what each does to the money, and yes pays the pod", async () => {
    const job = await aDeliveredJob("a-coat-accepted", true);
    const page = await openTheJob(job.jobId, POSTED_BY);
    await page.until(`document.querySelector("#your-answer")`, "the poster's answer to be offered", 30, DRAWN);
    const kept = keptOnRefusal(PRICE, SEATS, true);
    expect(await text(page, "#behind-it")).toBe(SITE.job.behind.wholePod);
    // said to the poster as "you", since the wallet here is theirs; and their time to answer is said once, in the panel
    expect(await text(page, "#stands .lede")).toBe(SITE.job.next.deliveredToYou.awaited.passed);
    expect(await text(page, "#stands")).not.toContain(SITE.job.answer.theirs);
    expect(await text(page, "#accept")).toBe(SITE.job.answer.accept(coins(PRICE)));
    expect(await text(page, "#your-answer")).toContain(SITE.job.answer.refuseSays.passed(coins(kept), coins(PRICE - kept)));
    expect(await text(page, "#your-answer")).toContain(SITE.job.answer.silence.passed);
    await photograph(page, "offered");

    const leadBefore = await balance(job.lead);
    const leadPay = await seatPay(contractAs(VALIDATOR), job.onChainId, "lead");
    await page.click("#accept");
    await page.until(`(${SAID}).includes(${JSON.stringify(SITE.job.answer.done.accept)})`, "the acceptance to be confirmed", 90, SAID);
    expect(await stateOf(job.onChainId)).toBe("settled");
    expect(await readHowItEnded(contractAs(VALIDATOR), job.onChainId)).toBe("accepted");
    expect(await balance(job.lead)).toBeGreaterThanOrEqual(leadBefore + leadPay);
    // nothing more to press: one answer to a job
    expect(await page.evaluate<boolean>(`document.querySelector("#accept").disabled && document.querySelector("#refuse").disabled`)).toBe(true);
    await photograph(page, "accepted");
  }, 180_000);

  test("no leaves the pod a quarter of work whose checks passed, and sends the rest back", async () => {
    const job = await aDeliveredJob("a-coat-refused", true);
    const page = await openTheJob(job.jobId, POSTED_BY);
    await page.until(`document.querySelector("#refuse")`, "the poster's answer to be offered");
    const leadBefore = await balance(job.lead);
    const leadPay = await seatPay(contractAs(VALIDATOR), job.onChainId, "lead");
    const posterBefore = await balance(POSTED_BY);

    await page.click("#refuse");
    await page.until(`(${SAID}).includes(${JSON.stringify(SITE.job.answer.done.refuse)})`, "the refusal to be confirmed", 90, SAID);
    expect(await stateOf(job.onChainId)).toBe("refunded");
    expect(await readHowItEnded(contractAs(VALIDATOR), job.onChainId)).toBe("refused");
    // the lead's quarter, and its deposit home
    expect(await balance(job.lead)).toBeGreaterThanOrEqual(leadBefore + (leadPay * BigInt(REFUSAL_SHARE_PERCENT)) / 100n);
    expect(await balance(job.lead)).toBeLessThan(leadBefore + leadPay);
    // three quarters back, less the gas of saying so
    const back = (await balance(POSTED_BY)) - posterBefore;
    expect(back).toBeGreaterThan((PRICE * 74n) / 100n);
    expect(back).toBeLessThanOrEqual(PRICE - keptOnRefusal(PRICE, SEATS, true));
  }, 180_000);

  test("work whose checks failed can still be accepted, and the page says a refusal would cost nothing", async () => {
    const job = await aDeliveredJob("a-coat-failed-and-accepted", false);
    const page = await openTheJob(job.jobId, POSTED_BY);
    await page.until(`document.querySelector("#your-answer")`, "the poster's answer to be offered", 30, DRAWN);
    expect(await text(page, "#stands .lede")).toBe(SITE.job.next.deliveredToYou.awaited.failed);
    expect(await text(page, "#your-answer")).toContain(SITE.job.answer.refuseSays.failed(coins(PRICE)));
    expect(await text(page, "#your-answer")).toContain(SITE.job.answer.silence.failed);

    await page.click("#accept");
    await page.until(`(${SAID}).includes(${JSON.stringify(SITE.job.answer.done.accept)})`, "the acceptance to be confirmed", 90, SAID);
    expect(await stateOf(job.onChainId)).toBe("settled");
  }, 180_000);

  test("with a seat that did not stand behind the work, the page says so and names what a yes really pays, and that is what it pays", async () => {
    // security held its seat and said nothing while the work was reviewed
    const behindIt: readonly Role[] = ["lead", "builder", "reviewer", "qa"];
    const job = await aDeliveredJob("a-coat-with-a-silent-seat", true, behindIt.filter((role) => role !== "builder"));
    const page = await openTheJob(job.jobId, POSTED_BY);
    await page.until(`document.querySelector("#your-answer")`, "the poster's answer to be offered", 30, DRAWN);

    const securitysShare = await seatPay(contractAs(VALIDATOR), job.onChainId, "security");
    const paid = paidOnAcceptance(PRICE, behindIt);
    expect(paid).toBe(PRICE - securitysShare);
    expect(await text(page, "#behind-it")).toBe("Its builder put it forward, and the lead, the reviewer and QA stand behind it. Security did not.");
    expect(await text(page, "#accept")).toBe(SITE.job.answer.accept(coins(paid)));
    expect(await text(page, "#your-answer")).toContain(SITE.job.answer.acceptSaysPart(coins(securitysShare)));
    const kept = keptOnRefusal(PRICE, behindIt, true);
    expect(await text(page, "#your-answer")).toContain(SITE.job.answer.refuseSays.passed(coins(kept), coins(PRICE - kept)));
    expect(await text(page, "#pod")).toContain(SITE.job.behind.doesNot);
    await photograph(page, "a-silent-seat");

    const leadBefore = await balance(job.lead);
    const securityBefore = await balance(job.security);
    const posterBefore = await balance(POSTED_BY);
    await page.click("#accept");
    await page.until(`(${SAID}).includes(${JSON.stringify(SITE.job.answer.done.accept)})`, "the acceptance to be confirmed", 90, SAID);
    // what the button said is what moved: the seats behind it paid, the silent seat its deposit and no more, its share back to the poster
    expect(await balance(job.lead)).toBe(leadBefore + (await seatPay(contractAs(VALIDATOR), job.onChainId, "lead")) + (await seatDeposit(contractAs(VALIDATOR), job.onChainId, "lead")));
    expect(await balance(job.security)).toBe(securityBefore + (await seatDeposit(contractAs(VALIDATOR), job.onChainId, "security")));
    const back = (await balance(POSTED_BY)) - posterBefore;
    expect(back).toBeLessThanOrEqual(securitysShare);
    expect(back).toBeGreaterThan((securitysShare * 9n) / 10n);
  }, 180_000);

  test("anybody but the poster is told who can answer, and is offered neither button", async () => {
    const job = await aDeliveredJob("a-coat-somebody-elses", true);
    const stranger = privateKeyToAccount(STRANGER).address;
    const page = await openTheJob(job.jobId, stranger);
    await page.until(`document.querySelector("#stands .not-their-wallet")`, "the page to say whose answer it is");
    expect(await text(page, "#stands .not-their-wallet p")).toBe(SITE.job.answer.notYours(shortAddress(stranger), shortAddress(POSTED_BY)));
    expect(await page.evaluate<boolean>(`document.querySelector("#accept") === null && document.querySelector("#refuse") === null`)).toBe(true);
    // and everybody is told until when, and what silence does
    expect(await text(page, "#stands")).toContain(SITE.job.answer.theirSilence.passed);
    expect(await stateOf(job.onChainId)).toBe("delivered");
    await photograph(page, "somebody-elses");
  }, 180_000);

  // the delivery above still waits: its poster finds it among their jobs, with the one thing to do on it
  test("the poster's own page lists a delivery that waits for them, with the way to answer it", async () => {
    const waiting = "a-coat-somebody-elses";
    const page = await openTheJob(waiting, POSTED_BY);
    await page.open(base + ROUTES.yours);
    const entry = `[...document.querySelectorAll("#posted .yours-list li")].find((one) => one.querySelector(${JSON.stringify(`a[href="${jobPath(waiting)}"]`)}))`;
    await page.until(`${entry}?.querySelector("a.primary")`, "the waiting delivery, with its button, on their own page", 30);
    expect(await page.evaluate<string>(`${entry}.querySelector("a.primary").textContent`)).toBe(SITE.yours.answerIt);
    expect(await page.evaluate<string>(`${entry}.querySelector("a.primary").getAttribute("href")`)).toBe(jobPath(waiting));
    expect(await page.evaluate<string>(`${entry}.innerText`)).toContain(SITE.job.answer.until);
    await photograph(page, "my-jobs");
  }, 180_000);

  // after the answers above: this poster has by now accepted three deliveries and refused one that passed
  test("a poster's record, as the contract counts it, is on the job's page and in the list agents read before taking a seat", async () => {
    const counted = { posted: 6, accepted: 3, refusedPassed: 1, refusedFailed: 0, unanswered: 0 };
    const open = await anOpenJob("a-coat-nobody-has-taken");

    const listing = JobListingSchema.parse(await (await fetch(base + ROUTES.jobList)).json());
    const listed = listing.jobs.find((job) => job.jobId === open.jobId);
    expect(listed?.poster).toEqual({ address: POSTED_BY, record: counted });

    const html = await (await fetch(base + jobPath(open.jobId))).text();
    expect(html).toContain(posterRecordWords(counted));
    expect(posterRecordWords(counted)).toBe("Of 6 jobs this wallet has posted here, it has refused 1 whose checks passed and accepted 3.");
  }, 180_000);

  test("each seat's agent carries how its earlier jobs ended, beside its address", async () => {
    // the pod of a job its poster accepted: every seat was paid, and that is counted for each
    const html = await (await fetch(base + jobPath("a-coat-accepted"))).text();
    const paidOnce = agentRecordWords({ accepted: 1, paidUnanswered: 0, refusedPassed: 0, failed: 0, undelivered: 0 });
    expect(paidOnce).toBe("before this: 1 paid");
    expect(html.split(`<span class="seat-record">${paidOnce}</span>`).length - 1).toBe(SEATS.length);
  }, 60_000);

  test("an agent's own page says what the posters of its jobs said, a refusal of passed work as plainly as a payment", async () => {
    const leadOf = async (jobId: string): Promise<string> => {
      const lead = (await store.read(jobId))?.tile.pod.find((seat) => seat.role === "lead")?.agent;
      if (!lead) throw new Error(`${jobId} has no lead`);
      return lead;
    };
    const nothing = { accepted: 0, paidUnanswered: 0, refusedPassed: 0, failed: 0, undelivered: 0 };

    const refused = await (await fetch(base + ROUTES.agent + await leadOf("a-coat-refused"))).text();
    expect(agentAnsweredWords({ ...nothing, refusedPassed: 1 })).toBe("Of the jobs it held a seat on: 1 refused although the checks passed.");
    expect(refused).toContain(agentAnsweredWords({ ...nothing, refusedPassed: 1 }));

    const accepted = await (await fetch(base + ROUTES.agent + await leadOf("a-coat-accepted"))).text();
    expect(accepted).toContain(agentAnsweredWords({ ...nothing, accepted: 1 }));
  }, 60_000);
});
