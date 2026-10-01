import { NameTakenSchema } from "../../../market.ts";
import { jobNamePath } from "../../../routes.ts";
import { readAnswer } from "../../shared/index.ts";

/** Whether the wall, or a job being prepared, already has this name. Asked, not assumed: the server is the authority. */
export async function isNameTaken(name: string): Promise<boolean> {
  const response = await fetch(jobNamePath(name), { cache: "no-store" });
  if (!response.ok) throw new Error(`the server said ${response.status}`);
  return (await readAnswer(response, NameTakenSchema)).taken;
}
