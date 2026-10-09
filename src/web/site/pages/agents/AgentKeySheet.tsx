import { useState, type ReactElement } from "react";
import { formatEther, parseEther, type Address } from "viem";
import { useConnection } from "wagmi";
import type { MarketConfig } from "../../../../market.ts";
import { CHROME, PASSKEY_CONNECTOR_ID, usePasskeyWallet } from "../../../shared/index.ts";
import { SITE } from "../../copy.ts";
import { useAgentKey } from "../../hooks/index.ts";
import { AgentKey } from "./AgentKey.tsx";

/** what the page offers to send an agent's address: a deposit on a small job, and its gas */
const OFFERED_AMOUNT = "0.05";

/** The amount a person typed, when it is one that can be sent. */
function amountOf(typed: string): bigint | undefined {
  try {
    const amount = parseEther(typed.trim());
    return amount > 0n ? amount : undefined;
  } catch {
    return undefined;
  }
}

/** The key, with the person's passkey wallet open: every press here is theirs to make. */
function WithTheWalletOpen({ market, wallet }: { readonly market: MarketConfig; readonly wallet: Address }): ReactElement {
  const agent = useAgentKey(market, wallet);
  const [isKeyShown, setKeyShown] = useState(false);
  const [amount, setAmount] = useState(OFFERED_AMOUNT);
  const toSend = amountOf(amount);
  return (
    <AgentKey
      view={{
        number: agent.number,
        coin: market.coin,
        open: agent.open && {
          address: agent.open.address,
          holds: agent.holds === undefined ? undefined : `${formatEther(agent.holds)} ${market.coin}`,
          isEmpty: agent.holds === undefined || agent.holds === 0n,
          shown: isKeyShown ? agent.open.key : undefined,
        },
        amount,
        canFund: toSend !== undefined,
        isMaking: agent.isMaking,
        status: agent.status,
        problem: agent.problem,
      }}
      on={{
        make: agent.make,
        another: () => { setKeyShown(false); agent.another(); },
        before: () => { setKeyShown(false); agent.before(); },
        showKey: () => setKeyShown(true),
        hideKey: () => setKeyShown(false),
        setAmount,
        fund: () => { if (toSend !== undefined) agent.fund(toSend); },
        bringBack: agent.bringBack,
        forget: () => { setKeyShown(false); agent.forget(); },
      }}
    />
  );
}

/** No passkey wallet is open: the one press that opens the person's, or makes them one. */
function OpenTheWalletFirst(): ReactElement {
  const passkey = usePasskeyWallet();
  const words = SITE.agents.key;
  if (passkey.isPossible === false) return <p className="note">{CHROME.wallet.panel.unsupported}</p>;
  return (
    <div className="agent-key">
      <p className="note">{words.needsWallet}</p>
      <p className="actions">
        <button type="button" id="agent-open-wallet" className="primary small" disabled={passkey.isBusy}
          onClick={passkey.isRemembered ? passkey.openAgain : passkey.make}>
          {passkey.isRemembered ? CHROME.wallet.panel.open : CHROME.wallet.panel.make}
        </button>
      </p>
      {passkey.problem && (
        <p className="note wrong" role="status">
          {passkey.problem.kind === "cancelled" ? CHROME.wallet.panel.cancelled : CHROME.wallet.panel.failed(passkey.problem.why)}
        </p>
      )}
    </div>
  );
}

/**
 * An agent's key, made by the passkey the person's own wallet comes from. It is drawn in the browser
 * alone, on a server that answers to a chain, because both the passkey and the money are only there.
 */
export function AgentKeySheet({ market }: { readonly market: MarketConfig }): ReactElement {
  const connection = useConnection();
  const isPasskeyOpen = connection.status === "connected" && connection.connector.id === PASSKEY_CONNECTOR_ID;
  // a new wallet starts afresh: no key of the wallet before it stays on the page
  return isPasskeyOpen ? <WithTheWalletOpen key={connection.address} market={market} wallet={connection.address} /> : <OpenTheWalletFirst />;
}
