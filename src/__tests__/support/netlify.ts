/**
 * A stand-in for Netlify, for tests: a server on a real port that takes a site the way Netlify's own
 * guide for tools says it does. A site is made under a word of its own, its files are offered by
 * their fingerprints, only the ones not already held are sent, and the deploy is asked after until it
 * is ready. So everything between this project and the wire is the code that runs in production.
 * Against Netlify itself, netlify-live.test.ts runs when a token is set.
 */
import { createHash } from "node:crypto";

/** where the stand-in serves the sites it holds, apart from the calls Netlify's own interface takes */
const SITES_AT = "/at/";
const FRONT_PAGE = "/index.html";
/** the name it gives a site asked for with none, as Netlify does */
export const NAMED_BY_NETLIFY = "curious-otter-1a2b3c";

export interface Asked { readonly method: string; readonly path: string; readonly headers: Headers; readonly body: Uint8Array }

export interface NetlifySaying {
  readonly endpoint: string;
  /** everything it was sent, in order */
  readonly asked: Asked[];
  /** the files of the site it holds, by address, once they have arrived */
  readonly files: Map<string, string>;
  /** the sites it was asked to take down */
  readonly removed: string[];
  /** where a site of some name answers visitors: on this stand-in's own port, with the files it was sent */
  addressOf(name: string): string;
  /** every address a visitor opened, in order: not asked of Netlify, so not among `asked` */
  readonly visited: string[];
  /** from now on it refuses nothing it was set to refuse: a bad moment that has passed */
  recover(): void;
  stop(): void;
}

/**
 * It already holds whatever is in `holds`, by fingerprint, and says a deploy is ready once every file
 * it asked for has arrived and it has been asked `readyAfter` times.
 */
export function netlifySaying(options: {
  /** sites it holds before anything is asked: this account's, or somebody else's, whose name is taken all the same */
  readonly sites?: readonly { readonly id: string; readonly name: string; readonly ours: boolean }[];
  readonly holds?: readonly string[];
  readonly readyAfter?: number;
  readonly refuses?: { readonly path: RegExp; readonly status: number; readonly body: string };
  /** it keeps every site private, as a team does whose new sites are: a visitor is sent to sign in */
  readonly keepsSitesPrivate?: boolean;
} = {}): NetlifySaying {
  const asked: Asked[] = [];
  const files = new Map<string, string>();
  const removed: string[] = [];
  const visited: string[] = [];
  const wanted = new Set<string>();
  let askedAfter = 0;
  let refuses = options.refuses;
  const addressOf = (name: string): string => `http://localhost:${server.port}${SITES_AT}${name}`;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const { pathname: path, searchParams } = new URL(request.url);
      if (path.startsWith(SITES_AT)) {
        // a visitor, not a caller of Netlify's: the site itself, or its team's sign-in page in front of it
        visited.push(path);
        if (options.keepsSitesPrivate) return new Response("<title>Login Redirect</title>", { status: 401, headers: { "content-type": "text/html" } });
        const front = files.get(FRONT_PAGE);
        return front === undefined ? new Response("Not Found", { status: 404 }) : new Response(front, { headers: { "content-type": "text/html" } });
      }
      const body = new Uint8Array(await request.arrayBuffer());
      asked.push({ method: request.method, path, headers: request.headers, body });
      if (refuses?.path.test(path)) return new Response(refuses.body, { status: refuses.status });
      if (request.method === "GET" && /\/sites\/?$/.test(path)) {
        // as Netlify lists them: this account's alone, any whose name has the asked one in it
        return Response.json((options.sites ?? []).filter((site) => site.ours && site.name.includes(searchParams.get("name") ?? ""))
          .map((site) => ({ id: site.id, name: site.name, ssl_url: addressOf(site.name) })));
      }
      if (request.method === "POST" && /\/sites\/?$/.test(path)) {
        const { name } = JSON.parse(new TextDecoder().decode(body)) as { name?: string };
        if (name !== undefined && (options.sites ?? []).some((site) => site.name === name)) return new Response(`{"errors":{"subdomain":["must be unique"]}}`, { status: 422 });
        // a site asked for with no name is given one of Netlify's own
        return name === undefined
          ? Response.json({ id: "site-2", name: NAMED_BY_NETLIFY, ssl_url: addressOf(NAMED_BY_NETLIFY) })
          : Response.json({ id: "site-1", name, ssl_url: addressOf(name), url: addressOf(name) });
      }
      if (request.method === "POST" && path.endsWith("/deploys")) {
        const offered = JSON.parse(new TextDecoder().decode(body)) as { files: Record<string, string> };
        for (const print of Object.values(offered.files)) if (!(options.holds ?? []).includes(print)) wanted.add(print);
        return Response.json({ id: "deploy-1", required: [...wanted], state: "uploading" });
      }
      if (request.method === "PUT") {
        wanted.delete(createHash("sha1").update(body).digest("hex"));
        files.set(decodeURIComponent(path.slice(path.indexOf("/files/") + "/files".length)), new TextDecoder().decode(body));
        return Response.json({});
      }
      if (request.method === "GET" && path.endsWith("/deploys/deploy-1")) {
        askedAfter++;
        return Response.json({ id: "deploy-1", state: wanted.size === 0 && askedAfter >= (options.readyAfter ?? 1) ? "ready" : "uploading" });
      }
      if (request.method === "DELETE") {
        removed.push(path.slice(path.lastIndexOf("/") + 1));
        return new Response(null, { status: 200 });
      }
      return new Response("no such thing", { status: 404 });
    },
  });
  return { endpoint: `http://localhost:${server.port}/api/v1`, asked, files, removed, addressOf, visited, recover: () => { refuses = undefined; }, stop: () => { void server.stop(true); } };
}
