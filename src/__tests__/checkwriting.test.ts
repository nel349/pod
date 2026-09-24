import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMAGE, readableToTheBox } from "../sandbox.ts";
import {
  CheckWriting, isStillWriting, ProvenChecks, readyToSeal, refusalOf, writeChecks, WritingSchema, type Written,
} from "../checkwriting/index.ts";
import { digestOf } from "../job.ts";
import { handle, type Market } from "../server.ts";
import { JobStore } from "../store.ts";
import { ROUTES, writingPath } from "../routes.ts";
import {
  COAT_REQUEST, DRY, GOOD_REPLY, WET, WORKING, dockerAvailable, good, replying, replyingInTurn, serverSaying, writerWith,
} from "./support/coat.ts";

/**
 * A poster's sentences become checks, and every check is tried before it can be sealed.
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
    expect(refusalOf({ ...COAT_REQUEST, kind: "cli" })).toBe("say whether it is a page or a service");
  });

  test("a proper request is not refused", () => {
    expect(refusalOf(COAT_REQUEST)).toBeUndefined();
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
      chain: { jobs: "0x0000000000000000000000000000000000000001", job: async () => undefined },
      writing: new CheckWriting({ writer: writerWith(replying(GOOD_REPLY).model), proven }),
      proven,
    };
    const store = new JobStore(await mkdtemp(join(tmpdir(), "pod-routes-")));
    const started = await handle(
      new Request(`http://pod.test${ROUTES.writeChecks}`, { method: "POST", body: JSON.stringify(COAT_REQUEST) }), store, market,
    );
    expect(started.status).toBe(202);
    const { id, url } = await started.json() as { id: string; url: string };
    expect(url).toBe(writingPath(id));

    const deadline = Date.now() + 180_000;
    let writing = WritingSchema.parse(await (await handle(new Request(`http://pod.test${url}`), store, market)).json());
    while (isStillWriting(writing) && Date.now() < deadline) {
      await Bun.sleep(250);
      writing = WritingSchema.parse(await (await handle(new Request(`http://pod.test${url}`), store, market)).json());
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
  test("good checks pass the working version, fail their near miss, and fail nothing built", async () => {
    const written = await writeChecks(COAT_REQUEST, writerWith(replying(GOOD_REPLY).model));

    expect(written.map(proven)).toEqual([
      { working: true, nearMiss: true, nothing: true },
      { working: true, nearMiss: true, nothing: true },
    ]);
    // the poster's own words, and which ones they kept back, survive the trip through the writer
    expect(written.map((check) => [check.says, check.secret])).toEqual([[WET, false], [DRY, true]]);
    // and the program the poster seals is the program that was tried, byte for byte
    expect(written.map((check) => check.checkable && check.source)).toEqual([`${good(0).check}\n`, `${good(1).check}\n`]);
    expect(readyToSeal(written)).toBe(true);
  }, 240_000);

  test("a near miss that never starts proves nothing, so its check is not counted as catching it", async () => {
    // the bug this guards: counting a check as having caught the near miss because the near miss
    // crashed, when the check never ran against it at all
    const crashing = { ...good(1), nearMissServer: "process.exit(1);" };
    const written = await writeChecks(COAT_REQUEST, writerWith(replying({ working: WORKING, checks: [good(0), crashing] }).model));

    expect(proven(written[1]!)).toEqual({ working: true, nearMiss: false, nothing: true });
    const saw = written[1]!.checkable ? written[1]!.saw.nearMiss : "";
    expect(saw).toStartWith("the artefact stopped before it answered");
    expect(readyToSeal(written)).toBe(false);
  }, 240_000);

  test("the model's words reach the poster with no em dashes in them, however the model wrote them", async () => {
    const dashing = { ...good(0), asks: "Asks while it is raining — hard", nearMiss: "It never says take a coat—ever" };
    const written = await writeChecks(COAT_REQUEST, writerWith(replying({ working: WORKING, checks: [dashing, good(1)] }).model));
    const first = written[0]!;
    expect(first.checkable && [first.asks, first.nearMiss]).toEqual(["Asks while it is raining, hard", "It never says take a coat, ever"]);
  }, 240_000);

  test("a near miss that breaks everything is no near miss, so it proves nothing about its check", async () => {
    // a check that catches this proves only that something is broken, which "nothing built" already shows
    const breaksEverything = { ...good(1), nearMissServer: serverSaying("null", "null") };
    const written = await writeChecks(COAT_REQUEST, writerWith(replying({ working: WORKING, checks: [good(0), breaksEverything] }).model));

    expect(proven(written[1]!)).toEqual({ working: true, nearMiss: false, nothing: true });
    expect(written[1]!.checkable && written[1]!.saw.nearMiss).toBe(`the near miss breaks more than one thing: "${WET}" fails against it too`);
    expect(readyToSeal(written)).toBe(false);
  }, 240_000);

  test("a near miss identical to the working version is missing nothing, and is refused as one", async () => {
    const unchanged = { ...good(1), nearMissServer: WORKING };
    const written = await writeChecks(COAT_REQUEST, writerWith(replying({ working: WORKING, checks: [good(0), unchanged] }).model));

    expect(proven(written[1]!)).toEqual({ working: true, nearMiss: false, nothing: true });
    expect(written[1]!.checkable && written[1]!.saw.nearMiss).toBe("the near miss is the working version, unchanged");
  }, 240_000);

  test("a writer whose first answer is unusable is told why, and its second, good answer is used", async () => {
    const { model, asked, prompts } = replyingInTurn("I would be happy to help with that!", GOOD_REPLY);
    const written = await writeChecks(COAT_REQUEST, writerWith(model));

    expect(asked()).toBe(2);
    expect(prompts()[1]).toContain("Your last reply could not be used");
    expect(readyToSeal(written)).toBe(true);
  }, 240_000);

  test("a writer that answers two sentences with one check is asked again, and told the count", async () => {
    const { model, prompts } = replyingInTurn({ working: WORKING, checks: [good(0)] }, GOOD_REPLY);
    const written = await writeChecks(COAT_REQUEST, writerWith(model));

    expect(prompts()[1]).toContain("there were 2 sentences and 1 checks");
    expect(readyToSeal(written)).toBe(true);
  }, 240_000);

  test("a check that passes anything is caught: it lets the near miss and nothing built through", async () => {
    const anything = { ...good(1), check: `console.log("fine"); process.exit(0);` };
    const written = await writeChecks(COAT_REQUEST, writerWith(replying({ working: WORKING, checks: [good(0), anything] }).model));

    expect(proven(written[1]!)).toEqual({ working: true, nearMiss: false, nothing: false });
    expect(readyToSeal(written)).toBe(false);
  }, 240_000);

  test("a check nobody could pass is caught: the working version fails it", async () => {
    // it wants an umbrella, which nothing in what the poster asked for would ever answer with
    const impossible = {
      ...good(0),
      check: `const a = await (await fetch(process.env.TARGET + "/?rain=yes")).json();
if (a.umbrella !== true) { console.log("no umbrella"); process.exit(1); }`,
    };
    const written = await writeChecks(COAT_REQUEST, writerWith(replying({ working: WORKING, checks: [impossible, good(1)] }).model));

    expect(proven(written[0]!)).toEqual({ working: false, nearMiss: true, nothing: true });
    expect(written[0]!.checkable && written[0]!.saw.working).toBe("no umbrella");
    expect(readyToSeal(written)).toBe(false);
  }, 240_000);

  test("a sentence no program can decide comes back as that, with how to say it instead", async () => {
    const taste = { checkable: false, why: "Say what you would see, for example the answer is in large type" };
    const written = await writeChecks(
      { ...COAT_REQUEST, statements: [COAT_REQUEST.statements[0]!, { says: "It looks lovely", secret: true }] },
      writerWith(replying({ working: WORKING, checks: [good(0), taste] }).model),
    );

    expect(written[1]).toEqual({ checkable: false, says: "It looks lovely", secret: true, why: taste.why });
    expect(readyToSeal(written)).toBe(false);
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
});
