import { describe, expect, test } from "bun:test";
import { MOST_SITE_FILES, siteFilesIn } from "../reference/roles/Builder.ts";

const block = (name: string, contents: string): string => `### ${name}\n\`\`\`html\n${contents}\n\`\`\``;

describe("the files of a website, in a builder's answer", () => {
  test("each named file is written whole, a page at an address of its own among them", () => {
    const answer = [block("site/index.html", "<h1>Cards</h1>"), block("site/cards/pikachu.html", "<h1>Pikachu</h1>")].join("\n\n");
    expect(siteFilesIn(answer)).toEqual({ "site/index.html": "<h1>Cards</h1>\n", "site/cards/pikachu.html": "<h1>Pikachu</h1>\n" });
  });

  test("a name may be written the ways a model writes one: in ticks, or under a deeper heading", () => {
    const answer = "#### `site/index.html`\n\n```html\n<p>front</p>\n```\n## site/about.html\n```\n<p>about</p>\n```";
    expect(Object.keys(siteFilesIn(answer))).toEqual(["site/index.html", "site/about.html"]);
  });

  test("an answer that names no file is the front page alone", () => {
    expect(siteFilesIn("```html\n<p>one page</p>\n```")).toEqual({ "site/index.html": "<p>one page</p>\n" });
    expect(siteFilesIn("<p>all of it is the page</p>")).toEqual({ "site/index.html": "<p>all of it is the page</p>\n" });
  });

  test("a file named outside the website's folder is refused, and nothing of the answer is written", () => {
    for (const outside of ["../secrets.txt", "site/../../etc/passwd", "/etc/passwd", "index.html", "site/", "site/.git/config", "sitex/index.html"]) {
      expect(() => siteFilesIn([block("site/index.html", "<p>fine</p>"), block(outside, "x")].join("\n"))).toThrow("outside the website's folder");
    }
  });

  test("a website with no front page is refused, and so is one with more files than a small site has", () => {
    expect(() => siteFilesIn(block("site/cards/pikachu.html", "<p>a card</p>"))).toThrow("no front page");
    const many = Array.from({ length: MOST_SITE_FILES + 1 }, (_, index) => block(`site/page-${index}.html`, "<p>x</p>")).join("\n");
    expect(() => siteFilesIn(`${block("site/index.html", "<p>front</p>")}\n${many}`)).toThrow(`at most ${MOST_SITE_FILES}`);
  });
});
