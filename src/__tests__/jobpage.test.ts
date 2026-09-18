import { describe, expect, test } from "bun:test";
import { renderJob, repeatCommand, type JobPage } from "../jobpage.ts";
import type { Receipt } from "../receipt.ts";

const receipt: Receipt = {
  version: "pod.receipt.v1",
  seal: `0x${"ab".repeat(32)}`,
  commit: "c0ffee1",
  tree: `0x${"cd".repeat(32)}`,
  image: "node@sha256:9bef0ef1e268f60627da9ba7d7605e8831d5b56ad07487d24d1aa386336d1944",
  start: "node server.js",
  checks: [],
  runs: 3,
  verdict: "passed",
  allowedHosts: [],
  undeclaredCalls: [],
  runner: "0x00000000000000000000000000000000000000cc",
  finishedAt: "2026-10-01T12:00:00.000Z",
};

const page = (over: Partial<JobPage> = {}): JobPage => ({
  tile: {
    jobId: "7", idea: "a site that rates my excuses", mode: "flash", verdict: "passed",
    open: "https://pod.example/j/7", commit: "c0ffee1", seconds: 2220, price: 20n,
    pod: [], securityHeldByUs: false,
  },
  seal: `0x${"ab".repeat(32)}`,
  checksSaid: [
    { says: "the page answers", hidden: false, exitCode: 0 },
    { says: "a weak excuse scores lower", hidden: true, exitCode: 0 },
  ],
  approvals: [
    { role: "lead", agent: "0xa1", commit: "c0ffee1", at: "2026-10-01T12:30:00Z" },
    { role: "security", agent: "0xa5", commit: "c0ffee1", at: "2026-10-01T12:34:00Z" },
  ],
  receipt,
  repository: "https://github.com/pod/job-7",
  podHolder: "0xowner",
  ...over,
});

describe("the job page", () => {
  test("shows what was checked, and marks the ones the pod never saw", () => {
    const html = renderJob(page(), "https://pod.example/checks/7");
    expect(html).toContain("the page answers");
    expect(html).toContain("hidden from the pod");
  });

  test("shows who signed what, and on which commit", () => {
    const html = renderJob(page(), "https://pod.example/checks/7");
    expect(html).toContain("security");
    expect(html).toContain("c0ffee1");
  });

  test("says when the platform held the security seat", () => {
    const held = renderJob(page({ tile: { ...page().tile, securityHeldByUs: true } }), "u");
    expect(held).toContain("held by the platform");
  });

  test("shows the seal the idea was published under before it opened", () => {
    expect(renderJob(page(), "u")).toContain("sealed before it opened");
  });

  test("says where the code went and who holds the token", () => {
    const html = renderJob(page(), "u");
    expect(html).toContain("https://github.com/pod/job-7");
    expect(html).toContain("0xowner");
  });

  test("a job with no receipt yet simply omits the repeat instructions", () => {
    expect(renderJob(page({ receipt: undefined }), "u")).not.toContain("Check it yourself");
  });
});

describe("repeating the run", () => {
  test("names the image by digest, cuts the network, and gives the fingerprint to compare", () => {
    const command = repeatCommand(receipt, "https://pod.example/checks/7");
    expect(command).toContain("@sha256:");
    expect(command).toContain("--network none");
    expect(command).toContain(receipt.tree);
    expect(command).toContain("https://pod.example/checks/7");
  });
});
