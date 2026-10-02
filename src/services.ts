/**
 * What the server opens beyond the wall, built from what it is told about the chain.
 *
 * Until the switch-over, POD_JOBS_ADDRESS is the first contract and nothing is prepared. After it,
 * POD_JOBS_ADDRESS is the contract that prepares jobs and POD_OLD_JOBS_ADDRESS the first one, whose
 * jobs the doors still answer for. The server then prepares jobs: it writes their checks with the
 * writer's key, and only that key; the validator's never lives here.
 *
 * Everything that can be wrong with the settings is found when the server starts, with a sentence: a
 * contract that does not prepare jobs, or a writer key the contract does not answer to.
 */
import { join } from "node:path";
import { isAddress, type Account, type Address, type Chain, type PublicClient, type Transport, type WalletClient } from "viem";
import { agentFactsFrom } from "./agentFacts.ts";
import { CheckWriting, ProvenChecks, type CheckWriter } from "./checkwriting/index.ts";
import { Claims } from "./claims.ts";
import { BoxSlots } from "./docker/index.ts";
import { CreditBook, CreditDoor, doorChainFor, Doorkeeper, GitDoor, JobList, NoteBoard, type DoorChain } from "./door/index.ts";
import { BOX_SLOTS_FOLDER, CREDIT_FOLDER, PREPARING_FOLDER, PROVEN_FOLDER, REPOSITORIES_FOLDER } from "./folders.ts";
import { holderOf } from "./handover.ts";
import { readJob, readJobCount, readSeats, readTerms, readValidator } from "./jobs.ts";
import { readJobV2, readWritingMoney, readWritingPrice, readWritingsIncluded, WriterKey } from "./jobsV2.ts";
import type { MarketConfig } from "./market.ts";
import { ownersFrom, type OwnedContract } from "./owners.ts";
import { readerFor, type ChainReader } from "./posting.ts";
import { Preparing, PreparingStore } from "./preparing/index.ts";
import { confirmTheContracts, JOBS_ADDRESS_SETTING } from "./contracts.ts";
import { OLD_JOBS_SETTING, WRITER_KEY_SETTING } from "./live.ts";
import type { Registries } from "./registry.ts";
import type { Market, Services } from "./server.ts";
import type { JobStore } from "./store.ts";

export { JOBS_ADDRESS_SETTING } from "./contracts.ts";
/** The setting naming the title contract */
export const TOKEN_ADDRESS_SETTING = "POD_TOKEN_ADDRESS";

export interface ServicesInput {
  readonly store: JobStore;
  /** the jobs folder: what lives beside the jobs, the repositories, the proven checks and the rest, is kept in it */
  readonly directory: string;
  readonly publicClient: PublicClient;
  /** what the page is told about the chain, beyond the contract it posts to */
  readonly page: Omit<MarketConfig, "jobs">;
  readonly registries: Registries;
  /** the contract new jobs are posted to */
  readonly jobs: Address;
  /** the contract jobs were posted to before, when `jobs` is the one that prepares them */
  readonly earlier?: Address;
  /** the title contract; without it nobody can claim anything here */
  readonly token?: Address;
  /** the writer's wallet, which a contract that prepares jobs needs, and no other */
  readonly writer?: WalletClient<Transport, Chain, Account>;
  readonly checkWriter: CheckWriter;
}

/** Every service, wired to the contracts it is given, after checking they are what they are said to be. */
export async function servicesFor(input: ServicesInput): Promise<Services> {
  const { store, directory, publicClient, jobs } = input;
  if (input.earlier && !input.writer) {
    throw new Error(`${WRITER_KEY_SETTING} is not set: the contract at ${jobs} prepares jobs, and their checks are written and signed with the writer's key`);
  }
  await confirmTheContracts({ publicClient, jobs, ...(input.earlier ? { earlier: input.earlier } : {}), ...(input.writer ? { writer: input.writer.account.address } : {}) });
  const contract = { address: jobs, publicClient };
  // one doorkeeper for both of an agent's doors, so a seat is the same seat at each
  const keeper = new Doorkeeper({
    store,
    chain: doorChainAt(jobs, publicClient),
    ...(input.earlier ? { earlier: [doorChainAt(input.earlier, publicClient)] } : {}),
  });
  const book = new CreditBook(join(directory, CREDIT_FOLDER));
  // beside the jobs, so a poster who paid can still publish after the server restarts
  const proven = new ProvenChecks(join(directory, PROVEN_FOLDER));
  const token = input.token ? { address: input.token, publicClient } : undefined;
  const preparing = input.earlier ? await preparingOn(input) : undefined;
  // the page shows what writing costs before the poster pays, so it is told here
  const writing = preparing
    ? { price: `${await readWritingPrice(contract)}`, included: await readWritingsIncluded(contract) }
    : undefined;
  const market: Market = {
    page: { ...input.page, jobs, ...(writing ? { writing } : {}) },
    chain: readerFor({ jobs, read: (id) => readJob(contract, id), now: async () => (await publicClient.getBlock()).timestamp }),
    ...(input.earlier ? { earlier: ownedAt(input.earlier, publicClient).reader } : {}),
    writing: new CheckWriting({ writer: input.checkWriter, proven }),
    proven,
  };
  return {
    market,
    door: new GitDoor({ repositories: join(directory, REPOSITORIES_FOLDER), keeper, credit: book }),
    notes: new NoteBoard({ keeper, store }),
    jobList: new JobList({ keeper, store }),
    credit: new CreditDoor({ book }),
    // who paid and who holds, on both contracts: old jobs keep their poster and their title holder (R12)
    owners: ownersFrom({
      contracts: [{ ...ownedAt(jobs, publicClient), prepares: preparing !== undefined }, ...(input.earlier ? [ownedAt(input.earlier, publicClient)] : [])],
      ...(token ? { holder: (tokenId: bigint) => holderOf(token, tokenId) } : {}),
    }),
    agents: agentFactsFrom({ client: publicClient, registries: input.registries, validator: () => readValidator(contract), credit: book }),
    ...(token ? { claims: new Claims({ store, token }) } : {}),
    ...(preparing ? { preparing } : {}),
  };
}

