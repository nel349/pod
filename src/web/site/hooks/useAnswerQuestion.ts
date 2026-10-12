import { useMutation, useQueryClient } from "@tanstack/react-query";
import { isAddress } from "viem";
import { useConfig } from "wagmi";
import { signMessage } from "wagmi/actions";
import { firstLine } from "../../../errors.ts";
import { answerMessage } from "../../../messages.ts";
import { questionsPath } from "../../../routes.ts";
import { connected } from "../../shared/index.ts";
import { SITE_QUERY_KEYS } from "./queryKeys.ts";

export type QuestionAnswerStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "working" }
  | { readonly kind: "sent" }
  | { readonly kind: "stopped"; readonly why: string };

/**
 * A poster's answer to one question their pod asked: a sentence their own wallet signs, which costs
 * nothing and moves no money, sent to the server that checks it is theirs. Every seat then reads it.
 */
export function useAnswerQuestion(job: { readonly jobId: string; readonly onChainId: string; readonly jobs: string }, question: string): {
  readonly status: QuestionAnswerStatus;
  readonly answer: (says: string) => void;
} {
  const config = useConfig();
  const client = useQueryClient();
  const answering = useMutation({
    mutationFn: async (says: string) => {
      if (!isAddress(job.jobs)) throw new Error("this job names no contract, so nobody can answer on it here");
      const poster = await connected(config);
      const at = Math.floor(Date.now() / 1000);
      const signature = await signMessage(config, {
        account: poster,
        message: answerMessage({ jobId: job.jobId, onChainId: job.onChainId, jobs: job.jobs, question, says, at }),
      });
      const sent = await fetch(questionsPath(job.jobId), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ question, says, at, poster, signature }),
      });
      if (!sent.ok) {
        const refused: unknown = await sent.json().catch(() => undefined);
        const why = typeof refused === "object" && refused !== null && "why" in refused && typeof refused.why === "string" ? refused.why : `the server said ${sent.status}`;
        throw new Error(why);
      }
    },
    onSuccess: () => void client.invalidateQueries({ queryKey: SITE_QUERY_KEYS.job(job.jobId) }),
  });
  const status: QuestionAnswerStatus = answering.isPending ? { kind: "working" }
    : answering.isSuccess ? { kind: "sent" }
    : answering.isError ? { kind: "stopped", why: firstLine(answering.error) }
    : { kind: "idle" };
  return { status, answer: (says) => answering.mutate(says) };
}
