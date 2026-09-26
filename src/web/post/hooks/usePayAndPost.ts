import { useRef, useState, type BaseSyntheticEvent } from "react";
import type { UseFormReturn } from "react-hook-form";
import { firstLine } from "../../../errors.ts";
import { NameTakenSchema } from "../../../market.ts";
import { z } from "zod";
import { jobNamePath, jobPath, refundApiPath } from "../../../routes.ts";
import {
  asSentence, canPress, COPY, NoWallet, PostingStopped, whatIsMissing,
  type DraftRequest, type PayStatus, type Payment, type PostForm, type SealedJob, type WrittenFor,
} from "../state/index.ts";
import { readAnswer } from "../../shared/index.ts";
import type { PostJobState } from "./usePostJob.ts";

interface PayAndPost {
  readonly status: PayStatus;
  /** the form's submit handler: checks everything is in place, then pays and posts, or finishes a paid job */
  readonly payAndPost: (event?: BaseSyntheticEvent) => Promise<void>;
}

/**
 * Pressing "pay and post". In order: everything the form itself must be, then the checks, then that
 * the name on the wall is free, and only then the payment. Everything that could stop the posting
 * and can be known in advance is found out before any money moves.
 *
 * Once a payment exists, pressing again finishes that job instead: the checks and the seal are the
 * ones already paid for, and only the name, which is the poster's to change, is asked about again.
 */
export function usePayAndPost(input: {
  readonly form: UseFormReturn<PostForm>;
  readonly request: DraftRequest;
  readonly written: WrittenFor | undefined;
  readonly sealed: SealedJob | undefined;
  /** why the job could not be sealed, if it could not */
  readonly sealError: string | undefined;
  readonly payment: Payment | undefined;
  readonly post: PostJobState["post"];
  readonly published: PostJobState["published"];
}): PayAndPost {
  const { form, request, written, sealed, sealError, payment, post, published } = input;
  const [status, setStatus] = useState<PayStatus>({ kind: "idle" });
  // set before the first wait, so a second press, or Enter held down, cannot start a second posting
  const inFlight = useRef(false);

  const payAndPost = form.handleSubmit(
    async (valid) => {
      if (inFlight.current || !canPress(status)) return;
      inFlight.current = true;
      const release = (): void => { inFlight.current = false; };

      const job = payment?.sealed ?? sealed;
      const missing = payment ? undefined : whatIsMissing(written, request);
      if (missing || !job) {
        const why = missing ?? (sealError ? COPY.problems.cannotSeal(sealError) : COPY.problems.notProven);
        setStatus({ kind: "idle", problem: asSentence(why) });
        release();
        return;
      }
      try {
        // the paid job may be on the wall already, published from another tab or just before a reload:
        // that is done, not a name somebody else took
        if (payment?.onChainId !== undefined && (await isOnTheWallAs(valid.name, payment.onChainId))) {
          published();
          setStatus({ kind: "posted", url: jobPath(valid.name) });
          release();
          return;
        }
        if (await isNameTaken(valid.name)) {
          setStatus({ kind: "idle", problem: asSentence(COPY.problems.nameTaken(valid.name)) });
          release();
          return;
        }
      } catch (error) {
        setStatus({ kind: "idle", problem: asSentence(COPY.problems.nameUnknown(firstLine(error))) });
        release();
        return;
      }

      setStatus({ kind: "posting" });
      post({ sealed: job, name: valid.name }, {
        onSuccess: ({ url }) => setStatus({ kind: "posted", url }),
        onError: (error) => setStatus(stoppedBy(error)),
        onSettled: release,
      });
    },
    (errors) => {
      const first = Object.values(errors).flatMap((error) => (error?.message ? [error.message] : []))[0];
      setStatus({ kind: "idle", problem: first === undefined ? undefined : asSentence(first) });
    },
  );

  return { status, payAndPost };
}

/** Whether the job on the wall by this name is this one on the contract. */
async function isOnTheWallAs(name: string, onChainId: string): Promise<boolean> {
  const response = await fetch(refundApiPath(name), { cache: "no-store" });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`the server said ${response.status}`);
  return (await readAnswer(response, OnTheWallSchema)).onChainId === onChainId;
}

const OnTheWallSchema = z.object({ onChainId: z.string() });

/** Whether the wall already has a job by this name. Asked, not assumed: the wall is the authority. */
async function isNameTaken(name: string): Promise<boolean> {
  const response = await fetch(jobNamePath(name), { cache: "no-store" });
  if (!response.ok) throw new Error(`the server said ${response.status}`);
  return (await readAnswer(response, NameTakenSchema)).taken;
}

/** What the page says when posting stopped: nothing sent, or paid, safe, and how to finish. */
function stoppedBy(error: Error): PayStatus {
  if (error instanceof NoWallet) return { kind: "idle", problem: COPY.pay.noWallet };
  const hasPaid = error instanceof PostingStopped && error.hasPaid;
  return {
    kind: "stopped",
    hasPaid,
    why: `${asSentence(error.message)} ${hasPaid ? COPY.pay.failedAfterPaying : COPY.pay.failedBeforePublish}`,
  };
}
