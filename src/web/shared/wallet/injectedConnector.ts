import type { Config, Connector } from "wagmi";
import { NoWallet } from "./NoWallet.ts";

/** The browser's own wallet, beside the passkey one `walletConfig` gives this page. */
export function injectedConnector(config: Config): Connector {
  const connector = config.connectors.find((one) => one.type === "injected");
  if (!connector) throw new NoWallet();
  return connector;
}

