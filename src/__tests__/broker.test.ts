import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBroker, SENSIBLE, type Broker } from "../broker.ts";
import { runSeat } from "../agent.ts";
import { openRepository } from "../repo.ts";

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

const dockerAvailable = await (async () => {
  try {
    return (await Bun.spawn(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exited) === 0;
  } catch {
    return false;
  }
})();

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

  test("the sensible limits are sensible", () => {
    expect(SENSIBLE.calls).toBeLessThanOrEqual(50);
    expect(SENSIBLE.seconds).toBeLessThanOrEqual(600);
  });
});

describe.skipIf(!dockerAvailable)("an agent with a model and no network", () => {
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
