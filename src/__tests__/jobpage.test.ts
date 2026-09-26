import { describe, expect, test } from "bun:test";
import { repeatCommand } from "../jobpage.ts";
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
