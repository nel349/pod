import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Browser, browserAvailable } from "./support/browser.ts";
import { ANVIL_KEYS, anvilAvailable, startAnvil, type Anvil } from "./support/anvil.ts";
import { walletInThePage } from "./support/wallet.ts";
import { COAT_IDEA, DRY, GOOD_REPLY, WET, dockerAvailable, replying, writerWith } from "./support/coat.ts";
import { serve, type Market } from "../server.ts";
import { JobStore } from "../store.ts";
import { readerFor } from "../posting.ts";
import { readJob } from "../jobs.ts";
import { CheckWriting, ProvenChecks } from "../checkwriting/index.ts";
import { checkFilePath, checksPath, jobPath, ROUTES } from "../routes.ts";
import { COPY } from "../web/post/state/index.ts";

/**
 * A stranger posts a job, from a browser, with their own wallet, without writing a line of code.
 *
 * Everything here is the real thing: the page, the check writer's program in its box, every check
 * tried against a working version, a near miss and nothing at all, the seal, the contract call, the
 * payment, the signature, the server's checks, and the chain. Two things stand in: the model behind
 * the writer answers from a script, and the wallet is the standard browser interface backed by a
 * chain whose accounts sign for themselves. What is missing is a model's judgement and a person
 * pressing "approve", neither of which these tests are about.
 *
 * Each test opens its own browser and posts under its own name, so any one of them can run alone.
 */

const available = (await anvilAvailable()) && (await browserAvailable()) && (await dockerAvailable());
let anvil: Anvil;
let jobs: Address;
let store: JobStore;
let provenFolder: string;
let base = "";
let server: { stop: () => void } | undefined;
let browser: Browser | undefined;

const POSTER = privateKeyToAccount(ANVIL_KEYS[1]).address;
const PRICE = 100_000_000_000_000_000n;

beforeAll(async () => {
  if (!available) return;
  anvil = await startAnvil();
  jobs = await anvil.deploy("PodJobs", [privateKeyToAccount(ANVIL_KEYS[6]).address]);
  store = new JobStore(await mkdtemp(join(tmpdir(), "pod-posted-")));

  provenFolder = join(await mkdtemp(join(tmpdir(), "pod-proven-")), "proven");
  // port 0: the system picks one that is free, so two runs never collide
  market = aMarket();
  const serving = serve(store, 0, { market });
  server = serving;
  if (serving.port === undefined) throw new Error("the server did not say which port it took");
  port = serving.port;
  base = `http://127.0.0.1:${port}`;
}, 120_000);

let port = 0;
let market: Market;

/** The market this server runs, with a check writer of its own that remembers only what it wrote itself. */
function aMarket(): Market {
  const proven = new ProvenChecks(provenFolder);
  return {
    page: { chainId: 31337, chainName: "a local chain", rpc: anvil.rpc, jobs, explorer: "http://explorer.invalid", coin: "ETH" },
    chain: readerFor({ jobs, read: (id) => readJob({ address: jobs, publicClient: anvil.publicClient }, id) }),
    writing: new CheckWriting({ writer: writerWith(replying(GOOD_REPLY).model), proven }),
    proven,
  };
}

afterEach(async () => {
  await browser?.stop();
  browser = undefined;
});

afterAll(async () => {
  server?.stop();
  // any writing still under way finishes and takes its boxes down before the test process ends
  await market?.writing.whenIdle();
  anvil?.stop();
});

/** A fresh browser on the posting page, with a wallet in it or not, and the wallet on the right chain or not. */
async function openThePage(withWallet: boolean, walletStartsOn = 31337): Promise<Browser> {
  browser = await Browser.start();
  if (withWallet) {
    await browser.beforeEveryPage(walletInThePage({ rpc: anvil.rpc, address: POSTER, chainId: 31337, startsOn: walletStartsOn }));
  }
  await browser.open(base + ROUTES.post);
  await browser.until(`document.querySelector("#idea")`, "the form to appear");
  return browser;
}

