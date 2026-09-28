import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import { sealSpec } from "../job.ts";
import { post, readJob, readJobCount } from "../jobs.ts";
import { holderOf } from "../handover.ts";
import { ownersFrom, type Owners } from "../owners.ts";
import { readerFor } from "../posting.ts";
import { openJob } from "../publish.ts";
import { claimPath, refundByNumberPath, refundPath, yoursApiPath } from "../routes.ts";
import { handle } from "../server.ts";
import { yoursData } from "../sitePages.ts";
import type { JobStore } from "../store.ts";
import { podTokenAbi } from "../token.ts";
import { moneyAt, YoursViewSchema } from "../web/site/index.ts";
import { ANVIL_KEYS, anvilAvailable, startAnvil, type Anvil } from "./support/anvil.ts";
import { aTitledJob, POSTER, TITLED_SPEC, type Titled } from "./support/titled.ts";

/**
 * A wallet's own page, read from a real local chain: the jobs it paid for, whether the record kept
 * who paid or only the chain knows, and the titles it holds now, which a sale changes.
 */

const available = await anvilAvailable();
const STRANGER = ANVIL_KEYS[3];
const POSTER_ADDRESS = privateKeyToAccount(POSTER).address;
const STRANGER_ADDRESS = privateKeyToAccount(STRANGER).address;

let anvil: Anvil;
let titled: Titled;
let store: JobStore;
let owners: Owners;
/** when each job posted here stops taking work, by its name: jobs posted a second apart end a second apart */
const windowEnds = new Map<string, Date>();
const windowOf = (jobId: string): Date => {
  const ends = windowEnds.get(jobId);
  if (!ends) throw new Error(`${jobId} was never posted here`);
  return ends;
};

/** A job paid for by `key`, opened on the wall, saved the way an older server left it: without who paid. */
async function aRunningJob(jobId: string, key: `0x${string}`): Promise<void> {
  const now = (await anvil.publicClient.getBlock()).timestamp;
  const seal = await sealSpec({ ...TITLED_SPEC, salt: jobId });
  const onChainId = await post(
    { address: titled.jobs, publicClient: anvil.publicClient, wallet: anvil.wallet(key) },
    { seal, endsAt: now + 3600n, reviewers: 1, price: TITLED_SPEC.price },
  );
  windowEnds.set(jobId, new Date(Number(now + 3600n) * 1000));
  const opened = await openJob(store, { jobId, seal, spec: TITLED_SPEC, endsAt: windowOf(jobId), seats: [] });
  await store.save({ ...opened, chain: { network: "monad-testnet", jobId: String(onChainId), jobs: titled.jobs } });
}

beforeAll(async () => {
  if (!available) return;
  anvil = await startAnvil();
  titled = await aTitledJob(anvil, { jobId: "a-coat-titled", commit: "c0ffee".padEnd(40, "0"), repository: "https://github.com/proof-of-development/pod-a-coat-titled" });
  store = titled.store;
  // the titled job is graded and passed, as the worker leaves it
  const record = await store.read("a-coat-titled");
  if (!record) throw new Error("the titled job was not kept");
  await store.save({ ...record, tile: { ...record.tile, verdict: "passed" } });
  await anvil.fund(STRANGER_ADDRESS);
  await aRunningJob("a-coat-still-open", POSTER);
  await aRunningJob("somebody-elses-coat", STRANGER);
  const reader = readerFor({ jobs: titled.jobs, read: (id) => readJob({ address: titled.jobs, publicClient: anvil.publicClient }, id), now: async () => (await anvil.publicClient.getBlock()).timestamp });
  owners = ownersFrom({
    jobs: titled.jobs, job: reader.job, count: () => readJobCount({ address: titled.jobs, publicClient: anvil.publicClient }), holder: (tokenId) => holderOf({ address: titled.token, publicClient: anvil.publicClient }, tokenId) });
}, 120_000);

afterAll(() => anvil?.stop());

