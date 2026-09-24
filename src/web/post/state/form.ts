/**
 * The posting form: what the poster fills in, and what of it goes to the check writer.
 *
 * The sentences are validated by the same schema the server uses, so nothing is refused here that
 * the server would accept, or the other way round.
 */
import { z } from "zod";
import { parseEther } from "viem";
import type { DeepPartial, DefaultValues } from "react-hook-form";
import { DEFAULT_MODE, KINDS, MODE_NAMES, type Kind } from "../../../job.ts";
import { WALL_NAME } from "../../../routes.ts";
import { MOST_STATEMENTS, StatementSchema, WriteRequestSchema } from "../../../checkwriting/request.ts";
import { COPY } from "./copy.ts";

/** how many words of the idea a suggested address keeps */
const WORDS_IN_A_NAME = 6;

/** A line in the brief or the exam, as the form holds it: possibly still empty. */
const LineSchema = z.object({ says: z.string() });

export const PostFormSchema = z.object({
  idea: WriteRequestSchema.shape.idea,
  kind: z.enum(KINDS, { error: COPY.problems.kind }),
  brief: z.array(LineSchema).max(MOST_STATEMENTS),
  exam: z.array(LineSchema).max(MOST_STATEMENTS),
  price: z.string().refine((price) => priceInWei(price) !== undefined, COPY.problems.price),
  mode: z.enum(MODE_NAMES),
  name: z.string().regex(WALL_NAME, COPY.problems.name),
}).superRefine((form, context) => {
  const lines = [...filled(form.brief), ...filled(form.exam)];
  if (lines.length === 0) context.addIssue({ code: "custom", path: ["brief"], message: COPY.problems.noLines });
  if (lines.length > MOST_STATEMENTS) context.addIssue({ code: "custom", path: ["exam"], message: COPY.problems.tooManyLines });
  for (const says of lines) {
    const line = StatementSchema.shape.says.safeParse(says);
    if (!line.success) context.addIssue({ code: "custom", path: ["brief"], message: line.error.issues[0]?.message ?? COPY.problems.noLines });
  }
});

/** The form, complete and valid: what a posting is built from. */
export type PostForm = z.infer<typeof PostFormSchema>;

/** The form as it stands while the poster is still filling it in: anything may be missing yet. */
export type DraftForm = DeepPartial<PostForm>;

/** What the check writer would be asked for right now, which may not yet be a request it would take. */
export interface DraftRequest {
  readonly idea: string;
  readonly kind: Kind | undefined;
  readonly statements: readonly { readonly says: string; readonly secret: boolean }[];
}

/** A blank form, with one empty line in each list so the poster can see where to write. No kind is chosen for them. */
export const BLANK_FORM: DefaultValues<PostForm> = {
  idea: "",
  brief: [{ says: "" }],
  exam: [{ says: "" }],
  price: "0.1",
  mode: DEFAULT_MODE,
  name: "",
};

/** A price as the poster typed it, in wei, or nothing when it is not an amount more than zero. */
export function priceInWei(price: string | undefined): bigint | undefined {
  try {
    const wei = parseEther((price ?? "").trim() || "0");
    return wei > 0n ? wei : undefined;
  } catch {
    // not a number at all, which is the same answer as zero: not a price
    return undefined;
  }
}

const filled = (lines: readonly (DeepPartial<{ says: string }> | undefined)[] | undefined): string[] =>
  (lines ?? []).map((line) => line?.says?.trim() ?? "").filter(Boolean);

/** What the check writer would be asked for: the idea, what it is, and every line in order, brief first. */
export function toWriteRequest(form: DraftForm): DraftRequest {
  return {
    idea: (form.idea ?? "").trim(),
    kind: form.kind,
    statements: [
      ...filled(form.brief).map((says) => ({ says, secret: false })),
      ...filled(form.exam).map((says) => ({ says, secret: true })),
    ],
  };
}

/** The same request, as a key: two requests are the same request exactly when their keys are equal. */
export const requestKey = (request: DraftRequest): string => JSON.stringify(request);

/** An address for the wall, from the idea, for as long as the poster has not typed one of their own. */
export function nameFrom(idea: string): string {
  return idea.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").split("-").slice(0, WORDS_IN_A_NAME).join("-");
}
