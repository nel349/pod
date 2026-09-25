import { afterEach, describe, expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEther } from "viem";
import type { Model } from "../broker.ts";
import { agentEmail, branchFor, JobListingSchema, type ListedJob } from "../door/index.ts";
import type { Role, Spec } from "../job.ts";
import { readJob } from "../jobs.ts";
import { pause } from "../pause.ts";
import { Builder } from "../reference/roles/Builder.ts";
import { Lead } from "../reference/roles/Lead.ts";
import { tellThePod, type Seated } from "../reference/Seated.ts";
import { Identity, MOST_REBUILDS, PodServer, REFUSED, runReferenceAgent, WorkingCopy, type DoorAccess } from "../reference/index.ts";
import { bytes32ToCommit } from "../repo.ts";
import { ROUTES } from "../routes.ts";
import { IMAGE } from "../sandbox.ts";
import { anvilAvailable } from "./support/anvil.ts";
import { COAT_IDEA, DRY, good, serverSaying, WET, WORKING } from "./support/coat.ts";
import { aPod, aPodServer, type Agent, type RunningPodServer } from "./support/podServer.ts";

/**
 * What goes wrong around a reference agent, and that it goes on anyway.
 *
 * A seat runs for as long as its job does, against a network, a chain and a model that each have bad
 * moments. None of those may stop it for good, lose what it was answering, or leave the pod waiting on
 * a commit only its own machine has. And a server it does not run may not make it write outside its
 * own folder, or read its signature off the machine's list of running commands.
 */

const available = await anvilAvailable();

const JOB = "a-coat-given-the-rain";
const SPEC: Spec = {
  idea: COAT_IDEA, kind: "service", mode: "flash", price: parseEther("1"),
  checks: [
    { says: WET, run: "node check-1.mjs", hidden: false, file: "check-1.mjs" },
    { says: DRY, run: "node check-2.mjs", hidden: true, file: "check-2.mjs" },
  ],
  allowed: [], salt: "a-number-nobody-can-guess",
};
const NEVER_A_COAT = serverSaying("false", "false");
const WHY_REFUSED = "it never says take a coat";

const fenced = (code: string): string => `\`\`\`js\n${code}\n\`\`\``;

/** Everything a test started, stopped once it is over whatever happened. */
const toStop: (() => void)[] = [];
afterEach(() => {
  for (const stop of toStop.splice(0)) stop();
});

async function aServer(pod: Readonly<Record<Role, Agent>>): Promise<RunningPodServer> {
  const running = await aPodServer({ jobId: JOB, spec: SPEC, files: { "check-1.mjs": good(0).check, "check-2.mjs": good(1).check }, fund: Object.values(pod) });
  toStop.push(() => running.stop());
  return running;
}

/** A seat taken with the agent's own key, and everything it works with, as the agent sets it up. */
async function seatAs(running: RunningPodServer, agent: Agent, role: Role, options: {
  readonly model?: Model;
  /** the door as the seat reaches it, given the real one: a test may stand in its way */
  readonly door?: (real: () => Promise<DoorAccess>) => () => Promise<DoorAccess>;
} = {}): Promise<Seated> {
  const server = new PodServer(running.base);
  const identity = new Identity(agent.key, await server.market());
  const job = { jobId: JOB, onChainId: running.onChainId };
  await identity.takeSeat(job, role);
  // the doors learn of a seat a moment after the chain does, and an agent waits for the list to show it
  let listed: ListedJob | undefined;
  await until(`the ${role} seat on the list`, async () => {
    listed = (await server.jobs()).jobs.find((listing) => listing.jobId === JOB);
    return listed?.seats.some((seat) => seat.role === role && seat.heldBy?.agent === agent.address) ?? false;
  });
  if (!listed) throw new Error(`${JOB} is not on the list`);
  const real = async (): Promise<DoorAccess> => server.gitDoor(job, identity.address, await identity.doorPassword(job, role));
  const copy = await WorkingCopy.open(options.door ? options.door(real) : real, { name: role, email: agentEmail(agent.address) });
  toStop.push(() => void copy.close());
  return { job, role, listed, identity, server, copy, model: options.model, image: IMAGE, say: () => {} };
}

