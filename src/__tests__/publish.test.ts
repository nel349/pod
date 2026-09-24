import { describe, expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openJob, recordFor, tileFor, type PublishJob, type Seat } from "../publish.ts";
import { JobStore } from "../store.ts";
import { handle } from "../server.ts";
import { jobPath } from "../routes.ts";
import type { Spec } from "../job.ts";
import { signReceipt, type Receipt } from "../receipt.ts";
import { receiptPath } from "../routes.ts";
import type { GradeReport } from "../pipeline.ts";

const KEY = `0x${"7".repeat(64)}` as const;
const RUNNER = privateKeyToAccount(KEY).address;
const SEAL = `0x${"ab".repeat(32)}` as const;

const SEATS: Record<string, Seat> = {
  lead: { role: "lead", agent: "0x1111111111111111111111111111111111111111", owner: "0xaaaAaAaaAAaAAAaaaAAAaaAAaAAAaAaAAAaAaAaA" },
  builder: { role: "builder", agent: "0x2222222222222222222222222222222222222222", owner: "0xBbBBBBbbBbBbbBbbBbBbBBbBBbbbBBBbBbbbBbBB" },
  security: { role: "security", agent: "0x3333333333333333333333333333333333333333", owner: "0xCCCcCCCcCCCCcCCCCCcCCCCCCCCcCCcCcCcCcCcC" },
};

async function report(over: Partial<Receipt> = {}): Promise<GradeReport> {
  const receipt: Receipt = {
    version: "pod.receipt.v1",
    seal: SEAL,
    commit: "c0ffee1234abcd",
    repository: "/repos/a-weather-page.git",
    tree: `0x${"11".repeat(32)}`,
    image: "node@sha256:9bef0ef1e268f60627da9ba7d7605e8831d5b56ad07487d24d1aa386336d1944",
    start: "node server.js",
    checks: [
      { says: "the page answers", command: "node loads.mjs", exitCode: 0, seconds: 0.4, hidden: false },
      { says: "a weak excuse scores lower", command: "node weak.mjs", exitCode: 0, seconds: 0.5, hidden: true },
    ],
    runs: 2,
    verdict: "passed",
    allowedHosts: [],
    undeclaredCalls: [],
    runner: RUNNER,
    finishedAt: "2026-09-17T12:00:00.000Z",
    ...over,
  };
  const signed = await signReceipt(receipt, KEY);
  return {
    verdict: { kind: receipt.verdict } as GradeReport["verdict"],
    signed,
    score: receipt.verdict === "passed" ? 100 : 0,
    tag: "pod.tests",
    rounds: [
      { checks: [], passed: true, artefactLog: "", seconds: 2 },
      { checks: [], passed: true, artefactLog: "", seconds: 3 },
    ],
  };
}

async function job(over: Partial<PublishJob> = {}): Promise<PublishJob> {
  return {
    jobId: "a-weather-page",
    seal: SEAL,
    idea: "A page that tells me whether to take a coat",
    mode: "flash",
    price: 25_000_000_000_000_000_000n,
    report: await report(),
    pod: [SEATS.lead!, SEATS.builder!],
    checksDirectory: new URL("../../fixtures/checks", import.meta.url).pathname,
    approvals: [],
    ...over,
  };
}

describe("what the wall is told about a graded job", () => {
  test("the tile says what the receipt says, and nothing it does not", async () => {
    const tile = tileFor(await job());
    expect(tile.verdict).toBe("passed");
    expect(tile.commit).toBe("c0ffee1234abcd");
    expect(tile.finishedAt).toBe("2026-09-17T12:00:00.000Z");
    expect(tile.receiptURI).toBe(receiptPath("a-weather-page"));
    // the time on the tile is the time the rounds took, added up
    expect(tile.seconds).toBe(5);
  });

  test("a failed job is published exactly as readily as a passed one", async () => {
    const tile = tileFor(await job({ report: await report({ verdict: "failed" }) }));
    expect(tile.verdict).toBe("failed");
    expect(tile.receiptHash?.startsWith("0x")).toBe(true);
  });

  test("a pod with nobody in the security seat says so on the tile", async () => {
    expect(tileFor(await job()).securityHeldByUs).toBe(true);
    expect(tileFor(await job({ pod: [SEATS.lead!, SEATS.security!] })).securityHeldByUs).toBe(false);
  });

  test("the hidden check is on the record, marked hidden rather than left out", async () => {
    const record = recordFor(await job());
    expect(record.checksSaid).toHaveLength(2);
    expect(record.checksSaid.filter((c) => c.hidden)).toHaveLength(1);
    expect(record.signed?.receipt.commit).toBe("c0ffee1234abcd");
  });
});

describe("a job that is open, before anybody has built anything", () => {
  const spec: Spec = {
    idea: "A page that tells me whether to take a coat, from my postcode",
    mode: "flash",
    price: 25_000_000_000_000_000_000n,
    checks: [
      { says: "the page answers with a verdict for today", run: "node loads.mjs", hidden: false },
      { says: "a cold, wet forecast says take a coat", run: "node cold.mjs", hidden: true },
      { says: "a postcode nobody recognises is refused, not guessed", run: "node nonsense.mjs", hidden: true },
    ],
    allowed: [{ host: "api.open-meteo.test", why: "the forecast" }],
    salt: "a-number-nobody-can-guess",
  };

  test("the page shows the visible checks, counts the sealed ones, and leaks neither", async () => {
    const store = new JobStore(await mkdtemp(join(tmpdir(), "pod-open-")));
    await openJob(store, {
      jobId: "coat-from-a-postcode",
      seal: SEAL,
      spec,
      endsAt: new Date("2026-09-18T10:00:00.000Z"),
      seats: [
        { role: "lead", seat: SEATS.lead! },
        { role: "builder", seat: SEATS.builder! },
        { role: "security" },
      ],
    });

    const body = await (await handle(new Request(`http://pod.test${jobPath("coat-from-a-postcode")}`), store)).text();

    expect(body).toContain("What will be checked");
    expect(body).toContain("the page answers with a verdict for today");
    expect(body).toContain("2 checks are sealed until there is a verdict");
    expect(body).toContain("security · open");

    // neither the hidden checks nor the salt reach the page
    expect(body).not.toContain("a cold, wet forecast");
    expect(body).not.toContain("nonsense.mjs");
    expect(body).not.toContain("a-number-nobody-can-guess");
  });

  test("an open job's checks are not fetchable, and the refusal says why", async () => {
    const store = new JobStore(await mkdtemp(join(tmpdir(), "pod-open-")));
    await openJob(store, {
      jobId: "coat-from-a-postcode", seal: SEAL, spec,
      endsAt: new Date("2026-09-18T10:00:00.000Z"),
      seats: [{ role: "lead", seat: SEATS.lead! }],
    });

    const response = await handle(new Request("http://pod.test/checks/coat-from-a-postcode"), store);
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("published when it has a verdict");
  });

  test("a pod with nobody in the security seat is disclosed while it is still open", async () => {
    const store = new JobStore(await mkdtemp(join(tmpdir(), "pod-open-")));
    const record = await openJob(store, {
      jobId: "coat-from-a-postcode", seal: SEAL, spec,
      endsAt: new Date("2026-09-18T10:00:00.000Z"),
      seats: [{ role: "lead", seat: SEATS.lead! }, { role: "security" }],
    });
    expect(record.tile.securityHeldByUs).toBe(true);
  });
});
