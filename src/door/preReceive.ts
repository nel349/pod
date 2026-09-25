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
 *   only their own commits     every new commit is written, and committed, as the seat that pushes it
 *
 * The door hands it the seat's branch and address in POD_BRANCH and POD_EMAIL.
 */

export interface Update {
  readonly old: string;
  readonly new: string;
  readonly ref: string;
}

export interface Pusher {
  readonly branch: string;
  readonly email: string;
}

/** What this needs to know about the commits, which the hook asks git and a test can answer itself. */
export interface Commits {
  isAncestor(older: string, newer: string): Promise<boolean>;
  /** the commits a push brings that no branch here has yet, with who wrote and who committed each */
  arriving(tip: string): Promise<readonly { readonly commit: string; readonly author: string; readonly committer: string }[]>;
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
    for (const arriving of await commits.arriving(update.new)) {
      const short = arriving.commit.slice(0, 12);
      if (arriving.author.toLowerCase() !== pusher.email) {
        return `${short} says it was written by ${arriving.author}, and commits pushed from this seat are written as ${pusher.email}`;
      }
      if (arriving.committer.toLowerCase() !== pusher.email) {
        return `${short} says it was committed by ${arriving.committer}, and commits pushed from this seat are committed as ${pusher.email}`;
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
    // separated by a NUL, which no address can hold: a space would let "<me me>" pass as "me"
    const listing = Bun.spawn(["git", "log", "--format=%H%x00%ae%x00%ce", tip, "--not", "--branches"], { stdout: "pipe", stderr: "pipe" });
    const [out, code] = await Promise.all([new Response(listing.stdout).text(), listing.exited]);
    if (code !== 0) throw new Error(`git could not list the commits in that push: ${await new Response(listing.stderr).text()}`);
    return out.split("\n").filter(Boolean).map((line) => {
      const [commit = "", author = "", committer = ""] = line.split("\0");
      return { commit, author, committer };
    });
  },
};

if (import.meta.main) {
  const branch = process.env.POD_BRANCH;
  const email = process.env.POD_EMAIL;
  if (!branch || !email) {
    console.error("pod: this push came in without a seat, so nothing was changed");
    process.exit(1);
  }
  let refused: string | undefined;
  try {
    refused = await refusalFor(updatesFrom(await Bun.stdin.text()), { branch, email }, gitCommits);
  } catch {
    // what went wrong is the server's to know; the agent is told only that nothing moved
    refused = "the push could not be checked, so nothing was changed. Push again";
  }
  if (refused) {
    console.error(`pod: refused: ${refused}`);
    process.exit(1);
  }
}
