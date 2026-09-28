/**
 * One Docker command, with a time limit of its own.
 *
 * Docker itself can stop answering: a daemon under load, a container that will not be created, a
 * client stuck on a socket. A command with no limit then holds up whoever waits on it for ever, and the
 * worker waits on the grader, so one stuck call stopped grading for every job (finding 10.3). Every
 * call here is killed once its time is up, and says so, so the caller can treat it as our failure.
 *
 * Killing the client does not stop a container it started. A caller that names its container passes
 * the name, and it is taken down too.
 */
import { readBounded } from "./readBounded.ts";

export interface DockerAnswer {
  readonly code: number;
  /** what it printed, read bounded: a box's code is not ours, and can print without end */
  readonly out: string;
  /** Docker did not answer in time, and the command was killed */
  readonly timedOut: boolean;
}

export async function runDocker(
  args: readonly string[],
  seconds: number,
  container?: string,
): Promise<DockerAnswer> {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const limit = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, seconds * 1000);
  try {
    const [stdout, stderr] = await Promise.all([readBounded(child.stdout), readBounded(child.stderr)]);
    const code = await child.exited;
    return { code, out: `${stdout}${stderr}`.trim(), timedOut };
  } finally {
    clearTimeout(limit);
    // taken down with the same limit: a Docker that did not answer once may not answer this either
    if (timedOut && container) await runDocker(["rm", "-f", container], seconds);
  }
}
