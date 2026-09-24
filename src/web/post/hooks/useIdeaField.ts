import { useFormContext, type UseFormRegisterReturn } from "react-hook-form";
import { nameFrom, type PostForm } from "../state/index.ts";

/**
 * The idea's field, registered with the form, which also suggests an address on the wall as the
 * poster types, until they type an address of their own.
 *
 * This happens in the change handler, where the change happens, rather than in an effect that
 * watches the idea afterwards: one render per keystroke instead of two, and no moment where the
 * two fields disagree.
 */
export function useIdeaField(): UseFormRegisterReturn<"idea"> {
  const { register, setValue, getFieldState } = useFormContext<PostForm>();
  return register("idea", {
    onChange: (event: { target: { value: string } }) => {
      if (getFieldState("name").isDirty) return;
      setValue("name", nameFrom(event.target.value), { shouldValidate: false, shouldDirty: false });
    },
  });
}
