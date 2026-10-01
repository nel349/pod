import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { AnswerSchema } from "../../../market.ts";
import { PreparingOnTheWireSchema, preparingFromTheWire, type PreparingView } from "../../../preparing/records.ts";
import { preparingPath } from "../../../routes.ts";
import { readAnswer } from "../../shared/index.ts";
import { QUERY_KEYS } from "./queryKeys.ts";

/** how often the page asks how the writing is going while it happens */
const ASK_EVERY_MS = 1500;

/**
 * What the server says about the job, for its poster, followed while a writing is waiting or under way.
 * Asked only while the job prepares: once it is approved or taken back the server has nothing more to
 * say, and what it said last is kept.
 */
export function usePreparedView(onChainId: string, authorization: string | undefined, isPreparing: boolean): UseQueryResult<PreparingView, Error> {
  return useQuery({
    queryKey: QUERY_KEYS.prepared(onChainId, authorization),
    enabled: authorization !== undefined && isPreparing,
    retry: false,
    queryFn: async (): Promise<PreparingView> => {
      const response = await fetch(preparingPath(onChainId), { cache: "no-store", headers: { authorization: authorization ?? "" } });
      if (!response.ok) {
        const answer = await readAnswer(response, AnswerSchema).catch(() => ({ why: undefined }));
        throw new PreparedRefused(response.status, answer.why ?? `the server said ${response.status}`);
      }
      return preparingFromTheWire(await readAnswer(response, PreparingOnTheWireSchema));
    },
    refetchInterval: (query) => (query.state.data && query.state.data.now.kind !== "idle" ? ASK_EVERY_MS : false),
  });
}

/** The server would not show the job: not the poster, a note that ran out, or no such job here. */
export class PreparedRefused extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
