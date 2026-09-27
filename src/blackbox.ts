/**
 * Grading from outside the box.
 *
 * The artefact runs in one container with no route out. The checks run in another that can reach
 * exactly one thing, the artefact. Nothing the pod shipped can read a check, patch a runner, or look
 * an answer up, because none of those things are in its box.
 *
 * This is the shape the second spike proved on 2026-09-17, after the first one showed that hiding
 * checks inside the same container stops writing but not reading, and reading the expected values is
 * enough to cheat.
 */
import { randomUUID } from "node:crypto";
import { PORT } from "./job.ts";
import { DOCKER_COULD_NOT_START, DockerFailed } from "./DockerFailed.ts";
import { runDocker } from "./runDocker.ts";

/**
 * What Docker keeps of a box's log on disk. Without a cap, a job that prints without end fills the
 * machine's disk, and `docker logs` hands the whole of it back. One file, trimmed as it grows.
 */
const LOG_KEPT_ON_DISK = "1m";
export const BOUNDED_LOGS = ["--log-driver", "json-file", "--log-opt", `max-size=${LOG_KEPT_ON_DISK}`, "--log-opt", "max-file=1"] as const;

export interface CheckToRun {
  readonly says: string;
  /** run inside the checks box, with TARGET pointing at the artefact */
  readonly command: string;
  readonly hidden: boolean;
}

export interface GradeRequest {
  /** the artefact, as it will run: a directory holding what the pod shipped */
  readonly artefact: string;
  /** how the artefact is started inside its box */
  readonly start: string;
  /** the directory holding the checks. It never touches the artefact's box */
  readonly checks: string;
  readonly toRun: readonly CheckToRun[];
  readonly image: string;
  /** hosts the job declared. Anything else is refused, and the refusal is reported */
  readonly allowedHosts?: readonly string[];
  readonly startSeconds?: number;
  readonly checkSeconds?: number;
}

export interface CheckOutcome {
  readonly says: string;
  readonly command: string;
  readonly hidden: boolean;
  readonly exitCode: number;
  readonly output: string;
  readonly seconds: number;
}

export interface GradeOutcome {
  readonly checks: readonly CheckOutcome[];
  readonly passed: boolean;
  /** what the artefact printed while it ran, which is where an undeclared call shows up */
  readonly artefactLog: string;
  readonly seconds: number;
}

/**
 * How long Docker has to answer a command that runs none of the job's work: making a network, starting
 * a box in the background, looking at one, reading its log, taking it down. A check has this on top of
 * its own time.
 */
const DOCKER_ANSWER_SECONDS = 60;
/** How long one look at whether the artefact answers may take, inside the box and from outside it */
const PROBE_SECONDS = 10;

/**
 * A Docker command the grading cannot go on without. Docker not answering in time is our failure,
 * never the pod's: it is thrown, so the grading is tried again and nothing is decided by it.
 */
async function docker(
  args: readonly string[],
  seconds: number = DOCKER_ANSWER_SECONDS,
  container?: string,
): Promise<{ code: number; out: string }> {
  const answer = await runDocker(args, seconds, container);
  if (answer.timedOut) throw new DockerFailed(`Docker did not answer "docker ${args[0]}" within ${seconds}s`);
  return answer;
}

/**
 * Run the checks against a running artefact, and take everything down afterwards.
 *
 * The network is private and has no route to the outside. A job that declared hosts gets them, and
 * nothing else, so an undeclared call fails in a way somebody can see rather than silently working.
 */
