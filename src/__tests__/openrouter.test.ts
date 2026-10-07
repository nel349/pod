import { afterEach, describe, expect, test } from "bun:test";
import { ONLY_ANSWERS, type Spent } from "../broker.ts";
import { modelThroughOpenRouter } from "../openrouter.ts";
import { CHECKS_MODEL_SETTING, CHECKS_THINKING_SETTING, OPENROUTER_KEY_SETTING, checksModelInWords, checksModelNamed } from "../services.ts";

/**
 * The model reached through OpenRouter, asked for real over HTTP.
 *
 * What stands in for OpenRouter is a server on a real port that answers in OpenRouter's shape, so
 * everything between the writer and the wire is the code that runs in production: the request that
 * is built, the answer that is read, and what is done when the answer is a refusal or nothing.
 */

type Reply = { readonly status?: number; readonly body: unknown; readonly afterMs?: number };
const standing: { stop(): void }[] = [];
afterEach(() => { for (const one of standing.splice(0)) one.stop(); });

/** A stand-in for OpenRouter that answers every request the same way, and keeps what it was sent. */
function openRouterSaying(reply: Reply): { readonly endpoint: string; readonly asked: { headers: Headers; body: Record<string, unknown>; path: string }[] } {
  const asked: { headers: Headers; body: Record<string, unknown>; path: string }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      asked.push({ headers: request.headers, body: await request.json() as Record<string, unknown>, path: new URL(request.url).pathname });
      if (reply.afterMs) await Bun.sleep(reply.afterMs);
      return new Response(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { "content-type": "application/json" } });
    },
  });
  standing.push({ stop: () => { void server.stop(true); } });
  return { endpoint: `http://localhost:${server.port}/api/v1`, asked };
}

const answering = (content: string | null, usage?: Record<string, number>): Reply => ({ body: { choices: [{ message: { content } }], ...(usage ? { usage } : {}) } });
const MODEL = "google/gemini-3.8-flash";
const patient = (): AbortSignal => AbortSignal.timeout(5_000);

describe("a model reached through OpenRouter", () => {
  test("it is asked with the key, the model named, our one line of instruction and the prompt, and its answer comes back trimmed", async () => {
    const { endpoint, asked } = openRouterSaying(answering("  forty-two\n"));
    const model = modelThroughOpenRouter({ key: "the-key", model: MODEL, endpoint });

    expect(await model("what is six times seven?", patient())).toBe("forty-two");

    expect(asked).toHaveLength(1);
    expect(asked[0]?.path).toBe("/api/v1/chat/completions");
    expect(asked[0]?.headers.get("authorization")).toBe("Bearer the-key");
    expect(asked[0]?.body.model).toBe(MODEL);
    expect(asked[0]?.body.messages).toEqual([{ role: "system", content: ONLY_ANSWERS }, { role: "user", content: "what is six times seven?" }]);
    // how hard to think is said only when whoever runs the server said it
    expect(asked[0]?.body.reasoning).toBeUndefined();
  });

  test("how hard it thinks is passed on when it is set, because thinking is most of what an answer costs", async () => {
    const { endpoint, asked } = openRouterSaying(answering("yes"));
    await modelThroughOpenRouter({ key: "k", model: MODEL, thinking: "low", endpoint })("?", patient());
    expect(asked[0]?.body.reasoning).toEqual({ effort: "low" });
  });

  test("what the answer cost is reported when OpenRouter says, under the model that was asked for", async () => {
    const { endpoint, asked } = openRouterSaying(answering("yes", { prompt_tokens: 1200, completion_tokens: 4500, cost: 0.018 }));
    const cost: Spent[] = [];
    await modelThroughOpenRouter({ key: "k", model: MODEL, endpoint })("?", patient(), (spent) => cost.push(spent));
    expect(cost).toEqual([{ model: MODEL, calls: 1, tokensIn: 1200, tokensOut: 4500, dollars: 0.018 }]);
    // and it was asked to say, or the record of a writing would hold no cost at all
    expect(asked[0]?.body.usage).toEqual({ include: true });
  });

  test("an answer with no cost on it reports none, and does not guess at money", async () => {
    const { endpoint } = openRouterSaying(answering("yes", { prompt_tokens: 10, completion_tokens: 2 }));
    const cost: Spent[] = [];
    await modelThroughOpenRouter({ key: "k", model: MODEL, endpoint })("?", patient(), (spent) => cost.push(spent));
    expect(cost).toEqual([]);
  });

  test("a refusal is a failure that says why in OpenRouter's own words, as when the account has no credit", async () => {
    const { endpoint } = openRouterSaying({ status: 402, body: { error: { message: "Insufficient credits. Add more at the billing page." } } });
    const model = modelThroughOpenRouter({ key: "k", model: MODEL, endpoint });
    await expect(model("?", patient())).rejects.toThrow("the model would not answer: Insufficient credits. Add more at the billing page.");
  });

  test("a refusal sent with a status that says all is well is still a refusal", async () => {
    // OpenRouter passes on a maker's error inside a 200 when the maker failed after it had begun
    const { endpoint } = openRouterSaying({ body: { error: { message: "Reasoning is mandatory for this model" } } });
    await expect(modelThroughOpenRouter({ key: "k", model: MODEL, endpoint })("?", patient())).rejects.toThrow("the model would not answer: Reasoning is mandatory for this model");
  });

  test("an answer of nothing is a failure, not an answer", async () => {
    for (const nothing of ["", "   \n", null]) {
      const { endpoint } = openRouterSaying(answering(nothing));
      await expect(modelThroughOpenRouter({ key: "k", model: MODEL, endpoint })("?", patient())).rejects.toThrow("the model answered with nothing");
    }
  });

  test("something that is not an answer at all is said to be unreadable, with what it was", async () => {
    const { endpoint } = openRouterSaying({ body: "<html>bad gateway</html>" });
    await expect(modelThroughOpenRouter({ key: "k", model: MODEL, endpoint })("?", patient())).rejects.toThrow("the model answered in a shape that could not be read: <html>bad gateway</html>");
  });

  test("a model past its deadline is stopped waiting for, and the request is let go", async () => {
    const { endpoint } = openRouterSaying({ ...answering("too late"), afterMs: 2_000 });
    const started = Date.now();
    await expect(modelThroughOpenRouter({ key: "k", model: MODEL, endpoint })("?", AbortSignal.timeout(150))).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1_500);
  });
});

