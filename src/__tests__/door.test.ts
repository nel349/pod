import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEther, recoverMessageAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { agentEmail, branchFor, doorChainFor, Doorkeeper, GitDoor, LONGEST_NOTE, MOST_A_REPOSITORY_MAY_WEIGH, NoteBoard, NOTES_A_SEAT_MAY_WRITE_A_MINUTE, PUSHES_A_SEAT_MAY_MAKE_A_MINUTE } from "../door/index.ts";
import type { Role, Spec } from "../job.ts";
import { post, readJob, readSeats, readTerms, takeSeat } from "../jobs.ts";
import { doorMessage, noteMessage } from "../messages.ts";
import { openJob } from "../publish.ts";
import { gitPath, notesPath } from "../routes.ts";
import { serve } from "../server.ts";
import { JobStore } from "../store.ts";
import { ANVIL_KEYS, anvilAvailable, startAnvil, type Anvil } from "./support/anvil.ts";

/**
 * The doors an agent uses, the git door and the notes, against a real chain, git with a real git client.
 *
 * Every refusal here is one the plan names: another branch, a key with no seat, a force push, a
 * deleted branch, a commit written as somebody else, a push after the window. Each is made the way an
 * agent would make it, with plain git, and each has to come back with its reason, because an agent
 * that is only told "no" cannot fix anything.
 */

const available = await anvilAvailable();

let anvil: Anvil;
let jobs: Address;
let store: JobStore;
let repositories: string;
let base = "";
let server: { stop: () => void } | undefined;

const POSTER = ANVIL_KEYS[1];
const PRICE = parseEther("1");
/** the real limit on how often, and a small one on weight, so it can be shown to bite without pushing 50MB */
const LIMITS = { mostAPushMayWeigh: 64 * 1024, pushesASeatMayMakeAMinute: PUSHES_A_SEAT_MAY_MAKE_A_MINUTE, mostARepositoryMayWeigh: MOST_A_REPOSITORY_MAY_WEIGH };
/** a second door, with limits small enough to reach in a test, on a server of its own */
const TIGHT = { mostAPushMayWeigh: 64 * 1024, pushesASeatMayMakeAMinute: 3, mostARepositoryMayWeigh: 1 };
let tightBase = "";
let tightServer: { stop: () => void } | undefined;

interface Agent {
  readonly key: Hex;
  readonly address: Address;
}

function anAgent(): Agent {
  const key = generatePrivateKey();
  return { key, address: privateKeyToAccount(key).address };
}

const lead = anAgent();
const builder = anAgent();
const stranger = anAgent();
/** holds the builder seat on the second job only, to show a seat opens its own job and no other */
const elsewhere = anAgent();

/** the two jobs, by the name on the wall and the number on the contract */
const FIRST = { jobId: "a-coat-given-the-rain", onChainId: 0n };
const SECOND = { jobId: "an-umbrella-given-the-wind", onChainId: 0n };

async function fund(to: Address): Promise<void> {
  const payer = anvil.wallet(ANVIL_KEYS[0]);
  await anvil.publicClient.waitForTransactionReceipt({
    hash: await payer.sendTransaction({ to, value: parseEther("10"), account: payer.account!, chain: payer.chain }),
  });
}

const contractAs = (key: Hex) => ({ address: jobs, publicClient: anvil.publicClient, wallet: anvil.wallet(key) });

/** A job posted on the contract and opened on the wall, as a poster's page would leave it. */
async function aPostedJob(jobId: string, seats: readonly (readonly [Role, Agent])[]): Promise<bigint> {
  const now = (await anvil.publicClient.getBlock()).timestamp;
  const seal = `0x${"ab".repeat(32)}` as Hex;
  const onChainId = await post(contractAs(POSTER), { seal, endsAt: now + 3600n, reviewers: 1, price: PRICE });
  for (const [role, agent] of seats) await takeSeat(contractAs(agent.key), onChainId, role, agent.address);

  const spec: Spec = { idea: "A page that says whether to take a coat", mode: "flash", price: PRICE, checks: [], allowed: [], salt: "nobody-can-guess" };
  const opened = await openJob(store, { jobId, seal, spec, endsAt: new Date(Number(now + 3600n) * 1000), seats: [] });
  await store.save({ ...opened, chain: { network: "monad-testnet", jobId: String(onChainId), jobs } });
  return onChainId;
}

