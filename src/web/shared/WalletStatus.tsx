import type { ReactElement } from "react";
import { useConnect, useConnection, useConnectors, useSwitchChain } from "wagmi";
import { firstLine } from "../../errors.ts";
import type { MarketConfig } from "../../market.ts";
import { useWalletPresent } from "../post/hooks/index.ts";
import { CHROME, shortAddress } from "./copy.ts";

/**
 * The wallet, in the header: whether this browser has one, whether it is connected, as whom, and on
 * which chain, with the one thing to do about it. Connecting here is only connecting: nothing is
 * signed or paid from the header.
 */
export function WalletStatus({ market }: { readonly market: MarketConfig }): ReactElement {
  const hasWallet = useWalletPresent();
  const connection = useConnection();
  const connectors = useConnectors();
  const connect = useConnect();
  const switchChain = useSwitchChain();

  if (connection.status === "connected") {
    if (connection.chainId !== market.chainId) {
      return (
        <button type="button" className="wrong" onClick={() => switchChain.mutate({ chainId: market.chainId })}>
          {CHROME.wallet.wrongChain(market.chainName)}
        </button>
      );
    }
    return <span className="who" title={connection.address}>{CHROME.wallet.connectedAs(shortAddress(connection.address))}</span>;
  }
  if (!hasWallet) return <span className="none">{CHROME.wallet.none}</span>;
  const connector = connectors[0];
  const busy = connection.status === "connecting" || connection.status === "reconnecting" || connect.isPending;
  return (
    <>
      <button type="button" disabled={busy || !connector} onClick={() => connector && connect.mutate({ connector })}>
        {busy ? CHROME.wallet.connecting : CHROME.wallet.connect}
      </button>
      {connect.error && <span className="wrong" role="status">{CHROME.wallet.failed}: {firstLine(connect.error)}</span>}
    </>
  );
}
