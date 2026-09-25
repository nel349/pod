import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialAvailable, push, repositoryName } from "../github.ts";
import { commitWork, head, openRepository } from "../repo.ts";

/**
 * A job's repository on GitHub.
 *
 * The part that can be checked without touching anybody's account is checked here. The part that
 * cannot — making a repository, pushing to it, reading the commit back — is proven by running a job,
 * because a test that creates a repository on every push would leave a trail of them.
 *
 * What this must never do is pass quietly when there is no credential. It says which half it ran.
 */
describe("a job's repository on GitHub", () => {
  test("its name can be matched to the wall without thinking", () => {
    expect(repositoryName("a-coat-or-not")).toBe("pod-a-coat-or-not");
  });

  test("whether this machine can act on GitHub is a question with an answer", async () => {
    const can = await credentialAvailable();
    // either is fine; silence is not. A run that publishes nothing should say so out loud
    expect(typeof can).toBe("boolean");
    if (!can) console.log("  (no GitHub credential here, so the publishing half is not exercised)");
  });

  test("pushing keeps the token off git's command line, where anybody on the machine can list it", async () => {
    const folder = await mkdtemp(join(tmpdir(), "pod-github-push-"));
    const repo = await openRepository(folder, "a-coat");
    const workspace = await mkdtemp(join(tmpdir(), "pod-github-work-"));
    await writeFile(join(workspace, "server.js"), "// the work\n");
    const commit = await commitWork(repo, { workspace, message: "the work", agent: "builder", email: "b@agents.pod.invalid" });
    const target = await openRepository(folder, "on-github");

    // a git that writes down how it was started, and then is git
    const shim = await mkdtemp(join(tmpdir(), "pod-git-shim-"));
    const started = join(shim, "started");
    const realGit = Bun.which("git");
    if (!realGit) throw new Error("git is not installed");
    await writeFile(join(shim, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${started}'\nexec '${realGit}' "$@"\n`);
    await chmod(join(shim, "git"), 0o755);
    const secret = "the-token-nobody-may-see";
    const was = { path: process.env.PATH, token: process.env.POD_GITHUB_TOKEN };
    process.env.PATH = `${shim}:${was.path ?? "/usr/bin:/bin"}`;
    process.env.POD_GITHUB_TOKEN = secret;
    try {
      await push(repo, { owner: "pod", name: "on-github", url: "https://example.invalid", cloneUrl: `file://${target.path}` }, "every branch");
    } finally {
      process.env.PATH = was.path;
      if (was.token === undefined) delete process.env.POD_GITHUB_TOKEN;
      else process.env.POD_GITHUB_TOKEN = was.token;
    }
    expect(await head(target)).toBe(commit);
    const commands = await readFile(started, "utf8");
    expect(commands).toContain("push");
    expect(commands).not.toContain(secret);
    expect(commands).not.toContain(btoa(`x-access-token:${secret}`));
  });

  test("a token never reaches an argument, so it cannot reach a log", async () => {
    const source = await Bun.file(new URL("../github.ts", import.meta.url)).text();
    // every exported function takes what it works on, never the credential
    const signatures = [...source.matchAll(/export async function (\w+)\(([^)]*)\)/g)];
    expect(signatures.length).toBeGreaterThan(3);
    for (const [, name, parameters] of signatures) {
      expect({ name, mentionsToken: /token|credential|secret/i.test(parameters!) })
        .toEqual({ name, mentionsToken: false });
    }
  });
});