/** Fill in the job the way a person would: an idea, what it is, a line of brief, a line of exam, an address. */
async function describeTheJob(page: Browser, name: string): Promise<void> {
  await page.type("#idea", COAT_IDEA);
  await page.click('input[name="kind"][value="service"]');
  await page.type('[data-lines="brief"] input', WET);
  await page.type('[data-lines="exam"] input', DRY);
  await page.type("#name", name);
}

async function writeTheChecks(page: Browser): Promise<void> {
  await page.click("#write");
  await page.until(
    `document.querySelector("#written-verdict")?.dataset.state === "ready"`, "the checks to be written and pass their trials", 240,
    `(document.querySelector("#writing")?.textContent ?? "") + " | " + (document.querySelector("#written")?.textContent ?? "")`,
  );
}

const said = (page: Browser): Promise<string> => page.evaluate<string>(`document.querySelector("#said").textContent`);
/** what the page says about the posting, and where each step is, for a wait that times out to report */
const POSTING_SAYS =
  `document.querySelector("#said").textContent + " | " + [...document.querySelectorAll("#progress li")].map((l) => l.dataset.step + "=" + l.dataset.state).join(" ")`;

/** The contract's job number for a name on the wall, read from what was published rather than assumed. */
async function onChainIdOf(name: string): Promise<bigint> {
  const id = (await store.read(name))?.chain?.jobId;
  if (id === undefined) throw new Error(`${name} was never published`);
  return BigInt(id);
}

