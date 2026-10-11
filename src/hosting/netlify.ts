/**
 * Netlify, as a place a delivered website goes live.
 *
 * The site is made in this server's own Netlify team, so its poster needs no account to open it, and
 * holds nothing of it while they decide. It is made under a word of its own, and a link signed with
 * this server's application secret over that word is what hands it over: whoever opens the link takes
 * the site into their own Netlify account. Files go up by their fingerprints, so only what Netlify
 * does not already hold is sent.
 *
 * Netlify's own guide for tools that deploy for somebody else is what this follows:
 * https://developers.netlify.com/guides/deploying-sites-from-ai-tools/
 */
import { createHash, createHmac } from "node:crypto";
import { z } from "zod";
import { firstLine } from "../errors.ts";
import { pause } from "../pause.ts";
import type { LiveSite, SiteFiles, SiteHost } from "./SiteHost.ts";

export const NETLIFY = "https://api.netlify.com/api/v1";
/** where a person opens a link that hands a site to them */
export const NETLIFY_CLAIM = "https://app.netlify.com/claim";
/** what Netlify is told made the site, and where its own pages say the person came from */
const MADE_BY = "pod";
/** how often a deploy is asked after while Netlify gets it ready, and how long before giving up */
const ASK_EVERY_MS = 1_500;
const READY_WITHIN_MS = 120_000;
/** how this server names itself to Netlify, which asks every caller to */
const USER_AGENT = "POD (proof of development)";
/** how much of a refusal is passed on */
const LONGEST_REFUSAL = 300;
/**
 * What Netlify answers a site it will not make as asked, which is how a name already held is
 * refused. A site's name is its address, one for all of Netlify, and a job's is no secret.
 */
const MAY_BE_THE_NAME: ReadonlySet<number> = new Set([400, 409, 422]);

/** Netlify's refusal, with the status it gave, for the one kind something can be done about. */
class Refused extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** The settings Netlify is reached with: the team's token, and the application whose secret signs a hand-over. */
export const NETLIFY_SETTINGS = {
  token: "POD_NETLIFY_TOKEN",
  team: "POD_NETLIFY_TEAM",
  clientId: "POD_NETLIFY_CLIENT_ID",
  clientSecret: "POD_NETLIFY_CLIENT_SECRET",
} as const;

export interface NetlifyOptions {
  /** a personal access token of the account sites are made in */
  readonly token: string;
  /** the team sites are made in; left out, the account's own */
  readonly team?: string;
  /** the OAuth application a hand-over is signed as; without both, sites go live and cannot be handed over */
  readonly clientId?: string;
  readonly clientSecret?: string;
  /** somewhere else to ask, which is Netlify everywhere but in its own test */
  readonly endpoint?: string;
  readonly readyWithinMs?: number;
}

const SiteSchema = z.object({ id: z.string().min(1), name: z.string().optional(), ssl_url: z.string().optional(), url: z.string().optional() });
type Site = z.infer<typeof SiteSchema>;
const DeploySchema = z.object({ id: z.string().min(1), required: z.array(z.string()).optional(), state: z.string().optional() });

/** A file's fingerprint as Netlify takes it. */
const sha1 = (bytes: Uint8Array): string => createHash("sha1").update(bytes).digest("hex");
const base64url = (value: string | Buffer): string => Buffer.from(value).toString("base64url");

/**
 * The token a hand-over link carries: this application's name and the site's own word, signed with
 * the application's secret, as a web token with the plainest signature there is. Written out rather
 * than taken from a library: it is three lines, and the contracts and the pages take none either.
 */
export function handoverToken(input: { readonly clientId: string; readonly clientSecret: string; readonly handover: string }): string {
  const signed = `${base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${base64url(JSON.stringify({ client_id: input.clientId, session_id: input.handover }))}`;
  return `${signed}.${createHmac("sha256", input.clientSecret).update(signed).digest("base64url")}`;
}

/** The settings name Netlify, or nothing does: a token with no word after it is refused with its name. */
export function netlifyFromTheEnvironment(environment: Record<string, string | undefined> = process.env): SiteHost | undefined {
  const token = environment[NETLIFY_SETTINGS.token]?.trim();
  if (!token) return undefined;
  const team = environment[NETLIFY_SETTINGS.team]?.trim();
  const clientId = environment[NETLIFY_SETTINGS.clientId]?.trim();
  const clientSecret = environment[NETLIFY_SETTINGS.clientSecret]?.trim();
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    throw new Error(`${NETLIFY_SETTINGS.clientId} and ${NETLIFY_SETTINGS.clientSecret} go together: a hand-over is signed by one application, with its secret`);
  }
  return netlify({ token, ...(team ? { team } : {}), ...(clientId && clientSecret ? { clientId, clientSecret } : {}) });
}

