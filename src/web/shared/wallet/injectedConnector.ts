import type { Config, Connector } from "wagmi";
import { NoWallet } from "./NoWallet.ts";

/** The browser's own wallet: the one connector `walletConfig` gives this page. */
export function injectedConnector(config: Config): Connector {
  const connector = config.connectors[0];
  if (!connector) throw new NoWallet();
  return connector;
}

/** Whether this browser has a wallet in it at all. */
export async function hasWalletInTheBrowser(config: Config): Promise<boolean> {
  return Boolean(await injectedConnector(config).getProvider());
}