describe.skipIf(!available)("a stranger posts a job from a browser", () => {
  test("the page asks for sentences, never for code, and shows every check's trials in plain words", async () => {
    const page = await openThePage(false);
    await describeTheJob(page, "words-not-code");
    await writeTheChecks(page);

    const shown = await page.evaluate<string>(`document.querySelector("#written").innerText`);
    expect(shown).toContain(WET);
    expect(shown).toContain("Asks while it is raining");
    expect(shown).toContain("Passes a version that works");
    expect(shown).toContain("Fails a near miss: it never says take a coat");
    expect(shown).toContain("Fails when nothing is built");
    // the code is there for whoever opens it, and not in anybody's way
    expect(await page.evaluate<boolean>(`[...document.querySelectorAll("#written details.source")].every((d) => !d.open)`)).toBe(true);
    // the words a poster would not understand appear nowhere on the page they read
    const text = (await page.text()).toLowerCase();
    for (const machinery of [".mjs", "node ", "exit 0", "stdout"]) expect(text).not.toContain(machinery);
  }, 300_000);

  test("a request too thin to write checks for is refused on the page, and nothing is sent", async () => {
    const page = await openThePage(false);
    await page.type("#idea", "coats");
    await page.click("#write");
    await page.until(`document.querySelector("#writing").textContent.length > 0`, "the page to say why");
    expect(await page.evaluate<string>(`document.querySelector("#writing").textContent`)).toBe("Say what you want built, in a sentence or more.");
    expect(await page.evaluate<boolean>(`document.querySelector("#written") === null`)).toBe(true);
  }, 60_000);

  test("changing a line after the checks were written marks them out of date and will not take payment", async () => {
    const page = await openThePage(true);
    await describeTheJob(page, "changed-its-mind");
    await writeTheChecks(page);
    await page.type('[data-lines="exam"] input', "When it is dry, it says leave the coat at home");
    await page.until(`document.querySelector("#written-verdict")?.dataset.state === "stale"`, "the checks to be marked out of date");

    const held = await anvil.publicClient.getBalance({ address: jobs });
    await page.click("#submit");
    await page.until(`document.querySelector("#said").textContent.includes("changed what you asked for")`, "the payment to be refused");
    expect(await anvil.publicClient.getBalance({ address: jobs })).toBe(held);
    expect(await store.read("changed-its-mind")).toBeUndefined();
  }, 300_000);

  test("without a wallet the page says so, and sends nothing", async () => {
    const page = await openThePage(false);
    await describeTheJob(page, "no-wallet-here");
    await writeTheChecks(page);
    await page.click("#submit");
    await page.until(`document.querySelector("#said").textContent.includes("no wallet")`, "the page to say there is no wallet");
    expect(await store.read("no-wallet-here")).toBeUndefined();
  }, 300_000);

  test("with a wallet, they pay, sign, and the job is on the wall with its money on the chain", async () => {
    const page = await openThePage(true);
    await describeTheJob(page, "a-coat-given-the-rain");
    await writeTheChecks(page);
    const held = await anvil.publicClient.getBalance({ address: jobs });

    await page.until(`document.querySelector("#submit").textContent.startsWith("Pay 0.1 ETH")`, "the button to offer the payment");
    await page.click("#submit");
    await page.until(`document.querySelector("#said").textContent.includes("Posted")`, "the job to be posted", 90, POSTING_SAYS);

    // touching the form afterwards must not take the confirmation away. Wait for proof React saw the
    // edit (the checks go out of date) before looking, or the look could come before the re-render
    await page.type('[data-lines="exam"] input', "an afterthought about gloves");
    await page.until(`document.querySelector("#written-verdict")?.dataset.state === "stale"`, "the page to see the edit");
    expect(await said(page)).toContain("Posted");
    expect(await page.evaluate<string>(`document.querySelector("#said a").getAttribute("href")`)).toBe(jobPath("a-coat-given-the-rain"));

    const states = await page.evaluate<string[]>(`[...document.querySelectorAll("#progress li")].map((li) => li.dataset.state)`);
    expect(states).toEqual(["done", "done", "done", "done", "done"]);

    // the wall has it, as an open job with its exam held back
    const record = await store.read("a-coat-given-the-rain");
    expect(record?.tile.verdict).toBe("running");
    expect(record?.brief?.sealedChecks).toBe(1);

    // and the chain has the money, from the person who posted, under the seal the page computed
    const onChain = await readJob({ address: jobs, publicClient: anvil.publicClient }, await onChainIdOf("a-coat-given-the-rain"));
    expect(onChain.poster.toLowerCase()).toBe(POSTER.toLowerCase());
    expect(onChain.seal).toBe(record!.seal);
    expect(await anvil.publicClient.getBalance({ address: jobs })).toBe(held + PRICE);
  }, 300_000);

  test("a wallet on another chain is moved to the right one before anything is paid", async () => {
    // the test wallet refuses to send anything while on the wrong chain, as real wallets do, so a
    // page that skipped the switch would fail here rather than pay on the wrong network
    const page = await openThePage(true, 1);
    await describeTheJob(page, "from-the-wrong-chain");
    await writeTheChecks(page);
    const held = await anvil.publicClient.getBalance({ address: jobs });

    await page.click("#submit");
    await page.until(`document.querySelector("#said").textContent.includes("Posted")`, "the job to be posted", 90, POSTING_SAYS);
    expect(await page.evaluate<string>(`document.querySelector('#progress [data-step="chain"]').dataset.state`)).toBe("done");
    expect(await anvil.publicClient.getBalance({ address: jobs })).toBe(held + PRICE);
  }, 300_000);

  test("the posted job shows its brief, keeps its exam off the page, and will not hand the exam over", async () => {
    const page = await openThePage(true);
    await describeTheJob(page, "the-exam-stays-sealed");
    await writeTheChecks(page);
    await page.click("#submit");
    await page.until(`document.querySelector("#said").textContent.includes("Posted")`, "the job to be posted", 90, POSTING_SAYS);

    await page.open(base + jobPath("the-exam-stays-sealed"));
    const text = (await page.text()).toLowerCase();
    expect(text).toContain(WET.toLowerCase());
    expect(text).not.toContain(DRY.toLowerCase());
    expect(text).toContain("1 check is sealed until there is a verdict");

    expect((await fetch(base + checksPath("the-exam-stays-sealed"))).status).toBe(409);
    // the exam's own file, which this page really posted, is not served either
    expect((await fetch(base + checkFilePath("the-exam-stays-sealed", "check-2.mjs"))).status).toBe(404);
  }, 300_000);

  test("a name already on the wall is refused before anything is paid, not after", async () => {
    // the bug this guards: the page found a taken name only when publishing, with the money already
    // on the chain, and then offered to pay again
    const first = await openThePage(true);
    await describeTheJob(first, "only-one-of-these");
    await writeTheChecks(first);
    await first.click("#submit");
    await first.until(`document.querySelector("#said").textContent.includes("Posted")`, "the first job to be posted", 90, POSTING_SAYS);
    await first.stop();

    const page = await openThePage(true);
    await describeTheJob(page, "only-one-of-these");
    await writeTheChecks(page);
    const held = await anvil.publicClient.getBalance({ address: jobs });

    await page.click("#submit");
    await page.until(`document.querySelector("#said").textContent.includes("already a job")`, "the page to say the name is taken");
    expect(await anvil.publicClient.getBalance({ address: jobs })).toBe(held);
    expect(await page.evaluate<boolean>(`document.querySelector("#progress") === null`)).toBe(true);
  }, 600_000);

  test("paid, then refused at publishing: the page finishes that job, and never takes the money twice", async () => {
    const page = await openThePage(true);
    await describeTheJob(page, "finished-not-paid-twice");
    await writeTheChecks(page);
    const held = await anvil.publicClient.getBalance({ address: jobs });

    // the server forgets what it proved, so publishing is refused after the payment has gone through
    const away = `${provenFolder}-away`;
    await rename(provenFolder, away);
    await page.click("#submit");
    await page.until(`document.querySelector("#said").textContent.includes("held by the contract")`, "publishing to fail after paying", 90, POSTING_SAYS);
    expect(await anvil.publicClient.getBalance({ address: jobs })).toBe(held + PRICE);
    expect(await page.evaluate<string>(`document.querySelector("#submit").textContent`)).toBe(COPY.pay.finish);

    // the server remembers again; pressing the button finishes the same job
    await rename(away, provenFolder);
    await page.click("#submit");
    await page.until(`document.querySelector("#said").textContent.includes("Posted")`, "the paid job to be published", 90, POSTING_SAYS);

    expect(await store.read("finished-not-paid-twice")).toBeDefined();
    // one payment, not two
    expect(await anvil.publicClient.getBalance({ address: jobs })).toBe(held + PRICE);
  }, 300_000);

  test("a server that restarts while writing is noticed: the poster is told to write again, and the page stops asking", async () => {
    const page = await openThePage(false);
    await describeTheJob(page, "written-through-a-restart");
    await page.click("#write");
    await page.until(`document.querySelector("#writing")?.dataset.state === "busy"`, "the writing to start");

    // the server restarts on the same address, with a writer that has never heard of this writing
    server?.stop();
    const before = market;
    market = aMarket();
    server = serve(store, port, { market });

    await page.until(
      `document.querySelector("#writing").textContent.includes(${JSON.stringify(COPY.checks.lost)})`,
      "the page to say the checks were lost", 30,
      `document.querySelector("#writing").textContent`,
    );
    expect(await page.evaluate<string | undefined>(`document.querySelector("#writing").dataset.state`)).toBe("failed");
    expect(await page.evaluate<boolean>(`document.querySelector("#write").disabled`)).toBe(false);

    // the stopped server's writing still finishes and takes its boxes down, rather than being cut off
    await before.writing.whenIdle();
  }, 300_000);

  test("on a phone the page does not scroll sideways", async () => {
    const page = await openThePage(false);
    await page.resize(390, 844);
    await page.open(base + ROUTES.post);
    await page.until(`document.querySelector("#idea")`, "the form to appear");
    const sideways = await page.evaluate<boolean>("document.documentElement.scrollWidth > document.documentElement.clientWidth + 1");
    expect(sideways).toBe(false);
  }, 60_000);
});
