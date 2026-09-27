import type { ReactElement } from "react";
import { CHROME } from "./copy.ts";
import { useChooseAccount } from "./wallet/index.ts";

/**
 * A button that asks the wallet to let the person pick another of their accounts, and says so when
 * the wallet will not: then switching inside the wallet itself is the way, and the page follows it.
 */
export function ChooseAccount({ label, className = "quiet" }: { readonly label: string; readonly className?: string }): ReactElement {
  const account = useChooseAccount();
  return (
    <>
      <button type="button" className={className} aria-label={CHROME.wallet.changeLabel} disabled={account.isChoosing} onClick={account.choose}>
        {label}
      </button>
      {account.why && <span className="said-status" role="status"> {CHROME.wallet.cannotChoose}</span>}
    </>
  );
}
