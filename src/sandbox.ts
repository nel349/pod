/**
 * One sealed run.
 *
 * The rules this enforces are the ones the spikes proved on 2026-09-17, and each is here because
 * something real defeats the alternative:
 *
 * - no route out, because a verdict that depends on the internet cannot be repeated, and because a
 *   way out is a way to fetch the checks or ship them somewhere
 * - the image pinned by digest, because every harness we read pins by tag and is therefore not
 *   reproducible
 * - nothing writable that matters, because the first thing a rigged repository tries is to rewrite
 *   what judges it
 * - a hard outer timeout, because the process inside can stop responding for reasons of its own
 *
 * The checks themselves do not live here. They drive the artefact from another container, because
 * code that can read the checks can return their expected values instead of doing the work.
 */

/**
 * The image every box runs, pinned by digest: Node, and nothing we added to it. A tag can be moved
 * under us; a digest cannot.
 */
export const IMAGE = "node@sha256:9bef0ef1e268f60627da9ba7d7605e8831d5b56ad07487d24d1aa386336d1944";

export interface SealedRun {
  /** the directory holding the work, mounted read-only and copied in */
  readonly source: string;
  /** what to run inside, once the work is in place */
  readonly command: string;
  /** container image, pinned by digest */
  readonly image: string;
  /** seconds before the run is killed from outside */
  readonly timeoutSeconds?: number;
}

export interface SealedRunOutcome {
  readonly exitCode: number;
  readonly output: string;
  readonly timedOut: boolean;
  readonly seconds: number;
}

/** Everything that keeps the box shut, in one place so it can be read and argued with. */
export function dockerArguments(run: SealedRun, name: string): string[] {
  return [
    "run", "--rm",
    "--name", name,
    "--network", "none",
    "--memory", "512m",
    "--cpus", "1",
    "--pids-limit", "128",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--read-only",
    "--tmpfs", "/tmp:rw,size=64m",
    "--tmpfs", "/work:rw,exec,size=128m",
    "-v", `${run.source}:/repo:ro`,
    run.image,
    "sh", "-c", `cp -r /repo/. /work/ && cd /work && ${run.command}`,
  ];
}

/**
 * Stopping a run means stopping the container, not the command that started it.
 *
 * Killing the client leaves the container running: a stray one sat on this machine for forty
 * minutes before anyone noticed. So the container is named, and the timeout kills it by name.
 */
async function killContainer(name: string): Promise<void> {
  try {
    await Bun.spawn(["docker", "kill", name], { stdout: "ignore", stderr: "ignore" }).exited;
  } catch {
    // already gone
  }
}

export async function runSealed(run: SealedRun): Promise<SealedRunOutcome> {
  const timeoutSeconds = run.timeoutSeconds ?? 120;
  const name = `pod-${crypto.randomUUID().slice(0, 12)}`;
  const started = Date.now();

  const child = Bun.spawn(["docker", ...dockerArguments(run, name)], { stdout: "pipe", stderr: "pipe" });

  let timedOut = false;
  const killer = setTimeout(() => {
    timedOut = true;
    void killContainer(name);
  }, timeoutSeconds * 1000);

  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const exitCode = await child.exited;
  clearTimeout(killer);

  // Belt and braces: if anything about the run was unusual, make sure nothing is left behind.
  if (timedOut || exitCode !== 0) await killContainer(name);

  return {
    exitCode,
    output: `${stdout}${stderr}`.trim(),
    timedOut,
    seconds: (Date.now() - started) / 1000,
  };
}

/**
 * The install phase: the one part that is allowed a network, and never the part that decides
 * anything.
 *
 * Dependencies have to come from somewhere, so this runs with a route out, writes the result into a
 * directory we keep, and stops. The graded run then starts from that directory with no route out at
 * all. Splitting the two is what lets us say the verdict did not depend on the internet.
 */
export interface InstallPhase {
  /** the work, mounted read-only */
  readonly source: string;
  /** where the installed tree is left, on the host */
  readonly destination: string;
  /** what installs things, for example "npm ci" */
  readonly command: string;
  readonly image: string;
  readonly timeoutSeconds?: number;
}

/**
 * Make a directory the sealed box can actually read.
 *
 * The box drops every capability, including the one that lets root ignore file modes, so a directory
 * only its owner can read is a directory the box cannot open. Anything we create for a run has to be
 * opened up deliberately: a temporary directory is 0700 on Linux, which is exactly the shape that
 * fails, and it fails by the artefact dying on its first command rather than by anything obvious.
 *
 * A real job arrives from a git checkout, which is already world readable. This is for the
 * directories we build ourselves.
 *
 * A link is left alone: it was put there by whoever wrote the code, and could point at any file on
 * this machine. Opening it would open that file instead.
 */
export async function readableToTheBox(directory: string): Promise<string> {
  const { chmod, lstat, readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  await chmod(directory, 0o755);
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    const found = await lstat(path);
    if (found.isSymbolicLink()) continue;
    await chmod(path, found.isDirectory() ? 0o755 : 0o644);
  }
  return directory;
}

/**
 * Make a directory the box can write into, not just read.
 *
 * The sibling of `readableToTheBox`, and the same lesson learned twice: a temporary directory is
 * 0700 on Linux, the box drops the capability that lets root ignore file modes, and so an agent
 * handed a workspace could read nothing and write nothing. On a Mac it all worked, because the file
 * sharing layer there ignores modes — which is why this cost a green suite and a red CI rather than
 * being noticed here.
 *
 * An agent's workspace is its own to change, so this is 0777 rather than 0755. What protects us from
 * the agent is the box, not the mode bits on a directory we made for it.
 *
 * A link is left alone. A workspace is a checkout of what earlier agents committed, and a link one
 * of them committed could point at any file or folder on this machine: following it would hand that
 * to everyone, and a folder all the way down.
 */
export async function writableByTheBox(directory: string): Promise<string> {
  const { chmod, lstat, readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  await chmod(directory, 0o777);
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    const found = await lstat(path);
    if (found.isSymbolicLink()) continue;
    if (found.isDirectory()) await writableByTheBox(path);
    else await chmod(path, 0o666);
  }
  return directory;
}

export async function installDependencies(phase: InstallPhase): Promise<SealedRunOutcome> {
  const timeoutSeconds = phase.timeoutSeconds ?? 600;
  const name = `pod-install-${crypto.randomUUID().slice(0, 12)}`;
  const started = Date.now();

  const args = [
    "run", "--rm",
    "--name", name,
    // a route out, and nothing else relaxed: still no capabilities, still a memory and process cap
    "--memory", "2g",
    "--cpus", "2",
    "--pids-limit", "512",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "-v", `${phase.source}:/repo:ro`,
    "-v", `${phase.destination}:/out`,
    phase.image,
    "sh", "-c", `cp -r /repo/. /out/ && cd /out && ${phase.command}`,
  ];

  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const killer = setTimeout(() => {
    timedOut = true;
    void killContainer(name);
  }, timeoutSeconds * 1000);

  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const exitCode = await child.exited;
  clearTimeout(killer);
  if (timedOut || exitCode !== 0) await killContainer(name);

  return {
    exitCode,
    output: `${stdout}${stderr}`.trim(),
    timedOut,
    seconds: (Date.now() - started) / 1000,
  };
}
