import type { ReactElement } from "react";
import type { ChecksView } from "../hooks/useChecksView.ts";
import { COPY } from "../state/index.ts";
import { Step } from "./Step.tsx";
import { WrittenCheck } from "./WrittenCheck.tsx";

/** Having the checks written, watching them be tried, and reading what came back. Draws; decides nothing. */
export function ChecksStep({ view }: { readonly view: ChecksView }): ReactElement {
  const { line, checks, verdict, howItIsAsked } = view;
  return (
    <Step name="checks" title={COPY.checks.title} guide={COPY.checks.guide}>
      <div className="write-row">
        <button type="button" id="write" className="primary" disabled={view.isBusy} data-busy={view.isBusy || undefined}
          onClick={view.onWrite}>
          {view.hasWritten ? COPY.checks.again : COPY.checks.write}
        </button>
        <p id="writing" className="writing" data-state={line.state} role="status" aria-live="polite">
          {line.state === "busy" && <span className="clock" aria-hidden="true">{line.clock} · </span>}
          {line.text}
        </p>
      </div>
      {checks.length > 0 && (
        <ol id="written" className={view.isFresh ? "written" : "written stale"}>
          {/* a sentence appears once in a request, so it names its check for as long as the list is shown */}
          {checks.map((check) => <WrittenCheck key={`${check.secret ? "exam" : "brief"}:${check.says}`} check={check} />)}
        </ol>
      )}
      {checks.length > 0 && howItIsAsked && (
        <aside id="how-it-is-asked" className={view.isFresh ? "asked-note" : "asked-note stale"}>
          <p className="asked-title">{COPY.checks.howItIsAsked.title}</p>
          <p>{howItIsAsked} {COPY.checks.howItIsAsked.told}</p>
        </aside>
      )}
      {verdict && (
        <div id="written-verdict" className="written-verdict" data-state={verdict.state} aria-live="polite">
          <p className="verdict-shout">{verdict.shout}</p>
          <p className="verdict-says">{verdict.says}</p>
        </div>
      )}
    </Step>
  );
}
