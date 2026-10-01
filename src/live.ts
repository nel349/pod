/**
 * The deployment, read from the environment rather than written into the code.
 *
 * An address in a source file is an address somebody will forget to change. These come from the
 * `.env` the deploy script writes, and every one of them is checked here rather than where it is
 * used, so a misconfigured runner fails at the start with a sentence instead of halfway through a
 * job with a revert.
 *
 * Keys never leave this file: what the rest of the project gets is a client that can sign, not the
 * material it signs with.
 */
import { createPublicClient, createWalletClient, defineChain, type Account, type Address, type Chain, type Hex, type PublicClient, type Transport, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet as viemMonadTestnet } from "viem/chains";
import { MONAD_TESTNET } from "./registry.ts";
import { politeHttp } from "./rpc.ts";
import type { Contract } from "./jobs.ts";

export const monadTestnet = defineChain({
  id: MONAD_TESTNET.id,
  name: "Monad testnet",
  nativeCurrency: { name: "Monad", symbol: MONAD_TESTNET.coin, decimals: 18 },
  rpcUrls: { default: { http: [MONAD_TESTNET.rpc] } },
  // the contract that answers many reads in one request, where every chain keeps it (viem's own record of Monad's)
  contracts: { multicall3: viemMonadTestnet.contracts.multicall3 },
});

/**
 * A client of Monad testnet as everything that reads it a lot should use one: reads made at the same
 * moment go to the node as one request, and a request the node turns away for coming too fast is
 * asked again rather than failed. The public node allows fifteen a second from one address.
 */
export function monadClient(rpc: string): PublicClient {
  return createPublicClient({ chain: monadTestnet, transport: politeHttp(rpc), batch: { multicall: true } }) as PublicClient;
}

/**
 * The contract jobs were taken on before the contract that prepares them, set once that one replaces
 * it. Its jobs are still read, graded and answered for; nothing new is posted to it. While it is not
 * set, POD_JOBS_ADDRESS is the first contract and nothing is prepared.
 */
export const OLD_JOBS_SETTING = "POD_OLD_JOBS_ADDRESS";
/** The key the checks are written and signed with, which only the server holds, never the validator's */
export const WRITER_KEY_SETTING = "POD_WRITER_KEY";

export interface Deployment {
  readonly rpc: string;
  /** the contract new jobs are posted to */
  readonly jobs: Address;
  /** the contract jobs were posted to before, when POD_JOBS_ADDRESS is the one that prepares them */
  readonly earlier?: Address;
  readonly token: Address;
  readonly validator: Address;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const KEY = /^0x[0-9a-fA-F]{64}$/;

function required(environment: Record<string, string | undefined>, name: string, shape: RegExp, what: string): string {
  const value = environment[name];
  if (!value) throw new Error(`${name} is not set. ${what}`);
  if (!shape.test(value)) throw new Error(`${name} does not look like ${what}`);
  return value;
}

/** What was deployed, and where. Throws with the missing name rather than carrying on without it. */
export function deployment(environment: Record<string, string | undefined> = process.env): Deployment {
  const earlier = environment[OLD_JOBS_SETTING]
    ? required(environment, OLD_JOBS_SETTING, ADDRESS, "the address of the contract jobs were posted to before") as Address
    : undefined;
  return {
    rpc: environment.MONAD_TESTNET_RPC ?? MONAD_TESTNET.rpc,
    jobs: required(environment, "POD_JOBS_ADDRESS", ADDRESS, "the PodJobs contract's address") as Address,
    ...(earlier ? { earlier } : {}),
    token: required(environment, "POD_TOKEN_ADDRESS", ADDRESS, "the PodToken contract's address") as Address,
    validator: required(environment, "POD_VALIDATOR_ADDRESS", ADDRESS, "the address verdicts come from") as Address,
  };
}

export interface LiveContracts {
  /** the contract new jobs are posted to */
  readonly jobs: Contract;
  /** the contract jobs were posted to before, still graded and read */
  readonly earlier?: Contract;
  readonly token: Contract;
  readonly publicClient: PublicClient;
  readonly validator: Address;
}

/**
 * The two contracts, ready to be written to by the validator.
 *
 * The key is read here and nowhere else. If the key does not match the validator the contracts were
 * deployed with, this says so now: the alternative is a settlement that reverts with the contract's
 * own error and a person wondering why.
 */
export function live(environment: Record<string, string | undefined> = process.env): LiveContracts {
  const where = deployment(environment);
  const key = required(environment, "POD_VALIDATOR_KEY", KEY, "the validator's private key") as Hex;
  const account = privateKeyToAccount(key);
  if (account.address.toLowerCase() !== where.validator.toLowerCase()) {
    throw new Error(
      `POD_VALIDATOR_KEY is the key for ${account.address}, but the contracts answer to ${where.validator}`,
    );
  }

  const publicClient = monadClient(where.rpc);
  const wallet = createWalletClient({ account, chain: monadTestnet, transport: politeHttp(where.rpc) });

  return {
    jobs: { address: where.jobs, publicClient, wallet },
    ...(where.earlier ? { earlier: { address: where.earlier, publicClient, wallet } } : {}),
    token: { address: where.token, publicClient, wallet },
    publicClient,
    validator: where.validator,
  };
}

/**
 * The writer's wallet, which reserves, keeps and releases the price of a writing and signs what was
 * written. Read here, like the validator's key; whether it is the key the contract answers to is
 * asked of the contract when the server starts.
 */
export function writerWallet(environment: Record<string, string | undefined> = process.env): WalletClient<Transport, Chain, Account> {
  const key = required(environment, WRITER_KEY_SETTING, KEY, "the writer's private key") as Hex;
  const rpc = environment.MONAD_TESTNET_RPC ?? MONAD_TESTNET.rpc;
  return createWalletClient({ account: privateKeyToAccount(key), chain: monadTestnet, transport: politeHttp(rpc) });
}
