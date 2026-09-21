/**
 * The one thing an agent is allowed to reach.
 *
 * An agent needs a model and nothing else. So it runs with no network at all, and the only way out
 * of its box is a unix socket mounted into it: a file, not a route. On the other side is this, on
 * the machine, holding whatever credential the model needs — which therefore never enters the box,
 * cannot be read out of it, and cannot be spent by anything but the broker.
 *
 * What the broker enforces, because an agent cannot be trusted to:
 *
 *   a cap on how many times a seat may ask, so a loop cannot run up a bill
 *   a cap on how much it may send, so a prompt cannot carry a repository
 *   a deadline, so a hung model does not hold a seat for ever
 *   a transcript, so what the agent was told and what it answered is evidence like anything else
 *
 * The model itself is one function. In tests it is a program that answers predictably; in a real run
 * it is Claude, through the CLI that is already signed in on this machine.
 */
import { unlink } from "node:fs/promises";

export interface Exchange {
  readonly at: string;
  readonly role: string;
  readonly asked: string;
  readonly answered: string;
  readonly seconds: number;
}

export interface BrokerLimits {
  /** how many times one seat may ask. A seat that needs more than this is stuck, not thinking */
  readonly calls: number;
  /** how much one prompt may carry */
  readonly characters: number;
  readonly seconds: number;
}

export const SENSIBLE: BrokerLimits = { calls: 24, characters: 60_000, seconds: 180 };

/** What actually answers. Given a prompt, hands back text, and knows nothing about sockets. */
export type Model = (prompt: string) => Promise<string>;

export interface Broker {
  readonly socket: string;
  readonly transcript: readonly Exchange[];
  readonly stop: () => Promise<void>;
}

/**
 * Claude, through the CLI this machine is already signed in with.
 *
 * No API key: the credential stays wherever the CLI keeps it, and the agent never sees it. Because
 * it is a subscription rather than a key, a run costs what the subscription costs, and the call cap
 * above is what stops a bad agent spending it.
 */
export function claudeOnThisMachine(): Model {
  return async (prompt: string) => {
    const child = Bun.spawn(["claude", "-p", prompt], { stdout: "pipe", stderr: "pipe" });
    const [answer, said] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if ((await child.exited) !== 0) throw new Error(`the model would not answer: ${said.slice(0, 300)}`);
    return answer.trim();
  };
}

/**
 * Open the socket an agent talks to.
 *
 * It answers one thing: a prompt, and the text that came back. There is no other route and no other
 * verb, because the smaller this is, the less there is to get wrong.
 */
export async function openBroker(input: {
  readonly socket: string;
  readonly role: string;
  readonly model: Model;
  readonly limits?: Partial<BrokerLimits>;
}): Promise<Broker> {
  const limits = { ...SENSIBLE, ...input.limits };
  const transcript: Exchange[] = [];
  let asked = 0;

  await unlink(input.socket).catch(() => {});

  const server = Bun.serve({
    unix: input.socket,
    async fetch(request) {
      if (request.method !== "POST") return new Response("ask with POST\n", { status: 405 });

      const prompt = await request.text();
      if (prompt.length > limits.characters) {
        return Response.json({ error: `a prompt may carry ${limits.characters} characters` }, { status: 413 });
      }
      if (++asked > limits.calls) {
        return Response.json({ error: `this seat has already asked ${limits.calls} times` }, { status: 429 });
      }

      const started = Date.now();
      try {
        const answered = await Promise.race([
          input.model(prompt),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("the model took too long")), limits.seconds * 1000)),
        ]);
        transcript.push({
          at: new Date().toISOString(), role: input.role, asked: prompt, answered,
          seconds: (Date.now() - started) / 1000,
        });
        return Response.json({ text: answered });
      } catch (error) {
        const why = (error as Error).message;
        transcript.push({
          at: new Date().toISOString(), role: input.role, asked: prompt, answered: `(nothing: ${why})`,
          seconds: (Date.now() - started) / 1000,
        });
        return Response.json({ error: why }, { status: 502 });
      }
    },
  });

  return {
    socket: input.socket,
    get transcript() { return transcript; },
    stop: async () => {
      server.stop(true);
      await unlink(input.socket).catch(() => {});
    },
  };
}
