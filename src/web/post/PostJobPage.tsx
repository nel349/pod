/**
 * Posting a job: the form, and the two things that happen to it.
 *
 * This is the one component that holds state, and all it does is wire hooks to steps. Every step
 * only draws what it is handed; every rule (what a request may be, whether checks are out of date,
 * what the seal is) lives in state/, where it is tested without a browser; and everything that talks
 * to the server, the wallet or the clock lives in hooks/.
 */
import { useState, type ReactElement } from "react";
import { FormProvider, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { DEFAULT_MODE } from "../../job.ts";
import { readyToSeal } from "../../checkwriting/written.ts";
import type { MarketConfig } from "../../market.ts";
import { Bill, ChecksStep, DraftBack, IdeaStep, LinesStep, PayStep, ProgressStrip, TermsStep } from "./components/index.ts";
import {
  draftStore, keptPaymentStore, useCheckWriting, useChecksView, useKeptDraft, usePayAndPost, usePointerDrift, usePostJob,
  useSealedJob, useWriteTheChecks,
} from "./hooks/index.ts";
import { useWalletPresent } from "../shared/index.ts";
import {
  BLANK_FORM, formOfPaidJob, freshSalt, isFresh, PostFormSchema, priceInWei, progressOf, toWriteRequest,
  type DraftForm, type PostForm, type StepName,
} from "./state/index.ts";

export function PostJobPage({ market }: { readonly market: MarketConfig }): ReactElement {
  // a payment this browser sent before and never saw published: the page comes back to that job
  const [kept] = useState(() => keptPaymentStore.read(market));
  // failing that, a draft left here before, as it was left, the checks written for it included
  const [draftBack, setDraftBack] = useState(() => (kept ? undefined : draftStore.read(market)));
  const form = useForm<PostForm>({
    resolver: zodResolver(PostFormSchema), defaultValues: kept ? formOfPaidJob(kept) : draftBack?.form ?? BLANK_FORM, mode: "onSubmit",
  });
  const draft: DraftForm = useWatch({ control: form.control });
  const request = toWriteRequest(draft);
  usePointerDrift();

  const [salt] = useState(freshSalt);
  const writing = useCheckWriting(draftBack ?? {});
  const writeTheChecks = useWriteTheChecks(writing, request);
  const checksView = useChecksView({ writing, request, refusal: writeTheChecks.refusal, onWrite: writeTheChecks.write });
  const { sealed, error: sealError } = useSealedJob(draft, writing.written, salt);
  const hasWallet = useWalletPresent();
  const { post, steps, payment, published } = usePostJob(market, kept);
  const { status, payAndPost } = usePayAndPost({ form, request, written: writing.written, sealed, sealError, payment, post, published });
  useKeptDraft(market, {
    form: draft, ...(writing.written ? { written: writing.written } : {}), ...(writing.underWay ? { underWay: writing.underWay } : {}),
  }, kept !== undefined || payment !== undefined || status.kind === "posted");
  const startAgain = (): void => {
    draftStore.forget(market);
    writing.reset();
    form.reset(BLANK_FORM);
    setDraftBack(undefined);
  };

  const areChecksReady = isFresh(writing.written, request) && readyToSeal(writing.written?.checks ?? []);
  const progress = progressOf({ form: draft, areChecksReady, isPosted: status.kind === "posted" });
  // the seal flashes once for each set of checks that comes back proven: the set's start is its name
  const flash = writing.written && readyToSeal(writing.written.checks) ? writing.written.writtenAt : 0;
  const working: StepName | undefined = writing.stage ? "checks" : status.kind === "posting" ? "pay" : undefined;

  return (
    <div className="poster">
      <Bill progress={progress} working={working} flash={flash} />
      <FormProvider {...form}>
        <form id="post" className="sheets" noValidate onSubmit={(event) => void payAndPost(event)}>
          <ProgressStrip progress={progress} working={working} />
          {draftBack && <DraftBack onStartAgain={startAgain} />}
          <IdeaStep />
          <LinesStep lines="brief" />
          <LinesStep lines="exam" />
          <ChecksStep view={checksView} />
          <TermsStep coin={market.coin} />
          <PayStep
            market={market}
            payment={{
              price: priceInWei(draft.price) ?? 0n, mode: draft.mode ?? DEFAULT_MODE, hasWallet, sealed, status, steps,
              paid: payment, isSubmitting: form.formState.isSubmitting,
            }}
          />
        </form>
      </FormProvider>
    </div>
  );
}
