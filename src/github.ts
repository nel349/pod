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
import { PLAIN_GIT } from "./plainGit.ts";
import type { Repository } from "./repo.ts";

/** The setting that names the GitHub account or organisation passing work is published under */
export const GITHUB_OWNER_SETTING = "POD_GITHUB_OWNER";

/** GitHub's API, which every call here, and the credit check's read of a gist, goes to */
export const GITHUB_API = "https://api.github.com";

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
  const response = await fetch(`${GITHUB_API}${path}`, {
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
 * Push one branch of what the pod has committed, or every branch, which is the whole record: the
 * work that passed on main and every seat's attempts beside it.
 *
 * The credential goes to git as a header in its environment, for the length of one command: never in
 * the address, which git puts on its command line where anybody on the machine can list it, and
 * never in a remote that is stored, so it cannot leak out of a repository somebody clones later.
 */
export async function push(repo: Repository, to: Published, branch: string | "every branch"): Promise<void> {
  const secret = await token();
  const header = `Authorization: Basic ${btoa(`x-access-token:${secret}`)}`;
  const refspec = branch === "every branch" ? "refs/heads/*:refs/heads/*" : `refs/heads/${branch}:refs/heads/${branch}`;
  const pushing = Bun.spawn(["git", `--git-dir=${repo.path}`, "push", "--quiet", to.cloneUrl, refspec], {
    stdout: "ignore", stderr: "pipe",
    env: { ...process.env, ...PLAIN_GIT, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: header },
  });
  if ((await pushing.exited) !== 0) {
    const said = await new Response(pushing.stderr as ReadableStream).text();
    // never let a token reach a log, however the push failed
    throw new Error(`could not push ${to.owner}/${to.name}: ${said.replaceAll(secret, "…").replaceAll(header, "…")}`);
  }
}

/**
 * A job's whole repository on GitHub under the owner given: made if it is not there, every branch
 * pushed, and opening on the branch the work that passed is on. Doing it again changes nothing.
 */
export async function publishJob(repo: Repository, owner: string, jobId: string, idea: string, opensOn: string): Promise<Published> {
  const published = await ensureRepository(owner, jobId, idea);
  await push(repo, published, "every branch");
  await setDefaultBranch(published, opensOn);
  return published;
}

/** Make a branch the one a repository opens on, which is also the one GitHub counts contributions on. */
export async function setDefaultBranch(to: Published, branch: string): Promise<void> {
  await call(`/repos/${to.owner}/${to.name}`, { method: "PATCH", body: JSON.stringify({ default_branch: branch }) });
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
 * Hand a repository to somebody else.
 *
 * GitHub treats this as an invitation when the new owner is a person: it is theirs when they accept,
 * and ours until they do. Nothing here pretends otherwise.
 */
export async function transferRepository(to: Published, account: string): Promise<void> {
  await call(`/repos/${to.owner}/${to.name}/transfer`, {
    method: "POST",
    body: JSON.stringify({ new_owner: account }),
  });
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