beforeAll(async () => {
  if (!available) return;
  anvil = await startAnvil();
  jobs = await anvil.deploy("PodJobs", [privateKeyToAccount(ANVIL_KEYS[6]).address]);
  for (const agent of [lead, builder, stranger, elsewhere]) await fund(agent.address);

  store = new JobStore(await mkdtemp(join(tmpdir(), "pod-door-jobs-")));
  repositories = await mkdtemp(join(tmpdir(), "pod-door-repositories-"));
  FIRST.onChainId = await aPostedJob(FIRST.jobId, [["lead", lead], ["builder", builder]]);
  SECOND.onChainId = await aPostedJob(SECOND.jobId, [["builder", elsewhere]]);

  const contract = { address: jobs, publicClient: anvil.publicClient };
  const keeper = new Doorkeeper({
    store,
    chain: doorChainFor({
      jobs,
      readJob: (id) => readJob(contract, id),
      readSeats: (id) => readSeats(contract, id),
      readTerms: (id) => readTerms(contract, id),
      latestBlockTime: async () => (await anvil.publicClient.getBlock()).timestamp,
    }),
  });
  const door = new GitDoor({ repositories, keeper, limits: LIMITS });
  const serving = serve(store, 0, { door, notes: new NoteBoard({ keeper, store }) });
  server = serving;
  base = `http://127.0.0.1:${serving.port}`;

  const tight = serve(store, 0, { door: new GitDoor({ repositories: await mkdtemp(join(tmpdir(), "pod-door-tight-")), keeper, limits: TIGHT }) });
  tightServer = tight;
  tightBase = `http://127.0.0.1:${tight.port}`;
}, 120_000);

afterAll(() => {
  server?.stop();
  tightServer?.stop();
  anvil?.stop();
});

/** The password an agent gives git: its seat, when the statement runs out, and its signature over the statement. */
async function password(agent: Agent, role: Role, job: { readonly jobId: string; readonly onChainId: bigint }, until = Math.floor(Date.now() / 1000) + 600, signer: Agent = agent): Promise<string> {
  const signature = await privateKeyToAccount(signer.key).signMessage({
    message: doorMessage({ jobId: job.jobId, onChainId: String(job.onChainId), jobs, role, branch: branchFor(role, agent.address), until }),
  });
  return `${role}.${until}.${signature}`;
}

/** Where git is pointed, with the seat's name and statement in it, the way any git client carries them. */
function remote(agent: Agent, secret: string, jobId = FIRST.jobId): string {
  const url = new URL(`${base}${gitPath(jobId)}`);
  url.username = agent.address;
  url.password = secret;
  return url.toString();
}

interface Ran {
  readonly code: number;
  readonly out: string;
}

/** Plain git, as an agent runs it: no settings from this machine, never a prompt. */
async function git(cwd: string, args: readonly string[], who?: { readonly author: string; readonly committer?: string }): Promise<Ran> {
  const child = Bun.spawn(["git", ...args], {
    cwd, stdout: "pipe", stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: cwd,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      ...(who ? {
        GIT_AUTHOR_NAME: "an agent", GIT_AUTHOR_EMAIL: who.author,
        GIT_COMMITTER_NAME: "an agent", GIT_COMMITTER_EMAIL: who.committer ?? who.author,
      } : {}),
    },
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, out: `${out}${err}` };
}

/** A working copy with one new commit in it, written as whoever is given. */
async function aCommit(who: { readonly author: string; readonly committer?: string }, file = "server.js", contents = "console.log('a coat')\n"): Promise<string> {
  const work = await mkdtemp(join(tmpdir(), "pod-door-work-"));
  await git(work, ["init", "--quiet", "--initial-branch=work"]);
  await writeFile(join(work, file), contents);
  await git(work, ["add", "."]);
  const made = await git(work, ["commit", "--quiet", "-m", "the work"], who);
  if (made.code !== 0) throw new Error(made.out);
  return work;
}

/**
 * A working copy of a seat's branch as the door holds it, or an empty one if the branch has nothing
 * yet, with one new commit on top: what an agent has in hand just before it pushes.
 */
