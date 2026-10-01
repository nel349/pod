import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PREPARING_FOLDER } from "../folders.ts";
import { MODES, sealSpec } from "../job.ts";
import { post } from "../jobs.ts";
import { podJobsV2Abi } from "../jobsV2.ts";
import { PreparingStore } from "../preparing/index.ts";
import { openJob } from "../publish.ts";
import { chainJobPath, preparingPagePath, yoursApiPath } from "../routes.ts";
import { ChainJobSchema } from "../chainJob.ts";
import { handle, type Services } from "../server.ts";
import { servicesFor } from "../services.ts";
import { yoursData } from "../sitePages.ts";
import { JobStore } from "../store.ts";
import { YoursViewSchema } from "../web/site/index.ts";
import { ANVIL_KEYS, anvilAvailable, startAnvil, type Anvil } from "./support/anvil.ts";
import { GOOD_REPLY, replying, writerWith } from "./support/coat.ts";
import { deployRegistries } from "./support/registries.ts";
import { TITLED_SPEC } from "./support/titled.ts";

/**
 * A wallet's own page after the switch-over: its job on the first contract still has its poster, and
 * its jobs on the contract that prepares them are where they stand, each with the one thing to do: read
 * the checks of one being prepared, or take back the money for one whose lines never reached the server.
 */
const available = await anvilAvailable();

const [DEPLOYER, POSTER, WRITER, VALIDATOR] = [ANVIL_KEYS[0], ANVIL_KEYS[1], ANVIL_KEYS[4], ANVIL_KEYS[6]];
const POSTER_ADDRESS = privateKeyToAccount(POSTER).address;
const WRITING = parseEther("0.05");
const SALT = "0123456789abcdef0123456789abcdef";

describe.skipIf(!available)("your own page, with jobs on both contracts", () => {
  let anvil: Anvil;
  let old: Address;
  let prepares: Address;
  let store: JobStore;
  let directory: string;
  let services: Services;

  async function paidOnTheNewContract(): Promise<bigint> {
    const payer = anvil.wallet(POSTER);
    const { request, result } = await anvil.publicClient.simulateContract({
      address: prepares, abi: podJobsV2Abi, functionName: "post", args: [BigInt(MODES.flash.windowMinutes * 60), 1],
      value: parseEther("0.1") + 3n * WRITING, account: payer.account,
    });
    await anvil.publicClient.waitForTransactionReceipt({ hash: await payer.writeContract(request) });
    return result;
  }

  beforeAll(async () => {
    anvil = await startAnvil();
    const validator = privateKeyToAccount(VALIDATOR).address;
    old = await anvil.deploy("PodJobs", [validator], DEPLOYER);
    prepares = await anvil.deploy("PodJobsV2", [validator, privateKeyToAccount(WRITER).address, 10n, WRITING, 100_000n], DEPLOYER);
    const registries = await deployRegistries(anvil);
    directory = await mkdtemp(join(tmpdir(), "pod-yours-prepared-"));
    store = new JobStore(directory);
    services = await servicesFor({
      store, directory, publicClient: anvil.publicClient,
      page: { chainId: 31337, chainName: "a local chain", rpc: anvil.rpc, explorer: "http://explorer.invalid", coin: "ETH", registries },
      registries, jobs: prepares, earlier: old, writer: anvil.wallet(WRITER), checkWriter: writerWith(replying(GOOD_REPLY).model),
    });
  }, 120_000);
  afterAll(() => anvil?.stop());

  test("an old job keeps its poster, one being prepared is sent to its checks, and one never set up to taking the money back", async () => {
    // on the first contract, posted and published before the switch, its poster never kept on the record
    const seal = await sealSpec(TITLED_SPEC);
    const endsAt = (await anvil.publicClient.getBlock()).timestamp + 3600n;
    const oldId = await post({ address: old, publicClient: anvil.publicClient, wallet: anvil.wallet(POSTER) }, { seal, endsAt, reviewers: 1, price: TITLED_SPEC.price });
    const opened = await openJob(store, { jobId: "an-old-coat", seal, spec: TITLED_SPEC, endsAt: new Date(Number(endsAt) * 1000), seats: [] });
    await store.save({ ...opened, chain: { network: "monad-testnet", jobId: `${oldId}`, jobs: old } });

    // on the new one: one set up and being prepared, one paid for whose lines never arrived
    const beingPrepared = await paidOnTheNewContract();
    const neverSetUp = await paidOnTheNewContract();
    await new PreparingStore(join(directory, PREPARING_FOLDER)).saveSetUp({
      onChainId: `${beingPrepared}`, jobs: prepares, name: "a-coat-being-prepared", poster: POSTER_ADDRESS, mode: "flash", salt: SALT,
      setUpAt: new Date().toISOString(),
    });

    const owners = services.owners;
    if (!owners) throw new Error("no owners, with a chain to answer to");
    const yours = await yoursData(store, owners, POSTER_ADDRESS, new Date(), services.preparing);
    expect(yours.posted.map((entry) => entry.tile.jobId)).toContain("an-old-coat");
    expect(yours.unpublished).toEqual(expect.arrayContaining([
      expect.objectContaining({ onChainId: `${beingPrepared}`, money: { kind: "preparing", page: preparingPagePath(`${beingPrepared}`) } }),
      expect.objectContaining({ onChainId: `${neverSetUp}`, money: { kind: "notSetUp", page: preparingPagePath(`${neverSetUp}`) } }),
    ]));
    // the old job is on the wall, so it is not listed again among those that are not
    expect(yours.unpublished?.some((job) => job.onChainId === `${oldId}`)).toBe(false);

    // the old job's money is read from the contract it is on, when the page names it; the new contract has no such number
    const onTheFirst = await handle(new Request(`http://pod.test${chainJobPath(`${oldId}`, old)}`), store, services);
    expect(ChainJobSchema.parse(await onTheFirst.json())).toMatchObject({ jobs: old, poster: POSTER_ADDRESS, state: "open" });
    expect((await handle(new Request(`http://pod.test${chainJobPath(`${oldId}`)}`), store, services)).status).toBe(404);

    // and the server answers the same at the wallet's own address
    const answer = await handle(new Request(`http://pod.test${yoursApiPath(POSTER_ADDRESS)}`), store, services);
    expect(YoursViewSchema.parse(await answer.json()).unpublished?.map((job) => job.money.kind).sort()).toEqual(["notSetUp", "preparing"]);
  }, 120_000);

  test("taken back, a job is said to be back, with nothing more to do", async () => {
    const id = await paidOnTheNewContract();
    const payer = anvil.wallet(POSTER);
    const { request } = await anvil.publicClient.simulateContract({ address: prepares, abi: podJobsV2Abi, functionName: "takeBack", args: [id], account: payer.account });
    await anvil.publicClient.waitForTransactionReceipt({ hash: await payer.writeContract(request) as Hex });
    const owners = services.owners;
    if (!owners) throw new Error("no owners, with a chain to answer to");
    const yours = await yoursData(store, owners, POSTER_ADDRESS, new Date(), services.preparing);
    expect(yours.unpublished?.find((job) => job.onChainId === `${id}`)?.money).toEqual({ kind: "refunded" });
  }, 60_000);
});