/** A model that answers in turn, and keeps what it was asked. An Error among the answers is thrown instead. */
function scripted(...answers: readonly (string | Error)[]): { readonly model: Model; readonly prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    model: async (prompt) => {
      prompts.push(prompt);
      const answer = answers[Math.min(prompts.length, answers.length) - 1];
      if (answer === undefined) throw new Error("the script has no answers");
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

/** Poll until something is so, or fail saying what never was. */
async function until(what: string, isSo: () => boolean | Promise<boolean>, seconds = 30): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  while (!(await isSo())) {
    if (Date.now() > deadline) throw new Error(`${what} never happened`);
    await Bun.sleep(50);
  }
}

describe("a list from a server that means harm", () => {
  test("a check whose file name reaches outside the agent's folder is not read at all", () => {
    const listing = (file: string): unknown => ({
      version: 1, guide: ROUTES.guide, market: ROUTES.market,
      jobs: [{
        jobId: JOB, at: { page: "/", git: "/", notes: "/" }, contract: { address: "0x1111111111111111111111111111111111111111", jobId: "1" },
        price: "1", endsAt: "2026-10-13T00:00:00.000Z", idea: COAT_IDEA, mode: "flash", allowedHosts: [],
        visibleChecks: [{ says: WET, run: "node check-1.mjs", file, url: "/c" }], sealedChecks: 1, seats: [], free: [], owners: [],
      }],
    });
    expect(JobListingSchema.safeParse(listing("check-1.mjs")).success).toBe(true);
    for (const file of ["../../.bashrc", "/etc/passwd", "checks/../../x", ".."]) {
      expect(JobListingSchema.safeParse(listing(file)).success).toBe(false);
    }
  });
});

describe("waiting between looks", () => {
  test("a wait that ends on its own leaves nothing listening on the stop", async () => {
    const stop = new AbortController();
    for (let look = 0; look < 20; look++) await pause(1, stop.signal);
    expect(getEventListeners(stop.signal, "abort")).toHaveLength(0);
  });

  test("a stop ends a wait at once", async () => {
    const stop = new AbortController();
    const started = performance.now();
    const waiting = pause(60_000, stop.signal);
    stop.abort();
    await waiting;
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe("a working copy", () => {
  test("emptied when there is no commit to reset to, so nothing from a failed turn is taken for work", async () => {
    const copy = await WorkingCopy.open(async () => { throw new Error("this copy never reaches the door"); }, { name: "builder", email: "b@agents.pod.invalid" });
    toStop.push(() => void copy.close());
    await copy.write({ "server.js": "left over\n", "more/deep.js": "and this\n" });
    expect(await copy.commit("a turn that went no further")).toBeDefined();
    await copy.reset(undefined);
    expect(await copy.head()).toBeUndefined();
    expect(await copy.read("server.js")).toBeUndefined();
    expect(await copy.read("more/deep.js")).toBeUndefined();
  });
});

describe.skipIf(!available)("a reference agent, when things go wrong", () => {
  test("its signature never reaches a command line, where anybody on the machine could read it", async () => {
    const pod = aPod();
    const running = await aServer(pod);

    // a git that writes down how it was started, and then is git
    const shim = await mkdtemp(join(tmpdir(), "pod-git-shim-"));
    const started = join(shim, "started");
    const realGit = Bun.which("git");
    if (!realGit) throw new Error("git is not installed");
    await writeFile(join(shim, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${started}'\nexec '${realGit}' "$@"\n`);
    await chmod(join(shim, "git"), 0o755);
    const path = process.env.PATH ?? "/usr/bin:/bin";
    process.env.PATH = `${shim}:${path}`;
    toStop.push(() => { process.env.PATH = path; });

    const handedOut: string[] = [];
    const builder = await seatAs(running, pod.builder, "builder", {
      door: (real) => async () => {
        const door = await real();
        handedOut.push(door.authorization);
        return door;
      },
    });
    const mine = branchFor("builder", pod.builder.address);
    await builder.copy.write({ "server.js": `${WORKING}\n` });
    const commit = await builder.copy.commit("Build it");
    if (!commit) throw new Error("nothing was committed");
    await builder.copy.push(mine);
    expect(await builder.copy.fetch(mine)).toBe(commit);

    // it went through the door, signed in, twice, and no command it started carried the signature
    expect((await running.git(["rev-parse", mine])).trim()).toBe(commit);
    expect(handedOut).toHaveLength(2);
    const commands = await readFile(started, "utf8");
    expect(commands).toContain("push");
    for (const authorization of handedOut) {
      const password = atob(authorization.slice("Basic ".length)).split(":")[1] ?? "";
      expect(password.length).toBeGreaterThan(100);
      expect(commands).not.toContain(password.split(".")[2] ?? password);
      expect(commands).not.toContain(authorization);
    }
  }, 120_000);

  test("a builder whose model failed answers the refusal on a later look, and does not count the failures as tries", async () => {
    const pod = aPod();
    const running = await aServer(pod);
    const badMoment = new Error("the model is having a bad moment");
    const failures = Array.from({ length: MOST_REBUILDS }, () => badMoment);
    const writing = scripted(fenced(NEVER_A_COAT), ...failures, fenced(WORKING));
    const [building, leading, qa] = await Promise.all([
      seatAs(running, pod.builder, "builder", { model: writing.model }), seatAs(running, pod.lead, "lead"), seatAs(running, pod.qa, "qa"),
    ]);
    const builder = new Builder(building);
    const lead = new Lead(leading);

    await builder.step();
    await lead.step();
    const candidate = bytes32ToCommit((await readJob(running.reading, running.onChainId)).commit);
    await tellThePod(qa, `${REFUSED}${WHY_REFUSED}`, candidate);

    // as many bad moments as it has tries: each is a turn that failed, not a try that was spent
    for (let look = 0; look < MOST_REBUILDS; look++) await expect(builder.step()).rejects.toThrow(badMoment.message);
    await builder.step();

    expect(writing.prompts).toHaveLength(MOST_REBUILDS + 2);
    expect(writing.prompts.at(-1)).toContain(`qa: ${WHY_REFUSED}`);
    const pushed = (await running.git(["show", `${branchFor("builder", pod.builder.address)}:server.js`])).trim();
    expect(pushed).toBe(WORKING);
  }, 120_000);

  test("a lead whose push failed puts the candidate on the door on its next look, before naming it", async () => {
    const pod = aPod();
    const running = await aServer(pod);
    // in the lead's first look the door is reached three times: its own branch, the builder's, and the
    // push. The push is refused, as a door that is down for a moment would refuse it
    let reached = 0;
    const [building, leading] = await Promise.all([
      seatAs(running, pod.builder, "builder", { model: scripted(fenced(WORKING)).model }),
      seatAs(running, pod.lead, "lead", {
        door: (real) => async () => (++reached === 3 ? { ...(await real()), authorization: `Basic ${btoa("nobody:nothing")}` } : real()),
      }),
    ]);
    const builder = new Builder(building);
    const lead = new Lead(leading);
    await builder.step();
    const leads = branchFor("lead", pod.lead.address);
    await expect(lead.step()).rejects.toThrow("the git door refused the push");
    expect(reached).toBe(3);
    await expect(running.git(["rev-parse", "--verify", leads])).rejects.toThrow();

    await lead.step();
    const onTheDoor = (await running.git(["rev-parse", leads])).trim();
    expect(bytes32ToCommit((await readJob(running.reading, running.onChainId)).commit)).toBe(onTheDoor);
    expect((await running.git(["show", `${onTheDoor}:server.js`])).trim()).toBe(WORKING);
  }, 120_000);

  test("it goes on through a list, a chain and a server that each fail for a while, and ends when the job does", async () => {
    const pod = aPod();
    const running = await aServer(pod);

    // the chain, as the agent reaches it, down while the test says so
    let chainDown = false;
    let refusedByTheChain = 0;
    const chain = Bun.serve({
      port: 0,
      fetch: async (request) => {
        if (chainDown) {
          refusedByTheChain++;
          return new Response("down for a moment", { status: 503 });
        }
        return fetch(running.anvil.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: await request.text() });
      },
    });
    toStop.push(() => chain.stop(true));

    // and the pod's server, whose list fails twice before it answers, and which says where the chain is
    let listRefusals = 0;
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === ROUTES.jobList && listRefusals < 2) {
          listRefusals++;
          return new Response("down for a moment", { status: 503 });
        }
        const answer = await fetch(new URL(`${url.pathname}${url.search}`, running.base), { method: request.method, headers: request.headers, body: request.body });
        if (url.pathname !== ROUTES.market) return answer;
        return Response.json({ ...(await answer.json()), rpc: `http://127.0.0.1:${chain.port}` });
      },
    });
    toStop.push(() => server.stop(true));

    const said: string[] = [];
    const stop = new AbortController();
    toStop.push(() => stop.abort());
    const agent = runReferenceAgent({
      server: `http://127.0.0.1:${server.port}`, key: pod.reviewer.key, role: "reviewer", every: 50, signal: stop.signal,
      model: async () => { throw new Error("there is no candidate, so nothing is asked"); },
      agentId: 1n, say: (what) => said.push(what),
    });
    await until("the reviewer seat taken", () => said.some((line) => line.includes("holds the reviewer seat")));
    expect(listRefusals).toBe(2);

    // down for longer than one read's retries, so a read fails outright
    chainDown = true;
    await until("a look failing on the chain", () => said.some((line) => line.includes("this turn failed, and will be tried again")));
    chainDown = false;
    expect(refusedByTheChain).toBeGreaterThan(1);

    // the job's window closes with the pod's server gone, so asking for the record cannot reach it
    server.stop(true);
    const job = await readJob(running.reading, running.onChainId);
    const now = (await running.anvil.publicClient.getBlock()).timestamp;
    await running.anvil.publicClient.request({ method: "evm_increaseTime" as never, params: [Number(job.endsAt - now) + 1] as never });
    await running.anvil.publicClient.request({ method: "evm_mine" as never, params: [] as never });

    // an agent that never sees the end is stopped, and says so, rather than holding the test up
    const outOfTime = setTimeout(() => stop.abort(), 30_000);
    toStop.push(() => clearTimeout(outOfTime));
    const finished = await agent;
    expect(finished).toEqual({ jobId: JOB, why: "the job's window has closed" });
    expect(said.some((line) => line.includes("the job list could not be read"))).toBe(true);
    expect(said.some((line) => line.includes("this turn failed, and will be tried again"))).toBe(true);
    expect(said.some((line) => line.includes("could not ask for the verdict to be recorded"))).toBe(true);
    // and all those looks left nothing listening on its stop
    expect(getEventListeners(stop.signal, "abort")).toHaveLength(0);
  }, 120_000);
});