async function onTopOf(
  agent: Agent, role: Role,
  change: { readonly file: string; readonly contents: string; readonly who?: { readonly author: string; readonly committer?: string } },
): Promise<{ readonly work: string; readonly url: string; readonly branch: string }> {
  const url = remote(agent, await password(agent, role, FIRST));
  const branch = branchFor(role, agent.address);
  const work = await mkdtemp(join(tmpdir(), "pod-door-work-"));
  await git(work, ["init", "--quiet", "--initial-branch=work"]);
  if ((await git(work, ["fetch", "--quiet", url, `refs/heads/${branch}`])).code === 0) {
    await git(work, ["reset", "--quiet", "--hard", "FETCH_HEAD"]);
  }
  await writeFile(join(work, change.file), change.contents);
  await git(work, ["add", "."]);
  const made = await git(work, ["commit", "--quiet", "-m", `the work: ${change.file}`], change.who ?? asSeat(agent));
  if (made.code !== 0) throw new Error(made.out);
  return { work, url, branch };
}

/** written, and committed, as the seat: what every commit pushed from a seat has to say */
const asSeat = (agent: Agent) => ({ author: agentEmail(agent.address) });

/** A note as a seat sends it: what it says, signed with its seat key, or with somebody else's to forge one. */
async function aNote(
  agent: Agent, role: Role, job: { readonly jobId: string; readonly onChainId: bigint },
  content: { readonly says: string; readonly about?: string; readonly at?: number }, signer: Agent = agent,
): Promise<{ agent: Address; role: Role; about?: string; says: string; at: number; signature: Hex }> {
  const at = content.at ?? Math.floor(Date.now() / 1000);
  const signature = await privateKeyToAccount(signer.key).signMessage({
    message: noteMessage({ jobId: job.jobId, onChainId: String(job.onChainId), jobs, role, about: content.about, says: content.says, at }),
  });
  return { agent: agent.address, role, ...(content.about === undefined ? {} : { about: content.about }), says: content.says, at, signature };
}

