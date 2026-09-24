import type { ReactElement } from "react";
import { useFormContext } from "react-hook-form";
import { KINDS } from "../../../job.ts";
import { LONGEST_IDEA } from "../../../checkwriting/request.ts";
import { useIdeaField } from "../hooks/useIdeaField.ts";
import { COPY, type PostForm } from "../state/index.ts";
import { Step } from "./Step.tsx";

/** What they want built, and whether it is a page or a service. */
export function IdeaStep(): ReactElement {
  const { register } = useFormContext<PostForm>();
  const idea = useIdeaField();
  return (
    <Step name="idea" title={<label htmlFor="idea">{COPY.idea.title}</label>}>
      <textarea id="idea" rows={3} maxLength={LONGEST_IDEA} placeholder={COPY.idea.placeholder} {...idea} />
      <fieldset className="kinds">
        <legend>{COPY.idea.kindLegend}</legend>
        {KINDS.map((kind) => (
          <label className="kind" key={kind}>
            <input type="radio" value={kind} {...register("kind")} />
            <span className="kind-name">{COPY.idea.kinds[kind].name}</span>
            <span className="kind-says">{COPY.idea.kinds[kind].says}</span>
          </label>
        ))}
      </fieldset>
    </Step>
  );
}
