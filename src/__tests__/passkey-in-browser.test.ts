import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestClient, getAddress, http, isHex, parseEther, type Address } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { readJobV2 } from "../jobsV2.ts";
import { ROUTES } from "../routes.ts";
import { serve, type Services } from "../server.ts";
import { servicesFor } from "../services.ts";
import { JobStore } from "../store.ts";
import { CHROME } from "../web/shared/copy.ts";
import { ANVIL_KEYS, anvilAvailable, startAnvil, type Anvil } from "./support/anvil.ts";
import { Browser, browserAvailable } from "./support/browser.ts";
import { COAT_IDEA, DRY, GOOD_REPLY, replying, WET, writerWith } from "./support/coat.ts";
import { deployRegistries } from "./support/registries.ts";
import { dockerAvailable } from "./support/tools.ts";

/**
 * A stranger with no wallet in their browser makes one from a passkey, in the header, and posts a job
 * with it: pays, signs the note that shows the checks, and approves them. POD's pages are one app, so the
 * wallet stays open from page to page; nothing of it is kept, so a reload asks the passkey again, once.
 *
 * The passkey is Chrome's own virtual authenticator, which answers the same prompt a phone or a laptop
 * would, PRF included; everything after it is the real page, server, contract and money. The page is
 * opened at localhost, not 127.0.0.1: a passkey belongs to a site's name, and an address is not one.
 */

const available = (await anvilAvailable()) && (await browserAvailable()) && (await dockerAvailable());
const [DEPLOYER, VALIDATOR, WRITER] = [ANVIL_KEYS[0], ANVIL_KEYS[6], ANVIL_KEYS[4]];
const WRITING = parseEther("0.05");
const PRICE = parseEther("0.1");
const FUNDS = parseEther("10");

let anvil: Anvil;
let jobs: Address;
let services: Services;
let base = "";
let server: { stop: () => void } | undefined;
let browser: Browser | undefined;

beforeAll(async () => {
  if (!available) return;
  anvil = await startAnvil();
  const validator = privateKeyToAccount(VALIDATOR).address;
  const old = await anvil.deploy("PodJobs", [validator], DEPLOYER);
  jobs = await anvil.deploy("PodJobsV2", [validator, privateKeyToAccount(WRITER).address, 10n, WRITING, 100_000n], DEPLOYER);
  const registries = await deployRegistries(anvil);
  const directory = await mkdtemp(join(tmpdir(), "pod-passkey-page-"));
  services = await servicesFor({
    store: new JobStore(directory), directory, publicClient: anvil.publicClient,
    page: { chainId: 31337, chainName: "a local chain", rpc: anvil.rpc, explorer: "http://explorer.invalid", coin: "ETH", registries },
    registries, jobs, earlier: old, writer: anvil.wallet(WRITER), checkWriter: writerWith(replying(GOOD_REPLY).model),
  });
  const serving = serve(new JobStore(directory), 0, services);
  server = serving;
  base = `http://localhost:${serving.port}`;
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

/** A fresh browser with no wallet in it, and a passkey authenticator that can do PRF, as a phone can. */
async function aBrowserWithAPasskeyAuthenticator(): Promise<Browser> {
  browser = await Browser.start();
  await browser.send("WebAuthn.enable");
  await browser.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal",
      hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true,
      // the person's touch, answered at once
      automaticPresenceSimulation: true,
    },
  });
  return browser;
}

const HEADER = `(document.querySelector(".wallet")?.innerText ?? "") + " | " + (document.querySelector("#passkey-problem")?.textContent ?? "")`;

/** The address the header shows for the open passkey wallet. */
const shownAddress = (page: Browser): Promise<string> => page.evaluate<string>(`document.querySelector(".wallet .who").title`);

/** The address the header shows, once the passkey wallet is open again. */
async function shownAddressWhenOpen(page: Browser): Promise<string> {
  await page.until(`document.querySelector("#wallet-details")`, "the passkey wallet to be open", 30, HEADER);
  return shownAddress(page);
}

/** Lock the open wallet from its panel; the header goes back to offering to open it again. */
async function lock(page: Browser): Promise<void> {
  await page.click("#wallet-details");
  await page.click("#lock-wallet");
  await page.until(`document.querySelector("#open-wallet")`, "the header to offer opening the wallet again", 30, HEADER);
}

