import { useEffect, useState, type ReactElement } from "react";
import { formatEther } from "viem";
import { useBalance, useConfig, useConnect, useConnection, useSwitchChain } from "wagmi";
import { firstLine } from "../../errors.ts";
import type { MarketConfig } from "../../market.ts";
import { ChooseAccount } from "./ChooseAccount.tsx";
import { ConnectPanel } from "./ConnectPanel.tsx";
import { CHROME, shortAddress } from "./copy.ts";
import { PasskeyDetails } from "./PasskeyDetails.tsx";
import { useBrowserWalletPresent } from "./useWalletPresent.ts";
import { injectedConnector, PASSKEY_CONNECTOR_ID, usePasskeyWallet } from "./wallet/index.ts";

/** Who is connected through a browser wallet, and the way to pick another of the person's accounts. */
function ConnectedAs({ address }: { readonly address: string }): ReactElement {
  return (
    <>
      <span className="who" title={address}><span className="as">{CHROME.wallet.connectedAs} </span>{shortAddress(address)}</span>
      <ChooseAccount label={CHROME.wallet.change} className="change" />
    </>
  );
}

/** The panel open or not, and closed by Escape as a person expects of anything that pops over the page. */
function usePanel(): { readonly isOpen: boolean; readonly toggle: () => void; readonly close: () => void } {
  const [isOpen, setOpen] = useState(false);
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent): void => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen]);
  return { isOpen, toggle: () => setOpen((was) => !was), close: () => setOpen(false) };
}

/** A passkey wallet open in this tab: its address, and a panel for what it holds, its phrase, and locking it. */
function PasskeyConnected({ address, market }: { readonly address: `0x${string}`; readonly market: MarketConfig }): ReactElement {
  const panel = usePanel();
  const passkey = usePasskeyWallet();
  const balance = useBalance({ address, query: { refetchInterval: panel.isOpen ? 5000 : false } });
  return (
    <>
      <span className="who passkey" title={address}><span className="as">{CHROME.wallet.passkey.badge} </span>{shortAddress(address)}</span>
      <button type="button" id="wallet-details" className="change" aria-expanded={panel.isOpen} aria-controls="wallet-panel"
        aria-label={CHROME.wallet.passkey.detailsLabel} onClick={panel.toggle}>
        {CHROME.wallet.passkey.details}
      </button>
      {panel.isOpen && (
        <PasskeyDetails
          view={{
            address,
            holds: balance.data ? CHROME.wallet.passkey.holds(`${formatEther(balance.data.value)} ${market.coin}`) : undefined,
            isEmpty: balance.data?.value === 0n,
            faucet: market.faucet,
            phrase: passkey.phrase,
            isBusy: passkey.isBusy,
          }}
          on={{ showPhrase: passkey.readPhrase, hidePhrase: passkey.hidePhrase, lock: () => { panel.close(); passkey.signOut(); }, close: panel.close }}
        />
      )}
    </>
  );
}

/** Nothing connected: the button that opens the two ways to connect. */
function Connect(): ReactElement {
  const config = useConfig();
  const panel = usePanel();
  const passkey = usePasskeyWallet();
  const hasBrowserWallet = useBrowserWalletPresent();
  const connect = useConnect();
  const connection = useConnection();
  const isBusy = passkey.isBusy || connect.isPending || connection.status === "connecting" || connection.status === "reconnecting";
  return (
    <>
      <button type="button" id="connect-wallet" aria-expanded={panel.isOpen} aria-controls="wallet-panel" onClick={panel.toggle}>
        {isBusy ? CHROME.wallet.connecting : CHROME.wallet.connect}
      </button>
      {connect.error && <span className="wrong" role="status">{CHROME.wallet.failed}: {firstLine(connect.error)}</span>}
      {panel.isOpen && (
        <ConnectPanel
          choices={{
            canUsePasskeys: passkey.isPossible, isPasskeyRemembered: passkey.isRemembered, hasBrowserWallet, isBusy, problem: passkey.problem,
          }}
          on={{
            makePasskeyWallet: passkey.make,
            openPasskeyWallet: passkey.openAgain,
            useBrowserWallet: () => { panel.close(); connect.mutate({ connector: injectedConnector(config) }); },
            close: panel.close,
          }}
        />
      )}
    </>
  );
}

/**
 * The wallet, in the header: whether one is connected, which kind, as whom, and on which chain, with
 * the one thing to do about it. Connecting here is only connecting: nothing is signed or paid from the
 * header, and the recovery phrase is shown only after its own passkey prompt.
 */
export function WalletStatus({ market }: { readonly market: MarketConfig }): ReactElement {
  const connection = useConnection();
  const switchChain = useSwitchChain();

  if (connection.status === "connected") {
    if (connection.connector.id === PASSKEY_CONNECTOR_ID) return <PasskeyConnected address={connection.address} market={market} />;
    if (connection.chainId !== market.chainId) {
      return (
        <button type="button" className="wrong" onClick={() => switchChain.mutate({ chainId: market.chainId })}>
          {CHROME.wallet.wrongChain(market.chainName)}
        </button>
      );
    }
    return <ConnectedAs address={connection.address} />;
  }
  return <Connect />;
}
