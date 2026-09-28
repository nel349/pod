/**
 * One Docker command, with a time limit of its own.
 *
 * Docker itself can stop answering: a daemon under load, a container that will not be created, a
 * client stuck on a socket. A command with no limit then holds up whoever waits on it for ever, and the
 * worker waits on the grader, so one stuck call stopped grading for every job (finding 10.3). Every
 * call here is killed once its time is up, and says so, so the caller can treat it as our failure.
 *
 * Killing the client does not stop a container it started. A caller that names its container passes
 * the name, and it is taken down too. Nor does killing the client always end what it printed: a helper
 * it started, such as the one Docker asks for credentials, can outlive it and hold its output open, so
 * once the time is up the output is waited for only a little longer.
 */
import { readBounded } from "./readBounded.ts";

export interface DockerAnswer {
  readonly code: number;
  /** what it printed, read bounded: a box's code is not ours, and can print without end */
  readonly out: string;
  /** Docker did not answer in time, and the command was killed */
  readonly isTimedOut: boolean;
}

/** How long a killed command's output is still waited for before it is given up on */
const OUTPUT_AFTER_KILL_MS = 5_000;
/** How long taking down a box left by a killed command may take */
const REMOVE_SECONDS = 30;
/** What is said for output that never ended after its command was killed */
const OUTPUT_NEVER_ENDED = "(what it printed never ended after it was stopped)";

export async function runDocker(
  args: readonly string[],
  seconds: number,
  container?: string,
): Promise<DockerAnswer> {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  let isTimedOut = false;
  let giveUpOnOutput = (): void => {};
  const outputGivenUp = new Promise<undefined>((resolve) => { giveUpOnOutput = () => resolve(undefined); });
  let afterKill: ReturnType<typeof setTimeout> | undefined;
  const limit = setTimeout(() => {
    isTimedOut = true;
    child.kill("SIGKILL");
    afterKill = setTimeout(giveUpOnOutput, OUTPUT_AFTER_KILL_MS);
  }, seconds * 1000);
  try {
    const read = await Promise.race([
      Promise.all([readBounded(child.stdout), readBounded(child.stderr)]),
      outputGivenUp,
    ]);
    const out = read === undefined ? OUTPUT_NEVER_ENDED : `${read[0]}${read[1]}`.trim();
    return { code: await child.exited, out, isTimedOut };
  } finally {
    clearTimeout(limit);
    clearTimeout(afterKill);
    // taken down with its own limit: a Docker that did not answer once may not answer this either
    if (isTimedOut && container) await runDocker(["rm", "-f", container], REMOVE_SECONDS);
  }
}