/**
 * Press the header's one offer for a wallet this browser already has, which is a passkey prompt and
 * nothing else: no panel, and no choice to make, because there is none left.
 */
async function openMine(page: Browser): Promise<void> {
  await page.until(`document.querySelector("#open-wallet")?.textContent === ${JSON.stringify(CHROME.wallet.passkey.openMine)}`, "the header to offer opening the wallet", 30, HEADER);
  // nothing to choose from: the panel that asks which kind of wallet is not there
  if (await page.evaluate<boolean>(`document.querySelector("#connect-wallet") !== null`)) throw new Error("the header still asks which wallet to connect");
  await page.click("#open-wallet");
  await page.until(`document.querySelector("#wallet-details")`, "the passkey wallet to be open again", 30, HEADER);
}

/** Open the wallet panel and press its first offer, then wait for the wallet to be connected. */
async function pressThePasskeyOffer(page: Browser, offer: string): Promise<void> {
  await page.click("#connect-wallet");
  await page.until(`document.querySelector("#passkey-primary")?.textContent === ${JSON.stringify(offer)}`, `the panel to offer "${offer}"`, 30, HEADER);
  await page.click("#passkey-primary");
  await page.until(`document.querySelector("#wallet-details")`, "the passkey wallet to be connected", 30, HEADER);
}

const SAID = `(document.querySelector("#submit")?.textContent ?? "no button") + " | " + (document.querySelector("#said")?.textContent ?? "") + " | " + [...document.querySelectorAll("#progress li")].map((l) => l.dataset.step + "=" + l.dataset.state).join(" ")`;
const SHOWN = `(document.querySelector("#writing")?.textContent ?? "") + " | " + (document.querySelector("#said")?.textContent ?? "") + " | " + (document.querySelector("#your-job")?.textContent ?? "")`;

