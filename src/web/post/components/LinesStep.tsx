import type { ReactElement } from "react";
import { LONGEST_STATEMENT } from "../../../checkwriting/request.ts";
import { useLines, type Lines } from "../hooks/useLines.ts";
import { COPY } from "../state/index.ts";
import { Step } from "./Step.tsx";

/** The brief or the exam: sentences, one to a line. */
export function LinesStep({ lines }: { readonly lines: Lines }): ReactElement {
  const { fields, register, hasRoom, hasExam, add, remove, addOnEnter } = useLines(lines);
  const copy = COPY[lines];

  return (
    <Step name={lines} title={copy.title} guide={copy.guide}>
      <ul className="lines" data-lines={lines}>
        {fields.map((field, index) => (
          <li className="line" key={field.id}>
            <input
              type="text"
              maxLength={LONGEST_STATEMENT}
              placeholder={index === 0 ? copy.placeholder : ""}
              aria-label={COPY.lines.fieldLabel(copy.title, index + 1)}
              onKeyDown={addOnEnter}
              {...register(`${lines}.${index}.says`)}
            />
            <button type="button" className="quiet" aria-label={COPY.lines.removeLabel(copy.title, index + 1)} onClick={() => remove(index)}>
              {COPY.lines.remove}
            </button>
          </li>
        ))}
      </ul>
      {hasRoom && <button type="button" className="quiet add" data-to={lines} onClick={add}>{COPY.lines.add}</button>}
      {lines === "exam" && !hasExam && <p className="note">{COPY.exam.none}</p>}
    </Step>
  );
}
