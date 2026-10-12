import type { ReactElement } from "react";
import { SITE } from "../../copy.ts";
import { STEPS, type Step } from "./story.ts";

/** The film's controls: stop it or start it, and go straight to any step. */
export function FilmControls({ current, isOn, steps, on }: {
  readonly current: Step;
  readonly isOn: boolean;
  readonly steps: Readonly<Record<Step, { readonly title: string }>>;
  readonly on: { readonly toggle: () => void; readonly goTo: (step: Step) => void };
}): ReactElement {
  const words = SITE.welcome.controls;
  return (
    <div className="film-controls">
      <button type="button" id="film-toggle" className="film-toggle" onClick={on.toggle}>{isOn ? words.pause : words.play}</button>
      <ol className="film-steps">
        {STEPS.map((step, at) => (
          <li key={step}>
            <button type="button" data-step={step} aria-current={step === current ? "step" : undefined} aria-label={words.goTo(steps[step].title)} onClick={() => on.goTo(step)}>
              {at + 1}
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
