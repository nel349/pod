/**
 * A job's repository, which is where the work actually is.
 *
 * Until this existed, a job was graded against a directory somebody prepared and a commit somebody
 * typed, and every test passed because every test was about the grading. So: each job owns a
 * repository, work lands in it as commits, and the thing that is graded is a checkout of one exact
 * commit — the one the seats approved on chain.
 *
 * The repositories are bare, which is the shape for something nobody edits in place. An agent never
 * touches git: it leaves work in a workspace and the platform commits what it finds, under that
 * agent's name. That is also why the token in the next part of this work needs so few rights.
 *
 * Git is the dependency, and it is already on every machine this runs on.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hex } from "viem";

export interface Ran {
  readonly code: number;
  readonly out: string;
}

async function git(args: readonly string[], cwd?: string, extra: Record<string, string> = {}): Promise<Ran> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      // a commit needs an author, and a machine has no ~/.gitconfig worth trusting
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      ...extra,
    },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code: await child.exited, out: `${stdout}${stderr}`.trim() };
}

async function must(args: readonly string[], cwd?: string, extra: Record<string, string> = {}): Promise<string> {
  const ran = await git(args, cwd, extra);
  if (ran.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${ran.out}`);
  return ran.out;
}

/** The one branch a pod works on. A crew is one crew, and an attempt that failed is a commit on it. */
export const BRANCH = "main";

export interface Repository {
  /** the bare repository's path, which is what every other call takes */
  readonly path: string;
  readonly jobId: string;
}

/** Open a repository for a job, creating it the first time. */
export async function openRepository(root: string, jobId: string): Promise<Repository> {
  const path = join(root, `${jobId}.git`);
  if (!(await Bun.file(join(path, "HEAD")).exists())) {
    await mkdir(path, { recursive: true });
    await must(["init", "--bare", `--initial-branch=${BRANCH}`, path]);
  }
  return { path, jobId };
}

export interface Work {
  /** a directory holding what the agent left behind. Its contents become the commit */
  readonly workspace: string;
  readonly message: string;
  /** the agent's own name and address, so the history says who did what */
  readonly agent: string;
  readonly email: string;
}

/**
 * Commit whatever is in a workspace, and hand back the object id.
 *
 * The index is built fresh from the workspace every time, so a file an agent deleted is a file the
 * commit deletes. Anything else would let work accumulate that nobody wrote.
 */
export async function commitWork(repo: Repository, work: Work): Promise<string> {
  const staged = await stage(repo, work.workspace);
  try {
    return await write(repo, work, staged.tree);
  } finally {
    await staged.discard();
  }
}

/**
 * Commit only if the work actually moved.
 *
 * A seat that read the code and changed nothing produces no commit. Comparing commit ids cannot
 * answer that — a new commit always has a new id, because its parent and its timestamp differ — so
 * this compares the tree, which is the thing that describes the work itself.
 */
export async function commitIfChanged(repo: Repository, work: Work): Promise<string | undefined> {
  const staged = await stage(repo, work.workspace);
  try {
    const tip = await head(repo);
    if (tip) {
      const before = await must([`--git-dir=${repo.path}`, "rev-parse", `${tip}^{tree}`]);
      if (before === staged.tree) return undefined;
    } else if (staged.tree === (await emptyTree(repo))) {
      // nothing before, and nothing now: an agent that produced nothing has produced nothing, and a
      // commit of an empty tree is a claim that something happened
      return undefined;
    }
    return await write(repo, work, staged.tree);
  } finally {
    await staged.discard();
  }
}

/** The id of a tree with nothing in it, which git will tell us rather than us remembering it. */
async function emptyTree(repo: Repository): Promise<string> {
  return must([`--git-dir=${repo.path}`, "hash-object", "-t", "tree", "/dev/null"]);
}

/** Build an index from a workspace and hand back the tree it describes. */
async function stage(repo: Repository, workspace: string): Promise<{ tree: string; discard: () => Promise<void> }> {
  const held = await mkdtemp(join(tmpdir(), "pod-index-"));
  const indexFile = join(held, "index");
  const where = [`--git-dir=${repo.path}`, `--work-tree=${workspace}`];
  const withIndex = { GIT_INDEX_FILE: indexFile };

  await must([...where, "add", "--all", "."], workspace, withIndex);
  const tree = await must([...where, "write-tree"], undefined, withIndex);
  return { tree, discard: () => rm(held, { recursive: true, force: true }) };
}

async function write(repo: Repository, work: Work, tree: string): Promise<string> {
  const parent = await head(repo);
  const commit = await must([
    `--git-dir=${repo.path}`,
    "-c", `user.name=${work.agent}`,
    "-c", `user.email=${work.email}`,
    "commit-tree", tree,
    ...(parent ? ["-p", parent] : []),
    "-m", work.message,
  ]);
  await must([`--git-dir=${repo.path}`, "update-ref", `refs/heads/${BRANCH}`, commit]);
  return commit;
}

