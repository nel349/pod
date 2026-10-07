/**
 * A model reached through OpenRouter, in the same shape as the one reached through the Claude CLI.
 *
 * One account there reaches models from many makers, and what a writing costs differs between them
 * by more than tenfold. Measured on 7 October 2026 on the seven briefs the writer is measured on,
 * Gemini 3.8 Flash, asked to think a little, proved 47 of 49 checks for 13 cents in all, where
 * Claude Sonnet proved 48 for about a dollar. Which model it is belongs to whoever runs the server
 * and pays for it, so it is a setting and nothing here prefers one.
 *
 * The key stays in this process. An agent in a box reaches a model only through the broker's socket,
 * as before, and never sees how the answer was fetched or what paid for it.
 */
import { z } from "zod";
import { ONLY_ANSWERS, type Model, type Spent } from "./broker.ts";

/** where OpenRouter is, and the one thing asked of it */
export const OPENROUTER = "https://openrouter.ai/api/v1";
const ANSWERS = "/chat/completions";

/** the most an answer may run to: the largest exam measured was under half of this */
const LONGEST_ANSWER_TOKENS = 32_000;
/** how much of a refusal is passed on */
const LONGEST_REFUSAL = 300;

export interface ThroughOpenRouter {
  readonly key: string;
  /** the model as OpenRouter lists it, such as `google/gemini-3.8-flash` */
  readonly model: string;
  /**
   * How hard the model thinks before it answers, in OpenRouter's words (`low`, `medium`, `high`).
   * Thinking is billed as output and is most of what an answer costs, and some models think until
   * the time allowed is gone. Left out, the model decides.
   */
  readonly thinking?: string;
  /** somewhere else to ask, which is OpenRouter everywhere but in its own test */
  readonly endpoint?: string;
}

const AnsweredSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable().optional() }) })).optional(),
  usage: z.object({
    prompt_tokens: z.number().optional(),
    completion_tokens: z.number().optional(),
    /** what the answer cost in dollars, which OpenRouter says when asked to */
    cost: z.number().optional(),
  }).optional(),
  error: z.object({ message: z.string().optional() }).optional(),
});

export function modelThroughOpenRouter(options: ThroughOpenRouter): Model {
  const { key, model, thinking } = options;
  const address = `${options.endpoint ?? OPENROUTER}${ANSWERS}`;
  return async (prompt, signal, spent) => {
    const response = await fetch(address, {
      method: "POST", signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model, max_tokens: LONGEST_ANSWER_TOKENS, usage: { include: true },
        ...(thinking ? { reasoning: { effort: thinking } } : {}),
        messages: [{ role: "system", content: ONLY_ANSWERS }, { role: "user", content: prompt }],
      }),
    });
    const printed = await response.text();
    const answered = whatItAnswered(printed);
    // it says why it refused in the body, with a status that is not always an error's
    if (!response.ok || answered?.refusal !== undefined) {
      throw new Error(`the model would not answer: ${(answered?.refusal ?? (printed.trim() || `status ${response.status}`)).slice(0, LONGEST_REFUSAL)}`);
    }
    if (!answered) throw new Error(`the model answered in a shape that could not be read: ${printed.trim().slice(0, LONGEST_REFUSAL)}`);
    if (answered.spent) spent?.({ ...answered.spent, model });
    if (answered.text.trim() === "") throw new Error("the model answered with nothing");
    return answered.text.trim();
  };
}

/** The answer OpenRouter sent, read out of its JSON, or nothing when what it sent is not that. */
function whatItAnswered(printed: string): { readonly text: string; readonly refusal?: string; readonly spent?: Omit<Spent, "model"> } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(printed);
  } catch {
    return undefined;
  }
  const read = AnsweredSchema.safeParse(parsed);
  if (!read.success) return undefined;
  const { choices, usage, error } = read.data;
  if (error) return { text: "", refusal: error.message ?? "it gave no reason" };
  const said = choices?.[0]?.message.content;
  if (said === undefined) return undefined;
  // what it cost is kept only when it was said: a writing's record does not guess at money
  const spent = usage?.cost !== undefined
    ? { calls: 1, dollars: usage.cost, tokensIn: usage.prompt_tokens ?? 0, tokensOut: usage.completion_tokens ?? 0 }
    : undefined;
  return { text: said ?? "", ...(spent ? { spent } : {}) };
}
