import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeOnThisMachine, ONLY_ANSWERS, openBroker, SENSIBLE, type Broker, type Spent } from "../broker.ts";
import { runSeat } from "../agent.ts";
import { openRepository } from "../repo.ts";
import { dockerAvailable } from "./support/tools.ts";

/**
 * The one thing an agent is allowed to reach.
 *
 * The model here is a function rather than Claude, because what is being tested is the boundary: an
 * agent with no network at all can still ask, cannot ask more than it was allowed, cannot send more
 * than it was allowed, and everything it asked is on the record afterwards.
 *
 * Swap the function for the real one and none of these change.
 */

const IMAGE = "node@sha256:9bef0ef1e268f60627da9ba7d7605e8831d5b56ad07487d24d1aa386336d1944";

const withDocker = await dockerAvailable();

let open: Broker | undefined;
afterEach(async () => { await open?.stop(); open = undefined; });

async function brokerSaying(answer: (prompt: string) => string, limits = {}): Promise<Broker> {
  const socket = join(await mkdtemp(join(tmpdir(), "pod-broker-")), "model.sock");
  open = await openBroker({ socket, role: "builder", model: async (p) => answer(p), limits });
  return open;
}

/** An agent that asks the model what to write, and writes it. */
const asksTheModel = `node -e '
  const http = require("http");
  const fs = require("fs");
  const ask = (prompt) => new Promise((resolve, reject) => {
    const request = http.request({ socketPath: process.env.POD_MODEL, path: "/", method: "POST" }, (response) => {
      let body = ""; response.on("data", (d) => body += d);
      response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    });
    request.on("error", reject);
    request.end(prompt);
  });
  ask(fs.readFileSync(process.env.POD_BRIEF, "utf8")).then((answer) => {
    if (answer.status !== 200) {
      fs.writeFileSync(process.env.POD_SAY, JSON.stringify({ decision: "refuse", why: "the model said no: " + answer.body.error }));
      return;
    }
    fs.writeFileSync("/work/server.js", answer.body.text);
    fs.writeFileSync(process.env.POD_SAY, JSON.stringify({ decision: "shipped", why: "wrote what the model said" }));
  });
'`;

describe("what the broker allows", () => {
  test("it answers one prompt with one answer", async () => {
    const broker = await brokerSaying((prompt) => `you asked: ${prompt}`);
    const response = await fetch("http://model/", {
      method: "POST", body: "hello", unix: broker.socket,
    } as RequestInit & { unix: string });
    expect(await response.json()).toEqual({ text: "you asked: hello" });
  });

  test("a seat that asks too many times is stopped, not billed", async () => {
    const broker = await brokerSaying(() => "fine", { calls: 2 });
    const ask = () => fetch("http://model/", { method: "POST", body: "x", unix: broker.socket } as RequestInit & { unix: string });
    expect((await ask()).status).toBe(200);
    expect((await ask()).status).toBe(200);
    const third = await ask();
    expect(third.status).toBe(429);
    expect((await third.json() as { error: string }).error).toContain("already asked 2 times");
    // and the one that was refused is not counted as an exchange that happened
    expect(broker.transcript).toHaveLength(2);
  });

  test("a prompt that carries a repository is refused before the model sees it", async () => {
    let sawIt = false;
    const broker = await brokerSaying(() => { sawIt = true; return "fine"; }, { characters: 100 });
    const response = await fetch("http://model/", {
      method: "POST", body: "x".repeat(101), unix: broker.socket,
    } as RequestInit & { unix: string });
    expect(response.status).toBe(413);
    expect(sawIt).toBe(false);
  });

  test("a model that hangs is given up on, and the giving up is on the record", async () => {
    const broker = await brokerSaying(() => { throw new Error("no"); });
    const response = await fetch("http://model/", { method: "POST", body: "x", unix: broker.socket } as RequestInit & { unix: string });
    expect(response.status).toBe(502);
    expect(broker.transcript[0]?.answered).toContain("nothing:");
  });

  test("only answers the model gave are counted as answered, which is what a writing is charged by", async () => {
    let turn = 0;
    const broker = await brokerSaying(() => { if (turn++ === 1) throw new Error("no"); return "fine"; });
    const ask = () => fetch("http://model/", { method: "POST", body: "x", unix: broker.socket } as RequestInit & { unix: string });
    expect((await ask()).status).toBe(200);
    expect((await ask()).status).toBe(502);
    expect((await ask()).status).toBe(200);
    expect(broker.transcript).toHaveLength(3);
    expect(broker.answered).toBe(2);
  });

  test("an answer that lands just as the deadline passes is still counted as answered, though it is not handed on", async () => {
    const socket = join(await mkdtemp(join(tmpdir(), "pod-broker-")), "model.sock");
    open = await openBroker({
      socket, role: "checkwriter", limits: { seconds: 1 },
      // it answers the moment it is told to stop: it did the work, too late to be used
      model: (_prompt, signal) => new Promise<string>((resolve) => { signal.addEventListener("abort", () => resolve("too late")); }),
    });
    const response = await fetch("http://model/", { method: "POST", body: "x", unix: socket } as RequestInit & { unix: string });
    expect(response.status).toBe(502);
    expect(open.answered).toBe(1);
  });

  test("a model past its deadline is told to stop, not only stopped waiting for", async () => {
    const socket = join(await mkdtemp(join(tmpdir(), "pod-broker-")), "model.sock");
    let wasTold = false;
    open = await openBroker({
      socket, role: "builder", limits: { seconds: 1 },
      model: (_prompt, signal) => new Promise<string>((resolve) => {
        signal.addEventListener("abort", () => { wasTold = true; resolve("too late"); });
      }),
    });
    const response = await fetch("http://model/", { method: "POST", body: "x", unix: socket } as RequestInit & { unix: string });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "the model took too long" });
    expect(wasTold).toBe(true);
  });

  test("the sensible limits are sensible", () => {
    expect(SENSIBLE.calls).toBeLessThanOrEqual(50);
    expect(SENSIBLE.seconds).toBeLessThanOrEqual(600);
  });
});

