import { afterEach, describe, expect, test } from "bun:test";
import { createHmac, createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { handoverToken, netlify, NETLIFY_CLAIM, NETLIFY_SETTINGS, netlifyFromTheEnvironment, NotAWebsite, SITE_LIMITS, siteFilesIn, siteNameFor } from "../hosting/index.ts";
import { NAMED_BY_NETLIFY, netlifySaying as standIn, type Asked } from "./support/netlify.ts";

/**
 * A delivered website put live on Netlify, asked for real over HTTP.
 *
 * What stands in for Netlify is a server on a real port that takes a site the way Netlify's own guide
 * for tools says it does: a site made under a word of its own, its files offered by their
 * fingerprints, only the ones it does not hold sent, and the deploy asked after until it is ready. So
 * everything between the worker and the wire is the code that runs in production. Against Netlify
 * itself it is run by netlify-live.test.ts, when a token is set.
 */

const standing: { stop(): void }[] = [];
afterEach(() => { for (const one of standing.splice(0)) one.stop(); });
const sha1 = (text: string): string => createHash("sha1").update(text).digest("hex");
const bytes = (text: string): Uint8Array<ArrayBuffer> => new Uint8Array(new TextEncoder().encode(text));
const textOf = (asked: Asked): string => new TextDecoder().decode(asked.body);
/** A stand-in for Netlify, stopped when the test ends. */
function netlifySaying(options: Parameters<typeof standIn>[0] = {}): ReturnType<typeof standIn> {
  const saying = standIn(options);
  standing.push(saying);
  return saying;
}

/** the word a site is made under, as the piece works it out from what the site is for and its own secret */
const wordFor = (madeFor: string, secret: string): string => createHmac("sha256", secret).update(`pod.handover:${madeFor}`).digest("hex");

const SITE = new Map([["/index.html", bytes("<h1>front</h1>")], ["/cards/mewtwo.html", bytes("<h1>Mewtwo</h1>")], ["/copy of front.html", bytes("<h1>front</h1>")]]);

describe("a website put live on Netlify", () => {
  test("the site is made under its own word, its files offered by fingerprint and sent once each, and its address comes back when it is ready", async () => {
    const { endpoint, asked, addressOf, visited } = netlifySaying();
    const live = await netlify({ token: "the-token", endpoint }).publish({ name: "pod-a-coat", files: SITE, madeFor: "a-coat:0xseal" });

    expect(live).toEqual({ siteId: "site-1", url: addressOf("pod-a-coat") });
    // opened once as a stranger would, before it is called live
    expect(visited).toEqual(["/at/pod-a-coat"]);
    const [made, offered, ...rest] = asked;
    expect(made?.method).toBe("POST");
    expect(made?.path).toBe("/api/v1/sites");
    expect(made?.headers.get("authorization")).toBe("Bearer the-token");
    // made under a word nobody could guess, worked out from what the site is for: nothing to keep, nothing to steal
    expect(JSON.parse(textOf(made!))).toEqual({ name: "pod-a-coat", created_via: "pod", session_id: wordFor("a-coat:0xseal", "the-token") });
    expect(offered?.path).toBe("/api/v1/sites/site-1/deploys");
    expect(JSON.parse(textOf(offered!))).toEqual({ files: {
      "/index.html": sha1("<h1>front</h1>"), "/cards/mewtwo.html": sha1("<h1>Mewtwo</h1>"), "/copy of front.html": sha1("<h1>front</h1>"),
    } });
    // two addresses hold the same page: it is sent once, and an address is written as an address is
    const sent = rest.filter((one) => one.method === "PUT");
    expect(sent.map((one) => one.path)).toEqual(["/api/v1/deploys/deploy-1/files/index.html", "/api/v1/deploys/deploy-1/files/cards/mewtwo.html"]);
    expect(sent.map(textOf)).toEqual(["<h1>front</h1>", "<h1>Mewtwo</h1>"]);
    expect(sent.every((one) => one.headers.get("content-type") === "application/octet-stream")).toBe(true);
  });

  test("a file Netlify holds already is not sent again, and a team's sites are made in the team", async () => {
    const { endpoint, asked } = netlifySaying({ holds: [sha1("<h1>front</h1>")] });
    await netlify({ token: "t", team: "proof of development", endpoint }).publish({ name: "n", files: SITE, madeFor: "w" });
    expect(asked[0]?.path).toBe("/api/v1/proof%20of%20development/sites");
    expect(asked.filter((one) => one.method === "PUT").map((one) => one.path)).toEqual(["/api/v1/deploys/deploy-1/files/cards/mewtwo.html"]);
  });

  test("it waits for Netlify to say the site is ready, and gives up in words when it never does", async () => {
    const slow = netlifySaying({ readyAfter: 2 });
    const live = await netlify({ token: "t", endpoint: slow.endpoint }).publish({ name: "n", files: SITE, madeFor: "w" });
    expect(live.url).toBe(slow.addressOf("n"));
    expect(slow.asked.filter((one) => one.method === "GET")).toHaveLength(2);

    const never = netlifySaying({ readyAfter: Number.POSITIVE_INFINITY });
    await expect(netlify({ token: "t", endpoint: never.endpoint, readyWithinMs: 1 }).publish({ name: "n", files: SITE, madeFor: "w" }))
      .rejects.toThrow("Netlify had not got the site ready");
  }, 20_000);

  test("a site its team keeps private is not called live: it is taken down again, and the reason names the setting", async () => {
    const { endpoint, removed, visited } = netlifySaying({ keepsSitesPrivate: true });
    await expect(netlify({ token: "t", endpoint }).publish({ name: "pod-a-coat", files: SITE, madeFor: "w" }))
      .rejects.toThrow("Netlify made the site and keeps it private, so only its team could open it (it answered 401): the team's default project visibility has to be public for new projects");
    expect(visited).toEqual(["/at/pod-a-coat"]);
    expect(removed).toEqual(["site-1"]);
  });

  test("a refusal is said with Netlify's own words, names what was being asked, and is not asked again", async () => {
    const { endpoint, asked } = netlifySaying({ refuses: { path: /\/sites$/, status: 401, body: `{"code":401,"message":"Access Denied"}` } });
    await expect(netlify({ token: "t", endpoint }).publish({ name: "n", files: SITE, madeFor: "w" }))
      .rejects.toThrow(`Netlify would not make the site: 401 {"code":401,"message":"Access Denied"}`);
    expect(asked.map((one) => one.method)).toEqual(["POST"]);
  });

  test("a name held by a site of this account's, left by a try that was cut short, is filled rather than refused for ever", async () => {
    const { endpoint, asked, files, addressOf } = netlifySaying({ sites: [{ id: "left-behind", name: "pod-a-coat-abcd1234", ours: true }, { id: "another", name: "pod-a-coat-abcd1234-old", ours: true }] });
    const live = await netlify({ token: "t", endpoint }).publish({ name: "pod-a-coat-abcd1234", files: SITE, madeFor: "w" });
    expect(live).toEqual({ siteId: "left-behind", url: addressOf("pod-a-coat-abcd1234") });
    expect(files.get("/index.html")).toBe("<h1>front</h1>");
    // made once, refused, looked for, and filled: no second site
    expect(asked.filter((one) => one.method === "POST" && one.path.endsWith("/sites"))).toHaveLength(1);
    expect(asked.some((one) => one.method === "POST" && one.path === "/api/v1/sites/left-behind/deploys")).toBe(true);
  });

  test("a name somebody else took keeps no job from going live: Netlify names the site, under the same word", async () => {
    const { endpoint, asked, addressOf } = netlifySaying({ sites: [{ id: "theirs", name: "pod-a-coat-abcd1234", ours: false }] });
    const live = await netlify({ token: "the-token", endpoint }).publish({ name: "pod-a-coat-abcd1234", files: SITE, madeFor: "a-coat:0xseal" });
    expect(live).toEqual({ siteId: "site-2", url: addressOf(NAMED_BY_NETLIFY) });
    const makings = asked.filter((one) => one.method === "POST" && one.path.endsWith("/sites")).map((one) => JSON.parse(textOf(one)) as Record<string, unknown>);
    expect(makings).toEqual([
      { name: "pod-a-coat-abcd1234", created_via: "pod", session_id: wordFor("a-coat:0xseal", "the-token") },
      { created_via: "pod", session_id: wordFor("a-coat:0xseal", "the-token") },
    ]);
  });

  test("a site that was made and then could not be filled is taken down again, so the next try is not kept out by its own leftover", async () => {
    const { endpoint, asked, removed } = netlifySaying({ refuses: { path: /\/deploys$/, status: 500, body: "the deploy could not start" } });
    await expect(netlify({ token: "t", endpoint }).publish({ name: "n", files: SITE, madeFor: "w" })).rejects.toThrow("Netlify would not take the site's files: 500");
    expect(removed).toEqual(["site-1"]);
    expect(asked.at(-1)).toMatchObject({ method: "DELETE", path: "/api/v1/sites/site-1" });
  });

  test("the link that hands a site over carries its own word, signed as this server's application, and cannot be made without one", async () => {
    const host = netlify({ token: "t", clientId: "the-app", clientSecret: "the-secret" });
    const link = await host.handoverLink("a-coat:0xseal");
    expect(link.startsWith(`${NETLIFY_CLAIM}?utm_source=pod#`)).toBe(true);
    const [header, payload, signature] = link.slice(link.indexOf("#") + 1).split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "HS256", typ: "JWT" });
    // the same word the site was made under, so this link takes that site and no other
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toEqual({ client_id: "the-app", session_id: wordFor("a-coat:0xseal", "the-secret") });
    expect(signature).toBe(createHmac("sha256", "the-secret").update(`${header}.${payload}`).digest("base64url"));
    expect(await host.handoverLink("another-job:0xseal")).not.toBe(link);
    expect(handoverToken({ clientId: "the-app", clientSecret: "the-secret", handover: wordFor("a-coat:0xseal", "the-secret") })).toBe(link.slice(link.indexOf("#") + 1));

    await expect(netlify({ token: "t" }).handoverLink("w")).rejects.toThrow(NETLIFY_SETTINGS.clientSecret);
  });

  test("a site is taken down by its name, and one already gone is no failure", async () => {
    const { endpoint, asked } = netlifySaying();
    await netlify({ token: "t", endpoint }).remove("site-1");
    expect(asked[0]).toMatchObject({ method: "DELETE", path: "/api/v1/sites/site-1" });

    const gone = netlifySaying({ refuses: { path: /\/sites\/site-9$/, status: 404, body: "Not Found" } });
    await netlify({ token: "t", endpoint: gone.endpoint }).remove("site-9");
    const broken = netlifySaying({ refuses: { path: /\/sites\/site-9$/, status: 500, body: "oops" } });
    await expect(netlify({ token: "t", endpoint: broken.endpoint }).remove("site-9")).rejects.toThrow("Netlify would not take the site down: 500");
  });

  test("a job's live site is named for the job, with enough of its seal that no two share a name, and never longer than a host allows", () => {
    expect(siteNameFor({ jobId: "a-coat", seal: "0xABCDEF0123456789" })).toBe("pod-a-coat-abcdef01");
    const long = siteNameFor({ jobId: "a".repeat(64), seal: "0xabcdef0123456789" });
    expect(long).toHaveLength(63);
    expect(long.endsWith("-abcdef01")).toBe(true);
    expect(siteNameFor({ jobId: "a-coat", seal: "0x1111111111" })).not.toBe(siteNameFor({ jobId: "a-coat", seal: "0x2222222222" }));
  });

  test("the settings name Netlify or nothing does, and half an application is refused by name", () => {
    expect(netlifyFromTheEnvironment({})).toBeUndefined();
    expect(netlifyFromTheEnvironment({ [NETLIFY_SETTINGS.token]: "t" })?.name).toBe("Netlify");
    expect(() => netlifyFromTheEnvironment({ [NETLIFY_SETTINGS.token]: "t", [NETLIFY_SETTINGS.clientId]: "app" })).toThrow(NETLIFY_SETTINGS.clientSecret);
  });
});

