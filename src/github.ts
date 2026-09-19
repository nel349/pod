/**
 * A job's repository, where a stranger can read it.
 *
 * The local repository from `repo.ts` is the source of truth for what was graded; this puts it
 * somewhere public, from the moment the job opens, so the wall can link work in progress and the
 * POD is title to something that exists.
 *
 * One credential, held in one place: `POD_GITHUB_TOKEN` if it is set, otherwise whatever `gh` is
 * already signed in with on this machine. Nothing here takes a token as an argument, so no token
 * ends up in a log line or a stack trace.
 *
 * What it can do is deliberately small: make a repository, push to it, read it back, and — for the
 * handover — archive or transfer one. It cannot delete anything.
 */
import type { Repository } from "./repo.ts";

const API = "https://api.github.com";

async function token(): Promise<string> {
  const fromEnvironment = process.env.POD_GITHUB_TOKEN;
  if (fromEnvironment) return fromEnvironment;

  const gh = Bun.spawn(["gh", "auth", "token"], { stdout: "pipe", stderr: "ignore" });
  const said = (await new Response(gh.stdout).text()).trim();
  if ((await gh.exited) !== 0 || !said) {
    throw new Error("no GitHub credential: set POD_GITHUB_TOKEN, or sign in with gh");
  }
  return said;
}

/** Whether this machine can act on GitHub at all, which is what the tests skip on. */
export async function credentialAvailable(): Promise<boolean> {
  try {
    await token();
    return true;
  } catch {
    return false;
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${await token()}`,
      "x-github-api-version": "2022-11-28",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const said = await response.text();
    throw new Error(`GitHub said ${response.status} for ${path}: ${said.slice(0, 300)}`);
  }
  return (await response.json()) as T;
}

export interface Published {
  readonly owner: string;
  readonly name: string;
  /** what a person opens */
  readonly url: string;
  /** what `git clone` takes */
  readonly cloneUrl: string;
}

/** The repository's name, which a reader should be able to match to the wall without thinking. */
export function repositoryName(jobId: string): string {
  return `pod-${jobId}`;
}

interface RepositoryAnswer {
  readonly full_name: string;
  readonly html_url: string;
  readonly clone_url: string;
  readonly archived?: boolean;
}

/**
 * Make the repository if it is not there, and hand back where it is either way.
 *
 * Public from the start: a job whose work nobody can watch is a weaker claim and a worse story.
 */
export async function ensureRepository(owner: string, jobId: string, idea: string): Promise<Published> {
  const name = repositoryName(jobId);
  try {
    const existing = await call<RepositoryAnswer>(`/repos/${owner}/${name}`);
    return { owner, name, url: existing.html_url, cloneUrl: existing.clone_url };
  } catch {
    // not there yet, which is the usual case
  }

  const made = await call<RepositoryAnswer>(`/orgs/${owner}/repos`, {
    method: "POST",
    body: JSON.stringify({
      name,
      description: idea.slice(0, 350),
      private: false,
      has_issues: false,
      has_projects: false,
      has_wiki: false,
      auto_init: false,
    }),
  });
  return { owner, name, url: made.html_url, cloneUrl: made.clone_url };
}

/**
 * Push what the pod has committed.
 *
 * The credential goes into the URL for the length of one command and never into a remote that is
 * stored, so it cannot leak out of a repository somebody clones later.
 */
export async function push(repo: Repository, to: Published, branch: string): Promise<void> {
  const authenticated = to.cloneUrl.replace("https://", `https://x-access-token:${await token()}@`);
  const pushing = Bun.spawn(
    ["git", `--git-dir=${repo.path}`, "push", "--quiet", authenticated, `refs/heads/${branch}:refs/heads/${branch}`],
    { stdout: "ignore", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
  );
  if ((await pushing.exited) !== 0) {
    const said = await new Response(pushing.stderr as ReadableStream).text();
    // never let a token reach a log, however the push failed
    throw new Error(`could not push ${to.owner}/${to.name}: ${said.replaceAll(await token(), "…")}`);
  }
}

/** Whether a commit is on GitHub, which is the question the audit asks about a published job. */
export async function hasCommit(to: Published, commit: string): Promise<boolean> {
  try {
    await call(`/repos/${to.owner}/${to.name}/commits/${commit}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Set a finished job's repository read-only.
 *
 * Thirty days after a job ends, however it ended. Read-only rather than deleted: the evidence has to
 * stay readable for as long as the verdict is on the chain, and nobody is going to push to it again.
 */
export async function archive(to: Published): Promise<void> {
  await call(`/repos/${to.owner}/${to.name}`, {
    method: "PATCH",
    body: JSON.stringify({ archived: true }),
  });
}
