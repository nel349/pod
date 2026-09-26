import { useConnection } from "wagmi";

/**
 * Whether an address is the wallet connected in this browser. Only for what is drawn inside
 * `InTheBrowser`, which is where there is a wallet to ask.
 */
export function useIsViewer(): (address: string | undefined) => boolean {
  const connection = useConnection();
  const viewer = connection.status === "connected" ? connection.address.toLowerCase() : undefined;
  return (address) => viewer !== undefined && address !== undefined && address.toLowerCase() === viewer;
}
