import type { ReactElement } from "react";
import { Sheet } from "../../../shared/index.ts";
import { SITE } from "../../copy.ts";
import type { JobView } from "../../views/index.ts";

type Outcome = keyof typeof SITE.job.outcome;

/** A check with no outcome was either not run yet, or ran on a job whose outcomes are not public yet. */
const outcomeOf = (exitCode: number | undefined, isRunning: boolean): Outcome =>
  exitCode === undefined ? (isRunning ? "notRun" : "notPublic") : exitCode === 0 ? "passed" : "failed";

/** The checks anybody may read now, what each said, and how many are still sealed. */
export function ChecksSheet({ job }: { readonly job: JobView }): ReactElement {
  const isRunning = job.verdict === "running";
  const isDelivered = job.delivery !== undefined;
  const title = isRunning ? SITE.job.checks.running : job.verdict === "withdrawn" ? SITE.job.checks.withdrawn : isDelivered ? SITE.job.checks.found : SITE.job.checks.done;
  // counted only when every check's outcome is public: a delivery's are, from the moment it is reported
  const isCounted = isDelivered && job.checks.length > 0 && job.sealedChecks === 0 && job.checks.every((check) => check.exitCode !== undefined);
  const passed = job.checks.filter((check) => check.exitCode === 0);
  // the checks can be fetched once the server publishes them, which is when none is sealed any more
  const canFetch = !isRunning && job.sealedChecks === 0;
  return (
    <Sheet number={4} id="checks" title={title} stamp={false}>
      {isCounted && <p className="lede" id="checks-found">{SITE.job.checksFound(passed.length, job.checks.length, passed.filter((check) => check.hidden).length)}</p>}
      <ul className="checks">
        {job.checks.map((check) => {
          const outcome = outcomeOf(check.exitCode, isRunning);
          return (
            <li key={check.says} className={outcome}>
              <span className="outcome">{SITE.job.outcome[outcome]}</span>
              <span className="says">{check.says}</span>
              {check.hidden && <span className="hidden-check">{SITE.job.hiddenCheck}</span>}
              {outcome === "failed" && check.said && <span className="check-said">{SITE.job.checkSaid} {check.said}</span>}
            </li>
          );
        })}
      </ul>
      {isCounted && <p className="note">{SITE.job.checksRunBy}</p>}
      {job.sealedChecks > 0 && <p className="note">{SITE.job.sealedCount(job.sealedChecks)}</p>}
      {canFetch && <p className="note fetch"><a href={job.checksPath}>{SITE.job.fetchChecks}</a>{SITE.job.fetchChecksRest}</p>}
    </Sheet>
  );
}
