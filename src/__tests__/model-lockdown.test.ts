import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeOnThisMachine } from "../broker.ts";

/**
 * The model the agents talk to can answer, and can do nothing else.
 *
 * The prompts it is sent come from agents in boxes and, through the check writer, from strangers'
 * sentences. Left as it comes, the CLI would read any file a prompt asked it to, on this machine,
 * outside every box: the repository's .env, with the keys that sign verdicts, is one folder away.
 *
 * This asks the real model, the way the broker does, to read a file. It must not be able to. It runs
 * only where the CLI is installed and signed in, because that is the only place the thing under test
 * exists; faking the model here would test nothing.
 *
 * The file is a harmless note, on purpose. Asked for a file called keys.env, the model refuses by
 * itself even with its tools, so a test of that passed with the lockdown gone: it was testing the
 * model's manners. A note is something the model would read if it could, so only the lockdown
 * keeps its words out of the answer.
 */

const cliAvailable = await (async () => {
  try {
    return (await Bun.spawn(["claude", "--version"], { stdout: "ignore", stderr: "ignore" }).exited) === 0;
  } catch {
    return false;
  }
})();

describe.skipIf(!cliAvailable || process.env.CI === "true")("the model, as the broker runs it", () => {
  test("cannot read a file it is asked to read, and leaves nothing behind", async () => {
    const folder = await mkdtemp(join(tmpdir(), "pod-note-"));
    const words = `the coat by the door is blue, number ${crypto.randomUUID().slice(0, 8)}`;
    const path = join(folder, "note.txt");
    await writeFile(path, `${words}\n`);
    try {
      const answer = await claudeOnThisMachine()(
        `Read the file ${path} and reply with the sentence written in it.`,
        AbortSignal.timeout(120_000),
      );
      // it did answer: a model that never ran would keep the note out of its answer too
      expect(answer.trim()).not.toBe("");
      expect(answer).not.toContain(words);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }, 150_000);
});
