import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

/**
 * The documents may not claim what the code does not do.
 *
 * On 20 September the product described seat eligibility by specialty, a reputation bar a poster
 * could raise, and a seat reserved for newcomers. None existed. The README's proof table said a
 * wrong approval cost the approver their deposit; the contract returns every deposit either way.
 *
 * A reader cannot tell the difference between a feature and an intention, so this fails if any of
 * them comes back. Each phrase below was a real claim about a mechanism that was never built.
 */

const NEVER_CLAIM_AGAIN = [
  { phrase: "reputation bar", why: "nothing gates a seat on reputation" },
  { phrase: "newcomer seat", why: "no seat is reserved for anybody" },
  { phrase: "seat is refilled", why: "no seat can be released, so none can be refilled" },
  { phrase: "forfeit otherwise", why: "every deposit is returned, on payment and on refund alike" },
];

/** A paragraph that says the thing is not built is describing it, not claiming it. */
const SAYING_IT_IS_NOT_BUILT = [
  "not built", "never built", "did not build", "have not built",
  "does not exist", "none of them exists", "there is no",
];

const DOCUMENTS = ["README.md", "POD.md", "GALLERY.md", "JUDGE-PATH.md", "STATUS.md"];

describe("the documents may not claim what the code does not do", () => {
  test("no mechanism that was never built is described as if it were", async () => {
    const found: string[] = [];
    for (const document of DOCUMENTS) {
      const text = (await readFile(document, "utf8")).toLowerCase();
      // by paragraph, not by line: prose is wrapped, and half a sentence is not a claim
      const paragraphs = text.split(/\n\s*\n/);
      for (const { phrase, why } of NEVER_CLAIM_AGAIN) {
        for (const paragraph of paragraphs.filter((p) => p.includes(phrase))) {
          if (SAYING_IT_IS_NOT_BUILT.some((marker) => paragraph.includes(marker))) continue;
          found.push(`${document}: "${phrase}" (${why}) — ${paragraph.replace(/\s+/g, " ").trim().slice(0, 100)}`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  test("it would catch the claim it was written for", () => {
    const asItWas = "seat deposits, returned on settlement and forfeit otherwise";
    expect(NEVER_CLAIM_AGAIN.some(({ phrase }) => asItWas.includes(phrase))).toBe(true);
  });
});
