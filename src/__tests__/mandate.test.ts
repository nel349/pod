import { afterEach, describe, expect, test } from "bun:test";
import { parseEther, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { secondsNow } from "../clock.ts";
import { agentEmail, branchFor, grantIsGoodNow } from "../door/index.ts";
import type { Role, Spec } from "../job.ts";
import { takeSeat } from "../jobs.ts";
import type { GrantWindow, Grants } from "../mandate.ts";
import { doorMessage, noteMessage } from "../messages.ts";
import { PodServer, WorkingCopy, type JobRef } from "../reference/index.ts";
import { notesPath } from "../routes.ts";
import { anvilAvailable } from "./support/anvil.ts";
import { COAT_IDEA, DRY, good, WET, WORKING } from "./support/coat.ts";
import { anAgent, aPodServer, type Agent, type RunningPodServer } from "./support/podServer.ts";

/**
 * A seat worked under a mandate: the person's wallet holds the seat, and the agent signs with a key
 * the wallet granted, never with the seat's own key, which it was never handed (18).
 *
 * The plugin is stood in for here, so all four ways the rule can go are proven against a real chain's
 * seats, a real git door and real notes. That the plugin on Monad answers these two questions in this
 * shape, at this address, is checked against the chain itself in mandate-live.test.ts.
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

const pair = (wallet: Address, key: Address): string => `${wallet.toLowerCase()}:${key.toLowerCase()}`;

/** The plugin, stood in for: what each wallet granted, and every pair the doors asked it about. */
class WhatTheWalletsGranted implements Grants {
  readonly asked: string[] = [];
  private readonly windows = new Map<string, GrantWindow>();

  /** A grant with no window, which is how the wallet leaves one granted without an end date */
  grant(wallet: Address, key: Address, window: GrantWindow = { from: 0, until: 0 }): void {
    this.windows.set(pair(wallet, key), window);
  }

  async granted(wallet: Address, key: Address): Promise<GrantWindow | undefined> {
    this.asked.push(pair(wallet, key));
    return this.windows.get(pair(wallet, key));
  }
}

const toStop: (() => void)[] = [];
afterEach(() => {
  for (const stop of toStop.splice(0)) stop();
});

/** A job on a local chain whose doors ask this stand-in what the wallets granted. */
async function aServer(grants: Grants, fund: readonly Agent[]): Promise<RunningPodServer> {
  const running = await aPodServer({
    jobId: JOB, spec: SPEC, grants, fund,
    files: { "check-1.mjs": good(0).check, "check-2.mjs": good(1).check },
  });
  toStop.push(() => running.stop());
  return running;
}

/** The password git is given: the seat the statement names, when it runs out, and the key that signed it. */
async function password(input: {
  readonly seat: Address;
  readonly signer: Agent;
  readonly role: Role;
  readonly job: JobRef;
  readonly jobs: Address;
  readonly until?: number;
}): Promise<string> {
  const until = input.until ?? secondsNow() + 600;
  const signature = await privateKeyToAccount(input.signer.key).signMessage({
    message: doorMessage({
      jobId: input.job.jobId, onChainId: String(input.job.onChainId), jobs: input.jobs,
      role: input.role, branch: branchFor(input.role, input.seat), until,
    }),
  });
  return `${input.role}.${until}.${signature}`;
}

/** A note as a seat sends one, signed by whichever key is acting for it. */
async function aNote(input: { readonly seat: Address; readonly signer: Agent; readonly role: Role; readonly job: JobRef; readonly jobs: Address; readonly says: string }): Promise<object> {
  const at = secondsNow();
  const signature = await privateKeyToAccount(input.signer.key).signMessage({
    message: noteMessage({ jobId: input.job.jobId, onChainId: String(input.job.onChainId), jobs: input.jobs, role: input.role, says: input.says, at }),
  });
  return { agent: input.seat, role: input.role, says: input.says, at, signature };
}

/** Why the notes refused a note, and with what status. */
async function sendNote(running: RunningPodServer, note: object): Promise<{ readonly status: number; readonly why?: string }> {
  const answer = await fetch(new URL(notesPath(JOB), running.base), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(note),
  });
  const said = (await answer.json()) as { readonly why?: string };
  return { status: answer.status, ...(said.why ? { why: said.why } : {}) };
}

/** The wallet's seat, taken by the wallet itself, and a working copy that signs with the key it hands out. */
async function aSeatUnderAMandate(running: RunningPodServer, wallet: Agent, signer: Agent, until?: number): Promise<WorkingCopy> {
  const job: JobRef = { jobId: JOB, onChainId: running.onChainId };
  await takeSeat({ ...running.reading, wallet: running.anvil.wallet(wallet.key) }, running.onChainId, "builder", wallet.address);
  const server = new PodServer(running.base);
  const copy = await WorkingCopy.open(
    async () => server.gitDoor(job, wallet.address, await password({ seat: wallet.address, signer, role: "builder", job, jobs: running.jobs, ...(until ? { until } : {}) })),
    // the seat is the wallet, so the work is committed as the wallet: the branch and the commits lead
    // back to the address that holds the seat, not to the key that happened to sign the statement
    { name: "builder", email: agentEmail(wallet.address) },
  );
  toStop.push(() => void copy.close());
  return copy;
}

