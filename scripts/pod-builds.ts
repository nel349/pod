/**
 * A pod, actually building something.
 *
 * The seats are agents, the agent is Claude through the CLI this machine is signed in with, and the
 * box each one runs in has no network — the model arrives through a socket and nothing else does.
 *
 *   bun run scripts/pod-builds.ts
 *
 * What comes out is a repository with the attempts in it, which is then graded the ordinary way by
 * the sealed re-run. Nothing an agent said decides the verdict.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPod } from "../src/agent.ts";
import { claudeOnThisMachine, openBroker } from "../src/broker.ts";
import { history, openRepository } from "../src/repo.ts";
import { IMAGE } from "../src/sandbox.ts";

const AGENTS = new URL("../agents", import.meta.url).pathname;

const brief = process.env.POD_BRIEF_TEXT
  ?? "A page that answers on port 3000 with JSON saying whether to take a coat, given ?rain=yes or ?rain=no.";
const jobId = process.env.POD_DEMO_ID ?? `a-pod-builds-${Date.now().toString(36)}`;
const repos = process.env.POD_REPOS ?? (await mkdtemp(join(tmpdir(), "pod-live-")));

const repo = await openRepository(repos, jobId);
const socket = join(await mkdtemp(join(tmpdir(), "pod-broker-")), "model.sock");
const broker = await openBroker({ socket, role: "pod", model: claudeOnThisMachine(), limits: { calls: 12 } });

console.log(`brief: ${brief}\n`);

try {
  const outcome = await runPod({
    repo, brief, image: IMAGE, broker, agents: AGENTS, attempts: 2, seconds: 300,
    seats: [
      { role: "builder", command: `node ${mount("builder.js")}`, name: "builder", email: "builder@pod.invalid" },
      { role: "reviewer", command: `node ${mount("reviewer.js")}`, name: "reviewer", email: "reviewer@pod.invalid" },
    ],
  });

  for (const attempt of outcome.attempts) {
    console.log(`attempt ${attempt.number}`);
    console.log(`  builder  ${attempt.built?.said?.decision ?? "said nothing"}: ${attempt.built?.said?.why ?? ""}`);
    for (const read of attempt.read) {
      console.log(`  ${read.role.padEnd(8)} ${read.said?.decision ?? "said nothing"}: ${read.said?.why ?? ""}`);
    }
  }

  console.log(`\nagreed: ${outcome.agreed}`);
  console.log(`asked the model ${broker.transcript.length} times`);
  console.log(`\nthe history:`);
  for (const commit of await history(repo)) {
    console.log(`  ${commit.commit.slice(0, 8)} ${commit.agent.padEnd(9)} ${commit.message}`);
  }
  console.log(`\nthe repository: ${repo.path}`);
} finally {
  await broker.stop();
}

/** The agents live outside the box; each one is mounted in as it runs. */
function mount(file: string): string {
  return `/agents/${file}`;
}
