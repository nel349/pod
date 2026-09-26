import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEther, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CheckWriting, ProvenChecks } from "../checkwriting/index.ts";
import { sealSpec } from "../job.ts";
import { post, readJob } from "../jobs.ts";
import { readerFor } from "../posting.ts";
import { openJob } from "../publish.ts";
import { refundPath } from "../routes.ts";
import { serve } from "../server.ts";
import { JobStore } from "../store.ts";
import { COPY } from "../web/refund/state/index.ts";
import { ANVIL_KEYS, anvilAvailable, startAnvil, type Anvil } from "./support/anvil.ts";
import { Browser, browserAvailable } from "./support/browser.ts";
import { GOOD_REPLY, replying, writerWith } from "./support/coat.ts";
import { POSTER, TITLED_SPEC } from "./support/titled.ts";
import { VALIDATOR } from "./support/podServer.ts";
import { walletInThePage } from "./support/wallet.ts";

/**
 * A poster takes back the money for a job that was never settled, from a browser, with their own
 * wallet (the rest of 11A). Everything is real: the page, the wallet, the contract and the chain's
 * clock. Nobody took a seat on these jobs, so neither could ever be settled.
 *
 * SCREENSHOTS, when set, names a folder the page is photographed into at each state, for a person to look at.
 */

const available = (await anvilAvailable()) && (await browserAvailable());

const POSTED_BY = privateKeyToAccount(POSTER).address;
/** another of the local chain's accounts, which signs for itself and posted nothing */
const STRANGER = privateKeyToAccount(ANVIL_KEYS[2]).address;
const CLOSED = "a-coat-nobody-finished";
const OPEN = "a-coat-still-open";
const PRICE = parseEther("1");

let anvil: Anvil;
let jobs: Address;
let base = "";
let server: { stop: () => void } | undefined;
let browser: Browser | undefined;
const onChainIds = new Map<string, bigint>();

async function aJobNobodyTook(store: JobStore, jobId: string): Promise<void> {
  const now = (await anvil.publicClient.getBlock()).timestamp;
  const seal = await sealSpec(TITLED_SPEC);
  const onChainId = await post({ address: jobs, publicClient: anvil.publicClient, wallet: anvil.wallet(POSTER) }, { seal, endsAt: now + 3600n, reviewers: 1, price: PRICE });
  const opened = await openJob(store, { jobId, seal, spec: TITLED_SPEC, endsAt: new Date(Number(now + 3600n) * 1000), seats: [] });
  await store.save({ ...opened, chain: { network: "monad-testnet", jobId: String(onChainId), jobs } });
  onChainIds.set(jobId, onChainId);
}

beforeAll(async () => {
  if (!available) return;
  anvil = await startAnvil();
  jobs = await anvil.deploy("PodJobs", [privateKeyToAccount(VALIDATOR).address]);
  const store = new JobStore(await mkdtemp(join(tmpdir(), "pod-refund-")));
  // one job whose window then closes, and one posted after, whose window is still open
  await aJobNobodyTook(store, CLOSED);
  await anvil.publicClient.request({ method: "evm_increaseTime" as never, params: [7200] as never });
  await anvil.publicClient.request({ method: "evm_mine" as never, params: [] as never });
  await aJobNobodyTook(store, OPEN);

  const proven = new ProvenChecks(await mkdtemp(join(tmpdir(), "pod-proven-")));
  const serving = serve(store, 0, {
    market: {
      page: { chainId: 31337, chainName: "a local chain", rpc: anvil.rpc, jobs, explorer: "http://explorer.invalid", coin: "ETH" },
      chain: readerFor({ jobs, read: (id) => readJob({ address: jobs, publicClient: anvil.publicClient }, id) }),
      writing: new CheckWriting({ writer: writerWith(replying(GOOD_REPLY).model), proven }),
      proven,
    },
  });
  server = serving;
  base = `http://127.0.0.1:${serving.port}`;
}, 120_000);