describe.skipIf(!available)("a wallet's own page", () => {
  test("lists the jobs it paid for, asking the chain for the ones whose record never kept who paid", async () => {
    const yours = await yoursData(store, owners, POSTER_ADDRESS, new Date());
    expect(yours.posted.map((entry) => entry.tile.jobId).sort()).toEqual(["a-coat-still-open", "a-coat-titled"]);
    const open = yours.posted.find((entry) => entry.tile.jobId === "a-coat-still-open");
    expect(open?.money).toEqual({ kind: "held", endsAt: windowOf("a-coat-still-open").toISOString(), takeBack: refundPath("a-coat-still-open") });
    // what is happening now comes first
    expect(yours.posted[0]?.tile.jobId).toBe("a-coat-still-open");
  });

  test("lists the titles it holds, with where to claim each", async () => {
    const yours = await yoursData(store, owners, POSTER_ADDRESS, new Date());
    expect(yours.holds.map((entry) => entry.tile.jobId)).toEqual(["a-coat-titled"]);
    expect(yours.holds[0]?.title).toEqual({ tokenId: titled.tokenId.toString(), holder: POSTER_ADDRESS, claim: claimPath("a-coat-titled") });
  });

  test("past the window, money nobody settled is the poster's to take back, as the contract says", async () => {
    const later = new Date(windowOf("a-coat-still-open").getTime() + 60_000);
    const open = (await yoursData(store, owners, POSTER_ADDRESS, later)).posted.find((entry) => entry.tile.jobId === "a-coat-still-open");
    // the record alone could not say, so the contract was asked, and its window is the one on the chain
    expect(open?.money).toEqual({ kind: "held", endsAt: windowOf("a-coat-still-open").toISOString(), takeBack: refundPath("a-coat-still-open") });
    if (!open?.money) throw new Error("the open job has no money on the page");
    expect(moneyAt(open.money, later)).toEqual({ kind: "returnable", takeBack: refundPath("a-coat-still-open") });
  });

  test("a title sold is the buyer's, on the buyer's page and off the seller's, while the job stays the poster's", async () => {
    await anvil.wallet(POSTER).writeContract({
      address: titled.token, abi: podTokenAbi, functionName: "transferFrom", args: [POSTER_ADDRESS, STRANGER_ADDRESS, titled.tokenId],
      account: privateKeyToAccount(POSTER), chain: null,
    }).then((hash) => anvil.publicClient.waitForTransactionReceipt({ hash }));

    const seller = await yoursData(store, owners, POSTER_ADDRESS, new Date());
    expect(seller.holds).toEqual([]);
    expect(seller.posted.map((entry) => entry.tile.jobId)).toContain("a-coat-titled");
    const buyer = await yoursData(store, owners, STRANGER_ADDRESS, new Date());
    expect(buyer.holds.map((entry) => entry.tile.jobId)).toEqual(["a-coat-titled"]);
    expect(buyer.posted.map((entry) => entry.tile.jobId)).toEqual(["somebody-elses-coat"]);
  });

  test("a job paid for and never published is found from any browser, by its number on the contract, and only by its payer", async () => {
    const now = (await anvil.publicClient.getBlock()).timestamp;
    const neverPublished = await post(
      { address: titled.jobs, publicClient: anvil.publicClient, wallet: anvil.wallet(POSTER) },
      { seal: await sealSpec({ ...TITLED_SPEC, salt: "never-published" }), endsAt: now + 3600n, reviewers: 1, price: TITLED_SPEC.price },
    );
    const yours = await yoursData(store, owners, POSTER_ADDRESS, new Date());
    expect(yours.unpublished).toEqual([{
      onChainId: neverPublished.toString(), price: TITLED_SPEC.price.toString(),
      money: { kind: "held", endsAt: new Date(Number(now + 3600n) * 1000).toISOString(), takeBack: refundByNumberPath(neverPublished.toString()) },
    }]);
    // somebody else never sees it
    expect((await yoursData(store, owners, STRANGER_ADDRESS, new Date())).unpublished).toEqual([]);
  });

  test("who paid for each job is asked once and remembered; a later visit asks again only about the wallet's own", async () => {
    const reading = { address: titled.jobs, publicClient: anvil.publicClient };
    const asked: bigint[] = [];
    const counting = ownersFrom({
      jobs: titled.jobs, count: () => readJobCount(reading),
      job: async (id) => { asked.push(id); return await readJob(reading, id); },
    });
    const count = await readJobCount(reading);
    const theirs = (await counting.paidBy(POSTER_ADDRESS)).map((paid) => paid.onChainId).sort();
    expect(asked.length).toBe(Number(count));
    asked.length = 0;
    await counting.paidBy(POSTER_ADDRESS);
    expect([...asked].sort()).toEqual(theirs);
  });

  test("a job from an earlier contract is never asked of this one by its number, which here is somebody else's", async () => {
    const opened = await openJob(store, { jobId: "from-an-earlier-contract", seal: `0x${"12".repeat(32)}`, spec: TITLED_SPEC, endsAt: windowOf("a-coat-still-open"), seats: [] });
    // number 1 on another contract; on this one, job 1 is the poster's titled job
    await store.save({ ...opened, chain: { network: "monad-testnet", jobId: "1", jobs: "0x00000000000000000000000000000000000000e1", tokenId: titled.tokenId.toString() } });
    const record = await store.read("from-an-earlier-contract");
    if (!record) throw new Error("the record was not kept");
    expect(await owners.posterOf(record)).toBeUndefined();
    expect(await owners.holderOf(record)).toBeUndefined();
    expect((await yoursData(store, owners, POSTER_ADDRESS, new Date())).posted.map((entry) => entry.tile.jobId)).not.toContain("from-an-earlier-contract");
  });

  test("the server answers the same at the wallet's own address, and refuses what is not an address", async () => {
    const answer = await handle(new Request(`http://pod.test${yoursApiPath(STRANGER_ADDRESS)}`), store, { owners });
    expect(answer.status).toBe(200);
    const yours = YoursViewSchema.parse(await answer.json());
    expect(yours.posted.map((entry) => entry.tile.jobId)).toEqual(["somebody-elses-coat"]);
    expect((await handle(new Request(`http://pod.test${yoursApiPath("not-an-address")}`), store, { owners })).status).toBe(400);
  });
});
