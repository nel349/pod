import type { Address } from "viem";
import type { Config } from "wagmi";
import { connect, getConnection } from "wagmi/actions";
import { injectedConnector } from "../post/wallet/index.ts";

/** The wallet's current account, connecting first if it is not connected yet. */
export async function connected(config: Config): Promise<Address> {
  const connection = getConnection(config);
  if (connection.status === "connected") return connection.address;
  const [account] = (await connect(config, { connector: injectedConnector(config) })).accounts;
  if (!account) throw new Error("the wallet did not give an address");
  return account;
}
