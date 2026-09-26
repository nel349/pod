import type { Address } from "viem";
import { useConnection } from "wagmi";

/** The wallet account this page is connected to, if it is. */
export function useConnectedAccount(): Address | undefined {
  const connection = useConnection();
  return connection.status === "connected" ? connection.address : undefined;
}
