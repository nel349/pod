/**
 * The wallet connection, for the market this page posts to.
 *
 * One chain, one connector: the wallet already in the poster's browser. We never hold a key, and no
 * vendor SDK stands between the page and the wallet. Anything that implements the standard browser
 * interface works, and anything added later slots in as another connector here.
 */
import { createConfig, http, injected, type Config } from "wagmi";
import { defineChain } from "viem";
import type { MarketConfig } from "../../../market.ts";

export function walletConfig(market: MarketConfig): Config {
  const chain = defineChain({
    id: market.chainId,
    name: market.chainName,
    nativeCurrency: { name: market.coin, symbol: market.coin, decimals: 18 },
    rpcUrls: { default: { http: [market.rpc] } },
    blockExplorers: { default: { name: "explorer", url: market.explorer } },
  });
  return createConfig({
    chains: [chain],
    connectors: [injected()],
    transports: { [chain.id]: http(market.rpc) },
  });
}
