import { useState } from "react";
import { WriteRequestSchema } from "../../../checkwriting/request.ts";
import { asSentence, COPY, type DraftRequest } from "../state/index.ts";
import type { CheckWritingState } from "./useCheckWriting.ts";

interface WriteTheChecks {
  /** why the last press did not start the writing, in the poster's words */
  readonly refusal: string | undefined;
  readonly write: () => void;
}

/**
 * Pressing "write the checks": the request is checked by the same schema the server uses, so a poster
 * who has not said enough is told what is missing here, before anything is sent.
 */
export function useWriteTheChecks(writing: CheckWritingState, request: DraftRequest): WriteTheChecks {
  const [refusal, setRefusal] = useState<string>();
  const write = (): void => {
    const parsed = WriteRequestSchema.safeParse(request);
    if (!parsed.success) {
      setRefusal(asSentence(parsed.error.issues[0]?.message ?? COPY.problems.noLines));
      return;
    }
    setRefusal(undefined);
    writing.start(parsed.data);
  };
  return { refusal, write };
}
