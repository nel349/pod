/**
 * Writing the checks, and following along while it happens.
 *
 * Starting is one request; the server answers with where to ask how it is going, and the page asks
 * until the checks are written or the writing failed. Everything the server says is read through a
 * schema. The last checks that came back are kept while the poster edits, so the page can show them
 * as out of date rather than making them vanish.
 */
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ROUTES } from "../../../routes.ts";
import { AnswerSchema } from "../../../market.ts";
import type { WriteRequest } from "../../../checkwriting/request.ts";
import { isStillWriting, WritingSchema, type Stage, type Writing } from "../../../checkwriting/written.ts";
import { COPY, requestKey, type WritingUnderWay, type WrittenFor } from "../state/index.ts";
import { QUERY_KEYS } from "./queryKeys.ts";
import { readAnswer } from "../../shared/index.ts";

/** How often the page asks how the writing is going, and how long it waits in all. */
const ASK_EVERY_MS = 1500;
const GIVE_UP_AFTER_MS = 12 * 60_000;

type Run = WritingUnderWay;

export interface CheckWritingState {
  readonly start: (request: WriteRequest) => void;
  /** forget the checks written so far, as when the poster starts again */
  readonly reset: () => void;
  /** what is happening now, while it happens */
  readonly stage: Stage | undefined;
  readonly startedAt: number | undefined;
  /** the last checks that came back, and the request they were written for */
  readonly written: WrittenFor | undefined;
  /** the writing still under way, which a draft keeps so a page that comes back can ask after it */
  readonly underWay: WritingUnderWay | undefined;
  readonly error: string | undefined;
}

async function begin(request: WriteRequest): Promise<{ readonly url: string }> {
  const response = await fetch(ROUTES.writeChecks, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
  });
  const answer = await readAnswer(response, AnswerSchema);
  if (!response.ok || !answer.url) throw new Error(answer.why ?? `the server said ${response.status}`);
  return { url: answer.url };
}

async function howItIsGoing(run: Run | undefined): Promise<Writing> {
  if (!run) throw new Error(COPY.checks.lost);
  if (Date.now() - run.startedAt > GIVE_UP_AFTER_MS) throw new Error(COPY.checks.tooLong);
  const response = await fetch(run.url, { cache: "no-store" });
  if (response.status === 404) throw new Error(COPY.checks.lost);
  if (!response.ok) throw new Error(`the server said ${response.status}`);
  return readAnswer(response, WritingSchema);
}

/** @param restored what a draft kept: checks written before the poster left, and any still being written */
export function useCheckWriting(restored: { readonly written?: WrittenFor; readonly underWay?: WritingUnderWay } = {}): CheckWritingState {
  const [run, setRun] = useState<Run | undefined>(restored.underWay);
  const [startedAt, setStartedAt] = useState<number | undefined>(restored.underWay?.startedAt);
  const [written, setWritten] = useState<WrittenFor | undefined>(restored.written);
  const [lastSeen, setLastSeen] = useState<Writing>();

  const starting = useMutation({
    mutationFn: begin,
    onSuccess: ({ url }, request) => setRun({ url, key: requestKey(request), startedAt: startedAt ?? Date.now() }),
  });

  const progress = useQuery({
    queryKey: QUERY_KEYS.checkWriting(run?.url),
    queryFn: () => howItIsGoing(run),
    enabled: run !== undefined,
    retry: false,
    // ask again while the writing is under way; stop once it is done, failed, or the asking itself failed
    refetchInterval: (query) => {
      if (query.state.status === "error") return false;
      return query.state.data === undefined || isStillWriting(query.state.data) ? ASK_EVERY_MS : false;
    },
  });

  // Keep the last written checks when they arrive. This is adjusting state while rendering, as React
  // recommends for state that follows another value, rather than an effect that renders twice: the
  // query shares structure, so `writing` only changes identity when what the server said changed.
  const writing = progress.data;
  if (writing !== lastSeen) {
    setLastSeen(writing);
    if (writing?.stage === "written" && run) {
      setWritten({ key: run.key, checks: writing.checks, writtenAt: run.startedAt, ...(writing.howItIsAsked ? { howItIsAsked: writing.howItIsAsked } : {}) });
    }
  }

  const failed = writing?.stage === "failed" ? writing.why : undefined;
  const error = starting.error?.message ?? progress.error?.message ?? failed;
  const isBusy = starting.isPending || (run !== undefined && !error && (writing === undefined || isStillWriting(writing)));

  return {
    start: (request) => { setRun(undefined); setStartedAt(Date.now()); starting.mutate(request); },
    reset: () => { setRun(undefined); setStartedAt(undefined); setWritten(undefined); starting.reset(); },
    stage: !isBusy ? undefined : isStillWriting(writing) ? writing.stage : "writing",
    startedAt: isBusy ? startedAt : undefined,
    written,
    underWay: isBusy ? run : undefined,
    error: isBusy ? undefined : error,
  };
}
