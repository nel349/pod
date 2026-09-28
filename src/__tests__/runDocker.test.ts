import { describe, expect, test } from "bun:test";
import { runDocker } from "../docker/index.ts";
import { IMAGE } from "../sandbox.ts";
import { dockerAvailable } from "./support/tools.ts";

const withDocker = await dockerAvailable();

describe.skipIf(!withDocker)("one Docker command, with a time limit of its own", () => {
  test("a command that answers in time says what it said", async () => {
    const answer = await runDocker(["run", "--rm", IMAGE, "node", "-e", "console.log('here'); process.exit(3)"], 120);
    expect(answer).toEqual({ code: 3, out: "here", isTimedOut: false });
  }, 180_000);

  test("a command that does not answer in time is killed, says so, and takes its box down with it", async () => {
    const name = `pod-limit-${crypto.randomUUID().slice(0, 8)}`;
    const at = Date.now();
    const answer = await runDocker(["run", "--rm", "--name", name, IMAGE, "sleep", "600"], 5, name);

    expect(answer.isTimedOut).toBe(true);
    expect((Date.now() - at) / 1000).toBeLessThan(60);
    const left = await runDocker(["ps", "-a", "--filter", `name=${name}`, "--format", "{{.Names}}"], 30);
    expect(left.out).toBe("");
  }, 180_000);
});
