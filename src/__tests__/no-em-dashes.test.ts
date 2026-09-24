import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

/**
 * No em dash reaches a reader.
 *
 * On a web page the em dash has become the tell of text nobody wrote, and the person this product is
 * for reads it that way. So none may appear in anything a visitor sees: page text, the words the
 * posting page uses, the card that travels when a job is shared, a refusal the server sends, or the
 * stylesheets. Written as the character or as either HTML spelling of it.
 *
 * Comments are not shown to anybody and are left alone. Everything else under src/, agents/ and
 * public/ is searched, because a string that renders can live in any file. Text the check writer's
 * model produces is not in any file; the server rewrites dashes out of it before it is shown, and
 * checkwriting.test.ts holds that.
 */

const DASHES = ["—", "&mdash;", "&#8212;", "&#x2014;"];
const COMMENT = /^\s*(\*|\/\/|\/\*)/;

async function linesWithDashes(): Promise<string[]> {
  const found: string[] = [];
  const root = new URL("../..", import.meta.url).pathname;
  for (const pattern of ["src/**/*.{ts,tsx,html,css}", "agents/**/*.js", "public/**/*.{css,html}"]) {
    for await (const path of new Glob(pattern).scan(root)) {
      if (path.includes("__tests__")) continue;
      const lines = (await Bun.file(`${root}${path}`).text()).split("\n");
      lines.forEach((line, i) => {
        if (DASHES.some((dash) => line.includes(dash)) && !COMMENT.test(line)) {
          found.push(`${path}:${i + 1}: ${line.trim().slice(0, 100)}`);
        }
      });
    }
  }
  return found;
}

describe("what a visitor reads", () => {
  test("has no em dash in it anywhere, in any spelling", async () => {
    expect(await linesWithDashes()).toEqual([]);
  });
});
