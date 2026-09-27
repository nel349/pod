import type { ReactElement } from "react";
import { explorerAddress } from "../../../../market.ts";
import { ChooseAccount, CHROME, shortAddress, useConnectedAccount } from "../../../shared/index.ts";
import { InTheBrowser } from "../../components/index.ts";
import { SITE } from "../../copy.ts";
import { useIsViewer, useSite } from "../../hooks/index.ts";

/** When the wallet connected here is not the one that paid, say so, and offer to pick the right account. */
function NotTheirWallet({ poster }: { readonly poster: string }): ReactElement | null {
  const connected = useConnectedAccount();
  const isViewer = useIsViewer();
  if (!connected || isViewer(poster)) return null;
  return (
    <div className="not-their-wallet" role="status">
      <p>{SITE.job.money.notTheirWallet(shortAddress(connected), shortAddress(poster))}</p>
      <p><ChooseAccount label={CHROME.wallet.chooseAnother} /></p>
    </div>
  );
}

/**
 * Whose money it is: who paid, for everybody, and, for a wallet that is not theirs, that only the
 * payer can take it back, which is the contract's rule and the reason a button may not work for you.
 */
export function WhoseMoney({ poster }: { readonly poster: string }): ReactElement {
  const { market } = useSite();
  const who = <code title={poster}>{shortAddress(poster)}</code>;
  return (
    <>
      <p className="note">
        {SITE.job.money.paidFor} {market ? <a href={explorerAddress(market.explorer, poster)}>{who}</a> : who}.
      </p>
      <InTheBrowser><NotTheirWallet poster={poster} /></InTheBrowser>
    </>
  );
}
