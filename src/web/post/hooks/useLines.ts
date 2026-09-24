import type { KeyboardEvent } from "react";
import { useFieldArray, useFormContext, useWatch, type FieldArrayWithId, type UseFormRegister } from "react-hook-form";
import { MOST_STATEMENTS } from "../../../checkwriting/request.ts";
import type { PostForm } from "../state/index.ts";

/** Which list of sentences: the one the builders see, or the one kept back. */
export type Lines = "brief" | "exam";

export interface LinesState {
  readonly fields: readonly FieldArrayWithId<PostForm, Lines>[];
  readonly register: UseFormRegister<PostForm>;
  /** whether another line fits: the brief and the exam share one limit, taken together */
  readonly hasRoom: boolean;
  /** whether the exam has anything in it yet, which decides whether to say a job may go without one */
  readonly hasExam: boolean;
  readonly add: () => void;
  readonly remove: (index: number) => void;
  /** Enter adds the next line, rather than submitting a form that ends in a payment */
  readonly addOnEnter: (event: KeyboardEvent<HTMLInputElement>) => void;
}

export function useLines(lines: Lines): LinesState {
  const { control, register } = useFormContext<PostForm>();
  const { fields, append, remove } = useFieldArray({ control, name: lines });
  const [brief, exam] = useWatch({ control, name: ["brief", "exam"] });
  const hasRoom = brief.length + exam.length < MOST_STATEMENTS;
  const add = (): void => append({ says: "" }, { shouldFocus: true });

  return {
    fields,
    register,
    hasRoom,
    hasExam: exam.some((line) => line.says.trim().length > 0),
    add,
    remove,
    addOnEnter: (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      if (hasRoom) add();
    },
  };
}
