import type { ReactElement } from "react";
import { COPY, shortRepository, type Claimable, type ClaimStatus, type Handed } from "../state/index.ts";
import { Sheet } from "../../shared/index.ts";
import { TakeTheSite } from "./TakeTheSite.tsx";

interface HandedSheetProps {
  readonly claimable: Claimable;
  readonly handed: Handed;
  readonly hasWallet: boolean;
  readonly status: ClaimStatus;
  /** sign as the title's holder, naming the account that already has the code */
  readonly onSign: (toAccount: string) => void;
}

/**
 * The code has left POD's account: who has it, where it lives, and that nothing is left to claim.
 * No account is asked for. A job that is a live website still offers its holder the site, on a signature.
 */
export function HandedSheet({ claimable, handed, hasWallet, status, onSign }: HandedSheetProps): ReactElement {
  const isWorking = status.kind === "working";
  const site = status.kind === "sent" || status.kind === "stopped" ? status.site : undefined;
  return (
    <Sheet number={2} id="handed" title={COPY.handed.title}>
      <p id="said" className="said-status done" role="status">
        {COPY.handed.to(handed)} <a href={claimable.repository}>{shortRepository(claimable.repository)}</a>.
      </p>
      <p className="note">{COPY.handed.says}</p>
      {claimable.live && <p id="live" className="note">{COPY.site.live} <a href={claimable.live}>{claimable.live}</a>.</p>}
      {claimable.isSiteTaken && <p id="site-taken" className="note">{COPY.site.taken} {COPY.handed.allDone}</p>}
      {claimable.live && !claimable.isSiteTaken && !site && (
        <>
          <p className="guide">{COPY.handed.site.guide}</p>
          <button type="button" id="sign-for-the-site" className="primary" disabled={!hasWallet || isWorking} data-busy={isWorking || undefined}
            onClick={() => onSign(handed.account)}>
            {isWorking ? COPY.handed.site.busy : COPY.handed.site.button}
          </button>
          {!hasWallet && <p className="said-status">{COPY.noWallet}</p>}
          {status.kind === "stopped" && <p id="stopped" className="said-status" role="status">{status.why}</p>}
        </>
      )}
      {site && !claimable.isSiteTaken && <TakeTheSite site={site} />}
    </Sheet>
  );
}
