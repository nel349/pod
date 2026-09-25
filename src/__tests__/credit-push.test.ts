import { afterEach, describe, expect, test } from "bun:test";
import { parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { creditEmail, type CreditLink } from "../credit.ts";
import { agentEmail, branchFor } from "../door/index.ts";
import type { Role, Spec } from "../job.ts";
import { creditMessage } from "../messages.ts";
import { Identity, PodServer, runReferenceAgent, WorkingCopy, type Committer } from "../reference/index.ts";
import { anvilAvailable } from "./support/anvil.ts";
import { COAT_IDEA, DRY, good, WET, WORKING } from "./support/coat.ts";
import { aPod, aPodServer, type Agent, type RunningPodServer } from "./support/podServer.ts";

/**
 * GitHub credit at the git door, with a real git client against a local chain (11G).
 *
 * A seat whose owner linked a GitHub account may write its commits in that account's name, or name it
 * as a co-author; every commit is still committed by the seat, so it leads back to the key that
 * pushed it. Any other GitHub account, named either way, is refused with the reason.
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
const OCTOCAT = { login: "octocat", githubId: 583231 };
const SOMEONE = { login: "someone", githubId: 42 };

const toStop: (() => void)[] = [];
afterEach(() => {
  for (const stop of toStop.splice(0)) stop();
});

async function aServer(pod: Readonly<Record<Role, Agent>>): Promise<RunningPodServer> {
  const running = await aPodServer({ jobId: JOB, spec: SPEC, files: { "check-1.mjs": good(0).check, "check-2.mjs": good(1).check }, fund: Object.values(pod) });
  toStop.push(() => running.stop());
  return running;
}

/** The link the credit door keeps once it has checked the owner's gist: the agent's own signature over the sentence. */
async function linked(agent: Agent, account = OCTOCAT): Promise<CreditLink> {
  const signature = await privateKeyToAccount(agent.key).signMessage({ message: creditMessage({ agent: agent.address, ...account }) });
  return { agent: agent.address, ...account, gist: `https://gist.github.com/${account.login}/6cad326836d38bd3a7ae`, signature };
}

async function until(what: string, isSo: () => Promise<boolean>, seconds = 30): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  while (!(await isSo())) {
    if (Date.now() > deadline) throw new Error(`${what} never happened`);
    await Bun.sleep(100);
  }
}

/** The builder's seat, taken, and a working copy that writes as it is told. */
async function aBuilder(running: RunningPodServer, agent: Agent, who: Partial<Committer> = {}): Promise<WorkingCopy> {
  const server = new PodServer(running.base);
  const identity = new Identity(agent.key, await server.market());
  const job = { jobId: JOB, onChainId: running.onChainId };
  await identity.takeSeat(job, "builder");
  await until("the seat on the list", async () => (await server.jobs()).jobs.some((listed) => listed.seats.some((seat) => seat.heldBy?.agent === agent.address)));
  const copy = await WorkingCopy.open(
    async () => server.gitDoor(job, identity.address, await identity.doorPassword(job, "builder")),
    { name: "builder", email: agentEmail(agent.address), ...who },
  );
  toStop.push(() => void copy.close());
  return copy;
}

describe.skipIf(!available)("GitHub credit at the git door", () => {
  test("a seat whose owner linked an account writes in its name and names it as co-author; nobody else's account passes", async () => {
    const pod = aPod();
    const running = await aServer(pod);
    await running.credit.save(await linked(pod.builder));
    const mine = branchFor("builder", pod.builder.address);

    // in the account's name, committed by the seat
    const copy = await aBuilder(running, pod.builder, { writtenAs: { name: "octocat", email: creditEmail(OCTOCAT) } });
    await copy.write({ "server.js": `${WORKING}\n` });
    const written = await copy.commit("Build it");
    if (!written) throw new Error("nothing was committed");
    await copy.push(mine);
    expect((await running.git(["log", "-1", "--format=%ae %ce", mine])).trim()).toBe(`${creditEmail(OCTOCAT)} ${agentEmail(pod.builder.address)}`);

    // naming it as a co-author is fine too
    await copy.write({ "README.md": "a coat, given the rain\n" });
    await copy.commit(`Say what it is\n\nCo-authored-by: octocat <${creditEmail(OCTOCAT)}>`);
    await copy.push(mine);

    // an account nobody linked to this seat is refused, and the branch stays where it was
    const before = (await running.git(["rev-parse", mine])).trim();
    await copy.write({ "NOTES.md": "more\n" });
    await copy.commit(`More\n\nCo-authored-by: someone <${creditEmail(SOMEONE)}>`);
    await expect(copy.push(mine)).rejects.toThrow(`names "someone <${creditEmail(SOMEONE)}>" as a co-author`);
    expect((await running.git(["rev-parse", mine])).trim()).toBe(before);
  }, 120_000);

  test("a seat whose owner linked nothing may not write in a linked account's name", async () => {
    const pod = aPod();
    const running = await aServer(pod);
    await running.credit.save(await linked(pod.lead));
    const copy = await aBuilder(running, pod.builder, { writtenAs: { name: "octocat", email: creditEmail(OCTOCAT) } });
    await copy.write({ "server.js": `${WORKING}\n` });
    await copy.commit("Build it");
    await expect(copy.push(branchFor("builder", pod.builder.address))).rejects.toThrow(`says it was written by ${creditEmail(OCTOCAT)}`);
  }, 120_000);

  test("the reference agent reads its owner's link and writes its work in that account's name", async () => {
    const pod = aPod();
    const running = await aServer(pod);
    await running.credit.save(await linked(pod.builder));
    const said: string[] = [];
    const stop = new AbortController();
    toStop.push(() => stop.abort());
    const agent = runReferenceAgent({
      server: running.base, key: pod.builder.key, role: "builder", every: 100, signal: stop.signal,
      model: async () => `\`\`\`js\n${WORKING}\n\`\`\``, say: (what) => said.push(what),
    });
    const mine = branchFor("builder", pod.builder.address);
    await until("the builder's push", async () => {
      try {
        return (await running.git(["rev-parse", "--verify", mine])).trim().length > 0;
      } catch {
        return false;
      }
    });
    stop.abort();
    await agent;
    expect(said.some((line) => line.includes("in the name of octocat on GitHub"))).toBe(true);
    expect((await running.git(["log", "-1", "--format=%ae %ce", mine])).trim()).toBe(`${creditEmail(OCTOCAT)} ${agentEmail(pod.builder.address)}`);
  }, 120_000);
});