export function netlify(options: NetlifyOptions): SiteHost {
  const endpoint = options.endpoint ?? NETLIFY;
  /**
   * The word a site is made under, which its hand-over link is signed over: worked out from what the
   * site is for and a secret only this server holds, so it is never stored and cannot be guessed.
   */
  const wordFor = (madeFor: string): string =>
    createHmac("sha256", options.clientSecret ?? options.token).update(`pod.handover:${madeFor}`).digest("hex");

  /** Ask Netlify, and say its own words back when it refuses. */
  async function ask(path: string, init: RequestInit & { readonly what: string }): Promise<Response> {
    const response = await fetch(`${endpoint}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${options.token}`, "user-agent": USER_AGENT, ...init.headers },
    });
    if (!response.ok) {
      const said = (await response.text().catch(() => "")).trim().slice(0, LONGEST_REFUSAL);
      throw new Refused(`Netlify would not ${init.what}: ${response.status}${said ? ` ${firstLine(new Error(said))}` : ""}`, response.status);
    }
    return response;
  }

  async function readAs<T>(response: Response, schema: z.ZodType<T>, what: string): Promise<T> {
    const parsed = schema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw new Error(`Netlify answered ${what} with something that could not be read`);
    return parsed.data;
  }

  const sitesAt = options.team ? `/${encodeURIComponent(options.team)}/sites` : "/sites";

  /** A site this account holds under exactly this name, if it holds one. */
  async function ours(name: string): Promise<Site | undefined> {
    const held = await readAs(await ask(`${sitesAt}?name=${encodeURIComponent(name)}`, { what: "say whether it holds the site" }), z.array(SiteSchema), "which sites it holds");
    return held.find((site) => site.name === name);
  }

  /**
   * Make a site under a name and a word of its own. When the name is held already, it is one of two
   * things. A site of this account's, left by a try that was cut short before it could be written
   * down or taken away: that one is filled, being the same job's under the same word. Or somebody
   * else's, since anybody who reads an open job can work out its name: then Netlify names this one,
   * so that taking a name keeps no job from going live.
   */
  async function make(name: string, word: string): Promise<Site> {
    const made = async (named: boolean): Promise<Site> => readAs(await ask(sitesAt, {
      what: "make the site", method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...(named ? { name } : {}), created_via: MADE_BY, session_id: word }),
    }), SiteSchema, "making the site");
    try {
      return await made(true);
    } catch (error) {
      if (!(error instanceof Refused) || !MAY_BE_THE_NAME.has(error.status)) throw error;
      return (await ours(name)) ?? (await made(false));
    }
  }

  /** Take a site down for good. One already gone is what was asked for. */
  async function remove(siteId: string): Promise<void> {
    const response = await fetch(`${endpoint}/sites/${encodeURIComponent(siteId)}`, {
      method: "DELETE", headers: { authorization: `Bearer ${options.token}`, "user-agent": USER_AGENT },
    });
    if (response.ok || response.status === 404) return;
    throw new Error(`Netlify would not take the site down: ${response.status}`);
  }

  /** Send a made site its files, by fingerprint, and wait until Netlify says it is ready. */
  async function fill(siteId: string, files: SiteFiles): Promise<void> {
    const prints = new Map([...files].map(([address, bytes]) => [address, sha1(bytes)] as const));
    const deploy = await readAs(await ask(`/sites/${encodeURIComponent(siteId)}/deploys`, {
      what: "take the site's files", method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: Object.fromEntries(prints) }),
    }), DeploySchema, "the list of files");
    // only what Netlify does not hold already, each file once however many addresses share its contents
    const wanted = new Set(deploy.required ?? []);
    for (const [address, bytes] of files) {
      const print = prints.get(address);
      if (print === undefined || !wanted.delete(print)) continue;
      const path = address.split("/").map(encodeURIComponent).join("/");
      await ask(`/deploys/${encodeURIComponent(deploy.id)}/files${path}`, {
        what: `take ${address}`, method: "PUT", headers: { "content-type": "application/octet-stream" }, body: bytes,
      });
    }

    const readyWithinMs = options.readyWithinMs ?? READY_WITHIN_MS;
    const deadline = Date.now() + readyWithinMs;
    for (;;) {
      const now = await readAs(await ask(`/deploys/${encodeURIComponent(deploy.id)}`, { what: "say whether the site is ready" }), DeploySchema, "whether the site is ready");
      if (now.state === "ready") return;
      if (now.state === "error") throw new Error("Netlify could not get the site ready");
      if (Date.now() >= deadline) throw new Error(`Netlify had not got the site ready after ${Math.round(readyWithinMs / 1000)}s`);
      await pause(ASK_EVERY_MS);
    }
  }

  return {
    name: "Netlify",

    async publish({ name, files, madeFor }): Promise<LiveSite> {
      const site = await make(name, wordFor(madeFor));
      try {
        const url = site.ssl_url ?? site.url;
        if (!url) throw new Error("Netlify made the site and did not say where it is");
        await fill(site.id, files);
        return { siteId: site.id, url };
      } catch (error) {
        // a site made and never filled is taken down again: left standing, it would hold the name the next try needs
        await remove(site.id).catch(() => undefined);
        throw error;
      }
    },

    async handoverLink(madeFor): Promise<string> {
      const { clientId, clientSecret } = options;
      if (!clientId || !clientSecret) {
        throw new Error(`this server names no Netlify application to hand a site over as: ${NETLIFY_SETTINGS.clientId} and ${NETLIFY_SETTINGS.clientSecret} are not set`);
      }
      return `${NETLIFY_CLAIM}?utm_source=${MADE_BY}#${handoverToken({ clientId, clientSecret, handover: wordFor(madeFor) })}`;
    },

    remove,
  };
}