afterEach(async () => {
  await browser?.stop();
  browser = undefined;
});

afterAll(() => {
  server?.stop();
  anvil?.stop();
});

async function openTheRefund(jobId: string, as: Address): Promise<Browser> {
  browser = await Browser.start();
  await browser.resize(1440, 900);
  await browser.beforeEveryPage(walletInThePage({ rpc: anvil.rpc, address: as, chainId: 31337, startsOn: 31337 }));
  await browser.open(base + refundPath(jobId));
  await browser.until(`document.querySelector("#standing")`, "the job's standing to appear");
  return browser;
}

async function photograph(page: Browser, name: string): Promise<void> {
  const folder = process.env.SCREENSHOTS;
  if (folder) await page.screenshot(join(folder, `refund-${name}.png`));
}

const SAYS = `document.querySelector("#said").textContent + " | " + [...document.querySelectorAll("#progress li")].map((l) => l.dataset.state).join(" ")`;
const text = (page: Browser, selector: string): Promise<string> => page.evaluate<string>(`document.querySelector(${JSON.stringify(selector)}).textContent`);
const isDisabled = (page: Browser): Promise<boolean> => page.evaluate<boolean>(`document.querySelector("#refund").disabled`);

describe.skipIf(!available)("taking the money back from a browser", () => {
  test("while the window is open, the page says until when, and there is nothing to press", async () => {
    const page = await openTheRefund(OPEN, POSTED_BY);
    await page.until(`document.querySelector("#standing").dataset.standing === "too early"`, "the job to read as too early");
    expect(await text(page, "#standing")).toStartWith("The window is open until");
    expect(await isDisabled(page)).toBe(true);
    await photograph(page, "too-early");
  }, 120_000);

  test("anybody but the poster is told so before they press, and the contract's refusal is said in words", async () => {
    const page = await openTheRefund(CLOSED, STRANGER);
    await page.until(`document.querySelector("#standing").dataset.standing === "ready"`, "the job to read as ready");
    await page.click("#refund");
    await page.until(`document.querySelector("#said").textContent.length > 0`, "the refusal to be said", 60, SAYS);
    expect(await text(page, "#said")).toBe(COPY.take.refused.NotPoster);
    await page.until(`document.querySelector("#not-poster")`, "the warning to appear");
    expect(await text(page, "#not-poster")).toBe(COPY.take.notPoster(STRANGER, POSTED_BY));
    // and the money has not moved: the job is still as nobody left it
    expect((await readJob({ address: jobs, publicClient: anvil.publicClient }, onChainIds.get(CLOSED) ?? 0n)).state).toBe("open");
    await photograph(page, "not-the-poster");
  }, 120_000);

  test("the poster presses, the money comes back, and the page says so", async () => {
    const before = await anvil.publicClient.getBalance({ address: POSTED_BY });
    const page = await openTheRefund(CLOSED, POSTED_BY);
    await page.until(`document.querySelector("#standing").dataset.standing === "ready"`, "the job to read as ready");
    expect(await isDisabled(page)).toBe(false);
    await photograph(page, "ready");
    await page.click("#refund");
    await page.until(`document.querySelector("#said").classList.contains("done")`, "the refund to be done", 60, SAYS);
    expect(await text(page, "#said")).toContain(COPY.take.done(PRICE, "ETH"));
    await page.until(`document.querySelector("#standing").dataset.standing === "refunded"`, "the job to read as refunded");
    expect((await readJob({ address: jobs, publicClient: anvil.publicClient }, onChainIds.get(CLOSED) ?? 0n)).state).toBe("refunded");
    // the price came back, less what the transaction cost
    expect(await anvil.publicClient.getBalance({ address: POSTED_BY })).toBeGreaterThan(before + PRICE - parseEther("0.01"));
    expect(await isDisabled(page)).toBe(true);
    await photograph(page, "done");
  }, 120_000);
});
