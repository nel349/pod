/**
 * Posting, in order. One list, and everything that depends on the order reads it: the number stamped
 * on each sheet, the sheet's id, and the seal, whose five wedges and centre are these same six steps
 * finished. Reorder it here and all three follow.
 */
export const STEPS = ["idea", "brief", "exam", "checks", "terms", "pay"] as const;

export type StepName = (typeof STEPS)[number];

/** A step's place in posting, counting from one, which is what the sheet is stamped with. */
export const stepNumber = (name: StepName): number => STEPS.indexOf(name) + 1;

/** The element a step lives in, so it can be linked to and scrolled to. */
export const stepId = (name: StepName): string => `step-${name}`;
