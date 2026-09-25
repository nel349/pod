import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dockerArguments, readableToTheBox, runSealed, writableByTheBox } from "../sandbox.ts";
import { checkout } from "./support/checkout.ts";
import { dockerAvailable } from "./support/tools.ts";

/** Pinned by digest, not by tag: the same image in September and in October. */
const IMAGE = "node@sha256:9bef0ef1e268f60627da9ba7d7605e8831d5b56ad07487d24d1aa386336d1944";
const FIXTURE = new URL("../../fixtures/honest", import.meta.url).pathname;

const withDocker = await dockerAvailable();

describe("the arguments that keep the box shut", () => {
  test("no route out, no capabilities, nothing writable that matters", () => {
    const args = dockerArguments({ source: "/x", command: "true", image: IMAGE }, "pod-test").join(" ");
    expect(args).toContain("--network none");
    expect(args).toContain("--cap-drop ALL");
    expect(args).toContain("--security-opt no-new-privileges");
    expect(args).toContain("--read-only");
    expect(args).toContain("/x:/repo:ro");
  });

  test("the image is pinned by digest rather than a tag", () => {
    const args = dockerArguments({ source: "/x", command: "true", image: IMAGE }, "pod-test");
    expect(args).toContain(IMAGE);
    expect(IMAGE).toContain("@sha256:");
  });
});

describe("opening a directory to the box", () => {
  /**
   * Code arrives with links in it, put there by whoever wrote it, and a link can point anywhere on
   * the machine. Opening a directory to the box must open the directory, never where a link leads.
   */
  async function aSecretAndALinkToIt(): Promise<{ readonly directory: string; readonly secret: string; readonly folder: string }> {
    const outside = await mkdtemp(join(tmpdir(), "pod-outside-"));
    const secret = join(outside, "secret");
    await writeFile(secret, "not the code's");
    await chmod(secret, 0o600);
    const folder = join(outside, "folder");
    await mkdir(folder, { mode: 0o700 });
    const directory = await mkdtemp(join(tmpdir(), "pod-code-"));
    await writeFile(join(directory, "server.js"), "");
    await symlink(secret, join(directory, "looks-harmless"));
    await symlink(folder, join(directory, "a-folder"));
    return { directory, secret, folder };
  }

  test("making it readable leaves what a link points at as it was", async () => {
    const { directory, secret, folder } = await aSecretAndALinkToIt();
    await readableToTheBox(directory);
    expect((await stat(join(directory, "server.js"))).mode & 0o777).toBe(0o644);
    expect((await stat(secret)).mode & 0o777).toBe(0o600);
    expect((await stat(folder)).mode & 0o777).toBe(0o700);
  });

  test("making it writable leaves what a link points at as it was", async () => {
    const { directory, secret, folder } = await aSecretAndALinkToIt();
    await writableByTheBox(directory);
    expect((await stat(join(directory, "server.js"))).mode & 0o777).toBe(0o666);
    expect((await stat(secret)).mode & 0o777).toBe(0o600);
    expect((await stat(folder)).mode & 0o777).toBe(0o700);
  });
});

describe.skipIf(!withDocker)("sandbox, against a real container", () => {
  test("an honest run finishes, and both escapes are refused", async () => {
    const outcome = await runSealed({ source: FIXTURE, command: "sh run.sh", image: IMAGE, timeoutSeconds: 90 });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.output).toContain("worked");
    expect(outcome.output).toContain("internet: blocked");
    expect(outcome.output).toContain("root filesystem: read-only");
    expect(outcome.timedOut).toBe(false);
  }, 120_000);

  test("the same work run twice says exactly the same thing", async () => {
    const one = await runSealed({ source: FIXTURE, command: "sh run.sh", image: IMAGE, timeoutSeconds: 90 });
    const two = await runSealed({ source: FIXTURE, command: "sh run.sh", image: IMAGE, timeoutSeconds: 90 });
    expect(one.output).toBe(two.output);
    expect(one.exitCode).toBe(two.exitCode);
  }, 180_000);

  test("a run that will not stop is killed from outside, and leaves nothing behind", async () => {
    const outcome = await runSealed({ source: FIXTURE, command: "sleep 600", image: IMAGE, timeoutSeconds: 5 });
    expect(outcome.timedOut).toBe(true);
    expect(outcome.seconds).toBeLessThan(30);

    const running = await new Response(
      Bun.spawn(["docker", "ps", "--filter", "name=pod-", "--format", "{{.Names}}"], { stdout: "pipe" }).stdout,
    ).text();
    expect(running.trim()).toBe("");
  }, 60_000);
});

describe.skipIf(!withDocker)("the install phase", () => {
  test("it has a route out, and what it installs lands where the graded run will find it", async () => {
    const { chmod, mkdir, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");

    const source = await checkout("pod-src-", {});
    // the install writes here, so the box needs more than a read: 0777 is what a scratch dir is
    const destination = await checkout("pod-out-", {});
    await chmod(destination, 0o777);
    await mkdir(join(source, "app"), { recursive: true });
    await writeFile(join(source, "app", "index.js"), "console.log('hi')\n");
    await chmod(join(source, "app"), 0o755);

    const { installDependencies } = await import("../sandbox.ts");
    const outcome = await installDependencies({
      source,
      destination,
      // stands in for a real install: it needs the network and leaves something behind
      command: "getent hosts registry.npmjs.org > vendor.txt && echo done",
      image: IMAGE,
      timeoutSeconds: 120,
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.output).toContain("done");
    expect(await Bun.file(join(destination, "vendor.txt")).exists()).toBe(true);
    expect(await Bun.file(join(destination, "app", "index.js")).exists()).toBe(true);
  }, 180_000);

  test("the graded run that follows has no route out, even though the install did", async () => {
    const outcome = await runSealed({
      source: FIXTURE,
      command: "sh run.sh",
      image: IMAGE,
      timeoutSeconds: 90,
    });
    expect(outcome.output).toContain("internet: blocked");
  }, 120_000);
});
