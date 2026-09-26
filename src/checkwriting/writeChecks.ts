/**
 * Turning what a poster said into checks.
 *
 * A poster is not a programmer. They say what would prove the work was done ("when it is raining it
 * tells me to take a coat") and a check writer, an agent in the same kind of box as the seats, turns
 * each sentence into a program that decides it from outside.
 *
 * Nothing the writer says is taken on trust. What it leaves in its box is read through a schema, as
 * anything from outside is. It also hands over a working version and, for each sentence, a near
 * miss (the working version with that one thing wrong) and every check is tried against them before
 * it can be sealed (see prove.ts). The working version and the near misses are thrown away
 * afterwards: they exist to try the checks, and a finished answer is exactly what the pod must not
 * be handed.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { runInBox } from "../agent.ts";
import type { CheckToRun } from "../blackbox.ts";
import { openBroker, type Broker, type Model } from "../broker.ts";
import { checkCommand, PORT, type HowItIsAsked } from "../job.ts";
import { writableByTheBox } from "../sandbox.ts";
import { jsonFromTheBox, plainDashes, textFromTheBox } from "./fromTheBox.ts";
import { prove, type Tried } from "./prove.ts";
import type { Statement, WriteRequest } from "./request.ts";
import { HowItIsAskedSchema, type Stage, type Written, type WrittenSet } from "./written.ts";

/** What writing and trying the checks needs: a model, the image the boxes run, and the agents. */
export interface CheckWriter {
  readonly model: Model;
  readonly image: string;
  /** the directory holding checkwriter.js, mounted read-only into the box */
  readonly agents: string;
}

/** a writer that needs more than a first answer and one correction is stuck, not thinking */
const WRITER_MAY_ASK = 2;
const MODEL_MAY_TAKE_SECONDS = 300;
/** long enough for every question the writer may ask to take its full time, and a minute to write the files */
const WRITER_MAY_TAKE_SECONDS = WRITER_MAY_ASK * MODEL_MAY_TAKE_SECONDS + 60;
/** how much of a box's own output goes into a refusal, which is enough to see why and no more */
const LOG_IN_A_REFUSAL = 300;

/**
 * Where the writer program leaves the check for the sentence at this index. The program is plain
 * JavaScript in its own box and cannot import this, so agents/checkwriter.js writes the same name by
 * the same rule, and the tests that run the real program are what hold the two together.
 */
const checkFileFor = (index: number): string => `check-${index + 1}.mjs`;

/** What the writer program says it did, in .pod/say.json. */
const SaidSchema = z.object({ decision: z.string(), why: z.string() });

/** What the writer program leaves in .pod/readback.json: one entry per sentence, and how the checks ask, if they had to. */
const ReadBackSchema = z.object({
  checks: z.array(z.discriminatedUnion("checkable", [
    z.object({ checkable: z.literal(true), asks: z.string(), expects: z.string(), nearMiss: z.string() }),
    z.object({ checkable: z.literal(false), why: z.string() }),
  ])),
  howItIsAsked: HowItIsAskedSchema.nullable(),
});
type ReadBack = z.infer<typeof ReadBackSchema>["checks"][number];

/** One sentence, what the writer made of it, and where its check lives. */
interface Planned {
  readonly statement: Statement;
  readonly entry: ReadBack;
  readonly file: string;
  readonly command: string;
  readonly nearMissDirectory: string;
}

/**
 * Write the checks, then try every one of them.
 *
 * Throws when the writer could not write anything, with the reason it gave. A check that was written
 * but did not prove itself is not an error: it comes back with its proof, so the poster can see which
 * trial failed and say it differently.
 */
