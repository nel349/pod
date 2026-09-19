import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The test that would have caught it.
 *
 * On 17 September this project graded fixtures at commit strings somebody typed — `d15d0cb`,
 * `7ae91bb` — and every test passed, because every test was about the grading. No test about
 * behaviour can catch a thing that was never wired; only a test about absence can.
 *
 * So: a commit in this codebase comes from git, or it is refused. Anything that looks like a commit
 * and was written by hand is a finding, and this goes red until it is gone.
 */

const LOOKS_LIKE_A_COMMIT = /^[0-9a-f]{6,39}$/;

/** Where a value is a commit: a field named for one, or a variable holding one. */
const ASSIGNS_A_COMMIT = [
  /\bcommit(?:Hash)?\s*[:=]\s*"([^"]+)"/g,
  /\bPOD_DEMO_COMMIT\s*\?\?\s*"([^"]+)"/g,
  /\bcommitToBytes32\("([^"]+)"\)/g,
];

async function sourceFiles(from: string): Promise<readonly string[]> {
  const found: string[] = [];
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "__tests__" || entry.name.startsWith(".")) continue;
    const path = join(from, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(path)));
    else if (entry.name.endsWith(".ts")) found.push(path);
  }
  return found;
}

describe("a commit comes from git, or it does not exist", () => {
  test("nothing outside the tests writes a commit id by hand", async () => {
    const files = [...(await sourceFiles("src")), ...(await sourceFiles("scripts"))];
    const invented: string[] = [];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const pattern of ASSIGNS_A_COMMIT) {
        for (const match of source.matchAll(pattern)) {
          const value = match[1]!;
          // a real object id is forty characters, or sixty-four on the newer hash
          if (LOOKS_LIKE_A_COMMIT.test(value)) invented.push(`${file}: ${match[0]}`);
        }
      }
    }

    expect(invented).toEqual([]);
  });

  test("the pattern it hunts for is one it would actually catch", () => {
    // the exact line that let the gap through, so this test proves it is not blind
    const theLineThatSlipped = `const commit = process.env.POD_DEMO_COMMIT ?? "d15d0cb";`;
    const caught = ASSIGNS_A_COMMIT.some((pattern) =>
      [...theLineThatSlipped.matchAll(pattern)].some((m) => LOOKS_LIKE_A_COMMIT.test(m[1]!)),
    );
    expect(caught).toBe(true);
  });

  test("a real object id is not a finding, because it came from git", () => {
    const real = `const commit = "c0ffee1234abcdef0123456789abcdef01234567";`;
    const caught = ASSIGNS_A_COMMIT.some((pattern) =>
      [...real.matchAll(pattern)].some((m) => LOOKS_LIKE_A_COMMIT.test(m[1]!)),
    );
    expect(caught).toBe(false);
  });
});
