import type { ReactElement } from "react";
import { useFormContext, useWatch } from "react-hook-form";
import { MODE_NAMES } from "../../../job.ts";
import { useCoinInDollars, type Rate } from "../hooks/index.ts";
import { coinsForDollars, COPY, type PostForm } from "../state/index.ts";
import { holdEnter } from "./holdEnter.ts";
import { Step } from "./Step.tsx";

/**
 * The three prices a poster can pick, in dollars, with what each is in the chain's coin.
 *
 * A poster thinks in dollars and the contract takes the chain's coin, so the dollars are the label
 * and the coin amount is what is paid: picking one writes that amount into the price. Without today's
 * price there are no dollars to show, and the page asks in the coin, as it always did.
 */
function PriceChoices({ rate, coin, isPaid }: { readonly rate: Rate; readonly coin: string; readonly isPaid: boolean }): ReactElement {
  const { control, setValue } = useFormContext<PostForm>();
  const price = useWatch({ control, name: "price" });
  return (
    <div className="price-choices" role="group" aria-label={COPY.terms.price}>
      {COPY.terms.priceChoices.map((choice) => {
        const amount = coinsForDollars(choice.usd, rate.usd);
        return (
          <button
            key={choice.usd}
            type="button"
            id={`price-${choice.usd}`}
            className={price === amount ? "price-choice picked" : "price-choice"}
            aria-pressed={price === amount}
            disabled={isPaid}
            onClick={() => setValue("price", amount, { shouldValidate: true, shouldDirty: true })}
          >
            <span className="in-dollars">{COPY.terms.priceInDollars(choice.usd)}</span>
            <span className="in-coins">{COPY.terms.priceInCoins(Number(amount).toLocaleString("en-US"), coin)}</span>
            <span className="buys">{choice.buys}</span>
          </button>
        );
      })}
    </div>
  );
}

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
  // today's price, from this server, which reads it from a free endpoint. Nothing waits for it
  const rate = useCoinInDollars();
  return (
    <Step name="terms" title={COPY.terms.title}>
      {rate && !isPaid && <PriceChoices rate={rate} coin={coin} isPaid={isPaid} />}
      <div className="terms">
        <label className="field">
          {rate && !isPaid ? COPY.terms.anotherAmount : COPY.terms.price}
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
      {!isPaid && <p id="price-says" className="note">{rate ? COPY.terms.rateSays(rate.from, coin) : COPY.terms.noRate(coin)}</p>}
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
