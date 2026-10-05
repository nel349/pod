import type { Address } from "viem";
import type { Config } from "wagmi";
import { getConnection } from "wagmi/actions";
import { openWallet } from "./wallet/index.ts";

/** The wallet's current account, opening the wallet first if none is connected yet. */
export async function connected(config: Config): Promise<Address> {
  const connection = getConnection(config);
  if (connection.status === "connected") return connection.address;
  return openWallet(config);
}
