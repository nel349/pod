import type { Config } from "wagmi";
import { getPublicClient } from "wagmi/actions";
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
