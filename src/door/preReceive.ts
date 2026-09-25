/**
 * What a push may change, decided inside git before anything is changed.
 *
 * Git runs this for every push, after it has received the commits and before it moves a single
 * branch; if it says no, nothing moves, and what it printed reaches the agent as the reason. The door
 * has already checked who is pushing and that the job's window is open. This checks what they sent:
 *
 *   only their own branch      one branch per seat, and every other one is somebody else's
 *   nothing deleted            the attempts that failed stay in the record
 *   nothing rewritten          a push only adds to what is already there
 *   only their own commits     every new commit is committed as the seat that pushes it, and written
 *                              as the seat or as the GitHub account its owner linked (11G), which is
 *                              also the only one a co-author line may name
 *
 * The door hands it the seat's branch and address in the settings named below.
 */
import { shortCommit } from "../repo.ts";

/** What the door sets for the hook: which program runs it, the rules, and the seat that pushes. hooks/pre-receive names the first two */
export const HOOK_SETTINGS = {
  bun: "POD_BUN",
  rules: "POD_PRE_RECEIVE",
  branch: "POD_BRANCH",
  email: "POD_EMAIL",
  /** the GitHub address the seat's owner linked, or nothing */
  credit: "POD_CREDIT",
} as const;
export interface Update {
  readonly old: string;
  readonly new: string;
  readonly ref: string;
}

export interface Pusher {
  readonly branch: string;
  readonly email: string;
  /** the GitHub address the seat's work is credited to, if its owner linked one */
  readonly credit?: string;
}

/** One commit a push brings, as the rules read it */
export interface Arriving {
  readonly commit: string;
  readonly author: string;
  readonly committer: string;
  /** each co-author line, as written: a name and an address in angle brackets */
  readonly coAuthors: readonly string[];
}

/** What this needs to know about the commits, which the hook asks git and a test can answer itself. */
export interface Commits {
  isAncestor(older: string, newer: string): Promise<boolean>;
  /** the commits a push brings that no branch here has yet, with who wrote and who committed each */
  arriving(tip: string): Promise<readonly Arriving[]>;
}

const NOTHING = /^0+$/;

/** Git's lines on standard input: `<old> <new> <ref>`, one per branch the push would move. */
export function updatesFrom(input: string): readonly Update[] {
  return input.split("\n").filter((line) => line.trim() !== "").map((line) => {
    const [old = "", tip = "", ref = ""] = line.trim().split(" ");
    return { old, new: tip, ref };
  });
}

/** Why this push is refused, or nothing if every branch it moves may move that way. */
export async function refusalFor(updates: readonly Update[], pusher: Pusher, commits: Commits): Promise<string | undefined> {
  const own = `refs/heads/${pusher.branch}`;
  for (const update of updates) {
    if (update.ref !== own) {
      return `you may push only to ${pusher.branch}, the branch your seat writes. ${update.ref.replace(/^refs\/heads\//, "")} is not yours`;
    }
    if (NOTHING.test(update.new)) return "branches are never deleted here, so every attempt stays in the record";
    if (!NOTHING.test(update.old) && !(await commits.isAncestor(update.old, update.new))) {
      return `history is never rewritten here: that push would drop commits already on ${pusher.branch}`;
    }
    const mayName = pusher.credit ? [pusher.email, pusher.credit.toLowerCase()] : [pusher.email];
    const asWho = pusher.credit ? `${pusher.email}, or as ${pusher.credit}, the GitHub account this seat's owner linked` : pusher.email;
    for (const arriving of await commits.arriving(update.new)) {
      const short = shortCommit(arriving.commit);
      if (!mayName.includes(arriving.author.toLowerCase())) {
        return `${short} says it was written by ${arriving.author}, and commits pushed from this seat are written as ${asWho}`;
      }
      if (arriving.committer.toLowerCase() !== pusher.email) {
        return `${short} says it was committed by ${arriving.committer}, and commits pushed from this seat are committed as ${pusher.email}`;
      }
      for (const line of arriving.coAuthors) {
        const named = /<([^<>]+)>\s*$/.exec(line)?.[1]?.toLowerCase();
        if (!named || !mayName.includes(named)) {
          return `${short} names "${line}" as a co-author, and commits pushed from this seat may name only ${asWho}`;
        }
      }
    }
  }
  return undefined;
}

/** The commits as git has them, in the repository the hook is running in. */
const gitCommits: Commits = {
  async isAncestor(older, newer) {
    return (await Bun.spawn(["git", "merge-base", "--is-ancestor", older, newer], { stdout: "ignore", stderr: "ignore" }).exited) === 0;
  },
  async arriving(tip) {
    // everything reachable from the new tip that no branch here reaches yet: exactly what this push adds
    // separated by a NUL, which no address can hold: a space would let "<me me>" pass as "me". Each
    // commit ends with a record separator, and its co-author lines are joined by a unit separator
    const format = "%H%x00%ae%x00%ce%x00%(trailers:key=Co-authored-by,valueonly,unfold,separator=%x1f)%x1e";
    const listing = Bun.spawn(["git", "log", `--format=${format}`, tip, "--not", "--branches"], { stdout: "pipe", stderr: "pipe" });
    const [out, code] = await Promise.all([new Response(listing.stdout).text(), listing.exited]);
    if (code !== 0) throw new Error(`git could not list the commits in that push: ${await new Response(listing.stderr).text()}`);
    return out.split("\x1e").map((record) => record.trim()).filter(Boolean).map((record) => {
      const [commit = "", author = "", committer = "", coAuthors = ""] = record.split("\0");
      return { commit, author, committer, coAuthors: coAuthors.split("\x1f").map((line) => line.trim()).filter(Boolean) };
    });
  },
};

if (import.meta.main) {
  const branch = process.env[HOOK_SETTINGS.branch];
  const email = process.env[HOOK_SETTINGS.email];
  const credit = process.env[HOOK_SETTINGS.credit];
  if (!branch || !email) {
    console.error("pod: this push came in without a seat, so nothing was changed");
    process.exit(1);
  }
  let refused: string | undefined;
  try {
    refused = await refusalFor(updatesFrom(await Bun.stdin.text()), { branch, email, ...(credit ? { credit } : {}) }, gitCommits);
  } catch {
    // what went wrong is the server's to know; the agent is told only that nothing moved
    refused = "the push could not be checked, so nothing was changed. Push again";
  }
  if (refused) {
    console.error(`pod: refused: ${refused}`);
    process.exit(1);
  }
}
