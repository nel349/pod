import type { CSSProperties, ReactElement, ReactNode } from "react";
import { stepId, stepNumber, type StepName } from "../state/index.ts";

interface StepProps {
  /** which step this is: its number, its id and its place on the seal all follow from the name */
  readonly name: StepName;
  readonly title: ReactNode;
  readonly guide?: string;
  readonly children: ReactNode;
}

/** how far a sheet leans, in degrees: odd ones one way, even ones the other, never straight */
const ODD_LEAN = -0.5;
const EVEN_LEAN = 0.4;

const lean = (number: number): CSSProperties => ({ "--lean": `${number % 2 ? ODD_LEAN : EVEN_LEAN}deg`, "--order": number });

/** One numbered step of posting a job, as a photocopied sheet taped to the wall. */
export function Step({ name, title, guide, children }: StepProps): ReactElement {
  const number = stepNumber(name);
  const id = stepId(name);
  return (
    <section className="sheet" id={id} aria-labelledby={`${id}-title`} style={lean(number)}>
      <span className="tape" aria-hidden="true" />
      <p className="stamp" aria-hidden="true">{String(number).padStart(2, "0")}</p>
      <h2 id={`${id}-title`}>{title}</h2>
      {guide && <p className="guide">{guide}</p>}
      {children}
    </section>
  );
}