/** The services the settings describe, or none, when no contract is named and the wall is only read. */
export async function servicesFromTheEnvironment(
  store: JobStore,
  directory: string,
  environment: Record<string, string | undefined> = process.env,
): Promise<Services> {
  const jobs = addressSetting(environment, JOBS_ADDRESS_SETTING);
  if (!jobs) return {};
  const earlier = addressSetting(environment, OLD_JOBS_SETTING);
  const tokenAddress = addressSetting(environment, TOKEN_ADDRESS_SETTING);
  const { monadClient, writerWallet } = await import("./live.ts");
  const { MONAD_REGISTRIES, MONAD_TESTNET } = await import("./registry.ts");
  const { claudeOnThisMachine } = await import("./broker.ts");
  const { IMAGE } = await import("./sandbox.ts");
  const rpc = environment.MONAD_TESTNET_RPC ?? MONAD_TESTNET.rpc;
  return servicesFor({
    store, directory, jobs,
    publicClient: monadClient(rpc),
    page: { chainId: MONAD_TESTNET.id, chainName: "Monad testnet", rpc, explorer: "https://testnet.monadscan.com", coin: MONAD_TESTNET.coin, registries: MONAD_REGISTRIES },
    registries: MONAD_REGISTRIES,
    ...(earlier ? { earlier, writer: writerWallet(environment) } : {}),
    ...(tokenAddress ? { token: tokenAddress } : {}),
    checkWriter: { model: claudeOnThisMachine(), image: IMAGE, agents: new URL("../agents", import.meta.url).pathname },
  });
}

/**
 * The service that prepares jobs on the contract that does, once the contract says it prepares jobs
 * and answers to this writer. Writings left unsettled or under way when the server last stopped are
 * picked up before it answers anybody.
 */
async function preparingOn(input: ServicesInput): Promise<Preparing> {
  // confirmTheContracts has checked the writer against the contract; servicesFor refused a missing one
  const { publicClient, jobs, writer } = input;
  const at = { address: jobs, publicClient };
  if (!writer) throw new Error(`${WRITER_KEY_SETTING} is not set`);
  const preparing = new Preparing({
    store: new PreparingStore(join(input.directory, PREPARING_FOLDER)),
    wall: input.store,
    chain: {
      jobs,
      job: (id) => readJobV2(at, id),
      money: (id) => readWritingMoney(at, id),
      writingPrice: () => readWritingPrice(at),
    },
    writer: new WriterKey({ ...at, wallet: writer }),
    checkWriter: input.checkWriter,
    // the worker grades in the same slots, so writing and grading together never run more boxes than the machine has
    boxes: new BoxSlots(join(input.directory, BOX_SLOTS_FOLDER)),
  });
  await preparing.recover();
  return preparing;
}

/** A contract, read the way owners need it. */
function ownedAt(jobs: Address, publicClient: PublicClient): OwnedContract & { readonly reader: ChainReader } {
  const at = { address: jobs, publicClient };
  const reader = readerFor({ jobs, read: (id) => readJob(at, id), now: async () => (await publicClient.getBlock()).timestamp });
  return { jobs, job: reader.job, count: () => readJobCount(at), reader };
}

/** A contract, read the way the doors need it. */
function doorChainAt(jobs: Address, publicClient: PublicClient): DoorChain {
  const at = { address: jobs, publicClient };
  return doorChainFor({
    jobs,
    readJob: (id) => readJob(at, id),
    readSeats: (id) => readSeats(at, id),
    readTerms: (id) => readTerms(at, id),
    latestBlockTime: async () => (await publicClient.getBlock()).timestamp,
  });
}

/** An address setting, or nothing when it is not set; set to something else, it is refused with its name. */
function addressSetting(environment: Record<string, string | undefined>, name: string): Address | undefined {
  const value = environment[name];
  if (!value) return undefined;
  if (!isAddress(value)) throw new Error(`${name} is not an address: ${value}`);
  return value;
}
