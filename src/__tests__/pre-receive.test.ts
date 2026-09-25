import { describe, expect, test } from "bun:test";
import { creditEmail } from "../credit.ts";
import { agentEmail, branchFor, refusalFor, updatesFrom, type Arriving, type Commits } from "../door/index.ts";

/**
 * What a push may change, as rules alone, without a repository: the git door runs them inside git on
 * every push, and door.test.ts pushes against them for real. Here each rule is shown to be the one
 * that refuses, fast, with the history written out by hand.
 */

const AGENT = "0x2222222222222222222222222222222222222222";
const SEAT = { branch: branchFor("builder", AGENT), email: agentEmail(AGENT) };
const NONE = "0".repeat(40);
const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const OTHER = "c".repeat(40);

/** A history written out by hand: what descends from what, and which commits a push brings. */
function history(input: {
  readonly descends?: readonly (readonly [string, string])[];
  readonly arriving?: readonly Arriving[];
}): Commits {
  return {
    isAncestor: async (older, newer) => older === newer || (input.descends ?? []).some(([a, b]) => a === older && b === newer),
    arriving: async () => input.arriving ?? [],
  };
}

const mine = (commit: string): Arriving => ({ commit, author: SEAT.email, committer: SEAT.email, coAuthors: [] });
/** the GitHub account the seat's owner linked, and one nobody linked */
const LINKED = creditEmail({ login: "octocat", githubId: 583231 });
const UNLINKED = creditEmail({ login: "someone", githubId: 42 });
const CREDITED = { ...SEAT, credit: LINKED };

describe("the rules for a push", () => {
  test("git's lines are read as old, new and the branch", () => {
    expect(updatesFrom(`${OLD} ${NEW} refs/heads/${SEAT.branch}\n\n`)).toEqual([{ old: OLD, new: NEW, ref: `refs/heads/${SEAT.branch}` }]);
  });

  test("a new branch, of the seat's own commits, on the seat's own branch, moves", async () => {
    const pushed = updatesFrom(`${NONE} ${NEW} refs/heads/${SEAT.branch}`);
    expect(await refusalFor(pushed, SEAT, history({ arriving: [mine(NEW)] }))).toBeUndefined();
  });

  test("somebody else's branch is refused, and main with it", async () => {
    for (const branch of [branchFor("lead", AGENT), "main", branchFor("builder", "0x3333333333333333333333333333333333333333")]) {
      const refused = await refusalFor(updatesFrom(`${NONE} ${NEW} refs/heads/${branch}`), SEAT, history({ arriving: [mine(NEW)] }));
      expect(refused).toContain(`you may push only to ${SEAT.branch}`);
    }
  });

  test("a branch is never deleted", async () => {
    const refused = await refusalFor(updatesFrom(`${OLD} ${NONE} refs/heads/${SEAT.branch}`), SEAT, history({}));
    expect(refused).toContain("never deleted");
  });

  test("history is never rewritten, and adding to it is fine", async () => {
    const onTop = history({ descends: [[OLD, NEW]], arriving: [mine(NEW)] });
    expect(await refusalFor(updatesFrom(`${OLD} ${NEW} refs/heads/${SEAT.branch}`), SEAT, onTop)).toBeUndefined();
    const elsewhere = history({ descends: [[OLD, NEW]], arriving: [mine(OTHER)] });
    expect(await refusalFor(updatesFrom(`${OLD} ${OTHER} refs/heads/${SEAT.branch}`), SEAT, elsewhere)).toContain("never rewritten");
  });

  test("every commit a push brings is written and committed as the seat, and only the seat", async () => {
    const pushed = updatesFrom(`${NONE} ${NEW} refs/heads/${SEAT.branch}`);
    const writtenByAnother = history({ arriving: [mine(OLD), { commit: NEW, author: "someone@example.com", committer: SEAT.email, coAuthors: [] }] });
    expect(await refusalFor(pushed, SEAT, writtenByAnother)).toContain("says it was written by someone@example.com");
    const committedByAnother = history({ arriving: [{ commit: NEW, author: SEAT.email, committer: "someone@example.com", coAuthors: [] }] });
    expect(await refusalFor(pushed, SEAT, committedByAnother)).toContain("says it was committed by someone@example.com");
    // the address is the seat's whatever its case
    const shouted = history({ arriving: [{ commit: NEW, author: SEAT.email.toUpperCase(), committer: SEAT.email, coAuthors: [] }] });
    expect(await refusalFor(pushed, SEAT, shouted)).toBeUndefined();
  });

  test("with a GitHub account linked, a commit may be written in its name, and name it as a co-author", async () => {
    const pushed = updatesFrom(`${NONE} ${NEW} refs/heads/${SEAT.branch}`);
    const inItsName = history({ arriving: [{ commit: NEW, author: LINKED, committer: SEAT.email, coAuthors: [] }] });
    expect(await refusalFor(pushed, CREDITED, inItsName)).toBeUndefined();
    const namingIt = history({ arriving: [{ ...mine(NEW), coAuthors: [`octocat <${LINKED}>`] }] });
    expect(await refusalFor(pushed, CREDITED, namingIt)).toBeUndefined();
    // but it is still committed by the seat, so every commit leads back to the key that pushed it
    const committedAsGitHub = history({ arriving: [{ commit: NEW, author: LINKED, committer: LINKED, coAuthors: [] }] });
    expect(await refusalFor(pushed, CREDITED, committedAsGitHub)).toContain("says it was committed by");
  });

  test("a GitHub account nobody linked to this seat is refused, as author and as co-author", async () => {
    const pushed = updatesFrom(`${NONE} ${NEW} refs/heads/${SEAT.branch}`);
    const writtenAsUnlinked = history({ arriving: [{ commit: NEW, author: UNLINKED, committer: SEAT.email, coAuthors: [] }] });
    expect(await refusalFor(pushed, CREDITED, writtenAsUnlinked)).toContain(`written by ${UNLINKED}`);
    const namingUnlinked = history({ arriving: [{ ...mine(NEW), coAuthors: [`someone <${UNLINKED}>`] }] });
    expect(await refusalFor(pushed, CREDITED, namingUnlinked)).toContain("as a co-author");
    const namingNobody = history({ arriving: [{ ...mine(NEW), coAuthors: ["someone, no address"] }] });
    expect(await refusalFor(pushed, CREDITED, namingNobody)).toContain("as a co-author");
    // and a seat whose owner linked nothing may not write as the account another seat's owner linked
    const inItsName = history({ arriving: [{ commit: NEW, author: LINKED, committer: SEAT.email, coAuthors: [] }] });
    expect(await refusalFor(pushed, SEAT, inItsName)).toContain(`written by ${LINKED}`);
    const namingIt = history({ arriving: [{ ...mine(NEW), coAuthors: [`octocat <${LINKED}>`] }] });
    expect(await refusalFor(pushed, SEAT, namingIt)).toContain("as a co-author");
  });
});
