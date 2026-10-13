import type { ReactElement } from "react";
import { canBeMineToJudge, type Written } from "../../../checkwriting/written.ts";
import { COPY, checkStandingOf } from "../state/index.ts";

/**
 * One line the poster wrote, and how the pod's work is checked against it: what the check does, what
 * a good answer is, what it cannot look at, and whether it can be used. The check's own code is there
 * for whoever wants it, and nobody has to read it.
 */
export function WrittenCheck({ check, mine }: {
  readonly check: Written;
  /** a line no program can decide, which its poster may keep to judge themselves: how it stands, and the press that changes it */
  readonly mine?: { readonly isMine: boolean; readonly keep: () => void; readonly giveBack: () => void };
}): ReactElement {
  const which = <p className="which">{check.secret ? COPY.checks.exam : COPY.checks.brief}</p>;
  const says = <p className="says">{check.says}</p>;

  if (!check.checkable) {
    // a line the builders are told, that no program can decide, is one its poster may answer for themselves
    const canBeTheirs = canBeMineToJudge(check) && mine !== undefined;
    return (
      <li className={mine?.isMine ? "written-check cannot mine" : "written-check cannot"}>
        {which}{says}
        <p className="cannot-why">{check.untold ? COPY.checks.untold(check.why) : COPY.checks.cannot(check.why)}</p>
        {canBeTheirs && (mine.isMine
          ? (
            <p className="mine-says">
              {COPY.checks.mine.kept}
              <button type="button" className="quiet" onClick={mine.giveBack}>{COPY.checks.mine.giveBack}</button>
            </p>
          )
          : (
            <p className="mine-says">
              {COPY.checks.mine.offer}
              <button type="button" className="quiet" onClick={mine.keep}>{COPY.checks.mine.keep}</button>
            </p>
          ))}
      </li>
    );
  }

  const standing = checkStandingOf(check);
  return (
    <li className={standing.isReady ? "written-check" : "written-check shaky"}>
      {which}{says}
      <dl className="readback">
        <div><dt>{COPY.checks.theCheck}</dt><dd>{check.asks}</dd></div>
        <div><dt>{COPY.checks.goodAnswer}</dt><dd>{check.expects}</dd></div>
      </dl>
      {check.leavesOut !== undefined && <p className="leaves-out"><span className="label">{COPY.checks.leavesOut}</span> {check.leavesOut}</p>}
      <p className={standing.isReady ? "standing ready" : "standing not"}>{standing.isReady ? COPY.checks.ready : standing.why}</p>
      <details className="source">
        <summary>{COPY.checks.showSource}</summary>
        <pre><code>{check.source}</code></pre>
      </details>
    </li>
  );
}
