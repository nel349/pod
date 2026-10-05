import type { ReactElement } from "react";
import { CHROME } from "./copy.ts";

/** Everything the open passkey wallet's panel shows. */
export interface PasskeyDetailsView {
  readonly address: string;
  /** what it holds, in words, once read */
  readonly holds: string | undefined;
  readonly isEmpty: boolean;
  /** where the chain gives testnet coin, when it has such a place */
  readonly faucet: string | undefined;
  /** the recovery phrase, while the person has asked to see it */
  readonly phrase: string | undefined;
  readonly isBusy: boolean;
}

export interface PasskeyDetailsActions {
  readonly showPhrase: () => void;
  readonly hidePhrase: () => void;
  readonly lock: () => void;
  readonly close: () => void;
}

/** The open passkey wallet: its address, what it holds, its recovery phrase, and locking it. Draws; decides nothing. */
export function PasskeyDetails({ view, on }: { readonly view: PasskeyDetailsView; readonly on: PasskeyDetailsActions }): ReactElement {
  const words = CHROME.wallet.passkey;
  return (
    <div className="wallet-panel" id="wallet-panel" role="dialog" aria-labelledby="wallet-panel-title">
      <div className="wallet-panel-head">
        <p id="wallet-panel-title" className="wallet-panel-title">{CHROME.wallet.panel.passkeyTitle}</p>
        <button type="button" className="quiet" onClick={on.close}>{CHROME.wallet.panel.close}</button>
      </div>
      <p className="wallet-way-title">{words.address}</p>
      <p id="passkey-address" className="wallet-address"><code>{view.address}</code></p>
      {view.holds && <p className="wallet-way-says">{view.holds}</p>}
      {view.isEmpty && (
        <p id="passkey-empty" className="wallet-way-says">
          {view.faucet ? <>{words.empty} <a href={view.faucet} target="_blank" rel="noreferrer">{words.faucet}</a>.</> : words.emptyNoFaucet}
        </p>
      )}
      {view.phrase ? (
        <div className="wallet-phrase">
          <p className="wallet-way-says">{words.phraseSays}</p>
          <ol id="recovery-phrase" className="phrase-words">{view.phrase.split(" ").map((word, index) => <li key={index}>{word}</li>)}</ol>
          <button type="button" className="quiet" onClick={on.hidePhrase}>{words.hidePhrase}</button>
        </div>
      ) : (
        <button type="button" id="show-phrase" className="quiet" disabled={view.isBusy} onClick={on.showPhrase}>{words.showPhrase}</button>
      )}
      <div className="wallet-lock">
        <button type="button" id="lock-wallet" className="quiet" onClick={on.lock}>{words.lock}</button>
        <p className="wallet-way-says">{words.lockSays}</p>
      </div>
    </div>
  );
}
