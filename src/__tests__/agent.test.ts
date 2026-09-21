import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPod, runSeat } from "../agent.ts";
import { history, openRepository, type Repository } from "../repo.ts";

/**
 * A seat, worked by an agent.
 *
 * The agents here are small programs rather than models, on purpose. What is being tested is the
 * harness — a workspace with the work so far in it, a box with no route out, whatever the agent
 * leaves becoming a commit under its own name, and the decision it made coming back — and a model
 * in that position would prove only that the model answered.
 *
 * When there is a key, the command changes and none of this does.
 */

const IMAGE = "node@sha256:9bef0ef1e268f60627da9ba7d7605e8831d5b56ad07487d24d1aa386336d1944";
const BRIEF = "A page that tells me whether to take a coat";

const dockerAvailable = await (async () => {
  try {
    return (await Bun.spawn(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exited) === 0;
  } catch {
    return false;
  }
})();

async function aRepository(): Promise<Repository> {
  return openRepository(await mkdtemp(join(tmpdir(), "pod-agents-")), "a-weather-page");
}

/** An agent is any program. This one ships a file and says so. */
const shipsSomething = `node -e '
  const fs = require("fs");
  fs.writeFileSync("/work/server.js", "console.log(process.env.POD_ROLE)\\n");
  fs.writeFileSync(process.env.POD_SAY, JSON.stringify({ decision: "shipped", why: "wrote the server" }));
'`;

/** This one reads, decides, and changes nothing — which is what a reviewer does. */
const readsAndApproves = `node -e '
  const fs = require("fs");
  const brief = fs.readFileSync(process.env.POD_BRIEF, "utf8");
  const shipped = fs.existsSync("/work/server.js");
  fs.writeFileSync(process.env.POD_SAY, JSON.stringify({
    decision: shipped ? "approve" : "refuse",
    why: shipped ? "there is a server, and the brief asked for one: " + brief.slice(0, 20) : "nothing was shipped",
  }));
'`;

describe.skipIf(!dockerAvailable)("a seat, worked by an agent", () => {
  test("what the agent leaves becomes a commit, under its own name", async () => {
    const repo = await aRepository();
    const outcome = await runSeat({
      role: "builder", repo, brief: BRIEF, image: IMAGE, command: shipsSomething,
      name: "builder-one", email: "builder@pod.invalid",
    });

    expect(outcome.said).toEqual({ decision: "shipped", why: "wrote the server" });
    expect(outcome.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(outcome.timedOut).toBe(false);

    const [latest] = await history(repo);
    expect(latest?.agent).toBe("builder-one");
    expect(latest?.commit).toBe(outcome.commit!);
  }, 240_000);

  test("a seat that changes nothing makes no commit, and still says what it decided", async () => {
    const repo = await aRepository();
    await runSeat({
      role: "builder", repo, brief: BRIEF, image: IMAGE, command: shipsSomething,
      name: "builder-one", email: "builder@pod.invalid",
    });

    const reviewer = await runSeat({
      role: "reviewer", repo, brief: BRIEF, image: IMAGE, command: readsAndApproves,
      name: "reviewer-one", email: "reviewer@pod.invalid",
    });

    expect(reviewer.said?.decision).toBe("approve");
    expect(reviewer.commit).toBeUndefined();
    expect(await history(repo)).toHaveLength(1);
  }, 240_000);

  test("the next seat sees the work the last one did", async () => {
    const repo = await aRepository();
    // a reviewer with nothing to review refuses
    const early = await runSeat({
      role: "reviewer", repo, brief: BRIEF, image: IMAGE, command: readsAndApproves,
      name: "reviewer-one", email: "reviewer@pod.invalid",
    });
    expect(early.said).toEqual({ decision: "refuse", why: "nothing was shipped" });

    await runSeat({
      role: "builder", repo, brief: BRIEF, image: IMAGE, command: shipsSomething,
      name: "builder-one", email: "builder@pod.invalid",
    });

    const later = await runSeat({
      role: "reviewer", repo, brief: BRIEF, image: IMAGE, command: readsAndApproves,
      name: "reviewer-one", email: "reviewer@pod.invalid",
    });
    expect(later.said?.decision).toBe("approve");
    expect(later.said?.why).toContain("A page that tells me");
  }, 300_000);

  test("the agent has no route out unless the job declared one", async () => {
    const repo = await aRepository();
    const looking = `node -e '
      const fs = require("fs");
      let out = "blocked";
      try { require("child_process").execSync("getent hosts example.com", { stdio: "pipe", timeout: 5000 }); out = "reachable"; }
      catch (e) {}
      fs.writeFileSync(process.env.POD_SAY, JSON.stringify({ decision: "shipped", why: "internet: " + out }));
    '`;

    const sealed = await runSeat({
      role: "builder", repo, brief: BRIEF, image: IMAGE, command: looking,
      name: "builder-one", email: "builder@pod.invalid",
    });
    expect(sealed.said?.why).toBe("internet: blocked");
    expect(sealed.hadNetwork).toBe(false);
  }, 240_000);

  test("the conversation with the platform never reaches the work", async () => {
    const repo = await aRepository();
    await runSeat({
      role: "builder", repo, brief: BRIEF, image: IMAGE, command: shipsSomething,
      name: "builder-one", email: "builder@pod.invalid",
    });

    const { checkout } = await import("../repo.ts");
    const laid = await mkdtemp(join(tmpdir(), "pod-laid-"));
    const { head } = await import("../repo.ts");
    await checkout(repo, (await head(repo))!, laid);

    const { readdir } = await import("node:fs/promises");
    const inside = await readdir(laid);
    expect(inside).toEqual(["server.js"]);
    expect(await Bun.file(join(laid, ".pod/say.json")).exists()).toBe(false);
  }, 240_000);

  test("an agent that says nothing is a seat that has not done its job", async () => {
    const repo = await aRepository();
    const silent = `node -e 'require("fs").writeFileSync("/work/something.txt", "hello")'`;
    const outcome = await runSeat({
      role: "qa", repo, brief: BRIEF, image: IMAGE, command: silent,
      name: "qa-one", email: "qa@pod.invalid",
    });

    expect(outcome.said).toBeUndefined();
    // it still committed what it left, because the work is the work
    expect(outcome.commit).toMatch(/^[0-9a-f]{40}$/);
  }, 240_000);
});

describe.skipIf(!dockerAvailable)("the pod, working", () => {
  /**
   * A builder that gets it wrong the first time and right the second, by reading what it was
   * refused for — which is exactly the story the product claims, and the one a fixture cannot fake.
   */
  const buildsBetterWhenTold = `node -e '
    const fs = require("fs");
    const brief = fs.readFileSync(process.env.POD_BRIEF, "utf8");
    const told = brief.includes("What was refused last time");
    fs.writeFileSync("/work/server.js", told ? "module.exports = (a, b) => a + b" : "module.exports = (a, b) => a - b");
    fs.writeFileSync(process.env.POD_SAY, JSON.stringify({
      decision: "shipped",
      why: told ? "read the refusal and fixed it" : "first attempt",
    }));
  '`;

  /** A reviewer that actually reads the code, rather than trusting what it was told. */
  const readsTheCode = `node -e '
    const fs = require("fs");
    const source = fs.readFileSync("/work/server.js", "utf8");
    const adds = source.includes("a + b");
    fs.writeFileSync(process.env.POD_SAY, JSON.stringify({
      decision: adds ? "approve" : "refuse",
      why: adds ? "it adds, as asked" : "it subtracts where the brief asked it to add",
    }));
  '`;

  test("a refusal sends it back, and the next attempt reads why", async () => {
    const repo = await aRepository();
    const outcome = await runPod({
      repo, brief: "Something that adds two numbers", image: IMAGE, attempts: 3,
      seats: [
        { role: "builder", command: buildsBetterWhenTold, name: "builder-one", email: "b@pod.invalid" },
        { role: "reviewer", command: readsTheCode, name: "reviewer-one", email: "r@pod.invalid" },
      ],
    });

    expect(outcome.attempts).toHaveLength(2);
    expect(outcome.attempts[0]?.refusals).toEqual([
      { role: "reviewer", why: "it subtracts where the brief asked it to add" },
    ]);
    expect(outcome.attempts[1]?.refusals).toEqual([]);
    expect(outcome.agreed).toBe(true);

    // both attempts are in the history, which is what makes the refusal evidence
    const commits = await history(repo);
    expect(commits.length).toBeGreaterThanOrEqual(2);
    expect(outcome.attempts[1]?.built?.said?.why).toBe("read the refusal and fixed it");
  }, 600_000);

  test("a pod that never satisfies its reviewer stops trying, and has not agreed", async () => {
    const repo = await aRepository();
    const neverLearns = `node -e '
      const fs = require("fs");
      fs.writeFileSync("/work/server.js", "module.exports = (a, b) => a - b");
      fs.writeFileSync(process.env.POD_SAY, JSON.stringify({ decision: "shipped", why: "again" }));
    '`;

    const outcome = await runPod({
      repo, brief: "Something that adds two numbers", image: IMAGE, attempts: 2,
      seats: [
        { role: "builder", command: neverLearns, name: "builder-one", email: "b@pod.invalid" },
        { role: "reviewer", command: readsTheCode, name: "reviewer-one", email: "r@pod.invalid" },
      ],
    });

    expect(outcome.attempts).toHaveLength(2);
    expect(outcome.agreed).toBe(false);
    expect(outcome.attempts[1]?.refusals[0]?.role).toBe("reviewer");
  }, 600_000);

  test("a seat that says nothing has not approved, and the work goes back", async () => {
    const repo = await aRepository();
    const saysNothing = `node -e 'require("fs").readFileSync("/work/server.js", "utf8")'`;
    const ships = `node -e '
      const fs = require("fs");
      fs.writeFileSync("/work/server.js", "module.exports = (a, b) => a - b");
      fs.writeFileSync(process.env.POD_SAY, JSON.stringify({ decision: "shipped", why: "shipped" }));
    '`;

    const outcome = await runPod({
      repo, brief: "Something that adds two numbers", image: IMAGE, attempts: 2,
      seats: [
        { role: "builder", command: ships, name: "b", email: "b@pod.invalid" },
        { role: "qa", command: saysNothing, name: "q", email: "q@pod.invalid" },
      ],
    });

    expect(outcome.attempts).toHaveLength(2);
    expect(outcome.agreed).toBe(false);
    expect(outcome.attempts[1]?.read[0]?.said).toBeUndefined();
  }, 600_000);

  test("a pod with no builder is refused before anything runs", async () => {
    const repo = await aRepository();
    expect(runPod({
      repo, brief: "anything", image: IMAGE,
      seats: [{ role: "reviewer", command: readsTheCode, name: "r", email: "r@pod.invalid" }],
    })).rejects.toThrow("nobody to ship anything");
  });
});
