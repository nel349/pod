import type { ReactElement } from "react";
import type { TrialView } from "../state/index.ts";

/** One of the three ways a check is tried. When it failed, what the check printed is the explanation. */
export function Trial({ trial }: { readonly trial: TrialView }): ReactElement {
  return (
    <li className={trial.hasHeld ? "trial held" : "trial broke"}>
      {trial.says}
      {trial.saw !== undefined && <> <span className="saw">{trial.saw}</span></>}
    </li>
  );
}
