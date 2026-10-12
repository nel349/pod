import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMAGE, readableToTheBox } from "../sandbox.ts";
import {
  CheckWriting, isChargedFor, isProven, isStillWriting, ProvenChecks, readyToSeal, refusalOf, writeChecks, WritingFailed, WritingSchema, type Written, type WriteRequest,
} from "../checkwriting/index.ts";
import { digestOf } from "../job.ts";
import { handle, type Market } from "../server.ts";
import { JobStore } from "../store.ts";
import { ROUTES, writingPath } from "../routes.ts";
import {
  COAT_REQUEST, DRY, GOOD_REPLY, WET, good, replying, replyingInTurn, writerWith,
} from "./support/coat.ts";
import { dockerAvailable } from "./support/tools.ts";
import { checkout } from "./support/checkout.ts";
import { prove } from "../checkwriting/prove.ts";
import { checkStandingOf, COPY } from "../web/post/state/index.ts";
import { DockerFailed } from "../docker/index.ts";
import type { Model, Spent } from "../broker.ts";

/**
 * An image Docker refuses to start any box from. Malformed on purpose: a well-formed name that no
 * registry has would send Docker to a registry and to this machine's credentials to look for it.
 */
const NO_SUCH_IMAGE = "POD/NOT A VALID IMAGE";

/**
 * A poster's sentences become checks, and every check is tried against nothing built before it can be sealed.
 *
 * The model is a function that answers with a fixed reply, because what is under test is not whether
 * a model writes good checks — it is what the platform does with whatever it is handed. Everything
 * else is real: the writer program in agents/, the box it runs in with no network, the socket it
 * asks through, and the grading boxes every check is tried in.
 */

const proven = (check: Written) => (check.checkable ? check.proof : undefined);
const withDocker = await dockerAvailable();

describe("what a poster may ask for", () => {
  test("a request with nothing that would prove it is refused, and says what to add", () => {
    expect(refusalOf({ ...COAT_REQUEST, statements: [] })).toBe("say at least one thing that would prove it works");
  });

  test("a kind of thing grading cannot drive is refused rather than accepted and never checked", () => {
    expect(refusalOf({ ...COAT_REQUEST, kind: "cli" })).toBe("say whether it is a website or a service");
  });

  test("a proper request is not refused", () => {
    expect(refusalOf(COAT_REQUEST)).toBeUndefined();
  });

  test("a writing is charged once the model answered, never when Docker failed us, and not before the model answered", () => {
    expect(isChargedFor(new Error("the writer gave up"), 1)).toBe(true);
    expect(isChargedFor(new Error("the writer gave up"), 0)).toBe(false);
    expect(isChargedFor(new DockerFailed("Docker could not start a trial's box"), 2)).toBe(false);
  });

});

describe.skipIf(!withDocker)("the route the page starts writing with", () => {
  test("answers 202 with where to ask, and asking there gives the checks, proven", async () => {
    const proven = new ProvenChecks(await mkdtemp(join(tmpdir(), "pod-proven-")));
    const market: Market = {
      page: {
        chainId: 31337, chainName: "a local chain", rpc: "http://127.0.0.1:8545",
        jobs: "0x0000000000000000000000000000000000000001", explorer: "http://explorer.invalid", coin: "ETH",
      },
      chain: {
        jobs: "0x0000000000000000000000000000000000000001",
        job: async () => undefined,
        now: async () => { throw new Error("writing checks never asks the chain the time"); },
      },
      writing: new CheckWriting({ writer: writerWith(replying(GOOD_REPLY).model), proven }),
      proven,
    };
    const store = new JobStore(await mkdtemp(join(tmpdir(), "pod-routes-")));
    const started = await handle(
      new Request(`http://pod.test${ROUTES.writeChecks}`, { method: "POST", body: JSON.stringify(COAT_REQUEST) }), store, { market },
    );
    expect(started.status).toBe(202);
    const { id, url } = await started.json() as { id: string; url: string };
    expect(url).toBe(writingPath(id));

    const deadline = Date.now() + 180_000;
    let writing = WritingSchema.parse(await (await handle(new Request(`http://pod.test${url}`), store, { market })).json());
    while (isStillWriting(writing) && Date.now() < deadline) {
      await Bun.sleep(250);
      writing = WritingSchema.parse(await (await handle(new Request(`http://pod.test${url}`), store, { market })).json());
    }
    expect(writing.stage).toBe("written");
    expect(writing.stage === "written" && writing.ready).toBe(true);
  }, 240_000);
});

