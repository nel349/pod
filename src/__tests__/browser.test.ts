import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { Browser, browserAvailable } from "./support/browser.ts";
import { serve } from "../server.ts";
import { JobStore, type JobRecord } from "../store.ts";
import { signReceipt, type Receipt } from "../receipt.ts";
import { checksPath, jobPath, receiptPath, ROUTES } from "../routes.ts";
import type { Tile } from "../gallery.ts";

/**
 * The wall, driven the way a person drives it.
 *
 * Every test here is the definition of done for one thing somebody can do. The markup tests next
 * door say the right strings are present; these say the thing is reachable, clickable, legible on a
 * phone and goes where it says it goes, which is the half a string search cannot see.
 */

const KEY = `0x${"7".repeat(64)}` as const;
const RUNNER = privateKeyToAccount(KEY).address;
const SEAL = `0x${"ab".repeat(32)}` as const;
const AGENT = "0x1a2b3c4d5e6f708192a3b4c5d6e7f80910111213" as const;

const available = await browserAvailable();
let browser: Browser;
let base = "";
let server: { stop: () => void } | undefined;

async function receiptFor(verdict: Receipt["verdict"], commit: string) {
  return signReceipt({
    version: "pod.receipt.v1", seal: SEAL, commit,
    repository: "http://127.0.0.1/bundle/one-that-passed",
    tree: `0x${"11".repeat(32)}`,
    image: "node@sha256:9bef0ef1e268f60627da9ba7d7605e8831d5b56ad07487d24d1aa386336d1944",
    start: "node server.js",
    checks: [
      { says: "the page answers", command: "node loads.mjs", exitCode: verdict === "passed" ? 0 : 1, seconds: 0.4, hidden: false },
      { says: "a thin excuse scores lower", command: "node weak.mjs", exitCode: verdict === "passed" ? 0 : 1, seconds: 0.5, hidden: true },
    ],
    runs: 2, verdict, allowedHosts: [], undeclaredCalls: [], runner: RUNNER,
    finishedAt: "2026-09-17T10:04:00.000Z",
  }, KEY);
}

function tile(over: Partial<Tile> = {}): Tile {
  return {
    jobId: "one-that-passed", idea: "A page that tells me whether to take a coat today",
    mode: "flash", verdict: "passed", open: "https://example.test/coat", commit: "c0ffee1234abcdef0123456789abcdef01234567",
    seconds: 812, price: 25_000_000_000_000_000_000n,
    pod: [{ role: "lead", agent: AGENT, owner: AGENT }],
    receiptURI: receiptPath("one-that-passed"),
    finishedAt: "2026-09-17T10:04:00.000Z", ...over,
  };
}

async function record(over: Partial<JobRecord> = {}): Promise<JobRecord> {
  const base = tile(over.tile);
  const signed = await receiptFor(base.verdict === "passed" ? "passed" : "failed", base.commit ?? "c0ffee1234");
  return {
    jobId: base.jobId, seal: SEAL, tile: { ...base, receiptURI: receiptPath(base.jobId), receiptHash: signed.hash },
    checksSaid: signed.receipt.checks.map((c) => ({ says: c.says, hidden: c.hidden, exitCode: c.exitCode })),
    approvals: [{ role: "lead", agent: AGENT, commit: base.commit ?? "c0ffee1234", at: "2026-09-17T09:58:00.000Z" }],
    signed, ...over,
  };
}

beforeAll(async () => {
  if (!available) return;
  const store = new JobStore(await mkdtemp(join(tmpdir(), "pod-browser-")));
  const checks = { "loads.mjs": "// asks the page for a page\n", "weak.mjs": "// the one the pod could not see\n" };
  await store.save(await record(), checks);
  await store.save(await record({
    tile: tile({ jobId: "one-that-failed", verdict: "failed", open: undefined, commit: "7ae91bb0001234567890abcdef1234567890abcd", finishedAt: "2026-09-16T10:04:00.000Z" }),
  }), checks);
  const unrepeatable = await record({
    tile: tile({ jobId: "one-nobody-could-repeat", verdict: "not-reproducible", open: undefined, commit: "3ee7100000abcdef1234567890abcdef12345678", finishedAt: "2026-09-15T10:04:00.000Z" }),
  });
  await store.save(unrepeatable, checks);

  await store.save({
    ...(await record({ tile: tile({ jobId: "one-still-open", verdict: "running", open: undefined, finishedAt: undefined }) })),
    signed: undefined,
    brief: {
      asked: "A page that tells me whether to take a coat, from my postcode",
      endsAt: "2026-09-18T10:00:00.000Z", sealedChecks: 2,
      seats: [{ role: "lead", taken: true }, { role: "security", taken: false }],
    },
  });

  const port = 9100 + Math.floor(Math.random() * 800);
  server = serve(store, port);
  base = `http://127.0.0.1:${port}`;
  browser = await Browser.start();
}, 120_000);

afterAll(async () => {
  server?.stop();
  if (available) await browser?.stop();
});

