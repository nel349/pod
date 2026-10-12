import { describe, expect, test } from "bun:test";
import { parseEther } from "viem";
import { SEATS } from "../seal.ts";
import {
  beatAfter, BEAT_MS, BEATS, ENDINGS, endingOf, exampleMoney, firstBeatOf, sceneOf, stepOf, STEPS, type Beat,
} from "../web/site/pages/welcome/story.ts";

/**
 * The story the welcome page tells, as plain state. What it says is a promise about how a job goes, so
 * these hold it to the same order and the same money the contract keeps.
 */
describe("the story of a job, as the welcome page tells it", () => {
  test("the film plays every step in order, the last one three times over, and then starts again", () => {
    expect(BEATS.map(stepOf)).toEqual(["say", "checks", "pod", "forward", "delivered", "lastWord", "lastWord", "lastWord"]);
    expect([...new Set(BEATS.map(stepOf))]).toEqual([...STEPS]);
    expect(BEATS.map(endingOf).filter((ending) => ending !== undefined)).toEqual([...ENDINGS]);
    // round once through every beat, and back to the first
    let beat: Beat = BEATS[0];
    const played = BEATS.map(() => { const now = beat; beat = beatAfter(beat); return now; });
    expect(played).toEqual([...BEATS]);
    expect(beat).toBe(BEATS[0]);
    // going to a step lands on the beat that starts it
    expect(STEPS.map(firstBeatOf).map(stepOf)).toEqual([...STEPS]);
    expect(firstBeatOf("lastWord")).toBe("accept");
    // every beat is held long enough to read a sentence
    expect(Object.values(BEAT_MS).every((held) => held >= 5000)).toBe(true);
  });

  test("the money is held from the first step until the poster's answer, and nobody is paid before it", () => {
    expect(sceneOf("say").money).toBe("arriving");
    for (const beat of ["checks", "pod", "forward", "delivered"] as const) expect(sceneOf(beat).money).toBe("held");
    expect(ENDINGS.map((ending) => sceneOf(ending).money)).toEqual(["paid", "shared", "paid"]);
    const everPaid = BEATS.filter((beat) => SEATS.some((role) => ["paid", "keptPart"].includes(sceneOf(beat).seats[role])));
    expect(everPaid).toEqual([...ENDINGS]);
  });

  test("nothing happens before what it follows from: no seat before the checks are approved, no result before the work, no answer before the delivery", () => {
    expect(SEATS.every((role) => sceneOf("say").seats[role] === "empty" && sceneOf("checks").seats[role] === "empty")).toBe(true);
    expect(sceneOf("checks").stamp).toBe("approved");
    expect(SEATS.every((role) => sceneOf("pod").seats[role] === "seated")).toBe(true);
    // one seat puts the work forward, and it is the builder's; the others stand behind it
    expect(SEATS.filter((role) => sceneOf("forward").seats[role] === "forward")).toEqual(["builder"]);
    expect(SEATS.filter((role) => sceneOf("forward").seats[role] === "behind")).toHaveLength(SEATS.length - 1);
    // a line kept from the builders is covered for as long as the work is being built, and shown once it has run
    for (const beat of ["checks", "pod", "forward"] as const) expect(sceneOf(beat).kept).toBe("covered");
    for (const beat of BEATS) {
      const scene = sceneOf(beat);
      expect(scene.canOpen).toBe(scene.lines === "passed");
      if (scene.answer !== "none") expect(scene.lines).toBe("passed");
      if (scene.lines === "passed") expect(scene.kept).toBe("passed");
    }
    expect(BEATS.filter((beat) => sceneOf(beat).answer !== "none")).toEqual([...ENDINGS]);
    expect(sceneOf("refuse").stamp).toBe("refused");
  });

  test("the example's money is the seats' own shares and the contract's own rule, to the last wei", () => {
    const price = parseEther("1");
    const money = exampleMoney(price, 25);
    expect(SEATS.reduce((sum, role) => sum + money.pay[role], 0n)).toBe(price);
    expect(money.pay.builder).toBe(parseEther("0.4"));
    expect(money.podKeeps).toBe(parseEther("0.25"));
    expect(money.comesBack).toBe(parseEther("0.75"));
    expect(money.kept.builder).toBe(parseEther("0.1"));
    // a price that does not divide evenly loses nothing between the two sides
    const odd = exampleMoney(1_000_000_000_000_000_003n, 25);
    expect(odd.comesBack + odd.podKeeps).toBe(odd.price);
    // a contract that leaves a pod nothing on a refusal sends everything back
    expect(exampleMoney(price, 0).comesBack).toBe(price);
  });
});
