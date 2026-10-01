/**
 * Posting a job on a contract that prepares jobs: the idea and the lines, the price and the time, then
 * one payment, after which the checks are written on the job's own page.
 *
 * Like the page it replaces, this holds the state and wires hooks to sheets; the rules live in state/
 * and the talking in hooks/.
 */
import { useState, type ReactElement } from "react";
import { FormProvider, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { DEFAULT_MODE } from "../../job.ts";
import type { MarketConfig } from "../../market.ts";
import { Bill, DraftBack, IdeaStep, LinesStep, PayFirstStep, ProgressStrip, StepOrderContext, TermsStep } from "./components/index.ts";
import { draftStore, keptSetUpStore, useKeptDraft, usePayFirst, usePointerDrift } from "./hooks/index.ts";
import {
  BLANK_FORM, formOfKeptSetUp, freshSalt, PAY_FIRST_STEPS, payFirstProgressOf, PostFormSchema, priceInWei, whatIsPaid,
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
            <ProgressStrip progress={progress} />
            {draftBack && <DraftBack onStartAgain={startAgain} />}
            <IdeaStep />
            <LinesStep lines="brief" />
            <LinesStep lines="exam" />
            <TermsStep coin={market.coin} />
            <PayFirstStep
              market={market}
              view={{
                paid: whatIsPaid(priceInWei(draft.price) ?? 0n, writing), mode: draft.mode ?? DEFAULT_MODE,
                status: paying.status, steps: paying.steps, kept: paying.kept, isSubmitting: form.formState.isSubmitting,
              }}
            />
          </form>
        </FormProvider>
      </div>
    </StepOrderContext.Provider>
  );
}
