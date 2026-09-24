/**
 * How far along posting is, as the seal shows it.
 *
 * The seal is the wall's seal: five wedges, one per seat, and a centre. Each step the poster finishes
 * pulls one wedge into place; paying locks the centre. So the picture on the left is not decoration:
 * it is a true account of how much of the job exists yet.
 */
import { MOST_STATEMENTS } from "../../../checkwriting/request.ts";
import { PostFormSchema, toWriteRequest, type DraftForm } from "./form.ts";
import { STEPS, type StepName } from "./steps.ts";

export interface Progress {
  /** which steps are finished, which is which pieces of the seal are in place */
  readonly placed: ReadonlySet<StepName>;
  /** the first step not yet finished, which is what the poster should do next */
  readonly next: StepName | undefined;
  readonly isComplete: boolean;
}

export function progressOf(input: {
  readonly form: DraftForm;
  /** the checks were written for what is asked now, and every one passed its trials */
  readonly areChecksReady: boolean;
  readonly isPosted: boolean;
}): Progress {
  const { form, areChecksReady, isPosted } = input;
  const shape = PostFormSchema.shape;
  const { statements } = toWriteRequest(form);
  const placed = new Set<StepName>();

  if (shape.idea.safeParse(form.idea).success && shape.kind.safeParse(form.kind).success) placed.add("idea");
  if (statements.some((line) => !line.secret) && statements.length <= MOST_STATEMENTS) placed.add("brief");
  if (statements.some((line) => line.secret)) placed.add("exam");
  if (areChecksReady) placed.add("checks");
  if (shape.price.safeParse(form.price).success && shape.name.safeParse(form.name).success) placed.add("terms");
  if (isPosted) placed.add("pay");

  return { placed, next: STEPS.find((step) => !placed.has(step)), isComplete: placed.size === STEPS.length };
}
