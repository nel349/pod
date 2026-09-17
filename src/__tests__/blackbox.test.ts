import { describe, expect, test } from "bun:test";
import { grade, type CheckToRun } from "../blackbox.ts";

const IMAGE = "node@sha256:9bef0ef1e268f60627da9ba7d7605e8831d5b56ad07487d24d1aa386336d1944";
const ARTEFACT = new URL("../../fixtures/app-honest", import.meta.url).pathname;
const CHECKS = new URL("../../fixtures/checks", import.meta.url).pathname;

const toRun: CheckToRun[] = [
  { says: "the page answers", command: "node loads.mjs", hidden: false },
  { says: "a weak excuse scores lower than a strong one", command: "node weak.mjs", hidden: true },
];

const dockerAvailable = await (async () => {
  try {
    return (await Bun.spawn(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exited) === 0;
  } catch {
    return false;
  }
})();

describe.skipIf(!dockerAvailable)("grading from outside the box", () => {
  test("an artefact that works passes both the visible and the hidden check", async () => {
    const outcome = await grade({ artefact: ARTEFACT, start: "node server.js", checks: CHECKS, toRun, image: IMAGE });
    expect(outcome.passed).toBe(true);
    expect(outcome.checks).toHaveLength(2);
    expect(outcome.checks.every((c) => c.exitCode === 0)).toBe(true);
  }, 240_000);

  test("the hidden check is the one that catches work that only looks right", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    // answers every request, always the same score: passes the visible check, fails the hidden one
    const lazy = await mkdtemp(join(tmpdir(), "pod-lazy-"));
    await writeFile(join(lazy, "server.js"),
      `require("http").createServer((_, res) => { res.setHeader("content-type","application/json"); res.end(JSON.stringify({score:5})); }).listen(3000, () => console.log("listening"));\n`);

    const outcome = await grade({ artefact: lazy, start: "node server.js", checks: CHECKS, toRun, image: IMAGE });
    expect(outcome.passed).toBe(false);
    expect(outcome.checks.find((c) => !c.hidden)?.exitCode).toBe(0);
    expect(outcome.checks.find((c) => c.hidden)?.exitCode).not.toBe(0);
  }, 240_000);

  test("the artefact cannot see the checks, and cannot reach anything but itself", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const nosy = await mkdtemp(join(tmpdir(), "pod-nosy-"));
    await writeFile(join(nosy, "server.js"),
      `const fs=require("fs");let seen="none";for(const p of ["/checks","/hidden"]){try{seen=p+": "+fs.readdirSync(p).join(",")}catch(e){}}
       let out="blocked";try{require("child_process").execSync("getent hosts example.com",{stdio:"pipe",timeout:5000});out="reachable"}catch(e){}
       console.log("checks visible: "+seen+" | internet: "+out);
       require("http").createServer((_,res)=>res.end("{}")).listen(3000,()=>console.log("listening"));\n`);

    const outcome = await grade({ artefact: nosy, start: "node server.js", checks: CHECKS, toRun, image: IMAGE });
    expect(outcome.artefactLog).toContain("checks visible: none");
    expect(outcome.artefactLog).toContain("internet: blocked");
  }, 240_000);

  test("nothing is left running afterwards", async () => {
    await grade({ artefact: ARTEFACT, start: "node server.js", checks: CHECKS, toRun, image: IMAGE });
    const running = await new Response(
      Bun.spawn(["docker", "ps", "-a", "--filter", "name=pod-art-", "--format", "{{.Names}}"], { stdout: "pipe" }).stdout,
    ).text();
    expect(running.trim()).toBe("");
    const networks = await new Response(
      Bun.spawn(["docker", "network", "ls", "--filter", "name=pod-net-", "--format", "{{.Name}}"], { stdout: "pipe" }).stdout,
    ).text();
    expect(networks.trim()).toBe("");
  }, 240_000);
});
