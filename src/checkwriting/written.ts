/**
 * What comes back from writing and trying the checks.
 *
 * Shared by the server that produces it and the page that shows it, so both agree on what a proven
 * check is. Written as schemas rather than bare types because it crosses the network: the page
 * checks what it was sent rather than trusting it, and the types are read off the same schemas so
 * the two can never drift apart. Nothing here may reach for the machine.
 */
import { z } from "zod";

/** What trying one check found. Each is true only when the check did what it has to. */
export const ProofSchema = z.object({
  /** it passed a version that does everything asked, so it can be passed at all */
  working: z.boolean(),
  /** it failed a version with exactly its one thing wrong, so it catches that mistake */
  nearMiss: z.boolean(),
  /** it failed when nothing was built, so it does not pay for no work */
  nothing: z.boolean(),
});

const SawSchema = z.object({ working: z.string(), nearMiss: z.string(), nothing: z.string() });

export const WrittenSchema = z.discriminatedUnion("checkable", [
  z.object({
    checkable: z.literal(false),
    says: z.string(),
    secret: z.boolean(),
    /** what the writer suggests instead, in words the poster can act on */
    why: z.string(),
  }),
  z.object({
    checkable: z.literal(true),
    says: z.string(),
    secret: z.boolean(),
    /** what the check does to the work, in everyday words */
    asks: z.string(),
    /** what a good answer looks like, in everyday words */
    expects: z.string(),
    /** the mistake the near miss makes, which is what this check is known to catch */
    nearMiss: z.string(),
    file: z.string(),
    source: z.string(),
    proof: ProofSchema,
    /** what the check printed each time, which is what a poster reads when a trial fails */
    saw: SawSchema,
  }),
]);

/** Where the writing is, for the page to show while the poster waits. */
export const STAGES = ["writing", "trying"] as const;

export const WritingSchema = z.discriminatedUnion("stage", [
  z.object({ stage: z.enum(STAGES) }),
  z.object({ stage: z.literal("written"), checks: z.array(WrittenSchema).readonly(), ready: z.boolean() }),
  z.object({ stage: z.literal("failed"), why: z.string() }),
]);

export type Proof = z.infer<typeof ProofSchema>;
export type Written = z.infer<typeof WrittenSchema>;
/** A sentence that became a check and was tried, whether or not it passed its trials. */
export type TriedCheck = Extract<Written, { readonly checkable: true }>;
export type Stage = (typeof STAGES)[number];
export type Writing = z.infer<typeof WritingSchema>;

/** Whether the writing is still under way: the one place that says which stages count as that. */
export function isStillWriting(writing: Writing | undefined): writing is Extract<Writing, { stage: Stage }> {
  return writing !== undefined && STAGES.some((stage) => stage === writing.stage);
}

/** Whether a sentence became a check that passed all three trials. */
export function isProven(check: Written): check is TriedCheck {
  return check.checkable && check.proof.working && check.proof.nearMiss && check.proof.nothing;
}

/** Whether every sentence became a check that passed all three of its trials. */
export function readyToSeal(checks: readonly Written[]): boolean {
  return checks.length > 0 && checks.every(isProven);
}
