/**
 * Sending a payment from the passkey wallet, through an endpoint that has to be allowed for.
 *
 * Monad's public endpoint refuses a payment from a wallet whose money it has not caught up with,
 * saying the signer is short, and then goes on refusing that wallet for minutes: one early ask is
 * enough, and waiting quietly afterwards does not clear it (measured, see MONAD_TESTNET.sending).
 * A person who presses Pay the moment their new wallet is funded, or before it is, was locked out of
 * their own money by it.
 *
 * So the wallet never asks early, and has a way round when the endpoint refuses all the same:
 *
 *   a wallet that cannot cover the payment is told so here, with what it holds, and the endpoint is
 *   never asked to send for it
 *   a wallet whose money has only just arrived waits until the endpoint will know it
 *   a payment the endpoint still refuses, from a wallet that holds the money, goes through the other
 *   endpoint. It is the same signed transaction, so it can be taken once and never twice
 *
 * Where the market names nothing to allow for, a payment is simply sent.
 */
import {
  createPublicClient, createWalletClient, formatEther, http,
  type Address, type Chain, type Hex, type LocalAccount, type SendTransactionParameters,
} from "viem";
import { firstLine } from "../../../../errors.ts";
import type { MarketConfig } from "../../../../market.ts";
import { sayTheWalletWaits } from "./waiting.ts";

/** What the market says its endpoint needs allowing for. */
export type Sending = NonNullable<MarketConfig["sending"]>;

/** A payment as a page asks for it, with whatever it left out still to be asked of the node. */
export type Asked = Pick<SendTransactionParameters, "to" | "data" | "value" | "gas" | "nonce" | "maxFeePerGas" | "maxPriorityFeePerGas">;

/**
 * What the endpoint says when it believes the signer cannot pay. It gives every refusal the same
 * code, so its words are the only thing that tells this one from the rest; viem tells nodes' refusals
 * apart the same way.
 */
const SAYS_THE_SIGNER_IS_SHORT = /insufficient balance/i;

/** The wallet does not hold what the payment takes, and was never sent to the endpoint to find that out. */
export class WalletIsShort extends Error {
  /** @param takes what the payment takes: with its gas when that is known, and before it when it is not */
  constructor(wallet: Address, holds: bigint, takes: { readonly amount: bigint; readonly isWithGas: boolean }, coin: string) {
    super(`this wallet, ${wallet}, holds ${formatEther(holds)} ${coin}, and this takes ${formatEther(takes.amount)} ${coin}${takes.isWithGas ? " with its gas" : ", and gas on top"}`);
  }
}

/** The wallet holds the money and the chain's endpoints refuse it all the same, for now. */
export class EndpointHasNotCaughtUp extends Error {
  constructor(chain: string) {
    super(`${chain} has not caught up with the money in this wallet and is refusing it for now. It clears within about ten minutes: press again then`);
  }
}

const wait = (seconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

/** Send what was asked as this signer, allowing for the endpoint where the market says to. */
export async function sendWithCare(signer: LocalAccount, chain: Chain, asked: Asked, sending: Sending | undefined): Promise<Hex> {
  const endpoint = http(chain.rpcUrls.default.http[0]);
  const wallet = createWalletClient({ account: signer, chain, transport: endpoint });
  if (!sending) return wallet.sendTransaction(asked);

  const reads = createPublicClient({ chain, transport: endpoint });
  const coin = chain.nativeCurrency.symbol;
  const holds = (): Promise<bigint> => reads.getBalance({ address: signer.address });
  try {
    // filling in what the page left out asks the node what it would cost, which sends nothing. A wallet
    // that cannot cover it is refused here, and is told so in its own terms
    const fill = (): ReturnType<typeof wallet.prepareTransactionRequest<Asked>> => wallet.prepareTransactionRequest(asked);
    let request;
    try {
      request = await fill();
    } catch (error) {
      if (!SAYS_THE_SIGNER_IS_SHORT.test(firstLine(error))) throw error;
      const value = asked.value ?? 0n;
      const now = await holds();
      if (now < value) throw new WalletIsShort(signer.address, now, { amount: value, isWithGas: false }, coin);
      // it holds the money and the node pricing the payment does not know yet: it is given its moment, once
      sayTheWalletWaits("settling");
      await wait(sending.settledAfterSeconds);
      request = await fill();
    }
    const takes = (request.value ?? 0n) + request.gas * (request.maxFeePerGas ?? request.gasPrice ?? 0n);
    await untilItsMoneyIsKnown(reads, signer.address, takes, sending, coin);

    const signed = await wallet.signTransaction(request);
    try {
      return await wallet.sendRawTransaction({ serializedTransaction: signed });
    } catch (refusal) {
      if (!SAYS_THE_SIGNER_IS_SHORT.test(firstLine(refusal))) throw refusal;
      const now = await holds();
      if (now < takes) throw new WalletIsShort(signer.address, now, { amount: takes, isWithGas: true }, coin);
      // it holds the money and is refused: the endpoint has not caught up, and will not for a while
      if (!sending.otherRpc) throw new EndpointHasNotCaughtUp(chain.name);
      sayTheWalletWaits("another way");
      await wait(sending.settledAfterSeconds);
      try {
        return await createWalletClient({ account: signer, chain, transport: http(sending.otherRpc) }).sendRawTransaction({ serializedTransaction: signed });
      } catch {
        throw new EndpointHasNotCaughtUp(chain.name);
      }
    }
  } finally {
    sayTheWalletWaits();
  }
}

/**
 * Wait, if the wallet's money has only just arrived, until the endpoint will know it. A wallet that
 * does not hold what the payment takes is told so, and nothing waits.
 *
 * Asked by what the wallet held a few blocks ago: if that already covered the payment there is
 * nothing to wait for, which is every payment but the first after money arrives.
 */
async function untilItsMoneyIsKnown(reads: ReturnType<typeof createPublicClient>, wallet: Address, takes: bigint, sending: Sending, coin: string): Promise<void> {
  const latest = await reads.getBlockNumber({ cacheTime: 0 });
  const blocks = BigInt(sending.settledAfterBlocks);
  const now = await reads.getBalance({ address: wallet, blockNumber: latest });
  if (now < takes) throw new WalletIsShort(wallet, now, { amount: takes, isWithGas: true }, coin);
  let before: bigint;
  try {
    before = await reads.getBalance({ address: wallet, blockNumber: latest > blocks ? latest - blocks : 0n });
  } catch {
    // an endpoint that will not say what was held earlier cannot say the money is new: nothing to wait for
    return;
  }
  if (before >= takes) return;
  sayTheWalletWaits("settling");
  await wait(sending.settledAfterSeconds);
}
