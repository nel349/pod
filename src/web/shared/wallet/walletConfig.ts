/**
 * The wallet connection, for the market this page posts to.
 *
 * One chain, two ways to sign: the wallet already in the person's browser, or a wallet made from their
 * passkey with Mera, whose key is worked out in the page and held nowhere else. We never hold a key,
 * and every page works with either.
 */
import { createConfig, http, injected, type Config } from "wagmi";
import { passkeyConnector } from "./passkey/index.ts";
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
    connectors: [injected(), passkeyConnector()],
    transports: { [chain.id]: http(market.rpc) },
  });
}
