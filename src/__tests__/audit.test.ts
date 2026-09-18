import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { audit, jobsOn, saidPlainly } from "../audit.ts";
import { serve } from "../server.ts";
import { JobStore, type JobRecord } from "../store.ts";
import { signReceipt, type Receipt } from "../receipt.ts";
import { receiptPath, ROUTES } from "../routes.ts";
import type { Tile } from "../gallery.ts";

const KEY = `0x${"7".repeat(64)}` as const;
const RUNNER = privateKeyToAccount(KEY).address;
const SEAL = `0x${"ab".repeat(32)}` as const;

const servers: { stop: () => void }[] = [];
afterAll(() => { for (const server of servers) server.stop(); });

function tile(over: Partial<Tile> = {}): Tile {
  return {
    jobId: "coat-or-no-coat",
    idea: "A page that tells me whether to take a coat",
    mode: "flash",
    verdict: "passed",
    commit: "c0ffee1234",
    seconds: 61,
    price: 25_000_000_000_000_000_000n,
    pod: [{ role: "lead", agent: RUNNER, owner: RUNNER }],
    securityHeldByUs: true,
    finishedAt: "2026-09-17T10:00:00.000Z",
    receiptURI: receiptPath("coat-or-no-coat"),
    ...over,
  };
}

async function receipt(over: Partial<Receipt> = {}): Promise<NonNullable<JobRecord["signed"]>> {
  const body: Receipt = {
    version: "pod.receipt.v1",
    seal: SEAL,
    commit: "c0ffee1234",
    repository: "/repos/a-weather-page.git",
    tree: `0x${"11".repeat(32)}`,
    image: "node@sha256:9bef0ef1e268f60627da9ba7d7605e8831d5b56ad07487d24d1aa386336d1944",
    start: "node server.js",
    checks: [{ says: "the page answers", command: "node loads.mjs", exitCode: 0, seconds: 0.4, hidden: false }],
    runs: 2,
    verdict: "passed",
    allowedHosts: [],
    undeclaredCalls: [],
    runner: RUNNER,
    finishedAt: "2026-09-17T12:00:00.000Z",
    ...over,
  };
  return signReceipt(body, KEY);
}

async function site(record?: JobRecord): Promise<string> {
  const store = new JobStore(await mkdtemp(join(tmpdir(), "pod-audit-")));
  if (record) await store.save(record, { "loads.mjs": "// asks the page for a page\n" });
  const port = 8900 + Math.floor(Math.random() * 900);
  servers.push(serve(store, port));
  return `http://127.0.0.1:${port}`;
}

describe("reading the wall the way a stranger would", () => {
  test("it finds the jobs a page links to", () => {
    expect(jobsOn(`<a href="${ROUTES.job}one">x</a> <a href="/elsewhere">y</a> <a href="${ROUTES.job}two">z</a>`))
      .toEqual(["one", "two"]);
  });
});

describe("auditing a running site", () => {
  test("a site with a job on it passes, and the count is real", async () => {
    const base = await site({
      jobId: "coat-or-no-coat", seal: SEAL, tile: tile(),
      checksSaid: [{ says: "the page answers", hidden: false, exitCode: 0 }],
      approvals: [], signed: await receipt(),
    });

    const outcome = await audit(base);
    expect(outcome.findings).toEqual([]);
    expect(outcome.jobs).toEqual(["coat-or-no-coat"]);
    expect(outcome.checked).toBeGreaterThan(4);
    expect(saidPlainly(outcome)).toContain("nothing wrong");
  });

  test("an empty site is not a finding, because an empty wall says so", async () => {
    const outcome = await audit(await site());
    expect(outcome.findings).toEqual([]);
    expect(outcome.jobs).toEqual([]);
  });

  test("a receipt that cannot be repeated is a finding, not a detail", async () => {
    const withoutStart = await receipt();
    const crippled = { ...withoutStart, receipt: { ...withoutStart.receipt, start: "" } };

    const base = await site({
      jobId: "coat-or-no-coat", seal: SEAL, tile: tile(),
      checksSaid: [{ says: "the page answers", hidden: false, exitCode: 0 }],
      approvals: [], signed: crippled,
    });

    const outcome = await audit(base);
    expect(outcome.findings.map((f) => f.what)).toContain("the receipt for coat-or-no-coat says how to repeat the run");
    expect(saidPlainly(outcome)).toContain("nobody can repeat it");
  });

  test("a site that is not there is every check failing, not a crash", async () => {
    const outcome = await audit("http://127.0.0.1:1");
    expect(outcome.findings.length).toBeGreaterThan(0);
    expect(outcome.findings[0]?.what).toBe("the wall loads");
  });
});
