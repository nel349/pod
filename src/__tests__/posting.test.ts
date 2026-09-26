import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { acceptPosting, postingMessage, readerFor, type ChainReader, type Posting, type SpecOnTheWire } from "../posting.ts";
import { ProvenChecks, type TriedCheck } from "../checkwriting/index.ts";
import { digestOf, sealSpec, type Spec } from "../job.ts";
import { post, readJob } from "../jobs.ts";
import { JobStore } from "../store.ts";
import { ANVIL_KEYS, anvilAvailable, startAnvil, type Anvil } from "./support/anvil.ts";

/**
 * A stranger posts a job.
 *
 * Every case here is a real transaction on a real EVM and a real signature, because what is being
 * tested is whether the server can be talked into publishing something the chain does not back, and
 * a fake chain would only tell us the fake agrees.
 */

const available = await anvilAvailable();
let anvil: Anvil;
let jobs: Address;
let reader: ChainReader;
let proven: ProvenChecks;

const POSTER = ANVIL_KEYS[1];
const STRANGER = ANVIL_KEYS[2];
const PRICE = parseEther("0.1");

const VISIBLE = "// the page answers";
const HIDDEN = "// the hidden check, which decides whether anybody is paid";

/** A check as the writer hands one back when it passed all three of its trials. */
const passedItsTrials = (source: string): TriedCheck => ({
  checkable: true, says: "a check", secret: false, asks: "asks", expects: "expects", nearMiss: "a mistake",
  file: "check.mjs", source,
  proof: { working: true, nearMiss: true, nothing: true },
  saw: { working: "ok", nearMiss: "caught", nothing: "caught" },
});

/** how the checks of a job that needed it ask for what its poster left open, proven with them */
const ASKED = { plainly: "The checks ask for a chosen temperature: 2 degrees for a cold day", exactly: "The page accepts temperature=<degrees> in its address." };

async function specOf(hidden = HIDDEN): Promise<Spec> {
  return {
    idea: "A page that tells me whether to take a coat",
    mode: "flash",
    price: PRICE,
    allowed: [],
    salt: "a-salt-nobody-can-guess",
    checks: [
      { says: "it answers", run: "node loads.mjs", hidden: false, file: "loads.mjs", digest: await digestOf(VISIBLE) },
      { says: "a cold day says take a coat", run: "node cold.mjs", hidden: true, file: "cold.mjs", digest: await digestOf(hidden) },
    ],
  };
}

const onTheWire = (spec: Spec): SpecOnTheWire => ({ ...spec, price: spec.price.toString() });

/** Post a job for real, from a wallet, and hand back what the chain gave it. */
async function paid(spec: Spec, key: Hex = POSTER): Promise<bigint> {
  const now = (await anvil.publicClient.getBlock()).timestamp;
  return post(
    { address: jobs, publicClient: anvil.publicClient, wallet: anvil.wallet(key) },
    { seal: await sealSpec(spec), endsAt: now + 3600n, reviewers: 1, price: spec.price },
  );
}

async function signed(input: { jobId: string; onChainId: bigint; spec: Spec; key?: Hex; files?: Record<string, string> }): Promise<Posting> {
  const key = input.key ?? POSTER;
  const account = privateKeyToAccount(key);
  const message = postingMessage({
    jobId: input.jobId, onChainId: input.onChainId.toString(), jobs, seal: await sealSpec(input.spec),
  });
  return {
    jobId: input.jobId,
    onChainId: input.onChainId.toString(),
    spec: onTheWire(input.spec),
    files: input.files ?? { "loads.mjs": VISIBLE, "cold.mjs": HIDDEN },
    poster: account.address,
    signature: await account.signMessage({ message }),
  };
}

const aStore = async () => new JobStore(await mkdtemp(join(tmpdir(), "pod-posting-")));

beforeAll(async () => {
  if (!available) return;
  anvil = await startAnvil();
  jobs = await anvil.deploy("PodJobs", [privateKeyToAccount(ANVIL_KEYS[6]).address]);
  reader = readerFor({
    jobs,
    read: async (id) => readJob({ address: jobs, publicClient: anvil.publicClient }, id),
  });
  // the two checks every honest posting below carries have been through their trials here
  proven = new ProvenChecks(await mkdtemp(join(tmpdir(), "pod-proven-")));
  await proven.remember({ checks: [passedItsTrials(VISIBLE), passedItsTrials(HIDDEN)], howItIsAsked: ASKED });
}, 120_000);

afterAll(() => anvil?.stop());