/**
 * Put a commit that passed on the main branch. The worker is the only thing that ever does, and only
 * with a commit whose verdict passed; the git door refuses main to every seat. Doing it twice is the
 * same as doing it once.
 */
export async function putOnMain(repo: Repository, commit: string): Promise<void> {
  if (!(await has(repo, commit))) throw new Error(`${commit} is not a commit in ${repo.jobId}`);
  if ((await head(repo)) === commit) return;
  await must([`--git-dir=${repo.path}`, "update-ref", `refs/heads/${BRANCH}`, commit]);
}

/**
 * What a repository weighs on disk, in bytes: its packs and its loose objects, as git counts them.
 * The git door caps it, because nothing pushed is ever deleted and a disk is shared by every job.
 */
export async function repositoryWeight(repo: Repository): Promise<number> {
  const counted = await must([`--git-dir=${repo.path}`, "count-objects", "-v"]);
  const kib = (name: string): number => Number(new RegExp(`^${name}: (\\d+)$`, "m").exec(counted)?.[1] ?? 0);
  return (kib("size") + kib("size-pack")) * 1024;
}

/** Whether a commit is on a branch, which is where every commit anybody may approve has to be. */
export async function onBranch(repo: Repository, commit: string, branch: string): Promise<boolean> {
  const ran = await git([`--git-dir=${repo.path}`, "merge-base", "--is-ancestor", commit, `refs/heads/${branch}`]);
  return ran.code === 0;
}

/** The tip of the branch, or nothing at all if the pod has not committed yet. */
export async function head(repo: Repository): Promise<string | undefined> {
  const ran = await git([`--git-dir=${repo.path}`, "rev-parse", `refs/heads/${BRANCH}`]);
  return ran.code === 0 ? ran.out : undefined;
}

/** Every commit on the branch, newest first: the attempts, including the ones that failed. */
export async function history(repo: Repository): Promise<readonly { readonly commit: string; readonly message: string; readonly agent: string }[]> {
  const ran = await git([`--git-dir=${repo.path}`, "log", "--format=%H%x00%s%x00%an", BRANCH]);
  if (ran.code !== 0) return [];
  return ran.out.split("\n").filter(Boolean).map((line) => {
    const [commit, message, agent] = line.split("\0");
    return { commit: commit!, message: message!, agent: agent! };
  });
}

/** Whether a commit is in this repository, which is the question a verdict rests on. */
export async function has(repo: Repository, commit: string): Promise<boolean> {
  const ran = await git([`--git-dir=${repo.path}`, "cat-file", "-e", `${commit}^{commit}`]);
  return ran.code === 0;
}

/**
 * Put one exact commit on disk, for grading.
 *
 * Not a clone and not a working copy: the files of that commit, and nothing else. No `.git`, so the
 * box cannot read the history, and no way for a later commit to change what was graded.
 */
export async function checkout(repo: Repository, commit: string, into: string): Promise<string> {
  if (!(await has(repo, commit))) throw new Error(`${commit} is not a commit in ${repo.jobId}`);
  await mkdir(into, { recursive: true });
  const ran = await git(["-c", "core.fsmonitor=false", `--git-dir=${repo.path}`, "archive", "--format=tar", commit]);
  if (ran.code !== 0) throw new Error(`could not read ${commit}: ${ran.out}`);

  // stream the archive straight into the directory rather than through a file
  const archive = Bun.spawn(["git", `--git-dir=${repo.path}`, "archive", "--format=tar", commit], { stdout: "pipe" });
  const extract = Bun.spawn(["tar", "-x", "-C", into], { stdin: archive.stdout, stdout: "ignore", stderr: "pipe" });
  const code = await extract.exited;
  if (code !== 0) {
    const said = await new Response(extract.stderr as ReadableStream).text();
    throw new Error(`could not lay out ${commit}: ${said}`);
  }
  return into;
}

/**
 * The copy that survives us: one file holding every commit, which anybody can clone from.
 *
 * It is written when a job is graded and published like everything else. Its hash goes in the signed
 * receipt, so a copy downloaded later can be proved identical to the one the verdict was about.
 */
export async function bundle(repo: Repository, to: string): Promise<string> {
  await must([`--git-dir=${repo.path}`, "bundle", "create", to, "--all"]);
  return to;
}

/**
 * A commit id as the contract holds it.
 *
 * An object id is twenty bytes today and thirty-two in a repository that has moved to the newer
 * hash. Both fit in the field, left-aligned and zero-padded, so the id can be read straight back off
 * the chain rather than hashed into something nobody can look up.
 */
export function commitToBytes32(commit: string): Hex {
  const hex = commit.toLowerCase();
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(hex)) throw new Error(`${commit} is not an object id`);
  return `0x${hex.padEnd(64, "0")}` as Hex;
}

/** And back again, for reading a verdict somebody else wrote. */
export function bytes32ToCommit(value: Hex): string {
  const hex = value.slice(2).toLowerCase();
  const short = hex.slice(0, 40);
  return hex.slice(40) === "0".repeat(24) ? short : hex;
}
