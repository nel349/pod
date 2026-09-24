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

async function docker(args: readonly string[]): Promise<{ code: number; out: string }> {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code: await child.exited, out: `${stdout}${stderr}`.trim() };
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

  await docker(["network", "create", "--internal", network]);
  try {
    const launched = await docker([
      "run", "-d",
      "--name", artefactName,
      "--network", network,
      "--memory", "512m", "--cpus", "1", "--pids-limit", "128",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--read-only", "--tmpfs", "/tmp:rw,size=64m", "--tmpfs", "/work:rw,exec,size=256m",
      "-v", `${request.artefact}:/repo:ro`,
      request.image,
      "sh", "-c", `cp -r /repo/. /work/ && cd /work && ${request.start}`,
    ]);
    if (launched.code !== 0) throw new Error(`the artefact's box would not start: ${launched.out}`);

    await waitUntilAnswering(artefactName, request.startSeconds ?? 90);

    const outcomes: CheckOutcome[] = [];
    for (const check of request.toRun) {
      const at = Date.now();
      const result = await docker([
        "run", "--rm",
        "--network", network,
        "--memory", "512m", "--cpus", "1", "--pids-limit", "128",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--read-only", "--tmpfs", "/tmp:rw,size=64m",
        "-v", `${request.checks}:/checks:ro`,
        "-e", `TARGET=http://${artefactName}:${PORT}`,
        request.image,
        "sh", "-c", `cd /checks && timeout ${request.checkSeconds ?? 60} ${check.command}`,
      ]);
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
    await docker(["rm", "-f", artefactName]);
    await docker(["network", "rm", network]);
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
    if (state.code !== 0) throw new Error(`the artefact's box is gone: ${state.out}`);
    if (!state.out.startsWith("true")) {
      const log = await docker(["logs", target]);
      const code = state.out.split(" ")[1] ?? "?";
      throw new Error(`the artefact stopped before it answered, exit ${code}. Its log said: ${log.out.slice(0, 500) || "(nothing)"}`);
    }
    const probe = await docker([
      "exec", target, "node", "-e",
      `fetch('http://127.0.0.1:${PORT}/').then(()=>process.exit(0)).catch(()=>process.exit(1))`,
    ]);
    if (probe.code === 0) return;
    await Bun.sleep(500);
  }
  const log = await docker(["logs", target]);
  throw new Error(`the artefact never answered within ${seconds}s. Its log said: ${log.out.slice(0, 500) || "(nothing)"}`);
}
