/**
 * The reference agent's one key, and everything it signs with it.
 *
 * One key, one identity: the key that takes the seat is the one that signs into the git door, signs
 * the notes and approves on the contract, so nothing can be claimed as one agent and done as another.
 * The key stays in this process. Nothing it signs contains it, and nothing here ever prints it.
 */
import { createPublicClient, createWalletClient, defineChain, http, toHex, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { branchFor } from "../door/seat.ts";
import { MOST_A_STATEMENT_MAY_LAST_SECONDS } from "../door/credentials.ts";
import type { Role } from "../job.ts";
import { approve, podJobsAbi, readJob, readSeats, takeSeat, type HeldSeat, type OnChainJob } from "../jobs.ts";
import type { MarketConfig } from "../market.ts";
import { doorMessage, noteMessage } from "../messages.ts";
import { requestValidation, type Registries } from "../registry.ts";
import { commitToBytes32 } from "../repo.ts";
import { secondsNow } from "../clock.ts";

/** A job as the agent names it: by its name on the wall and its number on the contract. */
export interface JobRef {
  readonly jobId: string;
  readonly onChainId: bigint;
}

/** How long each statement the agent signs for the git door is good for: well inside what the door allows */
const A_STATEMENT_LASTS_SECONDS = Math.min(10 * 60, MOST_A_STATEMENT_MAY_LAST_SECONDS);

export class Identity {
  private readonly account: PrivateKeyAccount;
  private readonly publicClient: PublicClient;
  private readonly wallet: WalletClient;
  readonly jobs: Address;
  /** where to ask for verdicts to be recorded, if the server says */
  readonly registries?: Registries;

  /**
   * @param owner who is behind the agent, for the contract's one-owner-to-a-job rule. Most people
   *              are both, so it is the agent's own address unless it is given
   */
  constructor(key: Hex, market: MarketConfig, readonly owner?: Address) {
    this.account = privateKeyToAccount(key);
    const chain = defineChain({
      id: market.chainId, name: market.chainName,
      nativeCurrency: { name: market.coin, symbol: market.coin, decimals: 18 },
      rpcUrls: { default: { http: [market.rpc] } },
    });
    this.publicClient = createPublicClient({ chain, transport: http() }) as PublicClient;
    this.wallet = createWalletClient({ account: this.account, chain, transport: http() });
    this.jobs = market.jobs;
    if (market.registries) this.registries = market.registries;
  }

  get address(): Address {
    return this.account.address;
  }

  get ownerAddress(): Address {
    return this.owner ?? this.account.address;
  }

  /** The git door's password: the seat, when the statement runs out, and the signature over it. */
  async doorPassword(job: JobRef, role: Role): Promise<string> {
    const until = secondsNow() + A_STATEMENT_LASTS_SECONDS;
    const signature = await this.account.signMessage({
      message: doorMessage({ jobId: job.jobId, onChainId: String(job.onChainId), jobs: this.jobs, role, branch: branchFor(role, this.address), until }),
    });
    return `${role}.${until}.${signature}`;
  }

  /** A note, signed, ready to send. */
  async note(job: JobRef, role: Role, says: string, about?: string): Promise<{
    readonly agent: Address; readonly role: Role; readonly about?: string; readonly says: string; readonly at: number; readonly signature: Hex;
  }> {
    const at = secondsNow();
    const signature = await this.account.signMessage({
      message: noteMessage({ jobId: job.jobId, onChainId: String(job.onChainId), jobs: this.jobs, role, about, says, at }),
    });
    return { agent: this.address, role, ...(about === undefined ? {} : { about }), says, at, signature };
  }

  private get contract(): { readonly address: Address; readonly publicClient: PublicClient; readonly wallet: WalletClient } {
    return { address: this.jobs, publicClient: this.publicClient, wallet: this.wallet };
  }

  takeSeat(job: JobRef, role: Role): Promise<Hex> {
    return takeSeat(this.contract, job.onChainId, role, this.ownerAddress);
  }

  approve(job: JobRef, role: Role, commit: string): Promise<Hex> {
    return approve(this.contract, job.onChainId, role, commitToBytes32(commit));
  }

  readJob(job: JobRef): Promise<OnChainJob> {
    return readJob(this.contract, job.onChainId);
  }

  readSeats(job: JobRef): Promise<readonly HeldSeat[]> {
    return readSeats(this.contract, job.onChainId);
  }

  /**
   * Ask the registry to record the verdict on this agent's seat: one request, naming the key the
   * contract takes verdicts from, pointing at the job's receipt. The agent's own act, with its own
   * key, which must own the identity or have been approved for it by the owner. The request's key is
   * fresh and random, so nobody can use it first and block the ask.
   */
  async askForMyVerdict(agentId: bigint, receiptLink: string): Promise<Hex> {
    if (!this.registries) throw new Error("the server names no ERC-8004 registries to ask");
    const runner = await this.publicClient.readContract({ address: this.jobs, abi: podJobsAbi, functionName: "validator" });
    const key = toHex(crypto.getRandomValues(new Uint8Array(32)));
    return requestValidation({ publicClient: this.publicClient, wallet: this.wallet }, { runner, agentId, evidenceURI: receiptLink, key }, this.registries);
  }

  /** The chain's own clock, which is what the job's window is measured by. */
  async now(): Promise<bigint> {
    return (await this.publicClient.getBlock()).timestamp;
  }
}
