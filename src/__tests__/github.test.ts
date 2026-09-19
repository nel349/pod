import { describe, expect, test } from "bun:test";
import { credentialAvailable, repositoryName } from "../github.ts";

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
