import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { sealSpec } from "../job.ts";
import { post, readJob } from "../jobs.ts";
import { ownersFrom } from "../owners.ts";
import { readerFor } from "../posting.ts";
import { openJob } from "../publish.ts";
import { jobPath, ROUTES } from "../routes.ts";
import { serve, type Market } from "../server.ts";
import { JobStore } from "../store.ts";
import { CheckWriting, ProvenChecks } from "../checkwriting/index.ts";
import { SITE } from "../web/site/copy.ts";
import { Browser, browserAvailable } from "./support/browser.ts";
import { ANVIL_KEYS, anvilAvailable, startAnvil, type Anvil } from "./support/anvil.ts";
import { walletInThePage } from "./support/wallet.ts";
import { GOOD_REPLY, replying, writerWith } from "./support/coat.ts";
import { TITLED_SPEC } from "./support/titled.ts";

/**
 * The pages the server draws, in a real browser: taken over by the same components without a word
 * changing, following a running job without a reload, and knowing the reader by their wallet.
 *
 * The chain is a real local one and the wallet is the standard browser interface in front of it.
 */

const available = (await anvilAvailable()) && (await browserAvailable());
const POSTER = privateKeyToAccount(ANVIL_KEYS[1]).address;
const LEAD = "0x00000000000000000000000000000000000000a1";

let anvil: Anvil;
let store: JobStore;
let base = "";
let server: { stop: () => void } | undefined;
let browser: Browser | undefined;
let market: Market | undefined;

/** Anything React or the page said went wrong, kept where a test can read it. */
const CATCH_ERRORS = `(() => {
  window.__errors = [];
  const said = console.error.bind(console);
  console.error = (...args) => { window.__errors.push(args.map(String).join(" ")); said(...args); };
  window.addEventListener("error", (event) => window.__errors.push(String(event.message)));
})();`;

beforeAll(async () => {
  if (!available) return;
  anvil = await startAnvil();
  const jobs = await anvil.deploy("PodJobs", [privateKeyToAccount(ANVIL_KEYS[6]).address]);
  store = new JobStore(await mkdtemp(join(tmpdir(), "pod-site-")));
  const reader = readerFor({ jobs, read: (id) => readJob({ address: jobs, publicClient: anvil.publicClient }, id) });
  const proven = new ProvenChecks(join(await mkdtemp(join(tmpdir(), "pod-site-proven-")), "proven"));
  market = {
    page: { chainId: 31337, chainName: "a local chain", rpc: anvil.rpc, jobs, explorer: "http://explorer.invalid", coin: "ETH" },
    chain: reader,
    writing: new CheckWriting({ writer: writerWith(replying(GOOD_REPLY).model), proven }),
    proven,
  };

  // a job its poster paid for on the chain, open and waiting for a pod
  const now = (await anvil.publicClient.getBlock()).timestamp;
  const seal = await sealSpec(TITLED_SPEC);
  const onChainId = await post({ address: jobs, publicClient: anvil.publicClient, wallet: anvil.wallet(ANVIL_KEYS[1]) }, {
    seal, endsAt: now + 3600n, reviewers: 1, price: TITLED_SPEC.price,
  });
  const opened = await openJob(store, { jobId: "a-coat", seal, spec: TITLED_SPEC, endsAt: new Date(Number(now + 3600n) * 1000), seats: [] });
  await store.save({ ...opened, chain: { network: "monad-testnet", jobId: String(onChainId), jobs }, poster: POSTER });

  const serving = serve(store, 0, { market, owners: ownersFrom({ job: reader.job }) });
  server = serving;
  if (serving.port === undefined) throw new Error("the server did not say which port it took");
  base = `http://127.0.0.1:${serving.port}`;
}, 120_000);

afterEach(async () => {
  await browser?.stop();
  browser = undefined;
});

afterAll(async () => {
  server?.stop();
  await market?.writing.whenIdle();
  anvil?.stop();
});

