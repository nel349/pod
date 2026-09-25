/**
 * A job about coats, and what a check writer might hand back for it.
 *
 * The model is the one thing the check-writing tests do not run for real: what is under test is what
 * the platform does with whatever the writer hands over. These are the replies a good writer, a lazy
 * one and a dishonest one would give, written out so the platform can be shown to tell them apart by
 * running them.
 */
import type { Model } from "../../broker.ts";
import type { CheckWriter, WriteRequest } from "../../checkwriting/index.ts";
import { IMAGE } from "../../sandbox.ts";

export const AGENTS = new URL("../../../agents", import.meta.url).pathname;

export const COAT_IDEA = "A service that tells me whether to take a coat, given whether it is raining";
export const WET = "When it is raining, it tells me to take a coat";
export const DRY = "When it is dry, it tells me I do not need one";

/** The brief says what happens in the rain; the exam, kept back, says what happens when it is dry. */
export const COAT_REQUEST: WriteRequest = {
  idea: COAT_IDEA,
  kind: "service",
  statements: [{ says: WET, secret: false }, { says: DRY, secret: true }],
};

export const serverSaying = (wet: string, dry: string): string => `require("http").createServer((request, response) => {
  const rain = new URL(request.url, "http://x").searchParams.get("rain");
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ coat: rain === "yes" ? ${wet} : ${dry} }));
}).listen(3000);`;

export const WORKING = serverSaying("true", "false");

const checkThat = (rain: string, coat: boolean): string => `const answer = await (await fetch(process.env.TARGET + "/?rain=${rain}")).json().catch(() => ({}));
if (answer.coat !== ${coat}) { console.log("rain=${rain} said coat=" + answer.coat); process.exit(1); }
console.log("rain=${rain} said coat=${coat}");`;

/** What a good writer hands back for each of the two sentences. */
export const good = (i: 0 | 1) => i === 0
  ? { checkable: true, asks: "Asks while it is raining", expects: "Take a coat", check: checkThat("yes", true),
    nearMiss: "It never says take a coat", nearMissServer: serverSaying("false", "false") }
  : { checkable: true, asks: "Asks while it is dry", expects: "No coat needed", check: checkThat("no", false),
    nearMiss: "It always says take a coat", nearMissServer: serverSaying("true", "true") };

export const GOOD_REPLY = { working: WORKING, checks: [good(0), good(1)] };

const asAnswer = (reply: unknown): string => (typeof reply === "string" ? reply : "```json\n" + JSON.stringify(reply) + "\n```");

/** A model that answers every prompt the same way, and counts how often it was asked. */
export function replying(reply: unknown): { readonly model: Model; readonly asked: () => number } {
  return replyingInTurn(reply);
}

/**
 * A model that gives these answers in order, repeating the last, and keeps every prompt it was sent,
 * so a test can see what the writer asked the second time as well as how often it asked.
 */
export function replyingInTurn(...replies: readonly unknown[]): {
  readonly model: Model;
  readonly asked: () => number;
  readonly prompts: () => readonly string[];
} {
  const prompts: string[] = [];
  return {
    model: async (prompt) => {
      prompts.push(prompt);
      return asAnswer(replies[Math.min(prompts.length, replies.length) - 1]);
    },
    asked: () => prompts.length,
    prompts: () => prompts,
  };
}

export const writerWith = (model: Model): CheckWriter => ({ model, image: IMAGE, agents: AGENTS });
