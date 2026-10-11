import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { grade, type CheckToRun } from "../blackbox.ts";
import { SERVE_THE_SITE, SITE_FOLDER, START, startFor, workFileFor } from "../job.ts";
import { IMAGE } from "../sandbox.ts";
import { dockerAvailable } from "./support/tools.ts";

/**
 * A job that is a website: a folder of files, served as they are for its checks by a server that is
 * ours and the same for every website. Real boxes, real files, real requests.
 */
const withDocker = await dockerAvailable();

/** A folder of work, files in folders included, readable by the box the way a checkout is. */
async function work(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pod-site-work-"));
  await chmod(root, 0o755);
  for (const [name, contents] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true, mode: 0o755 });
    await writeFile(join(root, name), contents, { mode: 0o644 });
  }
  return root;
}

/** A check that asks for an address and passes when the status and, if given, a piece of the body are as expected. */
const expects = (address: string, status: number, holds?: string): string => `import http from "node:http";
const target = new URL(process.env.TARGET);
// asked exactly as written: the address is not tidied first, as fetch would tidy it
const answer = await new Promise((resolve, reject) => {
  http.get({ host: target.hostname, port: target.port, path: ${JSON.stringify(address)} }, (response) => {
    let body = "";
    response.on("data", (chunk) => (body += chunk));
    response.on("end", () => resolve({ status: response.statusCode, body, type: response.headers["content-type"] }));
  }).on("error", reject);
});
const ok = answer.status === ${status}${holds === undefined ? "" : ` && answer.body.includes(${JSON.stringify(holds)})`};
console.log(${JSON.stringify(address)} + " answered " + answer.status + " " + answer.type + (ok ? "" : ": " + answer.body.slice(0, 60)));
process.exit(ok ? 0 : 1);
`;

async function graded(files: Readonly<Record<string, string>>, asked: readonly { readonly says: string; readonly check: string }[], prepare?: (root: string) => Promise<void>) {
  const artefact = await work(files);
  await prepare?.(artefact);
  const checks = await work(Object.fromEntries(asked.map((one, index) => [`check-${index + 1}.mjs`, one.check])));
  const toRun: CheckToRun[] = asked.map((one, index) => ({ says: one.says, command: `node check-${index + 1}.mjs`, hidden: false }));
  return grade({ artefact, start: SERVE_THE_SITE, checks, toRun, image: IMAGE });
}

describe("how a job's work is started", () => {
  test("a website's files are served by our own server, and a program is run as before", () => {
    expect(startFor("site")).toBe(SERVE_THE_SITE);
    expect(startFor("service")).toBe(START);
    expect(startFor("page")).toBe(START);
    // a job sealed before the page asked what it was is a program
    expect(startFor(undefined)).toBe(START);
    expect(workFileFor("site")).toBe(`${SITE_FOLDER}/index.html`);
    expect(workFileFor("service")).toBe("server.js");
  });

  test("the command that serves a website can be handed to a shell inside one pair of quotes, and names no file of the pod's", () => {
    expect(SERVE_THE_SITE.startsWith("node -e '")).toBe(true);
    expect(SERVE_THE_SITE.endsWith("'")).toBe(true);
    expect(SERVE_THE_SITE.slice("node -e '".length, -1)).not.toContain("'");
    expect(SERVE_THE_SITE).not.toContain("server.js");
  });
});

describe.skipIf(!withDocker)("a website, served for its checks", () => {
  test("its pages answer at their own addresses, as a folder's front page, and with .html left off", async () => {
    const outcome = await graded({
      "site/index.html": "<h1>Pokemon cards</h1>",
      "site/cards/mewtwo.html": "<h1>Mewtwo</h1>",
      "site/about/index.html": "<p>about this deck</p>",
      "site/style.css": "body { margin: 0 }",
    }, [
      { says: "the front page", check: expects("/", 200, "Pokemon cards") },
      { says: "the front page by its name", check: expects("/index.html", 200, "Pokemon cards") },
      { says: "a page by its file", check: expects("/cards/mewtwo.html", 200, "Mewtwo") },
      { says: "a page with .html left off", check: expects("/cards/mewtwo", 200, "Mewtwo") },
      { says: "a folder's front page", check: expects("/about/", 200, "about this deck") },
      { says: "a stylesheet", check: expects("/style.css", 200, "margin") },
      { says: "a page with a question after it", check: expects("/cards/mewtwo?from=front", 200, "Mewtwo") },
      { says: "nothing at an address with no file", check: expects("/cards/pikachu", 404) },
    ]);
    expect(outcome.checks.map((check) => [check.says, check.exitCode])).toEqual(outcome.checks.map((check) => [check.says, 0]));
    expect(outcome.passed).toBe(true);
    expect(outcome.checks.find((check) => check.says === "a stylesheet")?.output).toContain("text/css");
  }, 240_000);

  test("nothing above the website's folder is served, by an address or by a link, and a malformed address is answered, not crashed on", async () => {
    const outcome = await graded({
      "site/index.html": "<h1>front</h1>",
      "notes-of-the-pod.txt": "not part of the website",
    }, [
      { says: "an address that climbs out", check: expects("/../notes-of-the-pod.txt", 404) },
      { says: "an address that climbs out, written in code", check: expects("/%2e%2e/notes-of-the-pod.txt", 404) },
      { says: "an address that climbs out with a coded slash", check: expects("/..%2fnotes-of-the-pod.txt", 404) },
      { says: "a link to a file outside", check: expects("/outside.txt", 404) },
      { says: "a file through a linked folder", check: expects("/up/notes-of-the-pod.txt", 404) },
      { says: "a malformed address", check: expects("/%zz", 400) },
      { says: "the front page still answers after all that", check: expects("/", 200, "front") },
    ], async (root) => {
      await symlink("../notes-of-the-pod.txt", join(root, SITE_FOLDER, "outside.txt"));
      await symlink("..", join(root, SITE_FOLDER, "up"));
    });
    expect(outcome.checks.map((check) => [check.says, check.exitCode])).toEqual(outcome.checks.map((check) => [check.says, 0]));
  }, 240_000);

  test("work with no website in it starts all the same and answers not found, so its checks fail on the work and not on the box", async () => {
    const outcome = await graded({ "README.md": "nothing built yet" }, [{ says: "the front page", check: expects("/", 200) }]);
    expect(outcome.passed).toBe(false);
    expect(outcome.checks[0]?.exitCode).toBe(1);
    expect(outcome.checks[0]?.output).toContain("/ answered 404");
  }, 240_000);
});
