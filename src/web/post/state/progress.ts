/**
 * How far along posting is, as the seal shows it.
 *
 * The seal is the wall's seal: five wedges, one per seat, and a centre. Each step the poster finishes
 * pulls one wedge into place; paying locks the centre. So the picture on the left is not decoration:
 * it is a true account of how much of the job exists yet.
 */
import { MOST_STATEMENTS } from "../../../checkwriting/request.ts";
import { PostFormSchema, toWriteRequest, type DraftForm } from "./form.ts";
import { COPY } from "./copy.ts";
import { STEPS, type StepName, type StepOrder } from "./steps.ts";

export interface Progress {
  /** the order the steps come in, which is also which piece of the seal each one is */
  readonly order: StepOrder;
  /** which steps are finished, which is which pieces of the seal are in place */
  readonly placed: ReadonlySet<StepName>;
  /** the first step not yet finished, which is what the poster should do next */
  readonly next: StepName | undefined;
  readonly isComplete: boolean;
  /** the one thing to do next, in words, under the seal */
  readonly nextSays: string;
}

/** Whether the seal's centre is in place: the last step, which finishes the job. */
export const isSealed = (progress: Progress): boolean => progress.placed.has(progress.order[progress.order.length - 1] ?? "pay");

/** How far along, given which steps are finished, in the order they come. */
export function progressIn(order: StepOrder, placed: ReadonlySet<StepName>, words: Readonly<Partial<Record<StepName | "done", string>>>): Progress {
  const next = (order as readonly StepName[]).find((step) => !placed.has(step));
  return { order, placed, next, isComplete: placed.size === order.length, nextSays: words[next ?? "done"] ?? "" };
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

  return progressIn(STEPS, placed, COPY.next);
}
