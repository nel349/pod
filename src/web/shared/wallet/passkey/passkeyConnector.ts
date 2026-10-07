/**
 * The passkey wallet as a wagmi connector, beside the browser's own wallet: every page that pays,
 * signs, approves or takes money back works with either, unchanged.
 *
 * The key is in the page, so the wallet wagmi asks is in the page too (passkeyProvider.ts): it signs
 * with the held Mera account and reads through the node the market names. Connecting needs a wallet
 * opened first, by a passkey prompt the person chose to make; a reload connects nothing on its own.
 */
import { createConnector } from "wagmi";
import { SwitchChainError, type Address } from "viem";
import { endPasskeyWallet, heldPasskeyWallet } from "./held.ts";
import { passkeyProvider, type PasskeyProvider } from "./passkeyProvider.ts";
import type { Sending } from "./sending.ts";

/** the connector's name among wagmi's */
export const PASSKEY_CONNECTOR_ID = "pod-passkey";

/** Asked to connect before any passkey wallet was opened: the person opens one first. */
export class NoPasskeyWalletOpen extends Error {
  constructor() {
    super("open your passkey wallet first");
  }
}

/** @param sending what the chain's endpoint needs allowing for, when the market says it needs any */
export function passkeyConnector(sending?: Sending) {
  return createConnector<PasskeyProvider>((config) => {
    const chain = config.chains[0];
    const provider = passkeyProvider(chain, sending);
    const addressOfTheHeld = (): Address => {
      const held = heldPasskeyWallet();
      if (!held) throw new NoPasskeyWalletOpen();
      return held.account.address;
    };
    return {
      id: PASSKEY_CONNECTOR_ID,
      name: "Passkey",
      type: "passkey",
      async connect() {
        const address = addressOfTheHeld();
        return { accounts: [address] as never, chainId: chain.id };
      },
      async disconnect() {
        endPasskeyWallet();
      },
      async getAccounts() {
        const held = heldPasskeyWallet();
        return held ? [held.account.address] : [];
      },
      async getChainId() {
        return chain.id;
      },
      async getProvider() {
        return provider;
      },
      async isAuthorized() {
        return heldPasskeyWallet() !== undefined;
      },
      async switchChain({ chainId }) {
        // the one chain the market names; there is nothing else to switch to
        if (chainId !== chain.id) throw new SwitchChainError(new Error(`this wallet is for ${chain.name} only`));
        return chain;
      },
      onAccountsChanged() {},
      onChainChanged() {},
      onDisconnect() {
        config.emitter.emit("disconnect");
      },
    };
  });
}
