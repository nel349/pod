import type { ReactElement } from "react";
import { useFormContext } from "react-hook-form";
import { MODE_NAMES } from "../../../job.ts";
import { COPY, type PostForm } from "../state/index.ts";
import { holdEnter } from "./holdEnter.ts";
import { Step } from "./Step.tsx";

/**
 * What they pay, how long the builders have, and where the job will live on the wall. Once paid for,
 * the price and the time are what the chain holds, so they are shown and no longer changed.
 */
export function TermsStep({ coin, isPaid = false }: { readonly coin: string; readonly isPaid?: boolean }): ReactElement {
  const { register } = useFormContext<PostForm>();
  return (
    <Step name="terms" title={COPY.terms.title}>
      <div className="terms">
        <label className="field">
          {COPY.terms.price}
          <span className="with-unit">
            <input id="price" type="text" inputMode="decimal" autoComplete="off" readOnly={isPaid} onKeyDown={holdEnter} {...register("price")} /> {coin}
          </span>
        </label>
        <fieldset className="modes" disabled={isPaid}>
          <legend>{COPY.terms.modeLegend}</legend>
          {MODE_NAMES.map((mode) => (
            <label key={mode}><input type="radio" value={mode} {...register("mode")} /> {COPY.terms.modes[mode]}</label>
          ))}
        </fieldset>
      </div>
      {isPaid && <p className="note paid-fixed">{COPY.terms.paidFixed}</p>}
      <label className="field">
        {COPY.terms.name}
        <span className="slug-row">
          <span className="slug-prefix">/job/</span>
          <input id="name" type="text" placeholder={COPY.terms.namePlaceholder} autoComplete="off" spellCheck={false}
            onKeyDown={holdEnter} {...register("name")} />
        </span>
      </label>
    </Step>
  );
}
