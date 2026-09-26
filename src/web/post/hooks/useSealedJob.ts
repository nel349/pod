import { useQuery } from "@tanstack/react-query";
import { firstLine } from "../../../errors.ts";
import { PostFormSchema, sealJob, toWriteRequest, whatIsMissing, type DraftForm, type SealedJob, type WrittenFor } from "../state/index.ts";
import { QUERY_KEYS } from "./queryKeys.ts";

export interface SealedState {
  /** the job as it would be sealed right now, or nothing while something is still missing */
  readonly sealed: SealedJob | undefined;
  /** why sealing failed, when it did: the poster is told this, not that their checks are unproven */
  readonly error: string | undefined;
}

/**
 * The job as it would be sealed right now.
 *
 * Sealing hashes, which is asynchronous in a browser, so it is a query keyed by everything that goes
 * into the seal: change any of it and the seal is made again. That includes which writing produced
 * the checks, not only what was asked: writing the same request twice gives a different set of
 * checks, and the one paid for must be the one on the page.
 */
export function useSealedJob(draft: DraftForm, written: WrittenFor | undefined, salt: string): SealedState {
  const form = PostFormSchema.safeParse(draft);
  const readyToSeal = form.success && written !== undefined && !whatIsMissing(written, toWriteRequest(draft))
    ? { form: form.data, checks: written.checks, howItIsAsked: written.howItIsAsked }
    : undefined;
  const sealing = useQuery({
    queryKey: QUERY_KEYS.sealed([draft.idea, draft.kind, draft.mode, draft.price, written?.key, written?.writtenAt, salt]),
    queryFn: () => (readyToSeal
      ? sealJob(readyToSeal.form, readyToSeal.checks, salt, readyToSeal.howItIsAsked)
      : Promise.reject(new Error("nothing to seal yet"))),
    enabled: readyToSeal !== undefined,
    staleTime: Infinity,
    retry: false,
  });
  if (!readyToSeal) return { sealed: undefined, error: undefined };
  return { sealed: sealing.data, error: sealing.error ? firstLine(sealing.error) : undefined };
}
