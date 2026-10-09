import type { Config } from "wagmi";
import { getPublicClient } from "wagmi/actions";
import { encodeFunctionData, type Abi, type Address, type Hex } from "viem";
import { gasAskedPlainly, type CallToPrice } from "../../gas.ts";

/**
 * The gas a page states for a call it is about to hand a wallet, asked of the call alone.
 *
 * Left unsaid, the wallet asks the node itself, with the fee stated, and for a call that pays its
 * caller Monad's node answers with many times what the call needs and then holds all of it back
 * (see gas.ts). A wallet uses the gas it is given, so the page gives it.
 */
export async function gasToState(config: Config, chainId: number, call: CallToPrice): Promise<bigint> {
  const reads = getPublicClient(config, { chainId });
  if (!reads) throw new Error("this page cannot read the chain it is sending to");
  return gasAskedPlainly(reads, call);
}

/** A call to a contract as simulating it hands it back, as far as pricing it needs. */
interface Simulated {
  readonly account?: Address | { readonly address: Address } | null | undefined;
  readonly address: Address;
  readonly abi: Abi;
  readonly functionName: string;
  readonly args?: readonly unknown[] | undefined;
  readonly value?: bigint | undefined;
  readonly chainId?: number | undefined;
}

/**
 * A simulated call with its gas stated, ready to hand to the wallet. One place for it, because every
 * call a page sends that pays its sender needs it: an approval, a take-back, a reclaim, a withdrawal.
 */
export async function withStatedGas<request extends Simulated>(config: Config, chainId: number, request: request): Promise<request & { readonly gas: bigint }> {
  const account = typeof request.account === "string" ? request.account : request.account?.address;
  if (!account) throw new Error("a call has to say who sends it before its gas can be asked");
  const data: Hex = encodeFunctionData({ abi: request.abi, functionName: request.functionName, args: request.args ?? [] });
  return { ...request, gas: await gasToState(config, chainId, { account, to: request.address, data, value: request.value }) };
}