describe("which model writes the checks, from the settings", () => {
  test("nothing set leaves it to the CLI, and the first lines say that nobody chose", () => {
    const chosen = checksModelNamed({});
    expect(chosen).toEqual({ through: "cli" });
    expect(checksModelInWords(chosen)).toBe(`whichever model the CLI chooses (${CHECKS_MODEL_SETTING} names none), through the CLI on this machine`);
  });

  test("a plain name is the CLI's, with how hard it thinks when that is set", () => {
    const chosen = checksModelNamed({ [CHECKS_MODEL_SETTING]: " claude-sonnet-5-5 ", [CHECKS_THINKING_SETTING]: "low" });
    expect(chosen).toEqual({ through: "cli", model: "claude-sonnet-5-5", thinking: "low" });
    expect(checksModelInWords(chosen)).toBe("claude-sonnet-5-5, thinking low, through the CLI on this machine");
  });

  test("a name that starts openrouter: is OpenRouter's, asked with its key, and the key is never in the words", () => {
    const chosen = checksModelNamed({ [CHECKS_MODEL_SETTING]: `openrouter:${MODEL}`, [CHECKS_THINKING_SETTING]: "low", [OPENROUTER_KEY_SETTING]: "sk-or-secret" });
    expect(chosen).toEqual({ through: "openrouter", model: MODEL, key: "sk-or-secret", thinking: "low" });
    expect(checksModelInWords(chosen)).toBe(`${MODEL}, thinking low, through OpenRouter`);
    expect(checksModelInWords(chosen)).not.toContain("sk-or-secret");
  });

  test("a model of OpenRouter's with no key is refused when the server starts, not when a poster has paid", () => {
    expect(() => checksModelNamed({ [CHECKS_MODEL_SETTING]: `openrouter:${MODEL}` })).toThrow(`${OPENROUTER_KEY_SETTING} holds no key`);
    expect(() => checksModelNamed({ [CHECKS_MODEL_SETTING]: "openrouter:", [OPENROUTER_KEY_SETTING]: "k" })).toThrow("names no model after it");
  });
});
