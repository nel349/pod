/**
 * What comes back from writing and trying the checks.
 *
 * Shared by the server that produces it and the page that shows it, so both agree on what a proven
 * check is. Written as schemas rather than bare types because it crosses the network: the page
 * checks what it was sent rather than trusting it, and the types are read off the same schemas so
 * the two can never drift apart. Nothing here may reach for the machine.
 */
import { z } from "zod";

/**
 * What trying one check found. Each is true only when the check did what it has to.
 *
 * A check is tried once before it can be sealed: against a server with nothing built. What it is
 * worth against real work is found out when the pod's work is graded, which is what the pod is for.
 */
export const ProofSchema = z.object({
  /** it failed when nothing was built, so it does not pay for no work */
  nothing: z.boolean(),
  /**
   * Its own program loads. A program that does not fails against anything, so its failing against
   * nothing built is no trial, and no work could pass it. Absent on a writing from before this was asked.
   */
  loads: z.boolean().optional(),
  /**
   * Only on writings kept from before 11 Oct 2026, when a check was also tried against a version
   * written for the purpose and one with that sentence's thing wrong. Such a writing stays as it was
   * judged then.
   */
  working: z.boolean().optional(),
  nearMiss: z.boolean().optional(),
});

const SawSchema = z.object({ nothing: z.string(), working: z.string().optional(), nearMiss: z.string().optional() });

export const WrittenSchema = z.discriminatedUnion("checkable", [
  z.object({
    checkable: z.literal(false),
    says: z.string(),
    secret: z.boolean(),
    /** what the writer suggests instead, in words the poster can act on */
    why: z.string(),
    /**
     * A sentence kept from the builders that asks for something they are never told. A program could
     * check it, and no honest pod could build for it, so it is refused before the job can open: left in,
     * its poster could look at the work and refuse it for nothing.
     */
    untold: z.boolean().optional(),
  }),
  z.object({
    checkable: z.literal(true),
    says: z.string(),
    secret: z.boolean(),
    /** what the check does to the work, in everyday words */
    asks: z.string(),
    /** what a good answer looks like, in everyday words */
    expects: z.string(),
    /** what the sentence asks for that this check does not decide, when there is anything: a real payment, how it looks */
    leavesOut: z.string().optional(),
    file: z.string(),
    source: z.string(),
    proof: ProofSchema,
    /** what the check printed when it was tried, which is what a poster reads when the trial fails */
    saw: SawSchema,
  }),
]);

/** How the checks ask for what the poster's words left open: see HowItIsAsked in job.ts */
export const HowItIsAskedSchema = z.object({ plainly: z.string().min(1), exactly: z.string().min(1) });

/** Where the writing is, for the page to show while the poster waits. */
export const STAGES = ["writing", "trying"] as const;

export const WritingSchema = z.discriminatedUnion("stage", [
  z.object({ stage: z.enum(STAGES) }),
  z.object({
    stage: z.literal("written"),
    checks: z.array(WrittenSchema).readonly(),
    /** how the checks ask for what the poster left open, when they had to */
    howItIsAsked: HowItIsAskedSchema.optional(),
    ready: z.boolean(),
  }),
  z.object({ stage: z.literal("failed"), why: z.string() }),
]);

export type Proof = z.infer<typeof ProofSchema>;
/** What writing the checks comes back with: one entry per sentence, and how they ask, when they had to */
export interface WrittenSet {
  readonly checks: readonly Written[];
  readonly howItIsAsked?: z.infer<typeof HowItIsAskedSchema>;
}
export type Written = z.infer<typeof WrittenSchema>;
/** A sentence that became a check and was tried, whether or not it held. */
export type TriedCheck = Extract<Written, { readonly checkable: true }>;
export type Stage = (typeof STAGES)[number];
export type Writing = z.infer<typeof WritingSchema>;

/** Whether the writing is still under way: the one place that says which stages count as that. */
export function isStillWriting(writing: Writing | undefined): writing is Extract<Writing, { stage: Stage }> {
  return writing !== undefined && STAGES.some((stage) => stage === writing.stage);
}

/** Whether a sentence became a check that held in every trial it was given. */
export function isProven(check: Written): check is TriedCheck {
  return check.checkable && check.proof.loads !== false && check.proof.nothing && check.proof.working !== false && check.proof.nearMiss !== false;
}

/** Whether every sentence became a check that held in its trial. */
export function readyToSeal(checks: readonly Written[]): boolean {
  return checks.length > 0 && checks.every(isProven);
}
