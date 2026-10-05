/**
 * Opening a wallet when a page needs one and none is connected.
 *
 * The one used here last, if it can be opened; else the browser's own; else a passkey wallet made in
 * this browser before. Nothing of a passkey wallet is kept between pages, so opening it is its passkey
 * asked again, from the press that needed it.
 */
import type { Address } from "viem";
import type { Config, Connector } from "wagmi";
import { connect } from "wagmi/actions";
import { injectedConnector } from "./injectedConnector.ts";
import { NoWallet } from "./NoWallet.ts";
import { hasRememberedPasskey, heldPasskeyWallet, holdPasskeyWallet, openPasskeyWallet, PASSKEY_CONNECTOR_ID } from "./passkey/index.ts";

/** where wagmi keeps which wallet was connected last */
const LAST_CONNECTED_KEY = "recentConnectorId";

/** whether a passkey wallet is open in this tab, or one was made or opened in this browser before */
const hasPasskeyWallet = (): boolean => heldPasskeyWallet() !== undefined || hasRememberedPasskey();

/** Whether this page has a wallet it can use: one in the browser, or a passkey wallet it can open. */
export async function hasWalletInTheBrowser(config: Config): Promise<boolean> {
  return hasPasskeyWallet() || Boolean(await injectedConnector(config).getProvider());
}

/** The wallet to open: the passkey one if it was used last or is the only one, else the browser's. */
export async function walletToOpen(config: Config): Promise<Connector> {
  const passkey = config.connectors.find((one) => one.id === PASSKEY_CONNECTOR_ID);
  const hasBrowserWallet = Boolean(await injectedConnector(config).getProvider());
  if (passkey && hasPasskeyWallet()) {
    const usedLast = (await config.storage?.getItem(LAST_CONNECTED_KEY)) === PASSKEY_CONNECTOR_ID;
    if (usedLast || !hasBrowserWallet) return passkey;
  }
  if (hasBrowserWallet) return injectedConnector(config);
  throw new NoWallet();
}

/** Open the wallet to open, a passkey prompt for a passkey wallet, and connect it. */
export async function openWallet(config: Config): Promise<Address> {
  const connector = await walletToOpen(config);
  if (connector.id === PASSKEY_CONNECTOR_ID && !heldPasskeyWallet()) holdPasskeyWallet(await openPasskeyWallet());
  const [account] = (await connect(config, { connector })).accounts;
  if (!account) throw new Error("the wallet did not give an address");
  return account;
}
