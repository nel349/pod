import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { gradeJob } from "../pipeline.ts";
import { publish } from "../publish.ts";
import { partsOf, repeat, saidPlainly } from "../repeat.ts";
import { serve } from "../server.ts";
import { JobStore } from "../store.ts";
import { jobPath } from "../routes.ts";
import type { CheckToRun } from "../blackbox.ts";

/**
 * A stranger, checking a verdict they had no part in.
 *
 * The server here is a real server on a real port, and the fetches are real fetches, because the
 * thing being proved is exactly that somebody with nothing but a URL can reach the same answer.
 */

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

const servers: { stop: () => void }[] = [];
afterAll(() => { for (const server of servers) server.stop(); });

async function publishedJob(): Promise<{ readonly jobURL: string }> {
  const report = await gradeJob({
    seal: SEAL, commit: "c0ffee1", artefact: ARTEFACT, start: "node server.js",
    checks: CHECKS, toRun, image: IMAGE, times: 2, runner: RUNNER, runnerKey: KEY,
  });

  const store = new JobStore(await mkdtemp(join(tmpdir(), "pod-repeat-store-")));
  await publish(store, {
    jobId: "coat-or-no-coat", seal: SEAL, idea: "A page that tells me whether to take a coat",
    mode: "flash", price: 25_000_000_000_000_000_000n, report,
    pod: [{ role: "lead", agent: RUNNER, owner: RUNNER }],
    checksDirectory: CHECKS, approvals: [],
  });

  const port = 8800 + Math.floor(Math.random() * 900);
  servers.push(serve(store, port));
  return { jobURL: `http://127.0.0.1:${port}${jobPath("coat-or-no-coat")}` };
}

describe("a job URL is all a stranger needs", () => {
  test("the URL tells them which server and which job", () => {
    const { origin, jobId } = partsOf("https://pod.example/job/coat-or-no-coat");
    expect(origin).toBe("https://pod.example");
    expect(jobId).toBe("coat-or-no-coat");
  });
});

describe.skipIf(!dockerAvailable)("repeating a verdict somebody else published", () => {
  test("the same code reaches the same answer, and the signature holds", async () => {
    const { jobURL } = await publishedJob();

    const outcome = await repeat({ jobURL, artefact: ARTEFACT, times: 2 });

    expect(outcome.published).toBe("passed");
    expect(outcome.here.kind).toBe("passed");
    expect(outcome.agrees).toBe(true);
    expect(outcome.signatureHolds).toBe(true);
    // the hidden check ran here too: it is published once there is a verdict
    expect(outcome.checksRun).toHaveLength(2);
    expect(saidPlainly(outcome)).toContain("The published verdict holds");
  }, 300_000);

  test("code that is not the graded code disagrees, and says so", async () => {
    const { jobURL } = await publishedJob();

    const different = await mkdtemp(join(tmpdir(), "pod-different-"));
    await writeFile(join(different, "server.js"),
      `require("http").createServer((_, res) => { res.setHeader("content-type","application/json"); res.end(JSON.stringify({score:5})); }).listen(3000, () => console.log("listening"));\n`);
    const { chmod } = await import("node:fs/promises");
    await chmod(different, 0o755);
    await chmod(join(different, "server.js"), 0o644);

    const outcome = await repeat({ jobURL, artefact: different, times: 2 });

    expect(outcome.published).toBe("passed");
    expect(outcome.here.kind).toBe("failed");
    expect(outcome.agrees).toBe(false);
    expect(saidPlainly(outcome)).toContain("This machine disagrees");
  }, 300_000);
});