describe("a website's files, read from a pod's work", () => {
  async function work(files: Readonly<Record<string, string | Uint8Array>>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "pod-site-files-"));
    await chmod(root, 0o755);
    for (const [name, contents] of Object.entries(files)) {
      await mkdir(dirname(join(root, name)), { recursive: true });
      await writeFile(join(root, name), contents);
    }
    return root;
  }
  const names = (files: ReadonlyMap<string, Uint8Array>): string[] => [...files.keys()];

  test("every file is read by its address on the site, folders included, in an order that does not change", async () => {
    const root = await work({ "site/index.html": "front", "site/cards/mewtwo.html": "mewtwo", "site/style.css": "body{}", "server.js": "not part of the website" });
    const files = await siteFilesIn(join(root, "site"), "index.html");
    expect(names(files)).toEqual(["/cards/mewtwo.html", "/index.html", "/style.css"]);
    expect(new TextDecoder().decode(files.get("/cards/mewtwo.html"))).toBe("mewtwo");
  });

  test("a link is left out, wherever it points, so nothing of this machine is ever published", async () => {
    const root = await work({ "site/index.html": "front", "secret.txt": "a key of ours" });
    await symlink("../secret.txt", join(root, "site", "stolen.txt"));
    await symlink("..", join(root, "site", "up"));
    expect(names(await siteFilesIn(join(root, "site"), "index.html"))).toEqual(["/index.html"]);
  });

  test("work with no website, or no front page, is refused in words for the pod that built it", async () => {
    const empty = await work({ "server.js": "a program" });
    await expect(siteFilesIn(join(empty, "site"), "index.html")).rejects.toThrow("the work has no website folder in it");
    const headless = await work({ "site/about.html": "about" });
    await expect(siteFilesIn(join(headless, "site"), "index.html")).rejects.toThrow("no index.html at its top");
    await expect(siteFilesIn(join(headless, "site"), "index.html")).rejects.toBeInstanceOf(NotAWebsite);
  });

  test("a name a host could misread, a file too large and a website too large are each refused", async () => {
    const odd = await work({ "site/index.html": "front", "site/what?.html": "a question" });
    await expect(siteFilesIn(join(odd, "site"), "index.html")).rejects.toThrow(`"/what?.html" is a name no host can serve`);
    const hidden = await work({ "site/index.html": "front", "site/.env": "a secret left in the folder" });
    await expect(siteFilesIn(join(hidden, "site"), "index.html")).rejects.toThrow(`"/.env" is a name no host can serve`);
    const heavy = await work({ "site/index.html": "front", "site/film.bin": new Uint8Array(SITE_LIMITS.bytesEach + 1) });
    await expect(siteFilesIn(join(heavy, "site"), "index.html")).rejects.toThrow(`"/film.bin" is larger than a website's file may be`);
  });
});
