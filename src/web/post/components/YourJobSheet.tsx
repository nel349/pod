import type { ReactElement } from "react";
import { formatEther } from "viem";
import type { JobV2 } from "../../../jobsV2.ts";
import type { MarketConfig } from "../../../market.ts";
import type { PreparingView } from "../../../preparing/records.ts";
import { whenHere } from "../../site/copy.ts";
import type { ActionStatus } from "../hooks/usePreparedActions.ts";
import { MS_IN_A_SECOND } from "../../site/views/index.ts";
import { COPY, modeOfWindow, windowInWords, writingsLeft, type Standing } from "../state/index.ts";

/** Who may see the job: nobody connected, another wallet, the poster before signing, or the poster. */
export type Viewer = "noWallet" | "notYours" | "unsigned" | "poster";

export interface YourJobView {
  readonly onChainId: string;
  readonly job: JobV2;
  readonly standing: Standing;
  readonly viewer: Viewer;
  readonly view: PreparingView | undefined;
  readonly action: ActionStatus;
  readonly isSigning: boolean;
  /** why reading the job from the server failed, if it did */
  readonly problem: string | undefined;
  /** where it is on the wall, once it is */
  readonly wallPage: string | undefined;
}

/** What the poster can do from the sheet. */
export interface YourJobActions {
  readonly connect: () => void;
  readonly sign: () => void;
  readonly takeBack: () => void;
}

/** An approved job, as the chain says it stands since, and where to watch it. */
function Approved({ job, wallPage }: { readonly job: JobV2; readonly wallPage: string | undefined }): ReactElement {
  const says = job.state === "settled" ? COPY.prepared.approved.settled
    : job.state === "working" ? COPY.prepared.approved.working
    : COPY.prepared.approved.open(whenHere(new Date(Number(job.endsAt) * MS_IN_A_SECOND).toISOString()));
  return (
    <p id="standing" className="said-status done">
      {says}{" "}
      {wallPage
        ? <a href={wallPage}>{job.state === "settled" ? COPY.prepared.openFinished : COPY.prepared.openJob}</a>
        : COPY.prepared.notOnTheWallYet}
    </p>
  );
}

/** The job paid for: where it stands, what is left of the money for writing, and the way out. Draws; decides nothing. */
export function YourJobSheet({ market, job: shown, on }: {
  readonly market: MarketConfig;
  readonly job: YourJobView;
  readonly on: YourJobActions;
}): ReactElement {
  const { onChainId, job, standing, viewer, view, action } = shown;
  const mode = view?.mode ?? modeOfWindow(job.window);
  const isWorking = action.kind === "working";
  return (
    <section className="sheet your-job" id="your-job" aria-labelledby="your-job-title">
      <span className="tape" aria-hidden="true" />
      <h2 id="your-job-title">{COPY.prepared.job(onChainId)}</h2>
      {view && <p className="job-address">/job/{view.name}</p>}
      {mode && <p className="terms-plain">{COPY.prepared.terms(`${formatEther(job.price)} ${market.coin}`, windowInWords(mode))}</p>}
      {/* until it is approved the job is the poster's alone; after, it is public, and nobody is asked for a wallet */}
      {standing === "preparing" && viewer === "noWallet" && (
        <>
          <p>{COPY.prepared.noWallet}</p>
          <button type="button" id="connect" className="primary" onClick={on.connect}>{COPY.prepared.connect}</button>
        </>
      )}
      {standing === "preparing" && viewer === "notYours" && <p className="said-status">{COPY.prepared.notYours}</p>}
      {viewer === "unsigned" && standing === "preparing" && (
        <>
          <p>{COPY.prepared.signIn.says}</p>
          <button type="button" id="sign-in" className="primary" disabled={shown.isSigning} onClick={on.sign}>{COPY.prepared.signIn.button}</button>
        </>
      )}
      {standing === "approved" && <Approved job={job} wallPage={shown.wallPage} />}
      {standing === "takenBack" && <p id="standing" className="said-status">{COPY.prepared.takenBack}</p>}
      {standing === "closed" && <p id="standing" className="said-status">{COPY.prepared.closed}</p>}
      {standing === "preparing" && view && <p id="writings-left">{COPY.prepared.left(writingsLeft(view.money))}</p>}
      {/* the chain knows whose money it is: taking it back needs the wallet, not the note */}
      {standing === "preparing" && (viewer === "poster" || viewer === "unsigned") && (
        <div className="take-back">
          <p className="note">{COPY.prepared.takeBackSays}</p>
          <button type="button" id="take-back" className="quiet" disabled={isWorking} onClick={on.takeBack}>{COPY.prepared.takeBack}</button>
        </div>
      )}
      {action.kind === "working" && action.action === "takeBack" && <p className="said-status" role="status">{COPY.prepared.working[action.step]}</p>}
      {action.kind === "stopped" && action.action === "takeBack" && <p className="said-status" role="status">{action.why}</p>}
      {shown.problem && <p className="said-status" role="status">{shown.problem}</p>}
    </section>
  );
}
