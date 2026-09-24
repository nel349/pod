/**
 * A seat, worked by an agent.
 *
 * The part of this that is hard is not the model. It is everything around it: an agent gets a
 * workspace and nothing else, whatever it leaves becomes a commit under its own name, what it
 * decided is recorded, and none of it is allowed to touch the checks that will judge it.
 *
 * So the model is one call at the edge, and everything else is built and proven without it. An agent
 * here is any program: a script, a compiler, a model with a prompt. The protocol is deliberately
 * small enough that all three can be one.
 *
 *   in    the work so far, in /work, and the brief at /work/.pod/brief.md
 *   out   whatever it leaves in /work, and what it decided at /work/.pod/say.json
 *
 * `.pod` never reaches a commit: it is the conversation with the platform, not part of the work.
 */
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Role } from "./job.ts";
import type { Broker } from "./broker.ts";
import { checkout, commitIfChanged, head, type Repository } from "./repo.ts";
import { writableByTheBox } from "./sandbox.ts";

/** What an agent says it did, or decided. A seat that says nothing has not done its job. */
export interface Said {
  readonly decision: "shipped" | "approve" | "refuse";
  readonly why: string;
}

export interface SeatRun {
  readonly role: Role;
  readonly repo: Repository;
  /** what is being asked for, in the words the job was posted in */
  readonly brief: string;
  /** the agent, as it runs: an image and the command that starts it */
  readonly image: string;
  readonly command: string;
  /** the name the commit carries, which is the agent's own */
  readonly name: string;
  readonly email: string;
  /**
   * Hosts the agent may reach. Empty means no route out at all, which is the default: an agent that
   * needs a model says so, and the job records that it did.
   */
  readonly allowedHosts?: readonly string[];
  /**
   * A model, reachable through a socket mounted into the box.
   *
   * This is not a route out. It is a file the agent can write to and read from, and on the other
   * side is one function that answers prompts — so an agent with a model still has no internet, no
   * credential, and nothing else it can reach.
   */
  readonly broker?: Broker;
  /** a directory of agent programs, mounted read-only at /agents so a seat cannot rewrite itself */
  readonly agents?: string;
  readonly seconds?: number;
}

export interface SeatOutcome {
  readonly role: Role;
  readonly said?: Said;
  /** present when the agent changed the work. A reviewer that changes nothing has no commit */
  readonly commit?: string;
  readonly log: string;
  readonly seconds: number;
  readonly timedOut: boolean;
  /** true when the agent had a route out, so a reader knows what it could have reached */
  readonly hadNetwork: boolean;
  /** how many times it asked the model, which is a fact about the run worth keeping */
  readonly askedTheModel: number;
}

const SAY = ".pod/say.json";
const BRIEF = ".pod/brief.md";
/** where the socket appears inside the box. Outside /work, so it cannot be committed */
const MODEL = "/pod-model.sock";

async function docker(args: readonly string[]): Promise<{ code: number; out: string }> {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code: await child.exited, out: `${stdout}${stderr}`.trim() };
}