describe.skipIf(!available)("the wall, driven the way a person drives it", () => {
  test("it opens, and shows what happened to every job, failures included", async () => {
    await browser.open(base + ROUTES.wall);
    const text = await browser.text();
    expect(text).toContain("checks passed");
    expect(text).toContain("checks failed");
    expect(text).toContain("being built");
  }, 60_000);

  test("a tile is clickable across its whole surface, not only on its title", async () => {
    await browser.open(base + ROUTES.wall);

    // a point inside the tile but away from its heading: where a person actually aims
    const spot = await browser.cornerOf("article.flyer");
    await browser.clickAt(spot.x, spot.y);
    await Bun.sleep(300);
    expect(await browser.where()).toContain(ROUTES.job);
  }, 60_000);

  test("a job page says what was checked, and that one of them was hidden", async () => {
    await browser.open(base + jobPath("one-that-passed"));
    const text = (await browser.text()).toLowerCase();
    expect(text).toContain("the page answers");
    expect(text).toContain("hidden from the pod");
    expect(text).toContain("check it yourself");
  }, 60_000);

  test("the checks can be fetched from the page, hidden ones included", async () => {
    await browser.open(base + jobPath("one-that-passed"));
    await browser.click("p.fetch a");
    await Bun.sleep(300);
    expect(await browser.where()).toBe(checksPath("one-that-passed"));

    const listed = await browser.text();
    expect(listed).toContain("weak.mjs");
    expect(listed).toContain("loads.mjs");
  }, 60_000);

  test("a job still open shows its brief and will not hand over its checks", async () => {
    await browser.open(base + jobPath("one-still-open"));
    const text = (await browser.text()).toLowerCase();
    expect(text).toContain("what is asked");
    expect(text).toContain("2 more checks are sealed");
    expect(await browser.evaluate<string>(`[...document.querySelectorAll("#pod li.open .seat-role")].map((seat) => seat.textContent).join(",")`)).toContain("security");

    await browser.open(base + checksPath("one-still-open"));
    expect(await browser.text()).toContain("published when it has a verdict");
  }, 60_000);

  test("the command to repeat the run is on the page, and is the real one", async () => {
    await browser.open(base + jobPath("one-that-passed"));
    const command = await browser.evaluate<string>(`document.querySelector("pre.repeat")?.innerText ?? ""`);
    expect(command).toContain("docker run");
    expect(command).toContain("--network none");
    expect(command).toContain("node server.js");
    expect(command).toContain("c0ffee1234");
    expect(command).toContain("git clone");
  }, 60_000);

  test("an agent's page shows the seats it held and what came of them", async () => {
    await browser.open(`${base}${ROUTES.agent}${AGENT}`);
    const text = await browser.text();
    expect(text).toContain("lead");
    expect(text).toContain("passed");
    expect(text).toContain("failed");
  }, 60_000);

  test("every link on the wall goes somewhere that answers", async () => {
    await browser.open(base + ROUTES.wall);
    const broken = await browser.evaluate<string[]>(`(async () => {
      const links = [...document.querySelectorAll("a[href^='/']")].map((a) => a.getAttribute("href"));
      const bad = [];
      for (const href of new Set(links)) {
        const response = await fetch(href);
        if (!response.ok) bad.push(href + " -> " + response.status);
      }
      return bad;
    })()`);
    expect(broken).toEqual([]);
  }, 60_000);

  test("on a phone the page does not scroll sideways, and nothing is cut off", async () => {
    await browser.resize(390, 844);
    for (const path of [ROUTES.wall, jobPath("one-that-passed"), `${ROUTES.agent}${AGENT}`]) {
      await browser.open(base + path);
      const sideways = await browser.evaluate<boolean>(
        "document.documentElement.scrollWidth > document.documentElement.clientWidth + 1",
      );
      expect({ path, sideways }).toEqual({ path, sideways: false });
    }
    await browser.resize(1280, 900);
  }, 90_000);

  test("everything you can click can be reached with a keyboard, and shows where you are", async () => {
    await browser.open(base + ROUTES.wall);
    const unreachable = await browser.evaluate<string[]>(`(() => {
      const bad = [];
      for (const a of document.querySelectorAll("a")) {
        if (a.tabIndex < 0) bad.push(a.getAttribute("href") ?? a.textContent);
        const style = getComputedStyle(a, ":focus-visible");
        if (style.outlineStyle === "none" && style.boxShadow === "none") bad.push("no focus ring: " + a.textContent);
      }
      return bad;
    })()`);
    expect(unreachable).toEqual([]);
  }, 60_000);

  test("a job whose runs disagreed says what that means for the money", async () => {
    await browser.open(base + jobPath("one-nobody-could-repeat"));
    const text = (await browser.text()).toLowerCase();
    expect(text).toContain("did not give the same answer every time");
    expect(text).toContain("nothing was settled");
  }, 60_000);

  test("a job still open does not offer checks it is going to refuse", async () => {
    await browser.open(base + jobPath("one-still-open"));
    const offered = await browser.evaluate<boolean>(`!!document.querySelector("p.fetch a")`);
    expect(offered).toBe(false);
  }, 60_000);
});