describe.skipIf(!available)("a stranger with no browser wallet makes one from a passkey", () => {
  test("made in the header, it is the wallet its recovery phrase names, it pays and approves a job, and a passkey prompt opens it again", async () => {
    const page = await aBrowserWithAPasskeyAuthenticator();
    await page.open(base + ROUTES.post);
    await page.until(`document.querySelector("#connect-wallet")`, "the header to offer connecting", 30);

    // no wallet in the browser: the panel says so, and making a passkey wallet is the first offer
    await pressThePasskeyOffer(page, CHROME.wallet.panel.make);
    const address = await shownAddress(page);
    expect(await page.evaluate<string>(`document.querySelector(".wallet .who").textContent`)).toContain(CHROME.wallet.passkey.badge);

    // its panel shows the address, and that it holds nothing yet
    await page.click("#wallet-details");
    expect(await page.evaluate<string>(`document.querySelector("#passkey-address").textContent`)).toBe(address);
    await page.until(`document.querySelector("#passkey-empty")`, "the panel to say the wallet is empty", 30, HEADER);

    // the phrase, after its own prompt, is the wallet: any wallet given these 24 words finds the same address
    await page.click("#show-phrase");
    await page.until(`document.querySelectorAll("#recovery-phrase li").length === 24`, "the 24 words", 30, HEADER);
    const phrase = await page.evaluate<string>(`[...document.querySelectorAll("#recovery-phrase li")].map((li) => li.textContent).join(" ")`);
    expect(mnemonicToAccount(phrase).address).toBe(address as Address);
    // and the page keeps none of it: only which passkey to ask for
    const kept = await page.evaluate<string>(`JSON.stringify({ ...localStorage, ...sessionStorage })`);
    expect(kept).not.toContain(phrase.split(" ").slice(0, 3).join(" "));
    await page.click("#wallet-panel .wallet-panel-head button");

    // funded, it pays for a job, signs the note that shows the checks, and approves them
    await createTestClient({ mode: "anvil", transport: http(anvil.rpc) }).setBalance({ address: address as Address, value: FUNDS });
    await page.until(`document.querySelector("#idea")`, "the form to appear");
    await page.type("#idea", COAT_IDEA);
    await page.click('input[name="kind"][value="service"]');
    await page.type('[data-lines="brief"] input', WET);
    await page.type('[data-lines="exam"] input', DRY);
    await page.type("#name", "a-coat-paid-with-a-passkey");
    await page.type("#price", "0.1");
    await page.until(`document.querySelector("#submit").textContent === "Pay 0.25 ETH"`, "the button to offer the price and three writings", 30, SAID);
    await page.evaluate(`window.__samePage = true`);
    await page.click("#submit");
    await page.until(`/^\\/post\\/[0-9]+$/.test(location.pathname)`, "the job's own page", 90, SAID);
    const id = BigInt(await page.evaluate<string>(`location.pathname.split("/").pop()`));
    // the job's own page, reached in place: the same page all along, and the wallet still open on it
    expect(await page.evaluate<boolean>(`window.__samePage === true`)).toBe(true);
    expect(await shownAddressWhenOpen(page)).toBe(address);
    await page.until(`document.querySelector("#sign-in")`, "the page to ask for the note", 30, SHOWN);
    await page.click("#sign-in");
    await page.until(`document.querySelector("#written-verdict")?.dataset.state === "ready"`, "the checks to be written and hold", 240, SHOWN);
    await page.click("#approve");
    await page.until(`document.querySelector("#standing")?.textContent.startsWith("Approved")`, "the approval to land", 90, SHOWN);
    const job = await readJobV2({ address: jobs, publicClient: anvil.publicClient }, id);
    expect(job?.poster).toBe(address as Address);
    expect(job?.state).toBe("open");
    expect(job?.price).toBe(PRICE);

    // to your own page by the header's link, and back: still the same page, and the wallet still open
    await page.click(`.site-header nav a[href="${ROUTES.yours}"]`);
    await page.until(`document.querySelector("#unpublished")`, "your own page to list the job", 30, `document.body.innerText.slice(0, 400)`);
    expect(await page.evaluate<boolean>(`window.__samePage === true && location.pathname === ${JSON.stringify(ROUTES.yours)}`)).toBe(true);
    expect(await shownAddressWhenOpen(page)).toBe(address);
    await page.evaluate(`history.back()`);
    await page.until(`document.querySelector("#standing")?.textContent.startsWith("Approved")`, "the job's page again, by the back button", 30, SHOWN);
    expect(await page.evaluate<boolean>(`window.__samePage === true`)).toBe(true);

    // locked, the page forgets the key; the same passkey opens the same wallet, in one press
    await lock(page);
    await openMine(page);
    expect(await shownAddress(page)).toBe(address);

    // a reload in the same tab keeps the wallet open: the key it worked out is this tab's until it is
    // closed or the wallet is locked, so the page comes back as it was, with no passkey asked for
    await page.open(`${base}${ROUTES.post}/${id}`);
    await page.until(`document.querySelector("#standing")?.textContent.startsWith("Approved")`, "the job's page to say where it stands", 30, SHOWN);
    expect(await shownAddressWhenOpen(page)).toBe(address);
    expect(await page.evaluate<boolean>(`document.querySelector("#open-wallet") === null && document.querySelector("#connect-wallet") === null`)).toBe(true);
    // what it keeps is the account's own key, never the words that are the whole wallet
    const keptNow = await page.evaluate<string>(`JSON.stringify({ ...localStorage, ...sessionStorage })`);
    expect(keptNow).not.toContain(phrase.split(" ").slice(0, 3).join(" "));

    // locking forgets it, and then a reload does ask again
    await lock(page);
    await page.open(`${base}${ROUTES.post}/${id}`);
    await page.until(`document.querySelector("#open-wallet")`, "the header to offer opening the wallet after it was locked", 30, HEADER);
    await openMine(page);
    expect(await shownAddress(page)).toBe(address);
  }, 480_000);

  test("on the Agents page the same passkey makes a key for an agent: its own address, the key it is handed, money sent to it and brought back", async () => {
    const page = await aBrowserWithAPasskeyAuthenticator();
    const SHEET = `document.querySelector("#agent-key")?.innerText ?? "no sheet"`;
    const agentAddress = (): Promise<string> => page.evaluate<string>(`document.querySelector("#agent-address").textContent`);
    const chain = createTestClient({ mode: "anvil", transport: http(anvil.rpc) });
    await page.open(base + ROUTES.agents);

    // no wallet anywhere: the sheet's one press makes the person a passkey wallet, and then offers the agent's key
    await page.until(`document.querySelector("#agent-open-wallet")?.textContent === ${JSON.stringify(CHROME.wallet.panel.make)}`, "the sheet to offer making a passkey wallet", 30, SHEET);
    await page.click("#agent-open-wallet");
    await page.until(`document.querySelector("#make-agent-key")`, "the sheet to offer making the agent's key", 30, SHEET);
    const person = getAddress(await shownAddressWhenOpen(page));

    // one more prompt, and the agent has an address of its own
    await page.click("#make-agent-key");
    await page.until(`document.querySelector("#agent-address")`, "the agent's address", 30, SHEET);
    const agent = getAddress(await agentAddress());
    expect(agent).not.toBe(person);

    // it is the next account of the same recovery phrase, so any wallet given the words finds it too
    await page.click("#wallet-details");
    await page.click("#show-phrase");
    await page.until(`document.querySelectorAll("#recovery-phrase li").length === 24`, "the 24 words", 30, HEADER);
    const phrase = await page.evaluate<string>(`[...document.querySelectorAll("#recovery-phrase li")].map((li) => li.textContent).join(" ")`);
    expect(mnemonicToAccount(phrase, { addressIndex: 0 }).address).toBe(person);
    expect(mnemonicToAccount(phrase, { addressIndex: 1 }).address).toBe(agent);
    await page.click("#wallet-panel .wallet-panel-head button");

    // the key it shows is that address's key, and the page keeps none of it
    await page.click("#show-agent-key");
    await page.until(`document.querySelector("#agent-key-shown pre")`, "the key", 30, SHEET);
    const key = await page.evaluate<string>(`document.querySelector("#agent-key-shown pre").textContent`);
    if (!isHex(key)) throw new Error(`the page showed something that is not a key: ${key.slice(0, 12)}`);
    expect(privateKeyToAccount(key).address).toBe(agent);
    expect(await page.evaluate<string>(`JSON.stringify({ ...localStorage, ...sessionStorage })`)).not.toContain(key.slice(2));

    // money from the person's wallet to the agent's address, as much as the page offers
    await chain.setBalance({ address: person, value: FUNDS });
    await page.click("#fund-agent");
    await page.until(`document.querySelector("#agent-said")?.dataset.done === "fund"`, "the money to arrive", 60, SHEET);
    expect(await anvil.publicClient.getBalance({ address: agent })).toBe(parseEther("0.05"));

    // another agent is another key, and going back to the first is the first key again: nothing was kept, and nothing was lost
    await page.click("#another-agent");
    await page.click("#make-agent-key");
    await page.until(`document.querySelector("#agent-address")`, "the second agent's address", 30, SHEET);
    expect(await agentAddress()).toBe(mnemonicToAccount(phrase, { addressIndex: 2 }).address);
    await page.click("#agent-before");
    await page.click("#make-agent-key");
    await page.until(`document.querySelector("#agent-address")`, "the first agent's address again", 30, SHEET);
    expect(await agentAddress()).toBe(agent);

    // and everything it holds comes back, signed by the agent's own key, leaving it with nothing
    const before = await anvil.publicClient.getBalance({ address: person });
    await page.until(`document.querySelector("#bring-back")?.disabled === false`, "the page to know the address holds something", 30, SHEET);
    await page.click("#bring-back");
    await page.until(`document.querySelector("#agent-said")?.dataset.done === "back"`, "the money to come back", 60, SHEET);
    expect(await anvil.publicClient.getBalance({ address: agent })).toBe(0n);
    expect(await anvil.publicClient.getBalance({ address: person })).toBeGreaterThan(before);
  }, 240_000);

  test("a passkey that cannot do PRF is told so, and nothing is connected", async () => {
    browser = await Browser.start();
    await browser.send("WebAuthn.enable");
    await browser.send("WebAuthn.addVirtualAuthenticator", {
      options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: false, automaticPresenceSimulation: true },
    });
    await browser.open(base + ROUTES.post);
    await browser.until(`document.querySelector("#connect-wallet")`, "the header to offer connecting", 30);
    await browser.click("#connect-wallet");
    await browser.until(`document.querySelector("#passkey-primary")`, "the panel to offer a passkey wallet", 30, HEADER);
    await browser.click("#passkey-primary");
    await browser.until(`document.querySelector("#passkey-problem")`, "the panel to say what went wrong", 30, HEADER);
    expect(await browser.evaluate<string>(`document.querySelector("#passkey-problem").textContent`)).toBe(CHROME.wallet.panel.unsupported);
    expect(await browser.evaluate<boolean>(`document.querySelector("#wallet-details") === null`)).toBe(true);
  }, 120_000);
});