export async function grade(request: GradeRequest): Promise<GradeOutcome> {
  const id = randomUUID().slice(0, 8);
  const network = `pod-net-${id}`;
  const artefactName = `pod-art-${id}`;
  const started = Date.now();

  try {
    // inside, so a network Docker made after it stopped answering is still taken down
    const made = await docker(["network", "create", "--internal", network]);
    if (made.code !== 0) throw new DockerFailed(`Docker would not make the grading's network: ${made.out}`);
    const launched = await docker([
      "run", "-d",
      "--name", artefactName,
      "--network", network,
      ...BOUNDED_LOGS,
      "--memory", "512m", "--cpus", "1", "--pids-limit", "128",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--read-only", "--tmpfs", "/tmp:rw,size=64m", "--tmpfs", "/work:rw,exec,size=256m",
      "-v", `${request.artefact}:/repo:ro`,
      request.image,
      "sh", "-c", `cp -r /repo/. /work/ && cd /work && ${request.start}`,
    ]);
    // the work's own command runs after this answers, inside the box: a refusal here is Docker's
    if (launched.code !== 0) throw new DockerFailed(`Docker would not start the artefact's box: ${launched.out}`);

    await waitUntilAnswering(artefactName, request.startSeconds ?? 90);

    const checkSeconds = request.checkSeconds ?? 60;
    const outcomes: CheckOutcome[] = [];
    for (const [index, check] of request.toRun.entries()) {
      const at = Date.now();
      // named, so a box left behind by a Docker that stopped answering can be taken down
      const checkName = `pod-chk-${id}-${index}`;
      const result = await docker([
        "run", "--rm",
        "--name", checkName,
        "--network", network,
        ...BOUNDED_LOGS,
        "--memory", "512m", "--cpus", "1", "--pids-limit", "128",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--read-only", "--tmpfs", "/tmp:rw,size=64m",
        "-v", `${request.checks}:/checks:ro`,
        "-e", `TARGET=http://${artefactName}:${PORT}`,
        request.image,
        "sh", "-c", `cd /checks && timeout ${checkSeconds} ${check.command}`,
      ], checkSeconds + DOCKER_ANSWER_SECONDS, checkName);
      // a check whose box never started has not been run, so it is no failure of the work's
      if (result.code === DOCKER_COULD_NOT_START) throw new DockerFailed(`Docker could not start the box for "${check.says}": ${result.out}`);
      outcomes.push({
        says: check.says,
        command: check.command,
        hidden: check.hidden,
        exitCode: result.code,
        output: result.out,
        seconds: (Date.now() - at) / 1000,
      });
    }

    const log = await docker(["logs", artefactName]);
    return {
      checks: outcomes,
      passed: outcomes.every((o) => o.exitCode === 0),
      artefactLog: log.out,
      seconds: (Date.now() - started) / 1000,
    };
  } finally {
    // taking down is kept to its limit too, and never hides why the grading ended
    await runDocker(["rm", "-f", artefactName], DOCKER_ANSWER_SECONDS);
    await runDocker(["network", "rm", network], DOCKER_ANSWER_SECONDS);
  }
}

/**
 * Give the artefact a moment to come up, and say why if it never does.
 *
 * The probe runs inside the artefact's own container rather than starting a new one for each
 * attempt: on a cold machine, spawning a container per second was slower than the thing we were
 * waiting for. When it does time out, the artefact's own log is the first thing anyone will want.
 *
 * An artefact that dies on its first breath is the common case, so it is checked first and reported
 * at once. Waiting the full window for something that is already dead taught us nothing and cost a
 * minute and a half per run; worse, the container had to survive its own death for us to read the
 * log, which is why it is not started with --rm. The box takes it down in the caller's finally.
 */
async function waitUntilAnswering(target: string, seconds: number): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const state = await docker(["inspect", "-f", "{{.State.Running}} {{.State.ExitCode}}", target]);
    if (state.code !== 0) throw new DockerFailed(`the artefact's box is gone from Docker: ${state.out}`);
    if (!state.out.startsWith("true")) {
      const log = await docker(["logs", target]);
      const code = state.out.split(" ")[1] ?? "?";
      throw new Error(`the artefact stopped before it answered, exit ${code}. Its log said: ${log.out.slice(0, 500) || "(nothing)"}`);
    }
    // work that takes the connection and never replies is not answering yet, which is the work's
    // doing: a probe that runs out of time is looked at again, never taken for Docker failing us
    const probe = await runDocker([
      "exec", target, "node", "-e",
      `fetch('http://127.0.0.1:${PORT}/',{signal:AbortSignal.timeout(${PROBE_SECONDS * 1000})}).then(()=>process.exit(0)).catch(()=>process.exit(1))`,
    ], PROBE_SECONDS * 2);
    if (!probe.timedOut && probe.code === 0) return;
    await Bun.sleep(500);
  }
  const log = await docker(["logs", target]);
  throw new Error(`the artefact never answered within ${seconds}s. Its log said: ${log.out.slice(0, 500) || "(nothing)"}`);
}
