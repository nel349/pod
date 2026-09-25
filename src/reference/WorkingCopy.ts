/**
 * The agent's own copy of its job's repository, on its own machine.
 *
 * Plain git, nothing else: fetch what the pod has pushed, change files, commit as the seat, push the
 * seat's branch through the git door. Every command that reaches the door is handed a fresh signed
 * statement, as a header in its environment: never in the door's address, which git writes into its
 * command line where anybody on the machine can list it. Anything git prints is scrubbed of it too.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PLAIN_GIT } from "../plainGit.ts";

export interface Committer {
  readonly name: string;
  readonly email: string;
}

/** How to reach the git door: its address, and the header that signs in as the seat */
export interface DoorAccess {
  readonly url: string;
  readonly authorization: string;
}

interface Ran {
  readonly code: number;
  readonly out: string;
}

/** Where fetched branches are kept locally, apart from the agent's own work. */
const FETCHED = "refs/remotes/pod";

export class WorkingCopy {
  private constructor(
    readonly path: string,
    /** the git door, with a fresh statement, asked for anew each time */
    private readonly door: () => Promise<DoorAccess>,
    private readonly who: Committer,
  ) {}

  static async open(door: () => Promise<DoorAccess>, who: Committer): Promise<WorkingCopy> {
    const path = await mkdtemp(join(tmpdir(), "pod-agent-"));
    const copy = new WorkingCopy(path, door, who);
    await copy.must(["init", "--quiet", "--initial-branch=work"]);
    return copy;
  }

  /** Fetch one of the pod's branches, and hand back its tip, or nothing if nobody has pushed it yet. */
  async fetch(branch: string): Promise<string | undefined> {
    const ran = await this.toTheDoor(["fetch", "--quiet", "--no-tags"], `+refs/heads/${branch}:${FETCHED}/${branch}`);
    if (ran.code !== 0) {
      if (/couldn't find remote ref|not our ref/i.test(ran.out)) return undefined;
      throw new Error(`could not fetch ${branch}: ${ran.out}`);
    }
    return (await this.must(["rev-parse", `${FETCHED}/${branch}`])).trim();
  }

  /**
   * Make the working files those of one commit, or empty if there is none yet: nothing left from a
   * turn that failed half way can be taken for work the door already has.
   */
  async reset(commit: string | undefined): Promise<void> {
    if (commit) {
      await this.must(["reset", "--quiet", "--hard", commit]);
    } else {
      if (await this.head()) await this.must(["update-ref", "-d", "HEAD"]);
      await this.must(["read-tree", "--empty"]);
    }
    await this.must(["clean", "--quiet", "-fd"]);
  }

  async write(files: Readonly<Record<string, string>>): Promise<void> {
    for (const [name, contents] of Object.entries(files)) {
      const at = join(this.path, name);
      await mkdir(dirname(at), { recursive: true });
      await writeFile(at, contents);
    }
  }

  async read(file: string): Promise<string | undefined> {
    try {
      return await readFile(join(this.path, file), "utf8");
    } catch {
      return undefined;
    }
  }

  /** Commit everything, as the seat. Nothing to commit is not a commit. Hands back the tip either way. */
  async commit(message: string): Promise<string | undefined> {
    await this.must(["add", "--all", "."]);
    const changed = (await this.run(["diff", "--cached", "--quiet"])).code !== 0;
    if (changed) await this.must(["commit", "--quiet", "-m", message]);
    return this.head();
  }

  async head(): Promise<string | undefined> {
    const ran = await this.run(["rev-parse", "--verify", "--quiet", "HEAD"]);
    return ran.code === 0 ? ran.out.trim() : undefined;
  }

  /** Bring another commit in. A clash is not resolved here: it is reported, and the merge undone. */
  async merge(commit: string, message: string): Promise<{ readonly merged: boolean; readonly why?: string }> {
    const ran = await this.run(["merge", "--no-edit", "--allow-unrelated-histories", "-m", message, commit]);
    if (ran.code === 0) return { merged: true };
    await this.run(["merge", "--abort"]);
    return { merged: false, why: ran.out.trim() };
  }

  async isAncestor(older: string, newer: string): Promise<boolean> {
    return (await this.run(["merge-base", "--is-ancestor", older, newer])).code === 0;
  }

  /** Push the current commit to the seat's own branch. The door refuses anything else, with a reason. */
  async push(branch: string): Promise<void> {
    const ran = await this.toTheDoor(["push", "--quiet"], `HEAD:refs/heads/${branch}`);
    if (ran.code !== 0) throw new Error(`the git door refused the push: ${ran.out}`);
  }

  /** One commit's files, laid out in a folder of their own, the way a verdict lays them out. */
  async layOut(commit: string, into: string): Promise<string> {
    await mkdir(into, { recursive: true });
    const archive = Bun.spawn(["git", "archive", "--format=tar", commit], { cwd: this.path, stdout: "pipe", stderr: "pipe", env: this.env() });
    const extract = Bun.spawn(["tar", "-x", "-C", into], { stdin: archive.stdout, stdout: "ignore", stderr: "pipe" });
    if ((await extract.exited) !== 0 || (await archive.exited) !== 0) {
      throw new Error(`could not lay out ${commit}: ${await new Response(extract.stderr).text()}`);
    }
    return into;
  }

  async close(): Promise<void> {
    await rm(this.path, { recursive: true, force: true });
  }

  /** A command that talks to the door, with a statement made for it, and the statement kept out of what it says. */
  private async toTheDoor(args: readonly string[], refspec: string): Promise<Ran> {
    const door = await this.door();
    const ran = await this.run([...args, door.url, refspec], {
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: ${door.authorization}`,
    });
    return { code: ran.code, out: ran.out.replaceAll(door.authorization, "…") };
  }

  private async must(args: readonly string[]): Promise<string> {
    const ran = await this.run(args);
    if (ran.code !== 0) throw new Error(`git ${args[0]} failed: ${ran.out}`);
    return ran.out;
  }

  private async run(args: readonly string[], settings: Readonly<Record<string, string>> = {}): Promise<Ran> {
    const child = Bun.spawn(["git", ...args], { cwd: this.path, stdout: "pipe", stderr: "pipe", env: { ...this.env(), ...settings } });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, out: `${out}${err}` };
  }

  /** No settings from the machine, no prompts, and every commit written and committed as the seat. */
  private env(): Record<string, string> {
    return {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: this.path,
      ...PLAIN_GIT,
      GIT_AUTHOR_NAME: this.who.name, GIT_AUTHOR_EMAIL: this.who.email,
      GIT_COMMITTER_NAME: this.who.name, GIT_COMMITTER_EMAIL: this.who.email,
    };
  }
}
