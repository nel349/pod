/**
 * A posting not yet paid for, kept in the browser, so a poster who leaves the page and comes back
 * finds it as they left it, the checks it took minutes to write included.
 *
 * The checks stay good: the server keeps every check it proved, so checks written before the poster
 * left can still be posted after they return. Kept per chain and contract, like a kept payment, and
 * read through a schema, because a browser's storage is anybody's to edit: a draft that cannot be
 * read is ignored, and the page starts blank.
 */
import type { Address } from "viem";
import { z } from "zod";
import { KINDS, MODE_NAMES } from "../../../job.ts";
import { ROUTES } from "../../../routes.ts";
import { HowItIsAskedSchema, WrittenSchema } from "../../../checkwriting/written.ts";
import type { DraftForm } from "./form.ts";
import type { WrittenFor } from "./sealing.ts";

const LinesSchema = z.array(z.object({ says: z.string() }));

/** Where the page asks after checks still being written: only ever this server's own address for it */
const WRITING_ADDRESS = new RegExp(`^${ROUTES.writeChecks}/[0-9a-f-]{36}$`);

/**
 * Checks being written when the poster left. The server keeps what it wrote for an hour, so the page
 * that comes back asks at the same address rather than starting again.
 */
export interface WritingUnderWay {
  /** where to ask how it is going */
  readonly url: string;
  /** the request it is writing for, as `requestKey` spells it */
  readonly key: string;
  readonly startedAt: number;
}

const DraftSchema = z.object({
  version: z.literal(1),
  form: z.object({
    idea: z.string().optional(),
    // a choice nobody has made yet is kept by the form as null
    kind: z.enum(KINDS).nullish(),
    brief: LinesSchema.optional(),
    exam: LinesSchema.optional(),
    price: z.string().optional(),
    mode: z.enum(MODE_NAMES).optional(),
    name: z.string().optional(),
  }),
  written: z.object({
    key: z.string(),
    checks: z.array(WrittenSchema),
    howItIsAsked: HowItIsAskedSchema.optional(),
    writtenAt: z.number(),
  }).optional(),
  underWay: z.object({ url: z.string().regex(WRITING_ADDRESS), key: z.string(), startedAt: z.number() }).optional(),
});

export interface Draft {
  readonly form: DraftForm;
  /** the checks last written, and the request they were written for */
  readonly written?: WrittenFor;
  /** checks still being written, when the poster left while they were */
  readonly underWay?: WritingUnderWay;
}

/** Where a draft for this chain and contract is kept. */
export function draftKey(chainId: number, jobs: Address): string {
  return `pod.draft.${chainId}.${jobs.toLowerCase()}`;
}

export function keepDraft(draft: Draft): string {
  return JSON.stringify({
    version: 1, form: draft.form,
    ...(draft.written ? { written: draft.written } : {}),
    ...(draft.underWay ? { underWay: draft.underWay } : {}),
  });
}

/** Whether a draft has anything in it worth bringing back. */
export function isWorthKeeping(draft: Draft): boolean {
  const said = (lines: DraftForm["brief"]): boolean => (lines ?? []).some((line) => (line?.says ?? "").trim() !== "");
  return (draft.form.idea ?? "").trim() !== "" || said(draft.form.brief) || said(draft.form.exam) || draft.written !== undefined || draft.underWay !== undefined;
}

/** The kept draft, or nothing if there is none or it cannot be read. */
export function readDraft(text: string | null): Draft | undefined {
  if (text === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const draft = DraftSchema.safeParse(parsed);
  if (!draft.success) return undefined;
  const { form: { kind, ...form }, written, underWay } = draft.data;
  return { form: { ...form, ...(kind ? { kind } : {}) }, ...(written ? { written } : {}), ...(underWay ? { underWay } : {}) };
}
