import type { ReactElement } from "react";
import { useFormContext, useWatch } from "react-hook-form";
import { MODE_NAMES } from "../../../job.ts";
import { COPY, type PostForm } from "../state/index.ts";
import { holdEnter } from "./holdEnter.ts";
import { Step } from "./Step.tsx";

/**
 * What they pay, how long the builders have, and where the job will live on the wall. Once paid for,
 * the price and the time are what the chain holds, so they are shown and no longer changed.
 */
export function TermsStep({ coin, isPaid = false, canTell = false }: {
  readonly coin: string;
  readonly isPaid?: boolean;
  /** this server tells a poster by mail when their job is delivered, so an address is worth asking for */
  readonly canTell?: boolean;
}): ReactElement {
  const { register, control } = useFormContext<PostForm>();
  const mode = useWatch({ control, name: "mode" });
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
      <p id="mode-says" className="note mode-says" role="status">{COPY.terms.modeSays[mode]}</p>
      {isPaid && <p className="note paid-fixed">{COPY.terms.paidFixed}</p>}
      <label className="field">
        {COPY.terms.name}
        <span className="slug-row">
          <span className="slug-prefix">/job/</span>
          <input id="name" type="text" placeholder={COPY.terms.namePlaceholder} autoComplete="off" spellCheck={false}
            aria-describedby="name-says" onKeyDown={holdEnter} {...register("name")} />
        </span>
      </label>
      <p id="name-says" className="note">{COPY.terms.nameSays}</p>
      {canTell && (
        <>
          <label className="field tell">
        <span>{COPY.terms.tell} <span className="optional">{COPY.terms.tellOptional}</span></span>
        <input id="tell" type="text" inputMode="email" autoComplete="email" placeholder={COPY.terms.tellPlaceholder} spellCheck={false}
          aria-describedby="tell-says" onKeyDown={holdEnter} {...register("tell")} />
      </label>
          <p id="tell-says" className="note">{COPY.terms.tellSays}</p>
        </>
      )}
    </Step>
  );
}