/** One agent program, in a box, on a workspace that is its own. */
export interface InBox {
  /** what the box is called, so a stray one can be traced to what started it */
  readonly label: string;
  readonly workspace: string;
  readonly image: string;
  readonly command: string;
  /** whether it has a route out. Almost never: a model is a socket, not a route */
  readonly network?: boolean;
  readonly broker?: Broker;
  readonly agents?: string;
  readonly seconds?: number;
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Run an agent program in a box: no route out unless asked for, no capabilities, a memory and
 * process limit, the workspace at /work, the brief and the answer under /work/.pod, and the model —
 * when there is one — as a socket rather than a network.
 *
 * Seats use this, and so does anything else an agent does for the platform, so there is one place
 * that says what an agent's box is.
 */
export async function runInBox(run: InBox): Promise<{ readonly code: number; readonly out: string }> {
  const name = `pod-${run.label}-${Math.random().toString(36).slice(2, 10)}`;
  const seconds = run.seconds ?? 600;
  // the command inside has its own timeout, but a box that stops answering is killed from outside too
  const killer = setTimeout(() => { void docker(["kill", name]); }, (seconds + OUTER_GRACE_SECONDS) * 1000);
  try {
    const ran = await docker([
      "run", "--rm", "--name", name,
      ...(run.network ? [] : ["--network", "none"]),
      "--memory", "2g", "--cpus", "2", "--pids-limit", "512",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "-v", `${run.workspace}:/work`,
      // the model, as a file rather than a route: the box still has no network of any kind
      ...(run.broker ? ["-v", `${run.broker.socket}:${MODEL}`] : []),
      ...(run.agents ? ["-v", `${run.agents}:/agents:ro`] : []),
      ...Object.entries(run.env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
      "-e", `POD_BRIEF=/work/${BRIEF}`,
      "-e", `POD_SAY=/work/${SAY}`,
      ...(run.broker ? ["-e", `POD_MODEL=${MODEL}`] : []),
      "-w", "/work",
      run.image,
      "sh", "-c", `timeout ${seconds} ${run.command}; said=$?; ${HAND_THE_WORKSPACE_BACK}; exit $said`,
    ]);
    await openWhatIsOurs(run.workspace);
    return ran;
  } finally {
    clearTimeout(killer);
  }
}

/** how long past its own timeout a box is given before it is killed from outside */
const OUTER_GRACE_SECONDS = 30;

/**
 * The last thing a box does, after the agent has stopped: open everything in the workspace to its
 * owner on the host.
 *
 * The box runs as root, and on Linux what root creates in a mounted folder stays root's, so folders
 * the agent made could be neither read nor deleted by the server afterwards: a check writer's
 * results would be lost and its workspace left behind. Running the box as the host's user instead
 * was tried, and cuts the agent off from the model's socket under Docker Desktop. This runs after
 * the agent, so nothing it does can stop it, including making folders nobody else may open.
 *
 * It starts one level down, on purpose. /work itself belongs to the host's user, and root in a box
 * with no capabilities may not change it; the image's chmod is busybox, which gives up on the whole
 * tree when the top of it refuses, so `chmod -R /work` opened nothing at all. On a Mac the box sees
 * /work as its own, so only Linux ever showed it.
 */
const HAND_THE_WORKSPACE_BACK = "find /work -mindepth 1 -maxdepth 1 ! -type l -exec chmod -R a+rwX {} + 2>/dev/null";

/**
 * The host's half of handing the workspace back, after the box has gone.
 *
 * On a Mac what the agent made is the host user's already, but the file sharing layer will not let
 * the box change a folder the agent shut to mode 0, so only the host can open it. Anything that is
 * not ours was the box's to open. A link is never followed: the agent chose where it points, and it
 * could point at any file on this machine.
 */
async function openWhatIsOurs(directory: string): Promise<void> {
  const us = process.getuid?.();
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    const found = await lstat(path);
    if (found.isSymbolicLink()) continue;
    if (found.uid === us) await chmod(path, found.isDirectory() ? 0o777 : found.mode | 0o666);
    if (found.isDirectory()) await openWhatIsOurs(path);
  }
}

/**
 * Run one seat.
 *
 * The workspace starts as the work so far, which for the first seat on a new job is nothing at all.
 * The agent runs in a box with dropped capabilities and a memory limit, and with no route out unless
 * the job declared one — a model endpoint is a declared host like any other, and it goes on the
 * record rather than being assumed.
 */
export async function runSeat(run: SeatRun): Promise<SeatOutcome> {
  const workspace = await mkdtemp(join(tmpdir(), `pod-seat-${run.role}-`));
  const started = Date.now();
  const hadNetwork = (run.allowedHosts?.length ?? 0) > 0;

  try {
    const tip = await head(run.repo);
    if (tip) await checkout(run.repo, tip, workspace);

    await mkdir(join(workspace, ".pod"), { recursive: true });
    await writeFile(join(workspace, BRIEF), run.brief);

    // the box cannot ignore file modes, and a temporary directory is its owner's alone. Without
    // this an agent can read nothing and write nothing, and says nothing as a result
    await writableByTheBox(workspace);

    const ran = await runInBox({
      label: `seat-${run.role}`, workspace, image: run.image, command: run.command,
      network: hadNetwork, broker: run.broker, agents: run.agents, seconds: run.seconds,
      env: { POD_ROLE: run.role },
    });

    const said = await readSaid(workspace);
    // the conversation with the platform is not part of the work
    await rm(join(workspace, ".pod"), { recursive: true, force: true });

    const commit = await commitWhatChanged(run, workspace);

    return {
      role: run.role,
      said,
      commit,
      log: ran.out,
      seconds: (Date.now() - started) / 1000,
      timedOut: ran.code === 124,
      hadNetwork,
      askedTheModel: run.broker?.transcript.length ?? 0,
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function readSaid(workspace: string): Promise<Said | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(workspace, SAY), "utf8")) as Said;
    if (!["shipped", "approve", "refuse"].includes(parsed.decision)) return undefined;
    return { decision: parsed.decision, why: String(parsed.why ?? "") };
  } catch {
    return undefined;
  }
}

