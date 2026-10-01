import type { ReactElement } from "react";
import type { Finished } from "../../../preparing/records.ts";
import type { ActionStatus } from "../hooks/usePreparedActions.ts";
import { COPY, type WritingLine, type WritingVerdict } from "../state/index.ts";
import { Step } from "./Step.tsx";
import { WrittenCheck } from "./WrittenCheck.tsx";

/** Everything the approve sheet shows, worked out, so the sheet only draws it. */
export interface ApproveView {
  /** where the writing is now, while it happens */
  readonly line: WritingLine;
  /** the last writing that finished, which is what is read and approved */
  readonly writing: Finished | undefined;
  readonly verdict: WritingVerdict | undefined;
  /** whether the lines above are what the shown checks were written for */
  readonly isFresh: boolean;
  /** why approving is not offered, or nothing when it is */
  readonly whyNot: string | undefined;
  readonly isBusy: boolean;
  /** the button's words: writing again, or paying for one more writing first */
  readonly writeAgain: string;
  readonly action: ActionStatus;
}

/** Reading the checks written for the lines above, having them written again, and approving them. Draws; decides nothing. */
export function ApproveStep({ view, onWriteAgain, onApprove }: {
  readonly view: ApproveView;
  readonly onWriteAgain: () => void;
  readonly onApprove: () => void;
}): ReactElement {
  const { line, writing, verdict, action } = view;
  const checks = writing?.outcome.kind === "written" ? writing.outcome.checks : [];
  const howItIsAsked = writing?.outcome.kind === "written" ? writing.outcome.howItIsAsked?.plainly : undefined;
  const isWorking = action.kind === "working";
  return (
    <Step name="approve" title={COPY.prepared.title} guide={COPY.prepared.guide}>
      <p id="writing" className="writing" data-state={line.state} role="status" aria-live="polite">
        {line.state === "busy" && <span className="clock" aria-hidden="true">{line.clock} · </span>}
        {line.text}
        {line.state === "quiet" && !writing && COPY.prepared.none}
      </p>
      {checks.length > 0 && (
        <ol id="written" className={view.isFresh ? "written" : "written stale"}>
          {checks.map((check) => <WrittenCheck key={`${check.secret ? "exam" : "brief"}:${check.says}`} check={check} />)}
        </ol>
      )}
      {checks.length > 0 && howItIsAsked && (
        <aside id="how-it-is-asked" className={view.isFresh ? "asked-note" : "asked-note stale"}>
          <p className="asked-title">{COPY.checks.howItIsAsked.title}</p>
          <p>{howItIsAsked} {COPY.checks.howItIsAsked.told}</p>
        </aside>
      )}
      {verdict && !view.isBusy && (
        <div id="written-verdict" className="written-verdict" data-state={verdict.state} aria-live="polite">
          <p className="verdict-shout">{verdict.shout}</p>
          <p className="verdict-says">{verdict.says}</p>
        </div>
      )}
      <div className="write-row">
        <button type="button" id="approve" className="primary" disabled={view.isBusy || isWorking || view.whyNot !== undefined} onClick={onApprove}>
          {COPY.prepared.approve}
        </button>
        <button type="button" id="write" className="quiet" disabled={view.isBusy || isWorking} onClick={onWriteAgain}>
          {view.writeAgain}
        </button>
      </div>
      <p id="said" className="said-status" role="status">
        {action.kind === "working" && action.action !== "takeBack" && COPY.prepared.working[action.step]}
        {action.kind === "stopped" && action.action !== "takeBack" && action.why}
        {/* a verdict that already says why (out of date, short, not written) is not said twice */}
        {action.kind === "idle" && !view.isBusy && writing && (verdict === undefined || verdict.state === "ready") && view.whyNot}
      </p>
    </Step>
  );
}
