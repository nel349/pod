import type { ReactElement } from "react";
import { isProven, type Written } from "../../../checkwriting/written.ts";
import { COPY, trialsOf } from "../state/index.ts";
import { Trial } from "./Trial.tsx";

/** One line the poster wrote, as the check it became, and how that check did in its trials. */
export function WrittenCheck({ check }: { readonly check: Written }): ReactElement {
  const which = <p className="which">{check.secret ? COPY.checks.exam : COPY.checks.brief}</p>;
  const says = <p className="says">{check.says}</p>;

  if (!check.checkable) {
    return (
      <li className="written-check cannot">
        {which}{says}
        <p className="cannot-why">{COPY.checks.cannot(check.why)}</p>
      </li>
    );
  }

  return (
    <li className={isProven(check) ? "written-check" : "written-check shaky"}>
      {which}{says}
      <dl className="readback">
        <div><dt>{COPY.checks.theCheck}</dt><dd>{check.asks}</dd></div>
        <div><dt>{COPY.checks.goodAnswer}</dt><dd>{check.expects}</dd></div>
      </dl>
      <ul className="trials">
        {trialsOf(check).map((trial) => <Trial key={trial.name} trial={trial} />)}
      </ul>
      <details className="source">
        <summary>{COPY.checks.showSource}</summary>
        <pre><code>{check.source}</code></pre>
      </details>
    </li>
  );
}
