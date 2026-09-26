import { useQuery } from "@tanstack/react-query";
import { yoursApiPath } from "../../../routes.ts";
import { readAnswer } from "../../shared/index.ts";
import { YoursViewSchema, type YoursView } from "../views/index.ts";
import { SITE_QUERY_KEYS } from "./queryKeys.ts";

export type YoursState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly why: string }
  | { readonly kind: "read"; readonly yours: YoursView };

async function fetchYours(address: string): Promise<YoursView> {
  const response = await fetch(yoursApiPath(address));
  if (!response.ok) throw new Error(`the server said ${response.status}`);
  return await readAnswer(response, YoursViewSchema);
}

/** What a wallet posted and holds, as the server reads it from the chain and its own records. */
export function useYours(address: string): YoursState {
  const answer = useQuery({ queryKey: SITE_QUERY_KEYS.yours(address), queryFn: () => fetchYours(address) });
  if (answer.isPending) return { kind: "loading" };
  if (answer.isError) return { kind: "failed", why: answer.error.message };
  return { kind: "read", yours: answer.data };
}