describe.skipIf(!available)("a stranger posts a job", () => {
  test("how the checks ask is published with the job when it was proven with them, and a posting that says it otherwise is refused", async () => {
    const withAsked = { ...(await specOf()), howItIsAsked: ASKED };
    const store = await aStore();
    const accepted = await acceptPosting(store, reader, await signed({ jobId: "a-coat-asked", onChainId: await paid(withAsked), spec: withAsked }), proven);
    expect(accepted.ok).toBe(true);
    expect((await store.read("a-coat-asked"))?.brief?.howItIsAsked).toBe(ASKED.plainly);
    expect((await store.spec("a-coat-asked"))?.howItIsAsked).toEqual(ASKED);

    // the same checks, and a way of asking they were never proven with: sealed and paid for all the same
    const reworded = { ...(await specOf()), howItIsAsked: { ...ASKED, exactly: "The page accepts cold=yes in its address." } };
    const refused = await acceptPosting(await aStore(), reader, await signed({ jobId: "a-coat-reworded", onChainId: await paid(reworded), spec: reworded }), proven);
    expect(refused).toEqual({ ok: false, status: 409, why: expect.stringContaining("how the checks ask was never proven") });
  }, 120_000);

  test("a job paid for on the chain, signed by who paid, with the files it sealed, is published", async () => {
    const spec = await specOf();
    const store = await aStore();
    const accepted = await acceptPosting(store, reader, await signed({ jobId: "a-coat", onChainId: await paid(spec), spec }), proven);

    expect(accepted.ok).toBe(true);
    const record = await store.read("a-coat");
    expect(record?.tile.verdict).toBe("running");
    expect(record?.brief?.sealedChecks).toBe(1);
    // who paid is kept with it, as the chain said, so a page can say "your job" without asking again
    expect(record?.poster).toBe(privateKeyToAccount(POSTER).address);
    // the hidden check is held, not published, while the job is open
    expect(await store.checkFile("a-coat", "cold.mjs")).toBeUndefined();
    // and the spec it was sealed under is kept, which is what grading it later will need
    expect(await store.spec("a-coat")).toEqual(spec);
    const visible = spec.checks.filter((check) => !check.hidden).map((check) => check.file!);
    expect(await store.checkNames("a-coat")).toEqual(visible);
  }, 60_000);

  test("somebody else's signature cannot attach a spec to money they did not put up", async () => {
    const spec = await specOf();
    const posting = await signed({ jobId: "a-coat", onChainId: await paid(spec), spec, key: STRANGER });
    const accepted = await acceptPosting(await aStore(), reader, posting, proven);
    expect(accepted).toEqual({ ok: false, status: 403, why: expect.stringContaining("posted by somebody else") });
  }, 60_000);

  test("a signature that claims to be from somebody it is not from is refused", async () => {
    const spec = await specOf();
    const honest = await signed({ jobId: "a-coat", onChainId: await paid(spec), spec });
    const forged = { ...honest, poster: privateKeyToAccount(STRANGER).address };
    const accepted = await acceptPosting(await aStore(), reader, forged, proven);
    expect(accepted).toEqual({ ok: false, status: 401, why: "that signature is not from the address that says it posted" });
  }, 60_000);

  test("a spec that is not the one that was sealed is refused, however it differs", async () => {
    const onChainId = await paid(await specOf());
    const different = { ...(await specOf()), idea: "Something else entirely" };
    const accepted = await acceptPosting(await aStore(), reader, await signed({ jobId: "a-coat", onChainId, spec: different }), proven);
    expect(accepted).toEqual({ ok: false, status: 409, why: expect.stringContaining("does not match") });
  }, 60_000);

  test("a hidden check swapped after the money went in is caught", async () => {
    const spec = await specOf();
    const onChainId = await paid(spec);
    const swapped = await signed({
      jobId: "a-coat", onChainId, spec, files: { "loads.mjs": VISIBLE, "cold.mjs": "// an easier check" },
    });
    const accepted = await acceptPosting(await aStore(), reader, swapped, proven);
    expect(accepted).toEqual({ ok: false, status: 409, why: "cold.mjs is not the file that was sealed" });
  }, 60_000);

  test("a check the server never tried is refused, even paid for, sealed and signed properly", async () => {
    // the bug this guards: the page only lets a poster seal proven checks, but the page is theirs to
    // change and the API can be called without it. A check nobody could pass must not reach a pod
    const untried = "process.exit(1); // nobody passes this";
    const spec = await specOf(untried);
    const posting = await signed({
      jobId: "a-coat", onChainId: await paid(spec), spec, files: { "loads.mjs": VISIBLE, "cold.mjs": untried },
    });
    const store = await aStore();
    const accepted = await acceptPosting(store, reader, posting, proven);
    expect(accepted).toEqual({
      ok: false, status: 409,
      why: "\"a cold day says take a coat\" was never tried here: write the checks on the posting page, and post the ones that passed",
    });
    expect(await store.read("a-coat")).toBeUndefined();
  }, 60_000);

  test("a posting in the wrong shape is refused with what is wrong, not a crash", async () => {
    const { spec: _spec, ...noSpec } = await signed({ jobId: "a-coat", onChainId: 1n, spec: await specOf() });
    const accepted = await acceptPosting(await aStore(), reader, noSpec, proven);
    expect(accepted.ok).toBe(false);
    expect(accepted.ok ? 0 : accepted.status).toBe(400);
  }, 60_000);

  test("a name that is not a wall address, such as one beginning with a dot, is refused", async () => {
    const spec = await specOf();
    const accepted = await acceptPosting(await aStore(), reader, await signed({ jobId: ".proven", onChainId: await paid(spec), spec }), proven);
    expect(accepted).toEqual({ ok: false, status: 400, why: "a job's name is lower-case letters, numbers and dashes, from 3 to 64 of them" });
  }, 60_000);

  test("a job that was never paid for is not published", async () => {
    const accepted = await acceptPosting(await aStore(), reader, await signed({ jobId: "a-coat", onChainId: 999n, spec: await specOf() }), proven);
    expect(accepted).toEqual({ ok: false, status: 404, why: "there is no job 999 on the contract" });
  }, 60_000);

  test("a name already on the wall is not taken twice", async () => {
    const store = await aStore();
    const first = await specOf();
    expect((await acceptPosting(store, reader, await signed({ jobId: "a-coat", onChainId: await paid(first), spec: first }), proven)).ok).toBe(true);

    const second = await specOf();
    const again = await acceptPosting(store, reader, await signed({ jobId: "a-coat", onChainId: await paid(second), spec: second }), proven);
    expect(again).toEqual({ ok: false, status: 409, why: "there is already a job called a-coat" });
  }, 60_000);
});
