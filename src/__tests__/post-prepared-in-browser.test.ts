import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestClient, http, parseEther, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { podJobsV2Abi, readJobV2, readWritingMoney } from "../jobsV2.ts";
import { PREPARING_FOLDER } from "../folders.ts";
import { MODES } from "../job.ts";
import { PreparingStore } from "../preparing/index.ts";
import { refundByNumberPath, ROUTES } from "../routes.ts";
import { serve, type Services } from "../server.ts";
import { servicesFor } from "../services.ts";
import { JobStore } from "../store.ts";
import { COPY } from "../web/post/state/index.ts";
import { ANVIL_KEYS, anvilAvailable, startAnvil, type Anvil } from "./support/anvil.ts";
import { Browser, browserAvailable } from "./support/browser.ts";
import { COAT_IDEA, DRY, GOOD_REPLY, replying, WET, writerWith } from "./support/coat.ts";
import { deployRegistries } from "./support/registries.ts";
import { dockerAvailable } from "./support/tools.ts";
import { walletInThePage } from "./support/wallet.ts";

/**
 * A stranger posts a job on the contract that prepares jobs, from a browser, with their own wallet:
 * they pay once, the checks are written after, they read them and approve, or take the money back.
 *
 * Everything is the real thing: the page, the server built as it is from its settings, the writer
 * program and the trials in their boxes, the contract and its money. The model answers from a script,
 * and the wallet is the standard browser interface backed by a chain whose accounts sign for
 * themselves. Two tests make the network misbehave in the page, as a dropped connection or a server
 * that sends something it should not would: that is what they are about.
 */

const available = (await anvilAvailable()) && (await browserAvailable()) && (await dockerAvailable());
const [DEPLOYER, VALIDATOR, WRITER, POSTER] = [ANVIL_KEYS[0], ANVIL_KEYS[6], ANVIL_KEYS[4], ANVIL_KEYS[1]];
const POSTER_ADDRESS = privateKeyToAccount(POSTER).address;
const WRITING = parseEther("0.05");
const PRICE = parseEther("0.1");
/** how long a flash job's builders have once it opens, which the last test waits out */
const MODES_FLASH_SECONDS = MODES.flash.windowMinutes * 60;

let anvil: Anvil;
let jobs: Address;
let old: Address;
let services: Services;
let directory = "";
let base = "";
let server: { stop: () => void } | undefined;
let browser: Browser | undefined;

