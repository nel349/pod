import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { gradeJob } from "../pipeline.ts";
import { publish } from "../publish.ts";
import { handle } from "../server.ts";
import { JobStore } from "../store.ts";
import { checkFilePath, checksPath, jobPath, receiptPath, ROUTES } from "../routes.ts";
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

const dockerAvailable = await (async () => {
  try {
    return (await Bun.spawn(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exited) === 0;
  } catch {
    return false;
  }
})();

const get = (store: JobStore, path: string): Promise<Response> =>
  handle(new Request(`http://pod.test${path}`), store);

describe.skipIf(!dockerAvailable)("graded, published, and read by a stranger", () => {
  test("what the box decided is what the page says, and the checks come back with it", async () => {
    const report = await gradeJob({
      seal: SEAL, commit: "c0ffee1", artefact: ARTEFACT, start: "node server.js",
      checks: CHECKS, toRun, image: IMAGE, times: 2, runner: RUNNER, runnerKey: KEY,
    });

    const store = new JobStore(await mkdtemp(join(tmpdir(), "pod-e2e-")));
    const record = await publish(store, {
      jobId: "coat-or-no-coat",
      seal: SEAL,
      idea: "A page that tells me whether to take a coat",
      mode: "flash",
      price: 25_000_000_000_000_000_000n,
      report,
      pod: [{ role: "lead", agent: RUNNER, owner: RUNNER }],
      checksDirectory: CHECKS,
      approvals: [{ role: "lead", agent: RUNNER, commit: "c0ffee1", at: report.signed.receipt.finishedAt }],
      open: "https://example.test/coat",
    });

    expect(record.tile.verdict).toBe(report.signed.receipt.verdict);

    const wall = await (await get(store, ROUTES.wall)).text();
    expect(wall).toContain("A page that tells me whether to take a coat");
    expect(wall).toContain("checks passed");

    const page = await (await get(store, jobPath("coat-or-no-coat"))).text();
    expect(page).toContain("the page answers");
    expect(page).toContain("Check it yourself");
    expect(page).toContain(report.signed.receipt.image);

    // the stranger's path: the receipt as it was signed, and every check that produced it
    const served = await (await get(store, receiptPath("coat-or-no-coat"))).json();
    expect(await verifyReceipt(served as Awaited<ReturnType<typeof gradeJob>>["signed"])).toBe(true);

    const index = await (await get(store, checksPath("coat-or-no-coat"))).text();
    expect(index).toContain(checkFilePath("coat-or-no-coat", "weak.mjs"));
    const hidden = await get(store, checkFilePath("coat-or-no-coat", "weak.mjs"));
    expect(hidden.status).toBe(200);
    expect((await hidden.text()).length).toBeGreaterThan(0);
  }, 300_000);
});
