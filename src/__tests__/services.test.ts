import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BOX_SLOTS_FOLDER } from "../folders.ts";
import { MODES, sealSpec, type Spec } from "../job.ts";
import { post } from "../jobs.ts";
import { podJobsV2Abi, readWritingPrice } from "../jobsV2.ts";
import { preparingMessage, setUpMessage } from "../messages.ts";
import type { Registries } from "../registry.ts";
import { openJob } from "../publish.ts";
import { PreparingOnTheWireSchema, preparingFromTheWire, preparingToTheWire } from "../preparing/records.ts";
import { ROUTES } from "../routes.ts";
import { handle } from "../server.ts";
import { servicesFor, type ServicesInput } from "../services.ts";
import { JobStore } from "../store.ts";
import { ANVIL_KEYS, anvilAvailable, startAnvil, type Anvil } from "./support/anvil.ts";
import { COAT_REQUEST, GOOD_REPLY, replying, writerWith } from "./support/coat.ts";
import { deployRegistries } from "./support/registries.ts";
import { dockerAvailable } from "./support/tools.ts";

/**
 * The server's services, built from what it is told. Before the switch-over it answers to one contract
 * and prepares nothing; after it, it prepares jobs on the new contract with the writer's key and still
 * answers for the jobs on the old one. Settings that cannot work are refused when it starts.
 *
 * Everything is real but the model, which answers from a script.
 */
const available = (await anvilAvailable()) && (await dockerAvailable());

const [DEPLOYER, VALIDATOR, WRITER, POSTER, STRANGER] = ANVIL_KEYS;
const WRITING = parseEther("0.05");
const PRICE = parseEther("1");
const SALT = "0123456789abcdef0123456789abcdef";