describe("the model, when the program behind it misbehaves", () => {
  /**
   * A stand-in for the CLI, because what is under test is how its answer is read, not Claude: a
   * program that does what the real one was seen doing, finishing successfully with nothing said,
   * and one that fails outright.
   */
  async function aStandIn(script: string): Promise<string> {
    const folder = await mkdtemp(join(tmpdir(), "pod-standin-"));
    const cli = join(folder, "claude");
    await writeFile(cli, `#!/bin/sh\ncat > /dev/null\n${script}\n`);
    await chmod(cli, 0o755);
    return cli;
  }

  /** What the real CLI prints for one answer: a line of JSON, with the answer and its bill. */
  const printing = (answer: Record<string, unknown>): string => `cat <<'JSON'\n${JSON.stringify(answer)}\nJSON`;

  test("an answer of nothing is a failure, not an answer", async () => {
    const silent = claudeOnThisMachine({ cli: await aStandIn(printing({ result: "" })) });
    await expect(silent("say something", AbortSignal.timeout(10_000))).rejects.toThrow("the model answered with nothing");
    const blank = claudeOnThisMachine({ cli: await aStandIn(printing({ result: "  \n\n" })) });
    await expect(blank("say something", AbortSignal.timeout(10_000))).rejects.toThrow("the model answered with nothing");
    // and a program that finishes having printed nothing at all, or something that is not an answer
    const mute = claudeOnThisMachine({ cli: await aStandIn("exit 0") });
    await expect(mute("say something", AbortSignal.timeout(10_000))).rejects.toThrow("the model answered in a shape that could not be read");
    const chatty = claudeOnThisMachine({ cli: await aStandIn("echo 'a coat, today'") });
    await expect(chatty("say something", AbortSignal.timeout(10_000))).rejects.toThrow("could not be read: a coat, today");
  });

  test("a program that fails says why", async () => {
    const failing = claudeOnThisMachine({ cli: await aStandIn("echo 'not signed in' >&2; exit 1") });
    await expect(failing("say something", AbortSignal.timeout(10_000))).rejects.toThrow("the model would not answer: not signed in");
    // the CLI says why where its answer would have been, and may warn about something else beside it,
    // in colour: the reason is what is passed on, first and in plain text (6 Oct, an account out of credit)
    const broke = claudeOnThisMachine({ cli: await aStandIn("echo 'Credit balance is too low'; printf '\\033[33mconnectors are disabled\\033[39m' >&2; exit 1") });
    await expect(broke("say something", AbortSignal.timeout(10_000))).rejects.toThrow("the model would not answer: Credit balance is too low · connectors are disabled");
    // the same refusal inside the JSON it answers with, whatever it exits with
    const refused = claudeOnThisMachine({ cli: await aStandIn(printing({ result: "Credit balance is too low", is_error: true })) });
    await expect(refused("say something", AbortSignal.timeout(10_000))).rejects.toThrow("the model would not answer: Credit balance is too low");
  });

  test("a real answer comes back as it was said, without the space around it, and with what it cost", async () => {
    const answering = claudeOnThisMachine({ cli: await aStandIn(printing({
      result: "\n  a coat, today  \n", is_error: false, total_cost_usd: 0.0123,
      usage: { input_tokens: 9, output_tokens: 41, cache_creation_input_tokens: 500, cache_read_input_tokens: 70 },
      modelUsage: { "claude-of-some-kind": { costUSD: 0.0123 } },
    })) });
    const cost: Spent[] = [];
    expect(await answering("say something", AbortSignal.timeout(10_000), (spent) => cost.push(spent))).toBe("a coat, today");
    // everything it was sent counts as sent, kept from an earlier call or not
    expect(cost).toEqual([{ model: "claude-of-some-kind", calls: 1, tokensIn: 579, tokensOut: 41, dollars: 0.0123 }]);
    // an answer that carries no bill is still an answer, and nothing is made up for it
    const unbilled = claudeOnThisMachine({ cli: await aStandIn(printing({ result: "a coat, today" })) });
    expect(await unbilled("say something", AbortSignal.timeout(10_000), (spent) => cost.push(spent))).toBe("a coat, today");
    expect(cost).toHaveLength(1);
  });

  test("it is started with its own instructions replaced, and with the model its runner named, or none", async () => {
    // a stand-in that answers with how it was started
    const echoing = `printf '{"result":"%s"}' "$*"`;
    const named = await claudeOnThisMachine({ cli: await aStandIn(echoing), model: "claude-of-some-kind" })("say something", AbortSignal.timeout(10_000));
    expect(named).toContain(`--system-prompt ${ONLY_ANSWERS}`);
    expect(named).toEndWith("--model claude-of-some-kind");
    const unnamed = await claudeOnThisMachine({ cli: await aStandIn(echoing) })("say something", AbortSignal.timeout(10_000));
    expect(unnamed).not.toContain("--model");
  });
});

