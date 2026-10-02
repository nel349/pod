/**
 * Posting a job on a contract that prepares jobs: the idea and the lines, the price and the time, then
 * one payment, after which the checks are written on the job's own page.
 *
 * Like the page it replaces, this holds the state and wires hooks to sheets; the rules live in state/
 * and the talking in hooks/.
 */
import { useEffect, useState, type ReactElement } from "react";
import { FormProvider, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { DEFAULT_MODE } from "../../job.ts";
import type { MarketConfig } from "../../market.ts";
import { Bill, DraftBack, IdeaStep, LinesStep, PayFirstStep, ProgressStrip, StepOrderContext, TermsStep } from "./components/index.ts";
import { draftStore, keptSetUpStillWaits, keptSetUpStore, useKeptDraft, usePayFirst, usePointerDrift } from "./hooks/index.ts";
import {
  BLANK_FORM, COPY, formOfKeptSetUp, freshSalt, PAY_FIRST_STEPS, payFirstProgressOf, PostFormSchema, priceInWei, whatIsPaid,
  type DraftForm, type PostForm,
} from "./state/index.ts";

export function PayFirstPage({ market, writing }: { readonly market: MarketConfig; readonly writing: NonNullable<MarketConfig["writing"]> }): ReactElement {
  // a payment this browser sent before and never saw set up: the page comes back to that job
  const [kept] = useState(() => keptSetUpStore.read(market));
  // failing that, a draft left here before, as it was left
  const [draftBack, setDraftBack] = useState(() => (kept ? undefined : draftStore.read(market)));
  const form = useForm<PostForm>({
    resolver: zodResolver(PostFormSchema), defaultValues: kept ? formOfKeptSetUp(kept) : draftBack?.form ?? BLANK_FORM, mode: "onSubmit",
  });
  const draft: DraftForm = useWatch({ control: form.control });
  usePointerDrift();

  const [salt] = useState(() => kept?.salt ?? freshSalt());
  const paying = usePayFirst(market, form, salt, kept);
  // a payment kept from before whose job has moved on since has nothing to finish: let it go, and its lines
  const { letGo } = paying;
  useEffect(() => {
    if (!kept) return;
    let isCurrent = true;
    void keptSetUpStillWaits(market, kept).then((waits) => {
      if (waits || !isCurrent) return;
      letGo(COPY.payFirst.cameBackMovedOn);
      form.reset(BLANK_FORM);
    });
    return () => { isCurrent = false; };
    // asked once, of the payment the page came back to: kept never changes, and letGo and the form act on this page only
  }, [kept]);
  useKeptDraft(market, { form: draft }, paying.kept !== undefined || paying.status.kind === "posted");
  const startAgain = (): void => {
    draftStore.forget(market);
    form.reset(BLANK_FORM);
    setDraftBack(undefined);
  };

  const progress = payFirstProgressOf(draft, paying.kept !== undefined);
  return (
    <StepOrderContext.Provider value={PAY_FIRST_STEPS}>
      <div className="poster">
        <Bill progress={progress} working={paying.status.kind === "posting" ? "pay" : undefined} />
        <FormProvider {...form}>
          <form id="post" className="sheets" noValidate onSubmit={(event) => void paying.submit(event)}>
            <ProgressStrip progress={progress} working={paying.status.kind === "posting" ? "pay" : undefined} />
            {draftBack && <DraftBack onStartAgain={startAgain} />}
            <IdeaStep />
            <LinesStep lines="brief" />
            <LinesStep lines="exam" />
            <TermsStep coin={market.coin} isPaid={paying.kept !== undefined} />
            <PayFirstStep
              market={market}
              view={{
                // once paid for, what was paid, not what the form says now
                paid: whatIsPaid(priceInWei(paying.kept?.price ?? draft.price) ?? 0n, writing), mode: paying.kept?.mode ?? draft.mode ?? DEFAULT_MODE,
                status: paying.status, steps: paying.steps, kept: paying.kept, isSubmitting: form.formState.isSubmitting,
              }}
            />
          </form>
        </FormProvider>
      </div>
    </StepOrderContext.Provider>
  );
}