describe.skipIf(!withDocker)("how many are written at once", () => {
  test("a full server turns the next poster away, starts nothing for them, and takes them once a slot frees", async () => {
    const { model, asked } = replying(GOOD_REPLY);
    const proven = new ProvenChecks(await mkdtemp(join(tmpdir(), "pod-proven-")));
    const writing = new CheckWriting({ writer: writerWith(model), proven, atOnce: 1 });

    const first = writing.start(COAT_REQUEST);
    expect(first.ok).toBe(true);
    expect(writing.start(COAT_REQUEST)).toEqual({
      ok: false, status: 429, why: "other people's checks are being written right now. Try again in a minute",
    });

    // the first run finishes; a finished run no longer holds its slot
    const id = first.ok ? first.id : "";
    const deadline = Date.now() + 180_000;
    while (writing.read(id)?.stage !== "written" && Date.now() < deadline) await Bun.sleep(250);
    expect(writing.read(id)?.stage).toBe("written");
    // the turned-away request never reached the model: one run, one question
    expect(asked()).toBe(1);

    const third = writing.start(COAT_REQUEST);
    expect(third.ok).toBe(true);
    const thirdId = third.ok ? third.id : "";
    while (writing.read(thirdId)?.stage !== "written" && Date.now() < deadline) await Bun.sleep(250);
    expect(writing.read(thirdId)?.stage).toBe("written");

    // and what it proved was written down, so a posting of exactly these checks will be accepted
    expect(await proven.has(await digestOf(`${good(0).check}\n`))).toBe(true);
    expect(await proven.has(await digestOf("// a check nobody tried"))).toBe(false);
  }, 240_000);
});