/**
 * Commit what the agent left, if it left anything different.
 *
 * A seat that changed nothing produces no commit: a reviewer reads, it does not rewrite, and a
 * commit that changes nothing is noise in a history somebody will have to read later.
 */
async function commitWhatChanged(run: SeatRun, workspace: string): Promise<string | undefined> {
  return commitIfChanged(run.repo, {
    workspace,
    message: `${run.role}: ${run.command.slice(0, 60)}`,
    agent: run.name,
    email: run.email,
  });
}

/** A seat, and the agent that works it. */
export interface Seated {
  readonly role: Role;
  readonly command: string;
  readonly name: string;
  readonly email: string;
}

export interface PodRun {
  readonly repo: Repository;
  readonly brief: string;
  readonly image: string;
  /** the crew, in the order they work: the builder ships, the rest read */
  readonly seats: readonly Seated[];
  readonly allowedHosts?: readonly string[];
  readonly broker?: Broker;
  readonly agents?: string;
  readonly seconds?: number;
  /**
   * How many times the builder may try again after a refusal. A pod that cannot be refused is a pod
   * whose reviewers are decoration, and one that can try for ever is a pod that never ships.
   */
  readonly attempts?: number;
}

export interface Attempt {
  readonly number: number;
  readonly built?: SeatOutcome;
  readonly read: readonly SeatOutcome[];
  readonly refusals: readonly { readonly role: Role; readonly why: string }[];
}

export interface PodOutcome {
  readonly attempts: readonly Attempt[];
  /** the commit the pod settled on, if any seat ever shipped anything */
  readonly commit?: string;
  /** true when every reading seat approved the last attempt */
  readonly agreed: boolean;
}

/**
 * The pod, working.
 *
 * The builder ships; the seats that carry liability read what it shipped and approve or refuse. A
 * refusal sends it back, with the refusal in the workspace for the next attempt to read, and every
 * attempt stays in the history — the ones that were refused are the evidence that the reading seats
 * are not decoration.
 *
 * Nothing here decides whether the work is good. That is the sealed re-run's job, and it happens
 * after this, on whatever the pod settled on.
 */
export async function runPod(run: PodRun): Promise<PodOutcome> {
  const builder = run.seats.find((seat) => seat.role === "builder");
  if (!builder) throw new Error("a pod with no builder has nobody to ship anything");
  const readers = run.seats.filter((seat) => seat.role !== "builder");

  const attempts: Attempt[] = [];
  let brief = run.brief;

  for (let number = 1; number <= (run.attempts ?? 2); number++) {
    const built = await runSeat({ ...builder, repo: run.repo, brief, image: run.image,
      allowedHosts: run.allowedHosts, broker: run.broker, agents: run.agents, seconds: run.seconds });

    const read: SeatOutcome[] = [];
    for (const seat of readers) {
      read.push(await runSeat({ ...seat, repo: run.repo, brief, image: run.image,
        allowedHosts: run.allowedHosts, broker: run.broker, agents: run.agents, seconds: run.seconds }));
    }

    const refusals = read
      .filter((outcome) => outcome.said?.decision === "refuse")
      .map((outcome) => ({ role: outcome.role, why: outcome.said?.why ?? "" }));

    attempts.push({ number, built, read, refusals });

    // silence is not approval. A seat that said nothing has not approved, and the work goes back
    const held = read
      .filter((outcome) => outcome.said?.decision !== "approve")
      .map((outcome) => ({
        role: outcome.role,
        why: outcome.said?.why ?? "it said nothing at all, which is not approval",
      }));
    if (held.length === 0) break;

    // the next attempt is told what it was refused for, in the brief it reads
    brief = `${run.brief}\n\n## What was refused last time\n\n${held
      .map((refusal) => `- the ${refusal.role} refused: ${refusal.why}`)
      .join("\n")}`;
  }

  const last = attempts[attempts.length - 1]!;
  return {
    attempts,
    commit: await head(run.repo),
    agreed: last.read.length > 0 && last.read.every((outcome) => outcome.said?.decision === "approve"),
  };
}