const writeNote = (job: { readonly jobId: string }, note: object): Promise<Response> =>
  fetch(`${base}${notesPath(job.jobId)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(note) });

/** Read a job's notes as a seat does: with the same signed statement the git door takes. */
async function readNotes(job: { readonly jobId: string; readonly onChainId: bigint }, agent: Agent, role: Role): Promise<Response> {
  const statement = btoa(`${agent.address}:${await password(agent, role, job)}`);
  return fetch(`${base}${notesPath(job.jobId)}`, { headers: { authorization: `Basic ${statement}` } });
}

const why = async (answer: Response): Promise<string> => ((await answer.json()) as { why: string }).why;

/** The notes as the pod reads them. */
async function pod$Notes(job: { readonly jobId: string; readonly onChainId: bigint }): Promise<readonly { readonly says: string }[]> {
  return ((await (await readNotes(job, lead, "lead")).json()) as { notes: { says: string }[] }).notes;
}

/** What the bare repository holds, read straight from disk rather than through the door. */
async function onTheServer(args: readonly string[]): Promise<Ran> {
  return git(repositories, ["--git-dir", join(repositories, `${FIRST.jobId}.git`), ...args]);
}

describe.skipIf(!available)("the git door", () => {
  test("a seat pushes to its own branch, and the commit there is written as that seat", async () => {
    const work = await aCommit(asSeat(builder));
    const branch = branchFor("builder", builder.address);
    const pushed = await git(work, ["push", remote(builder, await password(builder, "builder", FIRST)), `HEAD:refs/heads/${branch}`]);
    expect(pushed.out).toContain(branch);
    expect(pushed.code).toBe(0);

    const written = await onTheServer(["log", "--format=%ae %ce", branch]);
    expect(written.out.trim()).toBe(`${agentEmail(builder.address)} ${agentEmail(builder.address)}`);
  }, 60_000);

  test("a pod arriving all at once finds the repository, however many ask first", async () => {
    const work = await mkdtemp(join(tmpdir(), "pod-door-together-"));
    const together = await Promise.all(Array.from({ length: 6 }, async () =>
      git(work, ["ls-remote", remote(elsewhere, await password(elsewhere, "builder", SECOND), SECOND.jobId)])));
    for (const answer of together) expect(answer.code).toBe(0);
  }, 60_000);

  test("any seat on the job reads every branch of it", async () => {
    const work = await mkdtemp(join(tmpdir(), "pod-door-read-"));
    const listed = await git(work, ["ls-remote", remote(lead, await password(lead, "lead", FIRST))]);
    expect(listed.code).toBe(0);
    expect(listed.out).toContain(`refs/heads/${branchFor("builder", builder.address)}`);
  }, 60_000);

  test("another seat's branch is refused, with the reason", async () => {
    const work = await aCommit(asSeat(builder));
    const theirs = branchFor("lead", lead.address);
    const pushed = await git(work, ["push", remote(builder, await password(builder, "builder", FIRST)), `HEAD:refs/heads/${theirs}`]);
    expect(pushed.code).not.toBe(0);
    expect(pushed.out).toContain(`you may push only to ${branchFor("builder", builder.address)}`);
    expect(pushed.out).toContain(`${theirs} is not yours`);
    expect((await onTheServer(["rev-parse", "--verify", "--quiet", `refs/heads/${theirs}`])).code).not.toBe(0);
  }, 60_000);

  test("main is nobody's to push: only work that passed goes there, and not through this door", async () => {
    const work = await aCommit(asSeat(lead));
    const pushed = await git(work, ["push", remote(lead, await password(lead, "lead", FIRST)), "HEAD:refs/heads/main"]);
    expect(pushed.code).not.toBe(0);
    expect(pushed.out).toContain("main is not yours");
  }, 60_000);

  test("a key with no seat on the job gets nothing, not even a read", async () => {
    const work = await aCommit(asSeat(stranger));
    const pushed = await git(work, ["push", remote(stranger, await password(stranger, "builder", FIRST)), `HEAD:refs/heads/${branchFor("builder", stranger.address)}`]);
    expect(pushed.code).not.toBe(0);
    expect(pushed.out).toContain(`that key holds no seat on job ${FIRST.onChainId}`);

    const read = await git(work, ["ls-remote", remote(stranger, await password(stranger, "builder", FIRST))]);
    expect(read.code).not.toBe(0);
    expect(read.out).toContain("holds no seat");
  }, 60_000);

  test("a seat opens its own job and no other", async () => {
    const work = await mkdtemp(join(tmpdir(), "pod-door-read-"));
    const read = await git(work, ["ls-remote", remote(builder, await password(builder, "builder", SECOND), SECOND.jobId)]);
    expect(read.code).not.toBe(0);
    expect(read.out).toContain(`that key holds no seat on job ${SECOND.onChainId}`);
    // and a statement for the first job does not open the second
    const replayed = await git(work, ["ls-remote", remote(builder, await password(builder, "builder", FIRST), SECOND.jobId)]);
    expect(replayed.code).not.toBe(0);
    expect(replayed.out).toContain("that signature is not from the address in the name");
  }, 60_000);

  test("a key that says it holds a seat it does not is told which one it holds", async () => {
    const work = await mkdtemp(join(tmpdir(), "pod-door-read-"));
    const read = await git(work, ["ls-remote", remote(builder, await password(builder, "lead", FIRST))]);
    expect(read.code).not.toBe(0);
    expect(read.out).toContain("that key holds the builder seat");
  }, 60_000);

  test("a statement that has run out, lasts too long, or is signed by another key is refused", async () => {
    const work = await mkdtemp(join(tmpdir(), "pod-door-read-"));
    const now = Math.floor(Date.now() / 1000);
    const ranOut = await git(work, ["ls-remote", remote(builder, await password(builder, "builder", FIRST, now - 1))]);
    expect(ranOut.out).toContain("that statement has run out");
    const tooLong = await git(work, ["ls-remote", remote(builder, await password(builder, "builder", FIRST, now + 2 * 60 * 60))]);
    expect(tooLong.out).toContain("an hour at most");
    const forged = await git(work, ["ls-remote", remote(builder, await password(builder, "builder", FIRST, now + 600, stranger))]);
    expect(forged.out).toContain("that signature is not from the address in the name");
    for (const refused of [ranOut, tooLong, forged]) expect(refused.code).not.toBe(0);
  }, 60_000);

  test("history is never rewritten: a force push is refused and the first commit stays", async () => {
    const work = await aCommit(asSeat(lead), "lead.txt", "first\n");
    const url = remote(lead, await password(lead, "lead", FIRST));
    const branch = branchFor("lead", lead.address);
    expect((await git(work, ["push", url, `HEAD:refs/heads/${branch}`])).code).toBe(0);
    const first = (await onTheServer(["rev-parse", branch])).out.trim();

    await writeFile(join(work, "lead.txt"), "rewritten\n");
    await git(work, ["commit", "--quiet", "--all", "--amend", "-m", "the work, rewritten"], asSeat(lead));
    const forced = await git(work, ["push", "--force", url, `HEAD:refs/heads/${branch}`]);
    expect(forced.code).not.toBe(0);
    expect(forced.out).toContain("history is never rewritten here");
    expect((await onTheServer(["rev-parse", branch])).out.trim()).toBe(first);
  }, 60_000);

  test("a branch is never deleted, so every attempt stays in the record", async () => {
    const { work, url, branch } = await onTopOf(builder, "builder", { file: "kept.txt", contents: "kept\n" });
    expect((await git(work, ["push", url, `HEAD:refs/heads/${branch}`])).code).toBe(0);

    const deleted = await git(work, ["push", url, `:refs/heads/${branch}`]);
    expect(deleted.code).not.toBe(0);
    expect(deleted.out).toContain("branches are never deleted here");
    expect((await onTheServer(["rev-parse", "--verify", "--quiet", branch])).code).toBe(0);
  }, 60_000);

  test("a commit written as somebody else is refused, and so is one committed as somebody else", async () => {
    const posing = await onTopOf(builder, "builder", { file: "posing.txt", contents: "posing\n", who: { author: agentEmail(lead.address) } });
    const asTheLead = await git(posing.work, ["push", posing.url, `HEAD:refs/heads/${posing.branch}`]);
    expect(asTheLead.code).not.toBe(0);
    expect(asTheLead.out).toContain(`says it was written by ${agentEmail(lead.address)}`);

    const committed = await onTopOf(builder, "builder", {
      file: "committed.txt", contents: "committed\n", who: { author: agentEmail(builder.address), committer: "somebody@example.com" },
    });
    const asSomebody = await git(committed.work, ["push", committed.url, `HEAD:refs/heads/${committed.branch}`]);
    expect(asSomebody.code).not.toBe(0);
    expect(asSomebody.out).toContain("says it was committed by somebody@example.com");
  }, 60_000);

  test("the lead brings in another seat's work: merged commits keep their authors, and only the merge is the lead's", async () => {
    const url = remote(lead, await password(lead, "lead", FIRST));
    const leads = branchFor("lead", lead.address);
    const builders = branchFor("builder", builder.address);
    const work = await mkdtemp(join(tmpdir(), "pod-door-lead-"));
    expect((await git(work, ["clone", "--quiet", "--branch", leads, url, "."])).code).toBe(0);
    expect((await git(work, ["fetch", "--quiet", url, `refs/heads/${builders}:refs/remotes/pod/builder`])).code).toBe(0);
    const merged = await git(work, ["merge", "--no-edit", "--allow-unrelated-histories", "pod/builder"], asSeat(lead));
    expect(merged.code).toBe(0);

    const pushed = await git(work, ["push", url, `HEAD:refs/heads/${leads}`]);
    expect(pushed.code).toBe(0);
    const authors = (await onTheServer(["log", "--format=%ae", leads])).out.trim().split("\n");
    expect(authors).toContain(agentEmail(builder.address));
    expect(authors[0]).toBe(agentEmail(lead.address));
  }, 60_000);

  test("a push heavier than a push may be is refused, and nothing moves", async () => {
    // random bytes do not compress, so what is sent is what is written
    const noise = Buffer.from(crypto.getRandomValues(new Uint8Array(LIMITS.mostAPushMayWeigh * 2))).toString("base64");
    const { work, url, branch } = await onTopOf(builder, "builder", { file: "heavy.bin", contents: noise });
    const before = (await onTheServer(["rev-parse", "--verify", "--quiet", branch])).out.trim();
    const pushed = await git(work, ["push", url, `HEAD:refs/heads/${branch}`]);
    expect(pushed.code).not.toBe(0);
    expect(pushed.out).toContain("pack exceeds maximum allowed size");
    expect((await onTheServer(["rev-parse", "--verify", "--quiet", branch])).out.trim()).toBe(before);
  }, 60_000);

  test("a seat that pushes too often is told to wait", async () => {
    let refused: Ran | undefined;
    let accepted = 0;
    for (let i = 0; i <= LIMITS.pushesASeatMayMakeAMinute && !refused; i++) {
      const { work, url, branch } = await onTopOf(lead, "lead", { file: "often.txt", contents: `${i}\n` });
      const pushed = await git(work, ["push", url, `HEAD:refs/heads/${branch}`]);
      if (pushed.code === 0) accepted++;
      else refused = pushed;
    }
    expect(refused?.out).toContain(`a seat may push ${LIMITS.pushesASeatMayMakeAMinute} times a minute`);
    // the pushes before the limit were real pushes, and went in
    expect(accepted).toBeGreaterThan(0);
  }, 120_000);
});

describe.skipIf(!available)("the git door, against what a hand-made request can do", () => {
  test("a commit whose address hides a second one, to pass off somebody else as its committer, is refused", async () => {
    const mine = agentEmail(builder.address);
    // written as "<me me>", committed as the lead: read by spaces, this looked like the seat's own twice
    const hiding = await onTopOf(builder, "builder", { file: "hiding.txt", contents: "x\n", who: { author: `${mine} ${mine}`, committer: agentEmail(lead.address) } });
    const before = await onTheServer(["rev-parse", "--verify", "--quiet", hiding.branch]);
    const pushed = await git(hiding.work, ["push", hiding.url, `HEAD:refs/heads/${hiding.branch}`]);
    expect(pushed.code).not.toBe(0);
    expect((await onTheServer(["rev-parse", "--verify", "--quiet", hiding.branch])).out).toBe(before.out);
  }, 60_000);

  test("a push sent without first asking what is there is counted all the same", async () => {
    const statement = btoa(`${lead.address}:${await password(lead, "lead", FIRST)}`);
    const sent: number[] = [];
    for (let i = 0; i <= TIGHT.pushesASeatMayMakeAMinute; i++) {
      const answer = await fetch(`${tightBase}${gitPath(FIRST.jobId)}/git-receive-pack`, {
        method: "POST", body: "0000",
        headers: { authorization: `Basic ${statement}`, "content-type": "application/x-git-receive-pack-request" },
      });
      await answer.arrayBuffer();
      sent.push(answer.status);
    }
    expect(sent.at(-1)).toBe(429);
    expect(sent.slice(0, TIGHT.pushesASeatMayMakeAMinute).every((status) => status === 200)).toBe(true);
  }, 60_000);

  test("a job's repository that has reached the most it may weigh takes no more pushes", async () => {
    const url = new URL(`${tightBase}${gitPath(SECOND.jobId)}`);
    url.username = elsewhere.address;
    url.password = await password(elsewhere, "builder", SECOND);
    const branch = branchFor("builder", elsewhere.address);
    const work = await aCommit(asSeat(elsewhere), "first.txt");
    expect((await git(work, ["push", url.toString(), `HEAD:refs/heads/${branch}`])).code).toBe(0);
    await writeFile(join(work, "second.txt"), "more\n");
    await git(work, ["add", "."]);
    await git(work, ["commit", "--quiet", "-m", "more"], asSeat(elsewhere));
    const full = await git(work, ["push", url.toString(), `HEAD:refs/heads/${branch}`]);
    expect(full.code).not.toBe(0);
    expect(full.out).toContain("has reached the most it may weigh");
  }, 60_000);

  test("a statement good until the end of time is refused in words, not with a crash", async () => {
    const work = await mkdtemp(join(tmpdir(), "pod-door-read-"));
    // signed over anything: no sentence can be built for such a time, and the door must refuse before it tries
    const signature = await privateKeyToAccount(builder.key).signMessage({ message: "any words at all" });
    const forever = await git(work, ["ls-remote", remote(builder, `builder.99999999999999.${signature}`)]);
    expect(forever.code).not.toBe(0);
    expect(forever.out).toContain("good for an hour at most");
  }, 60_000);
});

describe.skipIf(!available)("notes, signed by the seat that wrote them", () => {
  test("a seat writes a note about a commit, and the rest of the pod reads it back, signature and all", async () => {
    const about = (await onTheServer(["rev-parse", branchFor("builder", builder.address)])).out.trim();
    const note = await aNote(builder, "builder", FIRST, { about, says: "The server answers on 3000 and says take a coat when it rains." });
    const written = await writeNote(FIRST, note);
    expect(written.status).toBe(201);

    const read = await readNotes(FIRST, lead, "lead");
    expect(read.status).toBe(200);
    const { notes } = (await read.json()) as { notes: typeof note[] };
    const kept = notes.find((one) => one.signature === note.signature);
    expect(kept).toEqual(note);
    // anybody can check who said it, from the note alone
    const signer = await recoverMessageAddress({
      message: noteMessage({ jobId: FIRST.jobId, onChainId: String(FIRST.onChainId), jobs, role: kept!.role, about: kept!.about, says: kept!.says, at: kept!.at }),
      signature: kept!.signature,
    });
    expect(signer).toBe(builder.address);
  }, 60_000);

  test("a note can be about the job as a whole, with no commit", async () => {
    const note = await aNote(lead, "lead", FIRST, { says: "Builder, please keep the answer to one sentence." });
    expect((await writeNote(FIRST, note)).status).toBe(201);
  }, 60_000);

  test("a note signed by one key in another's name is refused", async () => {
    const forged = await aNote(builder, "builder", FIRST, { says: "I approve of everything." }, stranger);
    const written = await writeNote(FIRST, forged);
    expect(written.status).toBe(401);
    expect(await why(written)).toContain("not from the agent the note names");
  }, 60_000);

  test("a key with no seat, or claiming a seat it does not hold, cannot write", async () => {
    const outsider = await writeNote(FIRST, await aNote(stranger, "reviewer", FIRST, { says: "Let me in." }));
    expect(outsider.status).toBe(403);
    expect(await why(outsider)).toContain(`that key holds no seat on job ${FIRST.onChainId}`);

    const posing = await writeNote(FIRST, await aNote(builder, "lead", FIRST, { says: "As the lead, I say ship it." }));
    expect(posing.status).toBe(403);
    expect(await why(posing)).toContain("that key holds the builder seat");
  }, 60_000);

  test("a note cannot say it was written at another time", async () => {
    const yesterday = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
    const backdated = await writeNote(FIRST, await aNote(builder, "builder", FIRST, { says: "I said this first.", at: yesterday }));
    expect(backdated.status).toBe(400);
    expect(await why(backdated)).toContain("which is not now");
  }, 60_000);

  test("a note is a few paragraphs at most, and about a commit named in full", async () => {
    const long = await writeNote(FIRST, await aNote(builder, "builder", FIRST, { says: "a".repeat(LONGEST_NOTE + 1) }));
    expect(long.status).toBe(400);
    expect(await why(long)).toContain(`at most ${LONGEST_NOTE} characters`);

    const vague = await writeNote(FIRST, await aNote(builder, "builder", FIRST, { about: "abc123", says: "This one." }));
    expect(vague.status).toBe(400);
    expect(await why(vague)).toContain("named by its full id");
  }, 60_000);

  test("while the job runs, only its seats read the notes", async () => {
    const nobody = await fetch(`${base}${notesPath(FIRST.jobId)}`);
    expect(nobody.status).toBe(401);
    expect(nobody.headers.get("www-authenticate")).toContain("Basic");

    const outsider = await readNotes(FIRST, stranger, "builder");
    expect(outsider.status).toBe(403);
    expect(await why(outsider)).toContain("holds no seat");
  }, 60_000);

  test("once the job has a verdict, anybody reads them", async () => {
    const note = await aNote(elsewhere, "builder", SECOND, { says: "Done, and it answers in one sentence." });
    expect((await writeNote(SECOND, note)).status).toBe(201);
    expect((await fetch(`${base}${notesPath(SECOND.jobId)}`)).status).toBe(401);

    const record = (await store.read(SECOND.jobId))!;
    await store.save({ ...record, tile: { ...record.tile, verdict: "passed" } });
    const published = await fetch(`${base}${notesPath(SECOND.jobId)}`);
    expect(published.status).toBe(200);
    expect(((await published.json()) as { notes: unknown[] }).notes).toContainEqual(note);
  }, 60_000);

  test("a seat that writes too often is told to wait", async () => {
    let refused: Response | undefined;
    for (let i = 0; i <= NOTES_A_SEAT_MAY_WRITE_A_MINUTE && !refused; i++) {
      const written = await writeNote(FIRST, await aNote(lead, "lead", FIRST, { says: `Note ${i}.` }));
      if (written.status !== 201) refused = written;
    }
    expect(refused?.status).toBe(429);
    expect(await why(refused!)).toContain(`${NOTES_A_SEAT_MAY_WRITE_A_MINUTE} notes a minute`);
  }, 60_000);

  test("a note is said once: sent again, by anybody, it is refused, and its writer can still write", async () => {
    const note = await aNote(builder, "builder", FIRST, { says: "Refused: it never says take a coat." });
    expect((await writeNote(FIRST, note)).status).toBe(201);
    const replayed = await writeNote(FIRST, note);
    expect(replayed.status).toBe(409);
    expect(await why(replayed)).toContain("already been written");
    expect((await writeNote(FIRST, await aNote(builder, "builder", FIRST, { says: "And now it does." }))).status).toBe(201);
  }, 60_000);

  test("a note is checked exactly as it was signed, spaces and all", async () => {
    const note = await aNote(builder, "builder", FIRST, { says: "It answers in one sentence.  " });
    expect((await writeNote(FIRST, note)).status).toBe(201);
    expect((await pod$Notes(FIRST)).some((kept) => kept.says === "It answers in one sentence.  ")).toBe(true);
  }, 60_000);

  test("a note from the end of time is refused in words, not with a crash", async () => {
    // signed over anything: no sentence can be built for such a time, and the notes must refuse before they try
    const signature = await privateKeyToAccount(builder.key).signMessage({ message: "any words at all" });
    const farOff = await writeNote(FIRST, { agent: builder.address, role: "builder", says: "Later.", at: 9_000_000_000_000_000, signature });
    expect(farOff.status).toBe(400);
    expect(await why(farOff)).toContain("which is not now");
  }, 60_000);

  test("a note that never ends, sent with no length declared, is refused as it arrives rather than waited for", async () => {
    const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
    const endless = new ReadableStream<Uint8Array>({ pull: (controller) => controller.enqueue(chunk) });
    // a connection of its own: a sender refused part way still has the rest of its body in flight.
    // A server that read to the end first would never answer, and this would run out of time
    const answer = await fetch(`${base}${notesPath(FIRST.jobId)}`, {
      method: "POST", body: endless, duplex: "half", keepalive: false, signal: AbortSignal.timeout(15_000),
    } as RequestInit);
    expect(answer.status).toBe(413);
  }, 60_000);

  test("there are no notes for a job that is not there", async () => {
    const missing = await writeNote({ jobId: "nobody-posted-this" }, await aNote(builder, "builder", FIRST, { says: "Hello?" }));
    expect(missing.status).toBe(404);
  }, 60_000);
});

// last, because it moves the chain's clock past both jobs' windows
describe.skipIf(!available)("once the window has closed", () => {
  test("nothing more can be pushed or written, and everything can still be read", async () => {
    const job = await readJob({ address: jobs, publicClient: anvil.publicClient }, FIRST.onChainId);
    const now = (await anvil.publicClient.getBlock()).timestamp;
    await anvil.publicClient.request({ method: "evm_increaseTime" as never, params: [Number(job.endsAt - now) + 1] as never });
    await anvil.publicClient.request({ method: "evm_mine" as never, params: [] as never });

    const work = await aCommit(asSeat(builder), "late.txt");
    const url = remote(builder, await password(builder, "builder", FIRST));
    const late = await git(work, ["push", url, `HEAD:refs/heads/${branchFor("builder", builder.address)}`]);
    expect(late.code).not.toBe(0);
    expect(late.out).toContain(`job ${FIRST.onChainId}'s window closed at`);
    expect((await git(work, ["ls-remote", url])).code).toBe(0);

    const lateNote = await writeNote(FIRST, await aNote(builder, "builder", FIRST, { says: "One more thing." }));
    expect(lateNote.status).toBe(403);
    expect(await why(lateNote)).toContain("window closed at");
    expect((await readNotes(FIRST, builder, "builder")).status).toBe(200);
  }, 60_000);
});
