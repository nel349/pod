import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { neededOnCI } from "./support/tools.ts";

/**
 * Every test file is run by CI.
 *
 * CI names its test files by hand, one job per kind of machine a test needs, so a new file that
 * nobody adds to a job passes on the laptop that wrote it and is never run again. On 23 September
 * six new files, including the one that posts a job end to end, were in exactly that state. This is
 * the test that notices.
 */

const TESTS = new URL("./", import.meta.url).pathname;
const WORKFLOW = new URL("../../.github/workflows/ci.yml", import.meta.url).pathname;

describe("continuous integration", () => {
  test("runs every test file in the suite", async () => {
    const workflow = await Bun.file(WORKFLOW).text();
    const files = (await readdir(TESTS)).filter((name) => /\.test\.tsx?$/.test(name)).sort();
    const notRun = files.filter((name) => !workflow.includes(`src/__tests__/${name}`));
    expect(notRun).toEqual([]);
  });

  test("a test whose tool is missing on CI fails there, rather than skipping and passing", () => {
    const was = process.env.CI;
    try {
      process.env.CI = "true";
      expect(() => neededOnCI("anvil", false)).toThrow("anvil is not on this CI machine");
      expect(neededOnCI("anvil", true)).toBe(true);
      process.env.CI = "";
      expect(neededOnCI("anvil", false)).toBe(false);
    } finally {
      process.env.CI = was;
    }
  });
});
