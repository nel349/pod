/**
 * Posting, in order. One list, and everything that depends on the order reads it: the number stamped
 * on each sheet, the sheet's id, and the seal, whose five wedges and centre are these same six steps
 * finished. Reorder it here and all three follow.
 */
export const STEPS = ["idea", "brief", "exam", "checks", "terms", "pay"] as const;

/**
 * Posting on a contract that prepares jobs: the poster pays before the checks are written, and
 * approving them is what finishes the job, so it is the seal's centre.
 */
export const PAY_FIRST_STEPS = ["idea", "brief", "exam", "terms", "pay", "approve"] as const;

export type StepName = (typeof STEPS)[number] | (typeof PAY_FIRST_STEPS)[number];

/** Either order: five steps for the seal's five wedges, and the one that puts its centre in place. */
export type StepOrder = typeof STEPS | typeof PAY_FIRST_STEPS;

/** A step's place in posting, counting from one, which is what the sheet is stamped with. */
export const stepNumber = (name: StepName, order: StepOrder = STEPS): number => (order as readonly StepName[]).indexOf(name) + 1;

/** The element a step lives in, so it can be linked to and scrolled to. */
export const stepId = (name: StepName): string => `step-${name}`;