describe("a grant's window", () => {
  const nowSeconds = 1_700_000_000;

  test("a grant with no window is good: that is what the plugin holds when the wallet named no end date", () => {
    expect(grantIsGoodNow({ from: 0, until: 0 }, nowSeconds)).toBe(true);
  });

  test("a grant that has not started yet, and one that has run out, are both refused", () => {
    expect(grantIsGoodNow({ from: nowSeconds + 60, until: 0 }, nowSeconds)).toBe(false);
    expect(grantIsGoodNow({ from: 0, until: nowSeconds - 1 }, nowSeconds)).toBe(false);
    expect(grantIsGoodNow({ from: 0, until: nowSeconds }, nowSeconds)).toBe(false);
  });

  test("inside its window it is good, whether the window has a start, an end, or both", () => {
    expect(grantIsGoodNow({ from: nowSeconds - 60, until: nowSeconds + 60 }, nowSeconds)).toBe(true);
    expect(grantIsGoodNow({ from: nowSeconds - 60, until: 0 }, nowSeconds)).toBe(true);
    expect(grantIsGoodNow({ from: 0, until: nowSeconds + 1 }, nowSeconds)).toBe(true);
  });
});

describe.skipIf(!available)("a seat worked under a mandate", () => {
  test("a key the seat's wallet granted pushes the work and writes the pod's notes", async () => {
    const granted = new WhatTheWalletsGranted();
    const wallet = anAgent();
    const key = anAgent();
    granted.grant(wallet.address, key.address);
    const running = await aServer(granted, [wallet]);
    const job: JobRef = { jobId: JOB, onChainId: running.onChainId };

    const copy = await aSeatUnderAMandate(running, wallet, key);
    await copy.write({ "server.js": `${WORKING}\n` });
    expect(await copy.commit("Build it")).toBeString();
    const branch = branchFor("builder", wallet.address);
    await copy.push(branch);
    // what arrived is on the wallet's branch, committed by the wallet: the seat, not the key
    expect((await running.git(["log", "-1", "--format=%ce", branch])).trim()).toBe(agentEmail(wallet.address));

    const note = await sendNote(running, await aNote({ seat: wallet.address, signer: key, role: "builder", job, jobs: running.jobs, says: "Built it, under a mandate" }));
    expect(note.status).toBe(201);
    expect(granted.asked).toContain(pair(wallet.address, key.address));
  }, 120_000);

  test("the seat's own key is let in without the chain being asked about grants at all", async () => {
    const granted = new WhatTheWalletsGranted();
    const seat = anAgent();
    const running = await aServer(granted, [seat]);

    const copy = await aSeatUnderAMandate(running, seat, seat);
    await copy.write({ "server.js": `${WORKING}\n` });
    expect(await copy.commit("Build it")).toBeString();
    await copy.push(branchFor("builder", seat.address));
    expect(granted.asked).toEqual([]);
  }, 120_000);

  test("a key the wallet never granted is refused, and told what would have let it in", async () => {
    const granted = new WhatTheWalletsGranted();
    const wallet = anAgent();
    const stranger = anAgent();
    const running = await aServer(granted, [wallet]);
    const job: JobRef = { jobId: JOB, onChainId: running.onChainId };

    const copy = await aSeatUnderAMandate(running, wallet, stranger);
    await expect(copy.fetch(branchFor("builder", wallet.address))).rejects.toThrow(/nor from a key its wallet granted/);

    const note = await sendNote(running, await aNote({ seat: wallet.address, signer: stranger, role: "builder", job, jobs: running.jobs, says: "Let me in" }));
    expect(note.status).toBe(401);
    expect(note.why).toContain("nor from a key its wallet granted");
    expect(granted.asked).toContain(pair(wallet.address, stranger.address));
  }, 120_000);

  test("a grant that has run out is refused, and says to grant it again or sign with the seat's own key", async () => {
    const granted = new WhatTheWalletsGranted();
    const wallet = anAgent();
    const key = anAgent();
    // granted, but the window closed a minute ago: revoking is the owner's, and so is letting it lapse
    granted.grant(wallet.address, key.address, { from: 0, until: secondsNow() - 60 });
    const running = await aServer(granted, [wallet]);
    const job: JobRef = { jobId: JOB, onChainId: running.onChainId };

    const copy = await aSeatUnderAMandate(running, wallet, key);
    await expect(copy.fetch(branchFor("builder", wallet.address))).rejects.toThrow(/grant has run out/);

    const note = await sendNote(running, await aNote({ seat: wallet.address, signer: key, role: "builder", job, jobs: running.jobs, says: "Still here" }));
    expect(note.status).toBe(401);
    expect(note.why).toContain("grant has run out");
  }, 120_000);

  test("a made-up seat nobody took is refused without the plugin being asked anything", async () => {
    const granted = new WhatTheWalletsGranted();
    const wallet = anAgent();
    const key = anAgent();
    granted.grant(wallet.address, key.address);
    const running = await aServer(granted, [wallet]);
    const job: JobRef = { jobId: JOB, onChainId: running.onChainId };
    const nobody = anAgent();

    // the seat was never taken, so there is nothing to act for and nothing to read the chain about
    const note = await sendNote(running, await aNote({ seat: nobody.address, signer: key, role: "builder", job, jobs: running.jobs, says: "Hello" }));
    expect(note.status).toBe(401);
    expect(note.why).toContain("nor from a key its wallet granted");
    expect(granted.asked).toEqual([]);
  }, 120_000);
});