describe.skipIf(!available)("the server's services, from what it is told", () => {
  let anvil: Anvil;
  let old: Address;
  let prepares: Address;
  let registries: Registries;

  beforeAll(async () => {
    anvil = await startAnvil();
    const validator = privateKeyToAccount(VALIDATOR).address;
    old = await anvil.deploy("PodJobs", [validator], DEPLOYER);
    prepares = await anvil.deploy("PodJobsV2", [validator, privateKeyToAccount(WRITER).address, 10n, WRITING, 100_000n], DEPLOYER);
    registries = await deployRegistries(anvil);
  }, 120_000);
  afterAll(() => anvil?.stop());

  async function input(over: Partial<ServicesInput> = {}): Promise<ServicesInput> {
    const directory = await mkdtemp(join(tmpdir(), "pod-services-"));
    return {
      store: new JobStore(directory), directory, publicClient: anvil.publicClient,
      page: { chainId: 31337, chainName: "a local chain", rpc: anvil.rpc, explorer: "http://explorer.invalid", coin: "ETH", registries },
      registries, jobs: old, checkWriter: writerWith(replying(GOOD_REPLY).model),
      ...over,
    };
  }

  test("before the switch-over it answers to one contract, and nothing is prepared", async () => {
    const services = await servicesFor(await input());
    expect(services.market?.page.jobs).toBe(old);
    expect(services.market?.page.writing).toBeUndefined();
    expect(services.preparing).toBeUndefined();
  });

  test("after it, a paid job is prepared on the new contract, its checks written in the shared box slots", async () => {
    const built = await input({ jobs: prepares, earlier: old, writer: anvil.wallet(WRITER) });
    const services = await servicesFor(built);
    const preparing = services.preparing;
    if (!preparing) throw new Error("no job is prepared, with the contract that prepares them named");
    expect(preparing.jobs).toBe(prepares);
    expect(services.market?.page.jobs).toBe(prepares);
    // the page says what writing costs before anybody pays
    expect(services.market?.page.writing).toEqual({ price: `${WRITING}`, included: 3 });
    // checks are written only for a job paid for, and nothing is posted the old way round
    for (const [method, path] of [["POST", ROUTES.writeChecks], ["GET", `${ROUTES.writeChecks}/x`], ["POST", ROUTES.postJob]] as const) {
      const answer = await handle(new Request(`http://pod.test${path}`, { method, ...(method === "POST" ? { body: "{}" } : {}) }), built.store, services);
      expect(answer.status).toBe(410);
    }

    const poster = anvil.wallet(POSTER);
    const at = { address: prepares, publicClient: anvil.publicClient };
    const { request, result: onChainId } = await anvil.publicClient.simulateContract({
      address: prepares, abi: podJobsV2Abi, functionName: "post", args: [BigInt(MODES.flash.windowMinutes * 60), 1],
      value: PRICE + 3n * (await readWritingPrice(at)), account: poster.account,
    });
    await anvil.publicClient.waitForTransactionReceipt({ hash: await poster.writeContract(request) });
    const name = `a-coat-${crypto.randomUUID().slice(0, 8)}`;
    const setUp = await preparing.setUp({
      onChainId: `${onChainId}`, name, mode: "flash", salt: SALT, request: COAT_REQUEST, poster: poster.account.address,
      signature: await poster.signMessage({ account: poster.account, message: setUpMessage({ jobs: prepares, onChainId: `${onChainId}`, name, mode: "flash", salt: SALT }) }),
    });
    expect(setUp).toMatchObject({ ok: true });
    await preparing.whenIdle();

    const until = Math.floor(Date.now() / 1000) + 600;
    const statement = `Basic ${btoa(`${poster.account.address}:${until}.${await poster.signMessage({ account: poster.account, message: preparingMessage({ jobs: prepares, onChainId: `${onChainId}`, until }) })}`)}`;
    const read = await preparing.read(`${onChainId}`, statement);
    if (!read.ok) throw new Error(`the poster could not read their job: ${read.why}`);
    // what the poster's page reads is what was sent, the salt included, so the page can seal it again
    expect(preparingFromTheWire(PreparingOnTheWireSchema.parse(JSON.parse(JSON.stringify(preparingToTheWire(read.value)))))).toEqual(read.value);
    expect(read.value.salt).toBe(SALT);
    const [first] = read.value.writings;
    expect(first?.outcome.kind === "written" && first.outcome.ready).toBe(true);
    // the slots the worker grades in too, beside the jobs
    expect(await readdir(built.directory)).toContain(BOX_SLOTS_FOLDER);
  }, 300_000);

  test("after it, the doors still answer for a job on the old contract", async () => {
    const built = await input({ jobs: prepares, earlier: old, writer: anvil.wallet(WRITER) });
    const services = await servicesFor(built);
    const spec: Spec = { idea: "an old job, still open", mode: "flash", price: PRICE, checks: [], allowed: [], salt: SALT };
    const seal = await sealSpec(spec);
    const endsAt = (await anvil.publicClient.getBlock()).timestamp + 3600n;
    const onChainId = await post({ address: old, publicClient: anvil.publicClient, wallet: anvil.wallet(STRANGER) }, { seal, endsAt, reviewers: 1, price: PRICE });
    const opened = await openJob(built.store, { jobId: "an-old-job", seal, spec, endsAt: new Date(Number(endsAt) * 1000), seats: [] });
    await built.store.save({ ...opened, chain: { network: "monad-testnet", jobId: `${onChainId}`, jobs: old } });
    await built.store.saveSpec("an-old-job", spec);

    const listing = await services.jobList?.listing();
    expect(listing?.jobs.map((job) => job.jobId)).toContain("an-old-job");
  }, 120_000);

  test("a contract named in the wrong place, or twice, is refused when the server starts", async () => {
    const anotherFirst = await anvil.deploy("PodJobs", [privateKeyToAccount(VALIDATOR).address], DEPLOYER);
    await expect(servicesFor(await input({ jobs: anotherFirst, earlier: old, writer: anvil.wallet(WRITER) })))
      .rejects.toThrow("does not prepare jobs");
    // the new contract named with the old one forgotten would serve the old page against it
    await expect(servicesFor(await input({ jobs: prepares }))).rejects.toThrow("which prepares jobs: set POD_OLD_JOBS_ADDRESS");
    await expect(servicesFor(await input({ jobs: prepares, earlier: prepares, writer: anvil.wallet(WRITER) }))).rejects.toThrow("both name");
    const anotherPrepares = await anvil.deploy("PodJobsV2", [privateKeyToAccount(VALIDATOR).address, privateKeyToAccount(WRITER).address, 10n, WRITING, 100_000n], DEPLOYER);
    await expect(servicesFor(await input({ jobs: prepares, earlier: anotherPrepares, writer: anvil.wallet(WRITER) })))
      .rejects.toThrow("it has to be the first contract");
    await expect(servicesFor(await input({ jobs: prepares, earlier: "0x00000000000000000000000000000000000000e1", writer: anvil.wallet(WRITER) })))
      .rejects.toThrow("where there is no contract");
  });

  test("a contract that takes written checks from its validator is refused, so the validator's key never lives on the web server", async () => {
    const validator = privateKeyToAccount(VALIDATOR).address;
    const sharesItsKey = await anvil.deploy("PodJobsV2", [validator, validator, 10n, WRITING, 100_000n], DEPLOYER);
    await expect(servicesFor(await input({ jobs: sharesItsKey, earlier: old, writer: anvil.wallet(VALIDATOR) })))
      .rejects.toThrow("takes written checks from its validator");
  });

  test("a writer key the contract does not take checks from is refused when the server starts", async () => {
    const notTheWriter: Hex = STRANGER;
    await expect(servicesFor(await input({ jobs: prepares, earlier: old, writer: anvil.wallet(notTheWriter) })))
      .rejects.toThrow(`takes written checks only from ${privateKeyToAccount(WRITER).address}`);
  });

  test("with no writer key at all, it says which setting is missing", async () => {
    await expect(servicesFor(await input({ jobs: prepares, earlier: old }))).rejects.toThrow("POD_WRITER_KEY is not set");
  });
});