export async function writeChecks(
  request: WriteRequest,
  writer: CheckWriter,
  onStage: (stage: Stage) => void = () => {},
): Promise<WrittenSet> {
  const made: string[] = [];
  let broker: Broker | undefined;
  try {
    const workspace = await mkdtemp(join(tmpdir(), "pod-checkwriter-"));
    made.push(workspace);
    const brokerFolder = await mkdtemp(join(tmpdir(), "pod-broker-"));
    made.push(brokerFolder);
    broker = await openBroker({
      socket: join(brokerFolder, "model.sock"), role: "checkwriter", model: writer.model,
      limits: { calls: WRITER_MAY_ASK, seconds: MODEL_MAY_TAKE_SECONDS },
    });

    onStage("writing");
    const { plan, howItIsAsked } = await runTheWriter(request, writer, workspace, broker);

    onStage("trying");
    const checks = join(workspace, "checks");
    const checkable = plan.filter((planned) => planned.entry.checkable);
    const toRun: CheckToRun[] = checkable.map((planned) => ({ says: planned.statement.says, command: planned.command, hidden: false }));
    const tried = toRun.length === 0 ? new Map<string, Tried>() : await prove(checks, toRun, {
      working: join(workspace, "working"),
      nearMiss: new Map(checkable.map((planned) => [planned.command, planned.nearMissDirectory])),
    }, writer.image);

    const written = await Promise.all(plan.map(async ({ statement, entry, file, command }): Promise<Written> => {
      const { says, secret } = statement;
      if (!entry.checkable) return { checkable: false, says, secret, why: plainDashes(entry.why) };
      const trial = tried.get(command);
      if (!trial) throw new Error(`the check for "${says}" was written and never tried`);
      const source = await textFromTheBox(join(checks, file));
      if (source === undefined) throw new Error(`the check for "${says}" was tried and then could not be read back`);
      return {
        checkable: true, says, secret,
        asks: plainDashes(entry.asks), expects: plainDashes(entry.expects), nearMiss: plainDashes(entry.nearMiss),
        file, source, proof: trial.proof, saw: trial.saw,
      };
    }));
    return howItIsAsked ? { checks: written, howItIsAsked } : { checks: written };
  } finally {
    await broker?.stop();
    await Promise.all(made.map((folder) => rm(folder, { recursive: true, force: true })));
  }
}

/** Run the writer program in its box, and read back what it said it wrote, one entry per sentence. */
async function runTheWriter(
  request: WriteRequest, writer: CheckWriter, workspace: string, broker: Broker,
): Promise<{ readonly plan: readonly Planned[]; readonly howItIsAsked?: HowItIsAsked }> {
  await mkdir(join(workspace, ".pod"), { recursive: true });
  await writeFile(join(workspace, ".pod", "ask.json"), JSON.stringify({ ...request, port: PORT }));
  await writeFile(join(workspace, ".pod", "brief.md"), `${request.idea}\n\n${request.statements
    .map((statement, i) => `${i + 1}. ${statement.says}`).join("\n")}\n`);
  await writableByTheBox(workspace);

  const ran = await runInBox({
    label: "checkwriter", workspace, image: writer.image, command: "node /agents/checkwriter.js",
    broker, agents: writer.agents, seconds: WRITER_MAY_TAKE_SECONDS,
  });

  const said = await jsonFromTheBox(join(workspace, ".pod", "say.json"), SaidSchema);
  if (said?.decision !== "shipped") {
    throw new Error(said?.why ?? `the check writer stopped without saying why: ${ran.out.slice(0, LOG_IN_A_REFUSAL) || `exit ${ran.code}`}`);
  }
  const readback = await jsonFromTheBox(join(workspace, ".pod", "readback.json"), ReadBackSchema);
  if (!readback) throw new Error("the check writer said it was done and left nothing that could be read");

  const plan = request.statements.map((statement, i) => {
    const entry = readback.checks[i];
    if (!entry || readback.checks.length !== request.statements.length) {
      throw new Error("the check writer said it was done and left a different number of checks");
    }
    const file = checkFileFor(i);
    return { statement, entry, file, command: checkCommand(file), nearMissDirectory: join(workspace, "near-miss", String(i + 1)) };
  });
  const asked = readback.howItIsAsked;
  return asked ? { plan, howItIsAsked: { plainly: plainDashes(asked.plainly), exactly: plainDashes(asked.exactly) } } : { plan };
}
