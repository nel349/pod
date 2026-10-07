import type { ReactElement } from "react";
import type { TrialView } from "../state/index.ts";

/**
 * One of the three ways a check is tried. When it failed, what the check printed is the explanation;
 * when it held and there is more to know, that is said under it.
 */
export function Trial({ trial }: { readonly trial: TrialView }): ReactElement {
  return (
    <li className={trial.hasHeld ? "trial held" : "trial broke"}>
      <span className="words">{trial.says}</span>
      {trial.saw !== undefined && <> <span className="saw">{trial.saw}</span></>}
      {trial.also !== undefined && <> <span className="also">{trial.also}</span></>}
    </li>
  );
}