/** the header's wallet, in whichever state: drawn only once the page is the browser's */
const TAKEN_OVER = ".wallet button, .wallet .who, .wallet .none";

async function openAt(path: string, withWallet: boolean): Promise<Browser> {
  browser = await Browser.start();
  await browser.beforeEveryPage(CATCH_ERRORS);
  if (withWallet) await browser.beforeEveryPage(walletInThePage({ rpc: anvil.rpc, address: POSTER, chainId: 31337 }));
  await browser.open(base + path);
  await browser.until(`document.querySelector(${JSON.stringify(TAKEN_OVER)})`, "the page to be taken over, wallet and all");
  return browser;
}

const errors = (page: Browser): Promise<readonly string[]> => page.evaluate<readonly string[]>("window.__errors");
const text = (page: Browser, selector: string): Promise<string> =>
  page.evaluate<string>(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ""`);

describe.skipIf(!available)("the pages the server draws, in a browser", () => {
  test("the wall and a job are taken over by the browser with nothing redrawn and nothing said wrong", async () => {
    const page = await openAt(ROUTES.wall, false);
    expect(await text(page, ".flyers")).toContain(TITLED_SPEC.idea);
    await page.open(base + jobPath("a-coat"));
    await page.until(`document.querySelector(${JSON.stringify(TAKEN_OVER)})`, "the job page to be taken over");
    expect(await text(page, "#stands")).toContain(SITE.job.next.waiting);
    expect(await errors(page)).toEqual([]);
  }, 120_000);

  test("a running job's page follows it: a seat taken and a verdict appear without a reload", async () => {
    const page = await openAt(jobPath("a-coat"), false);
    expect(await text(page, "#pod")).not.toContain("0x0000…00a1");
    await page.evaluate(`window.__sameDocument = true`);

    const record = (await store.read("a-coat"))!;
    await store.save({ ...record, tile: { ...record.tile, pod: [{ role: "lead", agent: LEAD, owner: LEAD }] } });
    await page.until(`document.querySelector("#pod").textContent.includes("0x0000…00a1")`, "the seat to appear", 30);
    expect(await text(page, "#stands")).toContain(SITE.job.next.building(1));

    await store.save({ ...record, tile: { ...record.tile, verdict: "failed", pod: [{ role: "lead", agent: LEAD, owner: LEAD }] } });
    await page.until(`document.querySelector("#stands").textContent.includes(${JSON.stringify(SITE.job.next.failed)})`, "the verdict to appear", 30);
    // the same page all along, not a reload
    expect(await page.evaluate<boolean>("window.__sameDocument === true")).toBe(true);
    await store.save(record);
  }, 120_000);

  test("with the poster's wallet connected, their job says it is theirs, and their own page lists it", async () => {
    const page = await openAt(jobPath("a-coat"), true);
    await page.click(".wallet button");
    await page.until(`document.querySelector(".wallet .who")`, "the wallet to connect");
    await page.until(`document.querySelector(".yours-marks")?.textContent.includes(${JSON.stringify(SITE.job.yourJob)})`, "the job to say it is theirs");
    expect(await text(page, "#stands")).toContain(SITE.job.money.heldYours);

    await page.open(base + ROUTES.yours);
    await page.until(`document.querySelector("#posted")?.textContent.includes(${JSON.stringify(TITLED_SPEC.idea)})`, "their job on their own page", 30);
    expect(await text(page, "#posted")).toContain(SITE.job.money.heldUntil);
    expect(await errors(page)).toEqual([]);
  }, 120_000);

  test("on a phone no page scrolls sideways", async () => {
    const page = await openAt(ROUTES.wall, false);
    await page.resize(390, 844);
    for (const path of [ROUTES.wall, jobPath("a-coat"), ROUTES.yours, jobPath("nowhere")]) {
      await page.open(base + path);
      expect(await page.evaluate<boolean>("document.documentElement.scrollWidth <= document.documentElement.clientWidth")).toBe(true);
    }
  }, 120_000);
});
