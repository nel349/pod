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
import { createPublicClient, createWalletClient, defineChain, type Address, type Hex, type PublicClient } from "viem";
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

export interface Deployment {
  readonly rpc: string;
  readonly jobs: Address;
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
  return {
    rpc: environment.MONAD_TESTNET_RPC ?? MONAD_TESTNET.rpc,
    jobs: required(environment, "POD_JOBS_ADDRESS", ADDRESS, "the PodJobs contract's address") as Address,
    token: required(environment, "POD_TOKEN_ADDRESS", ADDRESS, "the PodToken contract's address") as Address,
    validator: required(environment, "POD_VALIDATOR_ADDRESS", ADDRESS, "the address verdicts come from") as Address,
  };
}

export interface LiveContracts {
  readonly jobs: Contract;
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
    token: { address: where.token, publicClient, wallet },
    publicClient,
    validator: where.validator,
  };
}
