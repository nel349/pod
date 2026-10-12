import type { ReactElement } from "react";
import { useFormContext } from "react-hook-form";
import { OFFERED_KINDS } from "../../../job.ts";
import { LONGEST_IDEA } from "../../../checkwriting/request.ts";
import { useIdeaField } from "../hooks/useIdeaField.ts";
import { useReferencesRead } from "../hooks/useReferencesRead.ts";
import { COPY, type PostForm } from "../state/index.ts";
import { Step } from "./Step.tsx";

/** What they want built, and whether it is a website or a service. */
export function IdeaStep(): ReactElement {
  const { register, formState } = useFormContext<PostForm>();
  const idea = useIdeaField();
  const references = useReferencesRead();
  const field = register("references", { onBlur: (event: { target: { value: string } }) => references.read(event.target.value) });
  return (
    <Step name="idea" title={<label htmlFor="idea">{COPY.idea.title}</label>}>
      <textarea id="idea" rows={3} maxLength={LONGEST_IDEA} placeholder={COPY.idea.placeholder} {...idea} />
      <fieldset className="kinds">
        <legend>{COPY.idea.kindLegend}</legend>
        {OFFERED_KINDS.map((kind) => (
          <label className="kind" key={kind}>
            <input type="radio" value={kind} {...register("kind")} />
            <span className="kind-name">{COPY.idea.kinds[kind].name}</span>
            <span className="kind-says">{COPY.idea.kinds[kind].says}</span>
          </label>
        ))}
      </fieldset>
      <label className="field references-field">
        <span>{COPY.references.title} <span className="optional">{COPY.references.optional}</span></span>
        <textarea id="references" rows={2} placeholder={COPY.references.placeholder} spellCheck={false} aria-describedby="references-says" {...field} />
      </label>
      <p id="references-says" className="note">{COPY.references.says}</p>
      {formState.errors.references?.message && <p className="said-status" role="status">{formState.errors.references.message}</p>}
      {references.isReading && <p id="references-read" className="note" role="status">{COPY.references.reading}</p>}
      {references.why && <p id="references-read" className="said-status" role="status">{COPY.references.notAsked(references.why)}</p>}
      {references.found && (
        <ul id="references-read" className="references-read" aria-live="polite">
          {references.found.map((one) => (
            <li key={one.link} data-ok={one.ok ? "" : undefined}>
              <span className="reference-link">{one.link}</span>
              <span className="reference-found">{one.ok ? COPY.references.kept(one.type, one.bytes) : COPY.references.refused(one.why)}</span>
            </li>
          ))}
        </ul>
      )}
    </Step>
  );
}
