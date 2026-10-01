/**
 * A job paid for, on its own page: /post/<number>. Its poster follows the checks being written, says a
 * line another way and has them written again, approves them, or takes the money back.
 *
 * It needs nothing kept in the browser: the chain says whose job it is and where it stands, and the
 * server shows what was written to that wallet once it signs a note. So the poster can come back from
 * any browser, with their wallet.
 */
import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { FormProvider, useForm, useWatch, type UseFormReturn } from "react-hook-form";
import { formatEther } from "viem";
import type { MarketConfig } from "../../market.ts";
import { ApproveStep, Bill, IdeaStep, LinesStep, ProgressStrip, StepOrderContext, YourJobSheet, type Viewer } from "./components/index.ts";
import {
  PreparedRefused, useBusySince, useChainJobV2, useElapsed, usePointerDrift, usePosterNote, usePreparedActions, usePreparedView,
} from "./hooks/index.ts";
import { useConfig } from "wagmi";
import { connected, useConnectedAccount } from "../shared/index.ts";
import {
  BLANK_FORM, COPY, formOfRequest, isThePoster, lastAsked, latestWriting, needsTopUp, nowLine, PAY_FIRST_STEPS, preparedProgressOf,
  requestKey, standingOf, toWriteRequest, whyNotApprove, writingVerdict, type DraftForm, type PostForm, type Progress, type StepName,
} from "./state/index.ts";

/** how the HTTP answer for a note that no longer lets the poster in reads */
const UNAUTHORISED = 401;
/** how the HTTP answer reads for a paid job this server was never sent the lines of */
const NOT_HERE = 404;

export function PreparedJobPage({ market, onChainId }: { readonly market: MarketConfig; readonly onChainId: string }): ReactElement {
  usePointerDrift();
  const config = useConfig();
  const account = useConnectedAccount();
  const chain = useChainJobV2(market, onChainId);
  const job = chain.data ?? undefined;
  const isPoster = job !== undefined && isThePoster(job, account);
  const note = usePosterNote(market, onChainId, isPoster ? account : undefined);
  const prepared = usePreparedView(onChainId, note.authorization, job !== undefined && standingOf(job) === "preparing");
  const view = prepared.data;
  const actions = usePreparedActions({ market, onChainId, view, job, authorization: note.authorization });

  // a note that ran out is forgotten, so the button to sign another comes back
  const refusal = prepared.error instanceof PreparedRefused ? prepared.error.status : undefined;
  const { forget } = note;
  useEffect(() => {
    if (refusal === UNAUTHORISED) forget();
  }, [refusal, forget]);

  // the lines start as the poster last asked for them, once, when the job is first read
  const form = useForm<PostForm>({ defaultValues: BLANK_FORM });
  const [linesFor, setLinesFor] = useState<string>();
  const asked = view ? lastAsked(view) : undefined;
  useEffect(() => {
    if (!asked || linesFor === onChainId) return;
    form.reset({ ...BLANK_FORM, ...formOfRequest(asked) });
    setLinesFor(onChainId);
  }, [asked, linesFor, onChainId, form]);
  const draft: DraftForm = useWatch({ control: form.control });
  const request = toWriteRequest(draft);

  const since = useBusySince(view?.now);
  const seconds = useElapsed(since);

  if (chain.isPending) return <PreparedSheets form={form} progress={preparedProgressOf("preparing")}><section className="sheet notice"><p>{COPY.loading}</p></section></PreparedSheets>;
  if (!job) {
    return <PreparedSheets form={form} progress={preparedProgressOf("preparing")}><section className="sheet notice"><p>{chain.error?.message ?? COPY.prepared.noSuchJob(onChainId)}</p></section></PreparedSheets>;
  }

  const standing = standingOf(job);
  const viewer: Viewer = account === undefined ? "noWallet" : !isPoster ? "notYours" : note.authorization ? "poster" : "unsigned";
  const writing = view ? latestWriting(view) : undefined;
  const isBusy = view !== undefined && (view.now.kind !== "idle" || view.asked !== undefined);
  const isFresh = writing !== undefined && requestKey(request) === requestKey(writing.request);
  const writeAgain = view && needsTopUp(view.money)
    ? COPY.prepared.topUpAndWrite(`${formatEther(view.money.writingPrice)} ${market.coin}`)
    : COPY.prepared.writeAgain;

  return (
    <PreparedSheets form={form} progress={preparedProgressOf(standing)} working={isBusy ? "approve" : undefined}>
      <YourJobSheet
        market={market}
        job={{
          onChainId, job, standing, viewer, view, action: actions.status, isSigning: note.isSigning,
          problem: note.error ?? problemOf(refusal, standing, prepared.error?.message),
        }}
        on={{ connect: () => void connected(config).catch(() => undefined), sign: note.sign, takeBack: actions.takeBack }}
      />
      {/* drawn once the poster's own lines are in, so nothing jumps under their finger as they arrive */}
      {standing === "preparing" && view && linesFor === onChainId && (
        <>
          <IdeaStep />
          <LinesStep lines="brief" />
          <LinesStep lines="exam" />
          <ApproveStep
            view={{
              line: nowLine(view.now, seconds), writing, verdict: writing ? writingVerdict(writing, request) : undefined,
              isFresh, whyNot: whyNotApprove(writing, request), isBusy, writeAgain, action: actions.status,
            }}
            onWriteAgain={() => actions.writeAgain(request)}
            onApprove={actions.approve}
          />
        </>
      )}
    </PreparedSheets>
  );
}

/** What to say about the server not showing the job: nothing once it moved on, or why, in the poster's words. */
function problemOf(refusal: number | undefined, standing: string, said: string | undefined): string | undefined {
  if (refusal === UNAUTHORISED || standing !== "preparing") return undefined;
  return refusal === NOT_HERE ? COPY.prepared.notSetUp : said;
}

/** The poster on the left and the sheets on the right, in the pay-first order, around one form. */
function PreparedSheets({ form, children, progress, working }: {
  readonly form: UseFormReturn<PostForm>;
  readonly children: ReactNode;
  readonly progress: Progress;
  readonly working?: StepName;
}): ReactElement {
  return (
    <StepOrderContext.Provider value={PAY_FIRST_STEPS}>
      <div className="poster">
        <Bill progress={progress} working={working} />
        <FormProvider {...form}>
          <form id="post" className="sheets" noValidate onSubmit={(event) => event.preventDefault()}>
            <ProgressStrip progress={progress} working={working} />
            {children}
          </form>
        </FormProvider>
      </div>
    </StepOrderContext.Provider>
  );
}
