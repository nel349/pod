import { describe, expect, test } from "bun:test";
import { BOUNDED_LOGS, grade, type CheckToRun } from "../blackbox.ts";
import { MOST_KEPT_BYTES } from "../readBounded.ts";
import { DockerFailed } from "../DockerFailed.ts";
import { checkout } from "./support/checkout.ts";
import { dockerAvailable } from "./support/tools.ts";

const IMAGE = "node@sha256:9bef0ef1e268f60627da9ba7d7605e8831d5b56ad07487d24d1aa386336d1944";
const ARTEFACT = new URL("../../fixtures/app-honest", import.meta.url).pathname;
const CHECKS = new URL("../../fixtures/checks", import.meta.url).pathname;

/** stdout and stderr are each read bounded, with a line saying what was let go */
const MOST_READ = 2 * MOST_KEPT_BYTES + 200;

const toRun: CheckToRun[] = [
  { says: "the page answers", command: "node loads.mjs", hidden: false },
  { says: "a weak excuse scores lower than a strong one", command: "node weak.mjs", hidden: true },
];

const withDocker = await dockerAvailable();

describe.skipIf(!withDocker)("grading from outside the box", () => {
  test("an artefact that works passes both the visible and the hidden check", async () => {
    const outcome = await grade({ artefact: ARTEFACT, start: "node server.js", checks: CHECKS, toRun, image: IMAGE });
    expect(outcome.passed).toBe(true);
    expect(outcome.checks).toHaveLength(2);
    expect(outcome.checks.every((c) => c.exitCode === 0)).toBe(true);
  }, 240_000);

  test("the hidden check is the one that catches work that only looks right", async () => {
    // answers every request, always the same score: passes the visible check, fails the hidden one
    const lazy = await checkout("pod-lazy-", {
      "server.js": `require("http").createServer((_, res) => { res.setHeader("content-type","application/json"); res.end(JSON.stringify({score:5})); }).listen(3000, () => console.log("listening"));\n`,
    });

    const outcome = await grade({ artefact: lazy, start: "node server.js", checks: CHECKS, toRun, image: IMAGE });
    expect(outcome.passed).toBe(false);
    expect(outcome.checks.find((c) => !c.hidden)?.exitCode).toBe(0);
    expect(outcome.checks.find((c) => c.hidden)?.exitCode).not.toBe(0);
  }, 240_000);

  test("the artefact cannot see the checks, and cannot reach anything but itself", async () => {
    const nosy = await checkout("pod-nosy-", {
      "server.js": `const fs=require("fs");let seen="none";for(const p of ["/checks","/hidden"]){try{seen=p+": "+fs.readdirSync(p).join(",")}catch(e){}}
       let out="blocked";try{require("child_process").execSync("getent hosts example.com",{stdio:"pipe",timeout:5000});out="reachable"}catch(e){}
       console.log("checks visible: "+seen+" | internet: "+out);
       require("http").createServer((_,res)=>res.end("{}")).listen(3000,()=>console.log("listening"));\n`,
    });

    const outcome = await grade({ artefact: nosy, start: "node server.js", checks: CHECKS, toRun, image: IMAGE });
    expect(outcome.artefactLog).toContain("checks visible: none");
    expect(outcome.artefactLog).toContain("internet: blocked");
  }, 240_000);

  test("an artefact that dies on its first breath is reported at once, with its own words", async () => {
    const doomed = await checkout("pod-doomed-", {
      "server.js": `console.error("cannot start: the port is a lie"); process.exit(3);\n`,
    });

    const at = Date.now();
    // the wait window is 90s; a dead box must be reported long before it, not after it
    const failure = await grade({ artefact: doomed, start: "node server.js", checks: CHECKS, toRun, image: IMAGE })
      .then(() => null, (error: Error) => error);

    expect(failure?.message).toContain("exit 3");
    expect(failure?.message).toContain("cannot start: the port is a lie");
    expect((Date.now() - at) / 1000).toBeLessThan(60);
  }, 240_000);

  test("an artefact that floods its own log is still graded, and only so much of the log is read", async () => {
    const honest = await Bun.file(`${ARTEFACT}/server.js`).text();
    const flooding = await checkout("pod-flood-", {
      "server.js": `${honest}\nconst line = "x".repeat(1023) + "\\n";\nsetInterval(() => { for (let i = 0; i < 256; i++) process.stdout.write(line); }, 10);\n`,
    });

    const outcome = await grade({ artefact: flooding, start: "node server.js", checks: CHECKS, toRun, image: IMAGE });
    expect(outcome.passed).toBe(true);
    expect(outcome.artefactLog).toContain("bytes not kept");
    expect(outcome.artefactLog.length).toBeLessThan(MOST_READ);
  }, 240_000);

  test("a check that floods its output is still graded, and keeps the end of what it said", async () => {
    const checks = await checkout("pod-flood-checks-", {
      "loads.mjs": await Bun.file(`${CHECKS}/loads.mjs`).text(),
      "flood.mjs": `const line = "y".repeat(1023) + "\\n";\nfor (let i = 0; i < 50 * 1024; i++) process.stdout.write(line);\nconsole.log("the check is done");\n`,
    });
    const flooding: CheckToRun[] = [
      { says: "the page answers", command: "node loads.mjs", hidden: false },
      { says: "a check with a great deal to say", command: "node flood.mjs", hidden: true },
    ];

    const outcome = await grade({ artefact: ARTEFACT, start: "node server.js", checks, toRun: flooding, image: IMAGE });
    const loud = outcome.checks.find((c) => c.hidden);
    expect(outcome.passed).toBe(true);
    expect(loud?.exitCode).toBe(0);
    expect(loud?.output.endsWith("the check is done")).toBe(true);
    expect(loud?.output.length).toBeLessThan(MOST_READ);
  }, 240_000);

  test("a box's log is capped on disk by Docker itself, not only when we read it", async () => {
    const name = `pod-logcap-${crypto.randomUUID().slice(0, 8)}`;
    try {
      const started = Bun.spawn([
        "docker", "run", "-d", "--name", name, ...BOUNDED_LOGS, IMAGE,
        "sh", "-c", "yes xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx | head -c 20000000",
      ], { stdout: "ignore", stderr: "pipe" });
      expect(await started.exited).toBe(0);
      expect(await Bun.spawn(["docker", "wait", name], { stdout: "ignore" }).exited).toBe(0);

      // counted by wc, so the test itself never holds what the box printed
      const counted = Bun.spawn(["sh", "-c", `docker logs ${name} 2>&1 | wc -c`], { stdout: "pipe" });
      const bytes = Number((await new Response(counted.stdout).text()).trim());
      expect(bytes).toBeGreaterThan(0);
      expect(bytes).toBeLessThan(1024 * 1024);
    } finally {
      await Bun.spawn(["docker", "rm", "-f", name], { stdout: "ignore", stderr: "ignore" }).exited;
    }
  }, 240_000);

  test("work that takes the connection and never replies is waited for as not answering, never taken for Docker failing", async () => {
    const silent = await checkout("pod-silent-", {
      "server.js": `require("http").createServer(() => {}).listen(3000, () => console.log("listening, and saying nothing"));\n`,
    });

    const failure = await grade({ artefact: silent, start: "node server.js", checks: CHECKS, toRun, image: IMAGE, startSeconds: 30 })
      .then(() => null, (error: Error) => error);

    expect(failure?.message).toContain("never answered within 30s");
    expect(failure?.message).toContain("listening, and saying nothing");
  }, 240_000);

  // an image name Docker refuses outright, so no registry and no credentials are ever asked
  test("a box Docker will not start is Docker's failure, never a verdict on the work", async () => {
    await expect(grade({ artefact: ARTEFACT, start: "node server.js", checks: CHECKS, toRun, image: "POD/NOT A VALID IMAGE" }))
      .rejects.toBeInstanceOf(DockerFailed);
  }, 240_000);

  test("a check the work keeps waiting fails when its time is up: the work's failure, never Docker's", async () => {
    // answers the look at whether it is up, and then never replies to anything a check asks
    const stalling = await checkout("pod-stalling-", {
      "server.js": `require("http").createServer((request, response) => { if (request.url === "/") response.end("up"); }).listen(3000, () => console.log("listening"));\n`,
    });
    const at = Date.now();
    const outcome = await grade({ artefact: stalling, start: "node server.js", checks: CHECKS, toRun: [toRun[1]!], image: IMAGE, checkSeconds: 5 });

    expect(outcome.passed).toBe(false);
    expect(outcome.checks[0]?.exitCode).not.toBe(0);
    expect((Date.now() - at) / 1000).toBeLessThan(60);
  }, 240_000);

  test("a check that ends with Docker's own code is an ordinary failure, not Docker failing", async () => {
    const checks = await checkout("pod-125-", { "exits.mjs": "process.exit(125);\n" });
    const outcome = await grade({
      artefact: ARTEFACT, start: "node server.js", checks, image: IMAGE,
      toRun: [{ says: "it ends with 125", command: "node exits.mjs", hidden: false }],
    });
    expect(outcome.checks[0]?.exitCode).toBe(1);
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
    const checks = await new Response(
      Bun.spawn(["docker", "ps", "-a", "--filter", "name=pod-chk-", "--format", "{{.Names}}"], { stdout: "pipe" }).stdout,
    ).text();
    expect(checks.trim()).toBe("");
  }, 240_000);
});