describe.skipIf(!withDocker)("every check is tried before it can be sealed", () => {
  test("good checks fail when nothing is built, and come back as the poster wrote them", async () => {
    const { checks: written } = await writeChecks(COAT_REQUEST, writerWith(replying(GOOD_REPLY).model));

    expect(written.map(proven)).toEqual([{ loads: true, nothing: true }, { loads: true, nothing: true }]);
    // the poster's own words, and which ones they kept back, survive the trip through the writer
    expect(written.map((check) => [check.says, check.secret])).toEqual([[WET, false], [DRY, true]]);
    // and the program the poster seals is the program that was tried, byte for byte
    expect(written.map((check) => check.checkable && check.source)).toEqual([`${good(0).check}\n`, `${good(1).check}\n`]);
    expect(readyToSeal(written)).toBe(true);
  }, 240_000);

  test("the writer is asked to build nothing: no version of the work, and no near miss", async () => {
    const { model, prompts } = replyingInTurn(GOOD_REPLY);
    await writeChecks(COAT_REQUEST, writerWith(model));
    expect(prompts()[0]).toContain("You do not build it");
    expect(prompts()[0]).not.toContain("near miss");
    expect(prompts()[0]).not.toContain("working version");
  }, 240_000);

  test("a writer that builds a version anyway is not held to it: only its checks are read", async () => {
    // an answer in the shape a writer gave before 11 Oct 2026, a version of the work and a near miss with it
    const old = { working: "process.exit(1);", checks: [{ ...good(0), nearMiss: "It never says", nearMissServer: "process.exit(1);" }, good(1)] };
    const { checks: written } = await writeChecks(COAT_REQUEST, writerWith(replying(old).model));
    expect(written.map(proven)).toEqual([{ loads: true, nothing: true }, { loads: true, nothing: true }]);
  }, 240_000);

  test("the model's words reach the poster with no em dashes in them, however the model wrote them", async () => {
    const dashing = { ...good(0), asks: "Asks while it is raining — hard", leavesOut: "How wet you get—nobody can check that" };
    const { checks: written } = await writeChecks(COAT_REQUEST, writerWith(replying({ checks: [dashing, good(1)] }).model));
    const first = written[0]!;
    expect(first.checkable && [first.asks, first.leavesOut]).toEqual(["Asks while it is raining, hard", "How wet you get, nobody can check that"]);
  }, 240_000);

  test("what a line asks for that its check cannot look at reaches the poster, and is absent when there is nothing", async () => {
    const partly = { ...good(0), leavesOut: "Whether the coat is the right one for the weather." };
    const nothingLeft = { ...good(1), leavesOut: null };
    const { checks: written } = await writeChecks(COAT_REQUEST, writerWith(replying({ checks: [partly, nothingLeft] }).model));

    expect(written[0]!.checkable && written[0]!.leavesOut).toBe("Whether the coat is the right one for the weather.");
    expect(written[1]!.checkable && "leavesOut" in written[1]!).toBe(false);
    // a check that leaves something out is still a check that can be used
    expect(readyToSeal(written)).toBe(true);
  }, 240_000);

  test("a writer that says what is left out in anything but a sentence is asked again", async () => {
    const { model, prompts } = replyingInTurn({ checks: [{ ...good(0), leavesOut: 42 }, good(1)] }, GOOD_REPLY);
    const { checks: written } = await writeChecks(COAT_REQUEST, writerWith(model));
    expect(prompts()[1]).toContain("check 1 was missing a part");
    expect(readyToSeal(written)).toBe(true);
  }, 240_000);

  test("what the model's answers cost reaches whoever asked for the writing, however it ended", async () => {
    const billing = (reply: unknown): Model => async (_prompt, _signal, spent) => {
      spent?.({ model: "claude-of-some-kind", calls: 1, tokensIn: 100, tokensOut: 40, dollars: 0.02 });
      return typeof reply === "string" ? reply : JSON.stringify(reply);
    };
    const cost: Spent[] = [];
    await writeChecks(COAT_REQUEST, writerWith(billing(GOOD_REPLY)), undefined, (spent) => cost.push(spent));
    expect(cost).toEqual([{ model: "claude-of-some-kind", calls: 1, tokensIn: 100, tokensOut: 40, dollars: 0.02 }]);

    // a writing that failed after two answers cost two answers, and says so once
    await expect(writeChecks(COAT_REQUEST, writerWith(billing("I would be happy to help!")), undefined, (spent) => cost.push(spent))).rejects.toBeInstanceOf(WritingFailed);
    expect(cost[1]).toEqual({ model: "claude-of-some-kind", calls: 2, tokensIn: 200, tokensOut: 80, dollars: 0.04 });
    expect(cost).toHaveLength(2);
  }, 240_000);

  test("a writer whose first answer is unusable is told why, and its second, good answer is used", async () => {
    const { model, asked, prompts } = replyingInTurn("I would be happy to help with that!", GOOD_REPLY);
    const { checks: written } = await writeChecks(COAT_REQUEST, writerWith(model));

    expect(asked()).toBe(2);
    expect(prompts()[1]).toContain("Your last reply could not be used");
    expect(readyToSeal(written)).toBe(true);
  }, 240_000);

  test("a writer that answers two sentences with one check is asked again, and told the count", async () => {
    const { model, prompts } = replyingInTurn({ checks: [good(0)] }, GOOD_REPLY);
    const { checks: written } = await writeChecks(COAT_REQUEST, writerWith(model));

    expect(prompts()[1]).toContain("there were 2 sentences and 1 checks");
    expect(readyToSeal(written)).toBe(true);
  }, 240_000);

  test("a check that passes anything is caught: it passes with nothing built", async () => {
    const anything = { ...good(1), check: `console.log("fine"); process.exit(0);` };
    const { checks: written } = await writeChecks(COAT_REQUEST, writerWith(replying({ checks: [good(0), anything] }).model));

    expect(proven(written[1]!)).toEqual({ loads: true, nothing: false });
    expect(written[1]!.checkable && written[1]!.saw.nothing).toBe("fine");
    expect(readyToSeal(written)).toBe(false);
  }, 240_000);

  test("the one trial cannot tell a check that stops before it asks anything from a good one: both load, and both fail on nothing built", async () => {
    // it is a program, so it loads, and it stops before it asks anything. Nothing here catches that:
    // it is found out when the pod's QA seat runs the checks it can see, and when the work is graded.
    // A file that is no program at all is caught, further down
    const broken = { ...good(1), check: `import "node:no-such-module";` };
    const { checks: written } = await writeChecks(COAT_REQUEST, writerWith(replying({ checks: [good(0), broken] }).model));

    expect(written.map(proven)).toEqual([{ loads: true, nothing: true }, { loads: true, nothing: true }]);
  }, 240_000);

  test("a sentence no program can decide comes back as that, with how to say it instead", async () => {
    const taste = { checkable: false, why: "Say what you would see, for example the answer is in large type" };
    const { checks: written } = await writeChecks(
      { ...COAT_REQUEST, statements: [COAT_REQUEST.statements[0]!, { says: "It looks lovely", secret: true }] },
      writerWith(replying({ checks: [good(0), taste] }).model),
    );

    expect(written[1]).toEqual({ checkable: false, says: "It looks lovely", secret: true, why: taste.why });
    expect(readyToSeal(written)).toBe(false);
  }, 240_000);

  test("a kept line that asks for something the builders are never told is refused as that, and the job cannot be sealed with it", async () => {
    const untold = { checkable: false, untold: true, why: "Nothing the builders see says a city may be misspelled. Move it to the lines they see, or test a line they see with another city." };
    const kept = { says: "A misspelled city still gets an answer", secret: true };
    const asked = replyingInTurn({ checks: [good(0), untold] });
    const { checks: written } = await writeChecks({ ...COAT_REQUEST, statements: [COAT_REQUEST.statements[0]!, kept] }, writerWith(asked.model));

    expect(written[1]).toEqual({ checkable: false, says: kept.says, secret: true, why: untold.why, untold: true });
    expect(readyToSeal(written)).toBe(false);
    // the writer was told which lines the builders see and which they do not, since it cannot judge this without
    expect(asked.prompts()[0]).toContain(`1. ${COAT_REQUEST.statements[0]!.says} [the builders see this]`);
    expect(asked.prompts()[0]).toContain(`2. ${kept.says} [kept from the builders]`);

    // a line the builders see is one they are told, whatever a writer says of it: it is never called untold
    const { checks: seen } = await writeChecks(
      { ...COAT_REQUEST, statements: [COAT_REQUEST.statements[0]!, { ...kept, secret: false }] }, writerWith(replying({ checks: [good(0), untold] }).model),
    );
    expect(seen[1]).toEqual({ checkable: false, says: kept.says, secret: false, why: untold.why });
  }, 240_000);

  test("a line that depends on the time of day is not refused: the checks ask for a chosen hour, and say so plainly and exactly", async () => {
    // the poster's own words, which a check cannot decide by waiting for night
    const request: WriteRequest = {
      idea: "A page that shows awake faces by day and sleeping faces at night", kind: "page",
      statements: [{ says: "When it is day, it shows awake faces", secret: false }, { says: "When it is night, it shows sleeping faces", secret: true }],
    };
    const shows = (hour: number, face: string): string => `const html = await (await fetch(process.env.TARGET + "/?hour=${hour}")).text().catch(() => "");
if (!html.includes("${face}")) { console.log("hour=${hour} showed no ${face}"); process.exit(1); }
console.log("hour=${hour} showed ${face}");`;
    const asked = {
      plainly: "To check day and night without waiting for them, the checks ask the page for a chosen hour — 10 in the morning and 10 at night",
      exactly: "The page accepts hour=0 to 23 in its address, and uses the server's clock when none is given. Day is 6:00 to 17:59.",
    };
    const writer = replyingInTurn({
      howItIsAsked: asked,
      checks: [
        { checkable: true, asks: "Asks for 10 in the morning", expects: "An awake face", check: shows(10, "😀") },
        { checkable: true, asks: "Asks for 10 at night", expects: "A sleeping face", check: shows(22, "😴") },
      ],
    });
    const set = await writeChecks(request, writerWith(writer.model));

    // both lines became checks that can be used, asking for a chosen hour
    expect(set.checks.map(proven)).toEqual([{ loads: true, nothing: true }, { loads: true, nothing: true }]);
    // and how they ask comes back, in the poster's words and the builder's, with no em dash left in either
    expect(set.howItIsAsked).toEqual({
      plainly: "To check day and night without waiting for them, the checks ask the page for a chosen hour, 10 in the morning and 10 at night",
      exactly: asked.exactly,
    });
    // the writer was told not to refuse what changes on its own, and to say how it asks instead
    expect(writer.prompts()[0]).toContain("are not a reason to refuse");
    expect(writer.prompts()[0]).toContain("howItIsAsked");
  }, 240_000);

  test("checks that did not need to ask for anything come back with nothing to say about it", async () => {
    const set = await writeChecks(COAT_REQUEST, writerWith(replying({ ...GOOD_REPLY, howItIsAsked: null }).model));
    expect(set.howItIsAsked).toBeUndefined();
    expect(readyToSeal(set.checks)).toBe(true);
  }, 240_000);

  test("a writer that gives how it asks in only one version is asked again", async () => {
    const halfSaid = { ...GOOD_REPLY, howItIsAsked: { plainly: "the checks ask for an hour" } };
    const writer = replyingInTurn(halfSaid, GOOD_REPLY);
    const set = await writeChecks(COAT_REQUEST, writerWith(writer.model));
    expect(writer.asked()).toBe(2);
    expect(writer.prompts()[1]).toContain("without both a plain and an exact version");
    expect(set.howItIsAsked).toBeUndefined();
  }, 240_000);

  test("a writer that says it is done and leaves nonsense is refused, not believed", async () => {
    // an agent program that claims success and leaves a readback in the wrong shape: what the box
    // hands back is read through a schema, so this has to be caught at the boundary, not crash later
    const rogue = await mkdtemp(join(tmpdir(), "pod-rogue-agent-"));
    await writeFile(join(rogue, "checkwriter.js"), `const fs = require("fs");
fs.writeFileSync("/work/.pod/readback.json", JSON.stringify([{ checkable: "yes please" }, 42]));
fs.writeFileSync(process.env.POD_SAY, JSON.stringify({ decision: "shipped", why: "trust me" }));`);
    await readableToTheBox(rogue);
    const { model } = replying(GOOD_REPLY);

    await expect(writeChecks(COAT_REQUEST, { model, image: IMAGE, agents: rogue }))
      .rejects.toThrow("the check writer said it was done and left nothing that could be read");
  }, 120_000);

  test("a writer that cannot answer in shape is asked once more, then the poster is told why", async () => {
    const { model, asked } = replying("I would be happy to help with that!");
    await expect(writeChecks(COAT_REQUEST, writerWith(model))).rejects.toThrow("could not write the checks");
    expect(asked()).toBe(2);
  }, 120_000);

  test("a writing that gave up after the model answered is charged: the model's time was spent", async () => {
    const { model } = replying("I would be happy to help with that!");
    const failure = await writeChecks(COAT_REQUEST, writerWith(model)).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(WritingFailed);
    expect(failure instanceof WritingFailed && failure.isCharged).toBe(true);
  }, 120_000);

  test("a writing whose model could not be reached is not charged", async () => {
    const unreachable: Model = async () => { throw new Error("the model would not answer: not signed in"); };
    const failure = await writeChecks(COAT_REQUEST, writerWith(unreachable)).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(WritingFailed);
    expect(failure instanceof WritingFailed && failure.isCharged).toBe(false);
  }, 120_000);

  test("a writing whose box Docker never started is not charged, and the model is never asked", async () => {
    const { model, asked } = replying(GOOD_REPLY);
    const failure = await writeChecks(COAT_REQUEST, { ...writerWith(model), image: NO_SUCH_IMAGE })
      .then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(WritingFailed);
    expect(failure instanceof WritingFailed && failure.isCharged).toBe(false);
    expect(asked()).toBe(0);
  }, 120_000);

  test("trials Docker could not run are no trials: the failure is Docker's, not a check that failed", async () => {
    const checks = await checkout("pod-trial-checks-", { "check-1.mjs": good(0).check });
    await expect(prove(checks, [{ says: WET, command: "node check-1.mjs", hidden: false, file: "check-1.mjs" }], NO_SUCH_IMAGE))
      .rejects.toBeInstanceOf(DockerFailed);
  }, 120_000);

  test("a check whose own program is broken is no check: it fails against anything, so failing with nothing built says nothing for it", async () => {
    // as a model really wrote one, on 11 Oct 2026: a slash inside a pattern ends the pattern, and the file is not a program
    const BROKEN = [
      "const target = process.env.TARGET || 'http://localhost:3000';",
      "const page = await (await fetch(target + '/')).text();",
      "const hasButton = /<(button|input|form)[^>]*>?[\\s\\S]*?mint[\\s\\S]*?</?(button|input|form)?>/i.test(page);",
      "process.exit(hasButton ? 0 : 1);",
    ].join("\n");
    const checks = await checkout("pod-trial-checks-", { "check-1.mjs": good(0).check, "check-2.mjs": BROKEN });
    const tried = await prove(checks, [
      { says: WET, command: "node check-1.mjs", hidden: false, file: "check-1.mjs" },
      { says: DRY, command: "node check-2.mjs", hidden: true, file: "check-2.mjs" },
    ], IMAGE);

    // a sound check, which waits on what it fetches at its top level as these programs do, loads and fails with nothing built
    expect(tried.get("node check-1.mjs")?.proof).toEqual({ loads: true, nothing: true });
    // the broken one fails there too, which is exactly why that alone could not be trusted
    const broken = tried.get("node check-2.mjs");
    expect(broken?.proof).toEqual({ loads: false, nothing: true });
    expect(broken?.saw.nothing).toStartWith("its own program does not load: ");

    const written = (proof: { loads: boolean; nothing: boolean }) =>
      ({ checkable: true as const, says: DRY, secret: true, asks: "a", expects: "b", file: "check-2.mjs", source: BROKEN, proof, saw: { nothing: "x" } });
    expect(isProven(written({ loads: true, nothing: true }))).toBe(true);
    expect(isProven(written({ loads: false, nothing: true }))).toBe(false);
    expect(readyToSeal([written({ loads: true, nothing: true }), written({ loads: false, nothing: true })]), "one broken check holds the whole set back").toBe(false);
    expect(checkStandingOf(written({ loads: false, nothing: true }))).toEqual({ isReady: false, why: COPY.checks.notUsable.broken });
  }, 300_000);
});
