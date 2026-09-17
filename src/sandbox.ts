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
