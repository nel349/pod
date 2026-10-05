import type { ReactElement } from "react";
import { CHROME } from "./copy.ts";
import type { PasskeyProblem } from "./wallet/index.ts";

/** Everything the connect panel shows, worked out, so the panel only draws it. */
export interface ConnectChoices {
  /** whether this browser can make a passkey wallet; undefined while it is asked */
  readonly canUsePasskeys: boolean | undefined;
  /** a passkey wallet was made or opened in this browser before, so opening it is the first offer */
  readonly isPasskeyRemembered: boolean;
  readonly hasBrowserWallet: boolean;
  readonly isBusy: boolean;
  readonly problem: { readonly kind: PasskeyProblem; readonly why: string } | undefined;
}

export interface ConnectActions {
  readonly makePasskeyWallet: () => void;
  readonly openPasskeyWallet: () => void;
  readonly useBrowserWallet: () => void;
  readonly close: () => void;
}

const problemWords = (problem: NonNullable<ConnectChoices["problem"]>): string =>
  problem.kind === "unsupported" ? CHROME.wallet.panel.unsupported
    : problem.kind === "cancelled" ? CHROME.wallet.panel.cancelled
    : CHROME.wallet.panel.failed(problem.why);

/** The two ways to connect: a wallet from a passkey, first, and the browser's own. Draws; decides nothing. */
export function ConnectPanel({ choices, on }: { readonly choices: ConnectChoices; readonly on: ConnectActions }): ReactElement {
  const words = CHROME.wallet.panel;
  const { canUsePasskeys, isPasskeyRemembered, isBusy } = choices;
  return (
    <div className="wallet-panel" id="wallet-panel" role="dialog" aria-labelledby="wallet-panel-title">
      <div className="wallet-panel-head">
        <p id="wallet-panel-title" className="wallet-panel-title">{words.title}</p>
        <button type="button" className="quiet" onClick={on.close}>{words.close}</button>
      </div>
      <section className="wallet-way" aria-labelledby="wallet-passkey-title">
        <p id="wallet-passkey-title" className="wallet-way-title">{words.passkeyTitle}</p>
        <p className="wallet-way-says">{words.passkeySays}</p>
        {canUsePasskeys === false ? <p className="said-status">{words.unsupported}</p> : (
          <div className="wallet-way-actions">
            <button type="button" id="passkey-primary" className="primary small" disabled={isBusy}
              onClick={isPasskeyRemembered ? on.openPasskeyWallet : on.makePasskeyWallet}>
              {isPasskeyRemembered ? words.open : words.make}
            </button>
            <button type="button" id="passkey-other" className="quiet" disabled={isBusy}
              onClick={isPasskeyRemembered ? on.makePasskeyWallet : on.openPasskeyWallet}>
              {isPasskeyRemembered ? words.makeAnother : words.haveOne}
            </button>
          </div>
        )}
        {choices.problem && <p id="passkey-problem" className="said-status" role="status">{problemWords(choices.problem)}</p>}
      </section>
      <section className="wallet-way" aria-labelledby="wallet-browser-title">
        <p id="wallet-browser-title" className="wallet-way-title">{words.browserTitle}</p>
        {choices.hasBrowserWallet
          ? <button type="button" id="browser-wallet" className="quiet" disabled={isBusy} onClick={on.useBrowserWallet}>{words.browserUse}</button>
          : <p className="wallet-way-says">{words.browserNone}</p>}
      </section>
    </div>
  );
}