describe.skipIf(!withDocker)("an agent with a model and no network", () => {
  test("it can ask, and everything it asked is on the record", async () => {
    const broker = await brokerSaying(() => "module.exports = () => 'built by a model'");
    const repo = await openRepository(await mkdtemp(join(tmpdir(), "pod-brokered-")), "a-job");

    const outcome = await runSeat({
      role: "builder", repo, brief: "Write a module that says who built it",
      image: IMAGE, command: asksTheModel, broker,
      name: "builder-one", email: "b@pod.invalid",
    });

    expect(outcome.said?.decision).toBe("shipped");
    expect(outcome.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(outcome.askedTheModel).toBe(1);
    expect(broker.transcript[0]?.asked).toContain("Write a module that says who built it");
    expect(broker.transcript[0]?.answered).toContain("built by a model");
    // the socket is a file, not a route: the box still has no network
    expect(outcome.hadNetwork).toBe(false);
  }, 240_000);

  test("with a model in reach it still cannot reach anything else", async () => {
    const broker = await brokerSaying(() => "fine");
    const repo = await openRepository(await mkdtemp(join(tmpdir(), "pod-brokered-")), "a-job");

    const looking = `node -e '
      const fs = require("fs");
      let out = "blocked";
      try { require("child_process").execSync("getent hosts example.com", { stdio: "pipe", timeout: 5000 }); out = "reachable"; }
      catch (e) {}
      const model = fs.existsSync(process.env.POD_MODEL) ? "there" : "missing";
      fs.writeFileSync(process.env.POD_SAY, JSON.stringify({ decision: "shipped", why: "internet: " + out + ", model: " + model }));
    '`;

    const outcome = await runSeat({
      role: "builder", repo, brief: "anything", image: IMAGE, command: looking, broker,
      name: "builder-one", email: "b@pod.invalid",
    });

    expect(outcome.said?.why).toBe("internet: blocked, model: there");
  }, 240_000);

  test("a seat that runs out of asks is told, and says so rather than shipping nothing quietly", async () => {
    const broker = await brokerSaying(() => "fine", { calls: 0 });
    const repo = await openRepository(await mkdtemp(join(tmpdir(), "pod-brokered-")), "a-job");

    const outcome = await runSeat({
      role: "builder", repo, brief: "anything", image: IMAGE, command: asksTheModel, broker,
      name: "builder-one", email: "b@pod.invalid",
    });

    expect(outcome.said?.decision).toBe("refuse");
    expect(outcome.said?.why).toContain("the model said no");
    expect(outcome.commit).toBeUndefined();
  }, 240_000);
});
