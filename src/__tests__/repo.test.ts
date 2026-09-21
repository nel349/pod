import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BRANCH, bundle, bytes32ToCommit, checkout, commitToBytes32, commitWork, has, head, history,
  openRepository, type Repository,
} from "../repo.ts";
import { fingerprintTree } from "../receipt.ts";

/**
 * The repository a job owns.
 *
 * Every test here is about the thing that was missing on 17 September: that the commit a verdict
 * names is a commit, in a repository, holding the code that was graded. Break any of it — commit the
 * wrong tree, grade a different commit, hand back an id that is not in the repository — and one of
 * these goes red.
 */

async function workspace(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pod-work-"));
  for (const [name, contents] of Object.entries(files)) {
    const path = join(directory, name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, contents);
  }
  return directory;
}

async function aRepository(): Promise<Repository> {
  return openRepository(await mkdtemp(join(tmpdir(), "pod-repos-")), "a-weather-page");
}

const BUILDER = { agent: "builder-one", email: "builder@pod.invalid" };

describe("a job's repository", () => {
  test("a fresh one has no commits, and says so rather than inventing one", async () => {
    const repo = await aRepository();
    expect(await head(repo)).toBeUndefined();
    expect(await history(repo)).toEqual([]);
  });

  test("what an agent left behind becomes a commit, under that agent's name", async () => {
    const repo = await aRepository();
    const commit = await commitWork(repo, {
      workspace: await workspace({ "server.js": "console.log('hello')\n" }),
      message: "a first attempt", ...BUILDER,
    });

    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    expect(await head(repo)).toBe(commit);
    expect(await has(repo, commit)).toBe(true);

    const [latest] = await history(repo);
    expect(latest).toMatchObject({ commit, message: "a first attempt", agent: "builder-one" });
  });

  test("a second attempt is a commit on the same branch, and the first one is still there", async () => {
    const repo = await aRepository();
    const first = await commitWork(repo, {
      workspace: await workspace({ "server.js": "// wrong\n" }), message: "first", ...BUILDER,
    });
    const second = await commitWork(repo, {
      workspace: await workspace({ "server.js": "// right\n" }), message: "second", ...BUILDER,
    });

    expect(second).not.toBe(first);
    expect(await head(repo)).toBe(second);
    expect((await history(repo)).map((c) => c.message)).toEqual(["second", "first"]);
    expect(await has(repo, first)).toBe(true);
  });

  test("a file the agent deleted is a file the commit deletes", async () => {
    const repo = await aRepository();
    await commitWork(repo, {
      workspace: await workspace({ "keep.js": "1\n", "gone.js": "2\n" }), message: "both", ...BUILDER,
    });
    const second = await commitWork(repo, {
      workspace: await workspace({ "keep.js": "1\n" }), message: "one of them", ...BUILDER,
    });

    const laid = await mkdtemp(join(tmpdir(), "pod-out-"));
    await checkout(repo, second, laid);
    expect((await readdir(laid)).sort()).toEqual(["keep.js"]);
  });

  test("grading gets one exact commit, with no history to read", async () => {
    const repo = await aRepository();
    const first = await commitWork(repo, {
      workspace: await workspace({ "server.js": "// the first try\n" }), message: "first", ...BUILDER,
    });
    await commitWork(repo, {
      workspace: await workspace({ "server.js": "// the second try\n" }), message: "second", ...BUILDER,
    });

    const laid = await mkdtemp(join(tmpdir(), "pod-out-"));
    await checkout(repo, first, laid);

    expect(await Bun.file(join(laid, "server.js")).text()).toBe("// the first try\n");
    // the box must not be able to read the history of what it is judging
    expect(await Bun.file(join(laid, ".git")).exists()).toBe(false);
  });

  test("two different commits describe two different trees", async () => {
    const repo = await aRepository();
    const first = await commitWork(repo, {
      workspace: await workspace({ "server.js": "// one\n" }), message: "first", ...BUILDER,
    });
    const second = await commitWork(repo, {
      workspace: await workspace({ "server.js": "// two\n" }), message: "second", ...BUILDER,
    });

    const a = await mkdtemp(join(tmpdir(), "pod-a-"));
    const b = await mkdtemp(join(tmpdir(), "pod-b-"));
    await checkout(repo, first, a);
    await checkout(repo, second, b);

    expect(await fingerprintTree(a)).not.toBe(await fingerprintTree(b));
  });

  test("a commit that is not in the repository cannot be graded", async () => {
    const repo = await aRepository();
    await commitWork(repo, { workspace: await workspace({ "a.js": "1\n" }), message: "only", ...BUILDER });

    const invented = "d15d0cb".padEnd(40, "0");
    expect(await has(repo, invented)).toBe(false);
    expect(checkout(repo, invented, await mkdtemp(join(tmpdir(), "pod-out-"))))
      .rejects.toThrow("is not a commit");
  });

  test("the copy that survives us holds the history, and can be cloned from", async () => {
    const repo = await aRepository();
    const commit = await commitWork(repo, {
      workspace: await workspace({ "server.js": "// the work\n" }), message: "the work", ...BUILDER,
    });

    const file = join(await mkdtemp(join(tmpdir(), "pod-bundle-")), "job.bundle");
    await bundle(repo, file);
    expect(await Bun.file(file).exists()).toBe(true);

    // clone from the file alone, with the original out of reach
    const clonedInto = join(await mkdtemp(join(tmpdir(), "pod-clone-")), "clone");
    const cloning = Bun.spawn(["git", "clone", "--quiet", file, clonedInto], { stdout: "ignore", stderr: "pipe" });
    expect(await cloning.exited).toBe(0);
    await rm(repo.path, { recursive: true, force: true });

    const cloned = { path: join(clonedInto, ".git"), jobId: "a-weather-page" };
    expect(await has(cloned, commit)).toBe(true);
    expect(await Bun.file(join(clonedInto, "server.js")).text()).toBe("// the work\n");
  });
});

describe("a seat that produced nothing", () => {
  test("makes no commit, rather than committing that nothing happened", async () => {
    const repo = await aRepository();
    const { commitIfChanged } = await import("../repo.ts");
    const nothing = await mkdtemp(join(tmpdir(), "pod-nothing-"));

    expect(await commitIfChanged(repo, { workspace: nothing, message: "nothing", ...BUILDER }))
      .toBeUndefined();
    expect(await head(repo)).toBeUndefined();
    expect(await history(repo)).toEqual([]);
  });
});

describe("a commit id, as the chain holds it", () => {
  test("it goes in and comes back the same", () => {
    const commit = "c0ffee1234abcdef0123456789abcdef01234567";
    expect(bytes32ToCommit(commitToBytes32(commit))).toBe(commit);
  });

  test("a longer id survives too, for a repository on the newer hash", () => {
    const commit = "a".repeat(64);
    expect(commitToBytes32(commit)).toBe(`0x${commit}`);
    expect(bytes32ToCommit(commitToBytes32(commit))).toBe(commit);
  });

  test("something that is not an object id is refused before it reaches the chain", () => {
    expect(() => commitToBytes32("d15d0cb")).toThrow("is not an object id");
    expect(() => commitToBytes32("the second one")).toThrow("is not an object id");
  });
});

describe("the branch", () => {
  test("a pod works on one", () => {
    expect(BRANCH).toBe("main");
  });
});
