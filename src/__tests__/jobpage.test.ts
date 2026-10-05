import { describe, expect, test } from "bun:test";
import { POD_SOURCE, repeatCommand } from "../jobpage.ts";
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
  test("is the grading itself, run by the reader: this job on this site, the image by digest, the tree to hold the code against", () => {
    const lines = repeatCommand(receipt, "one").split("\n");
    expect(lines).toContain(`cd .. && git clone ${POD_SOURCE} pod && cd pod && bun install`);
    expect(lines).toContain("bun run src/repeat.ts <this site>/job/one ../work");
    const said = lines.filter((line) => line.startsWith("#")).join("\n");
    expect(said).toContain("<this site>/checks/one");
    expect(said).toContain(receipt.image);
    expect(said).toContain(receipt.tree);
  });

  test("every line that is not said is one that runs: nothing is sketched", () => {
    const commands = repeatCommand(receipt, "one").split("\n").filter((line) => !line.startsWith("#"));
    // the code is fetched into ./work and left there; the grading is run from beside it, on that folder
    expect(commands).toHaveLength(3);
    expect(commands[0]).toEndWith(`cd work && git checkout ${receipt.commit}`);
    expect(commands[1]).toStartWith("cd .. && ");
    expect(commands[2]).toEndWith(" ../work");
    // the box is the grader's to start, with what it needs to be written in: a hand-written docker line was not it
    expect(commands.join("\n")).not.toContain("docker run");
  });

  test("fetches the code from wherever the receipt names, in the way that address is fetched", () => {
    const first = (repository: string, publishedAt?: string): string =>
      repeatCommand({ ...receipt, repository }, "one", publishedAt).split("\n").slice(1, 3).join("\n");
    expect(first("https://github.com/proof-of-development/pod-one")).toStartWith("git clone https://github.com/proof-of-development/pod-one work && cd work && git checkout c0ffee");
    expect(first("https://pod.example/bundle/one")).toStartWith("curl -fsSL -o job.bundle https://pod.example/bundle/one && git clone job.bundle work");
    expect(first("/bundle/one")).toStartWith("curl -fsSL -o job.bundle <this site>/bundle/one");
    // a receipt signed with a folder on the grader's own machine says so, and fetches from where it was published
    const older = first("/Users/somebody/jobs/.repositories/one.git", "https://github.com/proof-of-development/pod-one");
    expect(older).toContain("names a folder on the grader's machine");
    expect(older).toContain("git clone https://github.com/proof-of-development/pod-one work");
    expect(first("/Users/somebody/jobs/.repositories/one.git")).toContain("some other way");
  });

  test("a receipt that names the grader's own machine says so, and fetches the same history from this site", () => {
    const lines = (repository: string): string[] => repeatCommand({ ...receipt, repository }, "one").split("\n").slice(1);
    for (const itsOwn of ["http://localhost:3000/bundle/one", "http://127.0.0.1:3000/bundle/one", "http://[::1]:3000/bundle/one"]) {
      const [said, named, served, fetched] = lines(itsOwn);
      expect([said, named, served]).toEqual([
        "# this receipt names the grader's own machine, which nobody else can reach:",
        `#   ${itsOwn}`,
        "# the same history is served here",
      ]);
      expect(fetched).toStartWith("curl -fsSL -o job.bundle <this site>/bundle/one && git clone job.bundle work");
      // the address nobody can reach is said, never fetched
      expect(fetched).not.toContain("3000");
    }
    // a host that only starts like one of those is somebody's real host
    expect(lines("https://localhost.example/bundle/one")[0]).toStartWith("curl -fsSL -o job.bundle https://localhost.example/bundle/one");
  });
});
