import type { ReactElement } from "react";
import { Sheet } from "../../../shared/index.ts";
import { SITE } from "../../copy.ts";
import type { JobView } from "../../views.ts";

type Outcome = keyof typeof SITE.job.outcome;

const outcomeOf = (exitCode: number | undefined): Outcome =>
  exitCode === undefined ? "notRun" : exitCode === 0 ? "passed" : "failed";

/** The checks anybody may read now, what each said, and how many are still sealed. */
export function ChecksSheet({ job }: { readonly job: JobView }): ReactElement {
  const isRunning = job.verdict === "running";
  return (
    <Sheet number={4} id="checks" title={isRunning ? SITE.job.checks.running : SITE.job.checks.done} stamp={false}>
      <ul className="checks">
        {job.checks.map((check) => {
          const outcome = outcomeOf(check.exitCode);
          return (
            <li key={check.says} className={outcome}>
              <span className="outcome">{SITE.job.outcome[outcome]}</span>
              <span className="says">{check.says}</span>
              {check.hidden && <span className="hidden-check">{SITE.job.hiddenCheck}</span>}
            </li>
          );
        })}
      </ul>
      {job.sealedChecks > 0 && <p className="note">{SITE.job.sealedCount(job.sealedChecks)}</p>}
      {!isRunning && <p className="note fetch"><a href={job.checksPath}>{SITE.job.fetchChecks}</a>{SITE.job.fetchChecksRest}</p>}
    </Sheet>
  );
}