beforeAll(async () => {
  if (!available) return;
  anvil = await startAnvil();
  const validator = privateKeyToAccount(VALIDATOR).address;
  old = await anvil.deploy("PodJobs", [validator], DEPLOYER);
  jobs = await anvil.deploy("PodJobsV2", [validator, privateKeyToAccount(WRITER).address, 10n, WRITING, 100_000n], DEPLOYER);
  const registries = await deployRegistries(anvil);
  directory = await mkdtemp(join(tmpdir(), "pod-prepared-page-"));
  services = await servicesFor({
    store: new JobStore(directory), directory, publicClient: anvil.publicClient,
    page: { chainId: 31337, chainName: "a local chain", rpc: anvil.rpc, explorer: "http://explorer.invalid", coin: "ETH", registries },
    registries, jobs, earlier: old, writer: anvil.wallet(WRITER), checkWriter: writerWith(replying(GOOD_REPLY).model),
  });
  const serving = serve(new JobStore(directory), 0, services);
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

/** A fresh browser with the poster's wallet in it, and whatever else the test puts in every page first. */
async function aBrowser(...before: readonly string[]): Promise<Browser> {
  browser = await Browser.start();
  await browser.beforeEveryPage(walletInThePage({ rpc: anvil.rpc, address: POSTER_ADDRESS, chainId: 31337 }));
  for (const source of before) await browser.beforeEveryPage(source);
  return browser;
}

async function describeTheJob(page: Browser, name: string): Promise<void> {
  await page.open(base + ROUTES.post);
  await page.until(`document.querySelector("#idea")`, "the form to appear");
  await page.type("#idea", COAT_IDEA);
  await page.click('input[name="kind"][value="service"]');
  await page.type('[data-lines="brief"] input', WET);
  await page.type('[data-lines="exam"] input', DRY);
  await page.type("#name", name);
}

const SAID = `(document.querySelector("#said")?.textContent ?? "") + " | " + [...document.querySelectorAll("#progress li")].map((l) => l.dataset.step + "=" + l.dataset.state).join(" ")`;

/** Pay, and wait to be taken to the paid job's own page. */
async function pay(page: Browser): Promise<string> {
  await page.until(`document.querySelector("#submit").textContent === "Pay 0.25 ETH"`, "the button to offer the price and three writings", 30, SAID);
  await page.click("#submit");
  await page.until(`/^\\/post\\/[0-9]+$/.test(location.pathname)`, "the job's own page", 90, SAID);
  return page.evaluate<string>(`location.pathname.split("/").pop()`);
}

const SHOWN = `(document.querySelector("#writing")?.textContent ?? "") + " | " + (document.querySelector("#said")?.textContent ?? "") + " | " + (document.querySelector("#your-job")?.textContent ?? "")`;

/** Sign the note that shows the job, and wait for its checks to be written and pass their trials. */
async function readTheChecks(page: Browser): Promise<void> {
  await page.until(`document.querySelector("#sign-in")`, "the page to ask for the note", 30, SHOWN);
  await page.click("#sign-in");
  await page.until(`document.querySelector("#written-verdict")?.dataset.state === "ready"`, "the checks to be written and hold", 240, SHOWN);
}

describe.skipIf(!available)("a stranger posts a job that is prepared before it opens", () => {
  test("they pay once, read the checks written after, and approve them: the job opens with the seal of what they read", async () => {
    const page = await aBrowser();
    await describeTheJob(page, "a-coat-paid-first");
    // before paying, the page says what is paid and that it can all come back
    expect(await page.evaluate<string>(`document.querySelector("#step-pay").innerText`)).toContain("take it all back");
    const id = await pay(page);
    expect((await readJobV2({ address: jobs, publicClient: anvil.publicClient }, BigInt(id)))?.state).toBe("preparing");

    await readTheChecks(page);
    const shown = await page.evaluate<string>(`document.querySelector("#written").innerText`);
    expect(shown).toContain(WET);
    expect(shown).toContain(DRY);
    expect(await page.evaluate<string>(`document.querySelector("#writings-left").textContent`)).toBe(COPY.prepared.left(2));

    await page.click("#approve");
    await page.until(`document.querySelector("#standing")?.textContent.startsWith("Approved")`, "the approval to land", 90, SHOWN);
    const job = await readJobV2({ address: jobs, publicClient: anvil.publicClient }, BigInt(id));
    expect(job?.state).toBe("open");
    // the seal on the chain is the one the writer signed for the set the poster read
    const [written] = await new PreparingStore(join(directory, PREPARING_FOLDER)).writings(id);
    expect(written?.outcome.kind === "written" ? written.outcome.approval?.seal : undefined).toBe(job?.seal);
  }, 480_000);

  test("before approving they take it all back, less the one writing done, and the name is free again", async () => {
    const page = await aBrowser();
    await describeTheJob(page, "a-coat-taken-back");
    const id = await pay(page);
    await readTheChecks(page);
    const before = await anvil.publicClient.getBalance({ address: POSTER_ADDRESS });

    await page.click("#take-back");
    await page.until(`document.querySelector("#standing")?.textContent === ${JSON.stringify(COPY.prepared.takenBack)}`, "the money to come back", 90, SHOWN);
    const at = { address: jobs, publicClient: anvil.publicClient };
    expect((await readJobV2(at, BigInt(id)))?.state).toBe("refunded");
    expect(await readWritingMoney(at, BigInt(id))).toMatchObject({ balance: 0n, reserved: 0n, kept: 1 });
    // the price and the two writings never started came back, less what sending it cost
    const back = (await anvil.publicClient.getBalance({ address: POSTER_ADDRESS })) - before;
    expect(back > PRICE + 2n * WRITING - parseEther("0.01")).toBe(true);
    expect(await services.preparing?.isNameTaken("a-coat-taken-back")).toBe(false);
  }, 480_000);

  test("paid, then the lines never reached the server: on return the page sends them, and nothing is paid twice", async () => {
    // the first time the page sends the lines, the connection drops, as it would with the tab closed
    const dropOnce = `(() => {
      const send = window.fetch.bind(window);
      window.fetch = (url, options) => {
        if (String(url) === ${JSON.stringify(ROUTES.preparing)} && options?.method === "POST" && !sessionStorage.getItem("dropped")) {
          sessionStorage.setItem("dropped", "yes");
          return Promise.reject(new TypeError("Failed to fetch"));
        }
        return send(url, options);
      };
    })();`;
    const page = await aBrowser(dropOnce);
    await describeTheJob(page, "a-coat-sent-on-return");
    const held = await anvil.publicClient.getBalance({ address: jobs });
    await page.click("#submit");
    await page.until(`document.querySelector("#said").textContent.includes("held by the contract")`, "sending to fail after paying", 90, SAID);
    expect(await anvil.publicClient.getBalance({ address: jobs })).toBe(held + PRICE + 3n * WRITING);

    // your own page knows it too, and sends the poster back to finish it
    await page.open(base + ROUTES.yours);
    await page.until(`document.querySelector("#kept")`, "the kept payment on your own page", 30);
    expect(await page.evaluate<string>(`document.querySelector("#kept").innerText`)).toContain("never sent to be written");
    expect(await page.evaluate<string>(`document.querySelector("#kept a.primary").getAttribute("href")`)).toBe(ROUTES.post);

    // closed and opened again: the job it paid for is there to finish, the lines as they were
    await page.open(base + ROUTES.post);
    await page.until(`document.querySelector("#paid-as")`, "the paid job to be there on return");
    expect(await page.evaluate<string>(`document.querySelector("#paid-as").textContent`)).toContain(COPY.payFirst.comeBack);
    expect(await page.evaluate<string>(`document.querySelector("#idea").value`)).toBe(COAT_IDEA);
    expect(await page.evaluate<string>(`document.querySelector("#submit").textContent`)).toBe(COPY.payFirst.finish);

    await page.click("#submit");
    await page.until(`/^\\/post\\/[0-9]+$/.test(location.pathname)`, "the job's own page", 90, SAID);
    // one payment, not two
    expect(await anvil.publicClient.getBalance({ address: jobs })).toBe(held + PRICE + 3n * WRITING);
    // and nothing kept to finish any more
    await page.open(base + ROUTES.post);
    await page.until(`document.querySelector("#submit")`, "the form to appear");
    expect(await page.evaluate<boolean>(`document.querySelector("#paid-as") === null`)).toBe(true);
  }, 300_000);

  test("checks shown that are not the ones the writer signed are refused on the page, and nothing is approved (F10)", async () => {
    // the server's answer is changed on the way in: one check reads differently from the one sealed
    const reworded = `(() => {
      const send = window.fetch.bind(window);
      window.fetch = async (url, options) => {
        const answer = await send(url, options);
        if (!/^\\/api\\/preparing\\/[0-9]+$/.test(String(url)) || !answer.ok) return answer;
        const view = await answer.json();
        for (const writing of view.writings) {
          if (writing.outcome.kind === "written" && writing.outcome.checks[0]) writing.outcome.checks[0].says = "When it pours, it tells me to take a coat";
        }
        return new Response(JSON.stringify(view), { status: answer.status, headers: answer.headers });
      };
    })();`;
    const page = await aBrowser(reworded);
    await describeTheJob(page, "a-coat-not-as-sealed");
    const id = await pay(page);
    await page.until(`document.querySelector("#sign-in")`, "the page to ask for the note", 30, SHOWN);
    await page.click("#sign-in");
    // the set looks ready to approve: every check holds, and the lines are the ones it was written for
    await page.until(`document.querySelector("#written-verdict")?.dataset.state === "ready"`, "the checks to be written and hold", 240, SHOWN);
    expect(await page.evaluate<string>(`document.querySelector("#written").innerText`)).toContain("When it pours");

    await page.click("#approve");
    await page.until(`document.querySelector("#said").textContent === ${JSON.stringify(COPY.prepared.mismatch)}`, "the page to refuse", 60, SHOWN);
    expect((await readJobV2({ address: jobs, publicClient: anvil.publicClient }, BigInt(id)))?.state).toBe("preparing");
  }, 480_000);

  /** Pay, read the checks and approve them: the job opens, with nobody seated yet. */
  async function anOpenJob(page: Browser, name: string): Promise<string> {
    await describeTheJob(page, name);
    const id = await pay(page);
    await readTheChecks(page);
    await page.click("#approve");
    await page.until(`document.querySelector("#standing")?.textContent.startsWith("Approved")`, "the approval to land", 90, SHOWN);
    return id;
  }

  const REFUND_SAYS = `(document.querySelector("#standing")?.textContent ?? "") + " | " + (document.querySelector("#said")?.textContent ?? "")`;

  test("open with nobody seated, the poster takes it back from the refund page at once, without waiting for the window", async () => {
    const page = await aBrowser();
    const id = await anOpenJob(page, "a-coat-nobody-took");
    await page.open(base + refundByNumberPath(id, jobs));
    await page.until(`document.querySelector("#standing")?.dataset.standing === "take back now"`, "the page to offer it now", 30, REFUND_SAYS);
    await page.click("#refund");
    await page.until(`document.querySelector("#said").textContent.includes("on its way back")`, "the money to come back", 90, REFUND_SAYS);
    expect((await readJobV2({ address: jobs, publicClient: anvil.publicClient }, BigInt(id)))?.state).toBe("refunded");
  }, 480_000);

  test("a payment the poster's wallet could not take waits for them, and they withdraw it", async () => {
    const page = await aBrowser();
    const id = await anOpenJob(page, "a-coat-paid-to-a-wallet-that-refused");
    const test = createTestClient({ mode: "anvil", transport: http(anvil.rpc) });
    // the window closes; then, while the poster's address refuses money, somebody closes the job
    await test.increaseTime({ seconds: MODES_FLASH_SECONDS + 60 });
    await test.mine({ blocks: 1 });
    await test.setCode({ address: POSTER_ADDRESS, bytecode: "0x60006000fd" });
    const closer = anvil.wallet(ANVIL_KEYS[5]);
    const { request } = await anvil.publicClient.simulateContract({ address: jobs, abi: podJobsV2Abi, functionName: "close", args: [BigInt(id)], account: closer.account });
    await anvil.publicClient.waitForTransactionReceipt({ hash: await closer.writeContract(request) });
    await test.setCode({ address: POSTER_ADDRESS, bytecode: "0x" });
    const owed = await anvil.publicClient.readContract({ address: jobs, abi: podJobsV2Abi, functionName: "owed", args: [POSTER_ADDRESS] });
    expect(owed).toBe(PRICE);

    // your own page says it is waiting, and the refund page withdraws it
    await page.open(base + ROUTES.yours);
    await page.until(`document.querySelector("#owed")`, "your page to say money is waiting", 30);
    await page.open(base + ROUTES.refund);
    await page.until(`document.querySelector("#withdraw")`, "the page to offer withdrawing it", 30, `document.body.innerText.slice(0, 400)`);
    const before = await anvil.publicClient.getBalance({ address: POSTER_ADDRESS });
    await page.click("#withdraw");
    await page.until(`document.querySelector("#withdrawn")?.textContent === "Withdrawn."`, "the money to be withdrawn", 60, `document.querySelector("#withdrawn")?.textContent`);
    expect(await anvil.publicClient.readContract({ address: jobs, abi: podJobsV2Abi, functionName: "owed", args: [POSTER_ADDRESS] })).toBe(0n);
    expect((await anvil.publicClient.getBalance({ address: POSTER_ADDRESS })) > before + PRICE - parseEther("0.01")).toBe(true);
  }, 480_000);
});
