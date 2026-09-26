import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { CheckWriting, ProvenChecks } from "../checkwriting/index.ts";
import { readJob } from "../jobs.ts";
import { readerFor } from "../posting.ts";
import { Claims } from "../claims.ts";
import { claimPath } from "../routes.ts";
import { serve } from "../server.ts";
import type { JobStore } from "../store.ts";
import { COPY } from "../web/claim/state/index.ts";
import { ANVIL_KEYS, anvilAvailable, startAnvil, type Anvil } from "./support/anvil.ts";
import { Browser, browserAvailable } from "./support/browser.ts";
import { GOOD_REPLY, replying, writerWith } from "./support/coat.ts";
import { aTitledJob, POSTER } from "./support/titled.ts";
import { walletInThePage } from "./support/wallet.ts";

/**
 * The holder of a POD claims its repository from a browser, with their own wallet (11E).
 *
 * The page, the wallet's signature, the server's check against the title on the chain: all real. The
 * last step goes to GitHub, which refuses here, because a test has no right to move anybody's
 * repository; that GitHub says yes is shown once, for real, by github-live.test.ts. What this shows is
 * that the holder's claim gets as far as GitHub, anybody else's is refused before it, and the page
 * says which, and where it stopped.
 */

const available = (await anvilAvailable()) && (await browserAvailable());

const JOB = "a-coat-claimed-in-a-browser";
const HOLDER = privateKeyToAccount(POSTER).address;
/** another of the local chain's accounts, which signs for itself as the holder's does, and holds nothing */
const STRANGER = privateKeyToAccount(ANVIL_KEYS[2]).address;

let anvil: Anvil;
let store: JobStore;
let base = "";
let server: { stop: () => void } | undefined;
let browser: Browser | undefined;
let tokenId = 0n;
const was = process.env.POD_GITHUB_TOKEN;

beforeAll(async () => {
  if (!available) return;
  // GitHub refuses a token it does not know, which is all this test may do to GitHub
  process.env.POD_GITHUB_TOKEN = "not-a-token-github-knows";
  anvil = await startAnvil();
  const titled = await aTitledJob(anvil, { jobId: JOB, commit: "c0".repeat(20), repository: "https://github.com/pod-an-owner-nobody-has/pod-a-coat" });
  ({ store, tokenId } = titled);
  const proven = new ProvenChecks(await mkdtemp(join(tmpdir(), "pod-proven-")));
  const serving = serve(store, 0, {
    // the market the page reads its chain from, the same as the posting page's
    market: {
      page: { chainId: 31337, chainName: "a local chain", rpc: anvil.rpc, jobs: titled.jobs, explorer: "http://explorer.invalid", coin: "ETH" },
      chain: readerFor({ jobs: titled.jobs, read: (id) => readJob({ address: titled.jobs, publicClient: anvil.publicClient }, id) }),
      writing: new CheckWriting({ writer: writerWith(replying(GOOD_REPLY).model), proven }),
      proven,
    },
    claims: new Claims({ store, token: { address: titled.token, publicClient: anvil.publicClient } }),
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
  if (was === undefined) delete process.env.POD_GITHUB_TOKEN;
  else process.env.POD_GITHUB_TOKEN = was;
});

async function openTheClaim(as: `0x${string}`): Promise<Browser> {
  browser = await Browser.start();
  await browser.beforeEveryPage(walletInThePage({ rpc: anvil.rpc, address: as, chainId: 31337, startsOn: 31337 }));
  await browser.open(base + claimPath(JOB));
  await browser.until(`document.querySelector("#account")`, "the claim to appear");
  return browser;
}

const SAYS = `document.querySelector("#said").textContent + " | " + [...document.querySelectorAll("#progress li")].map((l) => l.dataset.state).join(" ")`;
const said = (page: Browser): Promise<string> => page.evaluate<string>(`document.querySelector("#said").textContent`);
const stepStates = (page: Browser): Promise<string[]> => page.evaluate<string[]>(`[...document.querySelectorAll("#progress li")].map((l) => l.dataset.state)`);

describe.skipIf(!available)("claiming a POD's repository from a browser", () => {
  test("the page shows the title, who holds it, and the repository", async () => {
    const page = await openTheClaim(HOLDER);
    const text = await page.evaluate<string>(`document.querySelector("#what").textContent`);
    expect(text).toContain(COPY.what.pod(tokenId.toString()));
    expect(text).toContain(HOLDER);
    expect(text).toContain("pod-an-owner-nobody-has/pod-a-coat");
  }, 120_000);

  test("the holder signs, the claim reaches GitHub, and GitHub's answer is said, stopped at its step", async () => {
    const page = await openTheClaim(HOLDER);
    await page.type("#account", "octocat");
    await page.click("#claim");
    await page.until(`document.querySelector("#said").textContent.includes("GitHub would not send the invitation")`, "GitHub's refusal to be said", 60, SAYS);
    expect(await stepStates(page)).toEqual(["done", "done", "failed"]);
    expect(await page.evaluate<boolean>(`document.querySelector("#not-holder") === null`)).toBe(true);
  }, 120_000);

  test("anybody else is told before signing that the wallet does not hold the title, and refused if they sign anyway", async () => {
    const page = await openTheClaim(STRANGER);
    await page.type("#account", "octocat");
    await page.click("#claim");
    await page.until(`document.querySelector("#said").textContent.includes("not the holder's")`, "the refusal to be said", 60, SAYS);
    expect(await stepStates(page)).toEqual(["done", "done", "failed"]);
    // once connected, the page says so beside the button, before anybody signs again
    await page.until(`document.querySelector("#not-holder")`, "the warning to appear");
    expect(await page.evaluate<string>(`document.querySelector("#not-holder").textContent`)).toBe(COPY.where.notHolder(STRANGER, HOLDER));
    expect(await said(page)).not.toContain("GitHub");
  }, 120_000);
});
