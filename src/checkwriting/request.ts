/**
 * What a poster asks the check writer for, and what it may not be.
 *
 * One schema, used by the poster's browser and by the server, so the form refuses exactly what the
 * server would refuse and in the same words. A poster told one thing by the page and another by the
 * server stops trusting both.
 */
import { z } from "zod";
import { KINDS } from "../job.ts";

/** The limits on what a poster may ask for, which are also what one writer's run can carry. */
export const MOST_STATEMENTS = 8;
export const LONGEST_STATEMENT = 280;
export const LONGEST_IDEA = 2000;
export const SHORTEST_IDEA = 12;
export const SHORTEST_STATEMENT = 6;

export const StatementSchema = z.object({
  says: z.string().trim()
    .min(SHORTEST_STATEMENT, "each thing that would prove it is a sentence")
    .max(LONGEST_STATEMENT, `keep each one under ${LONGEST_STATEMENT} characters`),
  /** true for the exam, which the pod does not see until there is a verdict */
  secret: z.boolean({ error: "each one is either in the brief or in the exam" }),
});

export const WriteRequestSchema = z.object({
  idea: z.string({ error: "say what you want built, in a sentence or more" }).trim()
    .min(SHORTEST_IDEA, "say what you want built, in a sentence or more")
    .max(LONGEST_IDEA, `keep what you want built under ${LONGEST_IDEA} characters`),
  kind: z.enum(KINDS, { error: "say whether it is a page or a service" }),
  statements: z.array(StatementSchema, { error: "say at least one thing that would prove it works" })
    .min(1, "say at least one thing that would prove it works")
    .max(MOST_STATEMENTS, `at most ${MOST_STATEMENTS} things, so each one is checked properly`)
    .refine(
      (statements) => new Set(statements.map((statement) => statement.says.trim().toLowerCase())).size === statements.length,
      "each line says something different: the same line twice would only be checked twice",
    ),
});

export type Statement = z.infer<typeof StatementSchema>;
export type WriteRequest = z.infer<typeof WriteRequestSchema>;

/** Why a request cannot be written, in words for the person who made it, or nothing if it can. */
export function refusalOf(request: unknown): string | undefined {
  const parsed = WriteRequestSchema.safeParse(request);
  return parsed.success ? undefined : parsed.error.issues[0]?.message;
}
