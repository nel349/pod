import type { Written } from "../../../checkwriting/written.ts";
import { isFresh, verdictOn, writingLine, type DraftRequest, type Verdict, type WritingLine } from "../state/index.ts";
import type { CheckWritingState } from "./useCheckWriting.ts";
import { useElapsed } from "./useElapsed.ts";

/** Everything the checks step shows, worked out, so the step itself only draws it. */
export interface ChecksView {
  readonly line: WritingLine;
  readonly checks: readonly Written[];
  readonly verdict: Verdict | undefined;
  readonly isFresh: boolean;
  readonly isBusy: boolean;
  readonly hasWritten: boolean;
  readonly onWrite: () => void;
}

export function useChecksView(input: {
  readonly writing: CheckWritingState;
  readonly request: DraftRequest;
  readonly refusal: string | undefined;
  readonly onWrite: () => void;
}): ChecksView {
  const { writing, request, refusal, onWrite } = input;
  const seconds = useElapsed(writing.startedAt);
  const fresh = isFresh(writing.written, request);
  const checks = writing.written?.checks ?? [];
  const isBusy = writing.stage !== undefined;
  return {
    line: writingLine({ stage: writing.stage, seconds, error: writing.error, refusal }),
    checks,
    verdict: writing.written && !isBusy ? verdictOn(checks, fresh) : undefined,
    isFresh: fresh,
    isBusy,
    hasWritten: writing.written !== undefined,
    onWrite,
  };
}
