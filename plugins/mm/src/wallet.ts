/**
 * MetaMask's wallet, as a seat on a pod uses it: its address, a sentence signed, a call sent.
 *
 * Nothing here holds a key. A call is handed to MetaMask, which checks it against the wallet's limits,
 * asks its owner where it falls outside them, signs and broadcasts. What comes back is read through a
 * schema, and a call is only said to have happened once the chain itself says so.
 */
import { CommandError, type CommandIO, type PluginCommandContext } from "@metamask/agent-wallet/plugin";
import { createPublicClient, getAddress, http, isAddress, isHex, type Address, type Hex, type PublicClient } from "viem";
import { z } from "zod";
import type { MarketConfig } from "../../../src/market.ts";
import { inWords } from "./inputs.ts";
import { startPassThrough, type PassThrough } from "./passThrough.ts";

/** the setting MetaMask's tool reads for where it asks the chain its questions */
const CHAIN_READING_SETTING = "MM_INFURA_RPC_BASE_URL";

const AddressSchema = z.string().refine((value) => isAddress(value, { strict: false }), "not an address").transform((value) => getAddress(value));
const HexSchema = z.custom<Hex>((value) => typeof value === "string" && isHex(value), "not hex");

/** the tool's own record of its wallets, as far as finding the one in use needs it */
const WalletsSchema = z.object({
  byokWallets: z.array(z.object({ id: z.string().optional(), address: AddressSchema })).default([]),
  remoteWallets: z.array(z.object({ address: AddressSchema })).default([]),
  selectedWallet: z.object({ ref: z.object({ address: AddressSchema.optional(), id: z.string().optional() }) }).optional(),
});

/** what MetaMask answers a request with, as far as a seat needs it */
const AnsweredSchema = z.object({
  status: z.string(),
  hash: HexSchema.optional(),
  signature: HexSchema.optional(),
  failureDescription: z.string().optional(),
});

/** A call to a contract, before anybody has signed it. */
export interface Call {
  readonly to: Address;
  readonly data: Hex;
  readonly value?: bigint;
}

/** What the wallet is asked, in the shapes its own commands ask in. */
type Asked =
  | { readonly kind: "transaction"; readonly chainId: number; readonly transaction: Call }
  | { readonly kind: "message"; readonly chainId: number; readonly message: string };

/** the statuses that mean MetaMask sent the call to the chain */
const SENT = ["CONFIRMED", "SUBMITTED", "BROADCASTED"] as const;
const SIGNED = ["SIGNED", "CONFIRMED", "APPROVED"] as const;

export class MetaMaskWallet {
  /** the chain, read at its own endpoint: what the plugin asks, it asks there */
  readonly reads: PublicClient;

  constructor(
    private readonly ctx: PluginCommandContext,
    private readonly io: CommandIO,
    private readonly commandId: string,
    private readonly market: MarketConfig,
  ) {
    this.reads = createPublicClient({ transport: http(market.rpc) });
  }

  /** The wallet in use: the one selected, or the only one there is. */
  address(): Address {
    const known = WalletsSchema.safeParse(this.ctx.walletStateManager.read());
    if (!known.success) throw new CommandError("NO_WALLET", "MetaMask's tool has no wallet set up.", "Run `mm init` first.");
    const { byokWallets, remoteWallets, selectedWallet } = known.data;
    const selected = selectedWallet?.ref.address ?? byokWallets.find((wallet) => wallet.id !== undefined && wallet.id === selectedWallet?.ref.id)?.address;
    const address = selected ?? [...remoteWallets, ...byokWallets][0]?.address;
    if (!address) throw new CommandError("NO_WALLET", "MetaMask's tool has no wallet set up.", "Run `mm init` first.");
    return address;
  }

  /** A sentence, signed by the wallet as any wallet signs one (EIP-191). */
  async sign(message: string): Promise<Hex> {
    const answered = await this.ask({ kind: "message", chainId: this.market.chainId, message });
    if (!SIGNED.some((status) => status === answered.status) || !answered.signature) {
      throw new CommandError("NOT_SIGNED", `MetaMask did not sign it: ${answered.failureDescription ?? answered.status}.`, "Run `mm wallet requests list` to see what it is waiting for.");
    }
    return answered.signature;
  }

  /** A call, sent by the wallet and waited for until the chain has taken it or refused it. */
  async send(call: Call): Promise<Hex> {
    const standIn = await this.standInIfMetaMaskCannotRead();
    let answered;
    try {
      answered = await this.ask({ kind: "transaction", chainId: this.market.chainId, transaction: call });
    } finally {
      await standIn?.stop();
    }
    if (!SENT.some((status) => status === answered.status) || !answered.hash) {
      throw new CommandError("NOT_SENT", `MetaMask did not send it: ${answered.failureDescription ?? answered.status}.`, "A call outside the wallet's limits waits for its owner: `mm wallet requests list` shows it, and it lapses if it is not approved in time.");
    }
    const receipt = await this.reads.waitForTransactionReceipt({ hash: answered.hash });
    if (receipt.status !== "success") throw new CommandError("REFUSED_BY_THE_CHAIN", `The chain refused ${answered.hash}, so nothing changed.`, "Read the job again and see what has changed since.");
    return answered.hash;
  }

  private async ask(asked: Asked): Promise<z.infer<typeof AnsweredSchema>> {
    try {
      const executor: (asked: Asked, options: { readonly signal?: AbortSignal }) => Promise<unknown> = await this.ctx.walletExecutor(this.io, this.commandId);
      return AnsweredSchema.parse(await executor(asked, { signal: this.io.signal }));
    } catch (error) {
      if (error instanceof CommandError) throw error;
      throw new CommandError("WALLET_ERROR", `MetaMask's wallet did not take it: ${inWords(error)}.`, "`mm wallet balance` shows what the wallet holds, and `mm doctor` whether the tool is signed in and set up.");
    }
  }

  /**
   * Where MetaMask's own service cannot read this chain, the chain's endpoint stands in for it while
   * one call is prepared (see passThrough.ts). Where it can, nothing is changed.
   */
  private async standInIfMetaMaskCannotRead(): Promise<PassThrough | undefined> {
    try {
      await this.ctx.publicClient(this.market.chainId).getBlockNumber();
      return undefined;
    } catch {
      const before = process.env[CHAIN_READING_SETTING];
      const standIn = await startPassThrough(this.market.rpc);
      process.env[CHAIN_READING_SETTING] = standIn.base;
      return {
        base: standIn.base,
        stop: async () => {
          if (before === undefined) delete process.env[CHAIN_READING_SETTING];
          else process.env[CHAIN_READING_SETTING] = before;
          await standIn.stop();
        },
      };
    }
  }
}
