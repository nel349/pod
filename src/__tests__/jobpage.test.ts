import { describe, expect, test } from "bun:test";
import { renderJob, repeatCommand, type JobPage } from "../jobpage.ts";
import type { Receipt } from "../receipt.ts";

const receipt: Receipt = {
  version: "pod.receipt.v1",
  seal: `0x${"ab".repeat(32)}`,
  commit: "c0ffee1234abcdef0123456789abcdef01234567",
  repository: "https://pod.example/bundle/one",
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
    pod: [],
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

  test("never says the platform held a seat: every seat is an agent's, or the contract pays nobody", () => {
    expect(renderJob(page({ tile: { ...page().tile, pod: [], verdict: "running" } }), "u")).not.toContain("held by the platform");
  });

  test("a job nobody has taken is waiting for a pod, and one with a seat taken is being built", () => {
    const waiting = renderJob(page({ tile: { ...page().tile, pod: [], verdict: "running" } }), "u");
    expect(waiting).toContain("waiting for a pod");
    const built = renderJob(page({ tile: { ...page().tile, verdict: "running" } }), "u");
    expect(built).toContain("being built");
  });

  test("while it runs, nothing says the checks the pod can see are sealed", () => {
    const running = renderJob(page({ tile: { ...page().tile, verdict: "running" } }), "u");
    expect(running).not.toContain("The pod cannot see them either");
  });

  test("shows the seal the idea was published under before it opened", () => {
    expect(renderJob(page(), "u")).toContain("sealed before it opened");
  });

  test("says where the work is, and what the title does about it", () => {
    const html = renderJob(page({
      repository: "https://github.com/pod/job-7",
      chain: { network: "monad-testnet", jobId: "7", jobs: "0xBAD5", tokenId: "4" },
    }), "u");

    expect(html).toContain("https://github.com/pod/job-7");
    expect(html).toContain("every attempt, including the ones that failed");
    expect(html).toContain("POD #4 is the title to this repository");
    expect(html).toContain("signing for it");
    // and where to read the same thing on the chain
    expect(html).toContain("Job 7");
  });

  test("a job that passed with no title says nobody can claim it yet", () => {
    expect(renderJob(page({ repository: "https://github.com/pod/job-7" }), "u"))
      .toContain("No title was minted");
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

  test("fetches the code from wherever the receipt names, in the way that address is fetched", () => {
    const first = (repository: string, publishedAt?: string): string =>
      repeatCommand({ ...receipt, repository }, "u", publishedAt).split("\n").slice(0, 2).join("\n");
    expect(first("https://github.com/proof-of-development/pod-one")).toStartWith("git clone https://github.com/proof-of-development/pod-one work && cd work && git checkout c0ffee");
    expect(first("https://pod.example/bundle/one")).toStartWith("curl -fsSL -o job.bundle https://pod.example/bundle/one && git clone job.bundle work");
    expect(first("/bundle/one")).toStartWith("curl -fsSL -o job.bundle <this site>/bundle/one");
    // a receipt signed with a folder on the grader's own machine says so, and fetches from where it was published
    const older = first("/Users/somebody/jobs/.repositories/one.git", "https://github.com/proof-of-development/pod-one");
    expect(older).toContain("names a folder on the grader's machine");
    expect(older).toContain("git clone https://github.com/proof-of-development/pod-one work");
    expect(first("/Users/somebody/jobs/.repositories/one.git")).toContain("some other way");
  });
});
