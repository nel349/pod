import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { gradeJob, undeclaredCalls } from "../pipeline.ts";
import { verifyReceipt } from "../receipt.ts";
import type { CheckToRun } from "../blackbox.ts";

const IMAGE = "node@sha256:9bef0ef1e268f60627da9ba7d7605e8831d5b56ad07487d24d1aa386336d1944";
const ARTEFACT = new URL("../../fixtures/app-honest", import.meta.url).pathname;
const CHECKS = new URL("../../fixtures/checks", import.meta.url).pathname;
const KEY = `0x${"7".repeat(64)}` as const;
const RUNNER = privateKeyToAccount(KEY).address;
const SEAL = `0x${"ab".repeat(32)}` as const;

const toRun: CheckToRun[] = [
  { says: "the page answers", command: "node loads.mjs", hidden: false },
  { says: "a weak excuse scores lower", command: "node weak.mjs", hidden: true },
];

describe("spotting a call nobody declared", () => {
  test("a failed lookup in the artefact's log is reported", () => {
    const log = "listening\ngetaddrinfo ENOTFOUND api.example.com";
    expect(undeclaredCalls(log, [])).toHaveLength(1);
  });

  test("a host the job declared is not a finding", () => {
    const log = "listening\ngetaddrinfo ENOTFOUND api.weather.test";
    expect(undeclaredCalls(log, ["api.weather.test"])).toHaveLength(0);
  });

  test("a quiet artefact produces no findings", () => {
    expect(undeclaredCalls("listening\nserved 12 requests", [])).toHaveLength(0);
  });
});

const dockerAvailable = await (async () => {
  try {
    return (await Bun.spawn(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exited) === 0;
  } catch {
    return false;
  }
})();

describe.skipIf(!dockerAvailable)("a job, graded end to end", () => {
  test("work that holds up is passed, signed, and scored 100", async () => {
    const report = await gradeJob({
      seal: SEAL, commit: "c0ffee1", artefact: ARTEFACT, start: "node server.js",
      checks: CHECKS, toRun, image: IMAGE, times: 2, runner: RUNNER, runnerKey: KEY,
    });

    expect(report.verdict.kind).toBe("passed");
    expect(report.score).toBe(100);
    expect(report.tag).toBe("pod.tests");
    expect(await verifyReceipt(report.signed)).toBe(true);
    expect(report.signed.receipt.checks).toHaveLength(2);
    expect(report.signed.receipt.tree.startsWith("0x")).toBe(true);
  }, 300_000);

  test("work that only looks right is failed, and still signed", async () => {
    const lazy = await mkdtemp(join(tmpdir(), "pod-lazy-"));
    await writeFile(join(lazy, "server.js"),
      `require("http").createServer((_, res) => { res.setHeader("content-type","application/json"); res.end(JSON.stringify({score:5})); }).listen(3000, () => console.log("listening"));\n`);

    const report = await gradeJob({
      seal: SEAL, commit: "c0ffee2", artefact: lazy, start: "node server.js",
      checks: CHECKS, toRun, image: IMAGE, times: 2, runner: RUNNER, runnerKey: KEY,
    });

    expect(report.verdict.kind).toBe("failed");
    expect(report.score).toBe(0);
    expect(await verifyReceipt(report.signed)).toBe(true);
  }, 300_000);

  test("an artefact that cannot make up its mind reaches no verdict at all", async () => {
    const flaky = await mkdtemp(join(tmpdir(), "pod-flaky-"));
    await writeFile(join(flaky, "server.js"),
      `const weak = Math.random() < 0.5;
       require("http").createServer((req, res) => {
         const url = new URL(req.url, "http://x");
         const excuse = url.searchParams.get("excuse") ?? "";
         const score = weak ? 5 : Math.max(1, Math.min(10, Math.ceil(excuse.trim().length / 8)));
         res.setHeader("content-type","application/json");
         res.end(JSON.stringify({ excuse, score }));
       }).listen(3000, () => console.log("listening"));\n`);

    // ten rounds: a coin flip each time, so agreement across all ten is vanishingly unlikely
    const report = await gradeJob({
      seal: SEAL, commit: "c0ffee3", artefact: flaky, start: "node server.js",
      checks: CHECKS, toRun, image: IMAGE, times: 10, runner: RUNNER, runnerKey: KEY,
    });

    expect(report.verdict.kind).toBe("not-reproducible");
    expect(report.score).toBe(0);
    expect(report.tag).toBe("pod.tests.unreproducible");
    expect(report.signed.receipt.verdict).toBe("not-reproducible");
  }, 600_000);
});
