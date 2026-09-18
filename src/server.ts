/**
 * The public face: the wall, one job, and the checks anyone can fetch.
 *
 * Every page here is readable with no wallet, no key and no account, because the promise of the
 * project is that a stranger can check a verdict. The handler is a plain function from a request to
 * a response so the tests can walk every route without opening a port.
 *
 * What it will not do: invent a tile. An empty wall says it is empty. A job with no receipt says the
 * receipt is missing. A missing source is a sentence, never a placeholder number.
 */
import { renderWall } from "./gallery.ts";
import { renderAgent } from "./agentpage.ts";
import { renderJob } from "./jobpage.ts";
import { checksArePublished, JobStore } from "./store.ts";
import { checkFilePath, checksPath, isSafeName, ROUTES } from "./routes.ts";

const TEXT = { "content-type": "text/plain; charset=utf-8" } as const;
const HTML = { "content-type": "text/html; charset=utf-8" } as const;
const JSON_TYPE = { "content-type": "application/json; charset=utf-8" } as const;
const CSS = { "content-type": "text/css; charset=utf-8" } as const;

const style = new URL("../public/wall.css", import.meta.url);

/** The page a wall with nothing on it shows, rather than a page that looks broken. */
const NOTHING_YET = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>POD, built by pods of agents</title>
<link rel="stylesheet" href="${ROUTES.style}"></head>
<body><header><h1>Nothing has been built yet</h1>
<p>No job has been graded on this server. When one has, it appears here, whether it passed or not.</p>
</header></body></html>`;

export async function handle(request: Request, store: JobStore): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (request.method !== "GET") return new Response("only GET\n", { status: 405, headers: TEXT });

  if (pathname === ROUTES.wall) {
    const tiles = await store.tiles();
    return new Response(tiles.length === 0 ? NOTHING_YET : renderWall(tiles), { headers: HTML });
  }

  if (pathname === ROUTES.style) {
    return new Response(await Bun.file(style).text(), { headers: CSS });
  }

  if (pathname === ROUTES.health) {
    return new Response(`${(await store.tiles()).length} jobs\n`, { headers: TEXT });
  }

  if (pathname.startsWith(ROUTES.job)) {
    const jobId = pathname.slice(ROUTES.job.length);
    const record = await store.read(jobId);
    if (!record) return notFound(`no job called ${jobId}`);
    return new Response(renderJob({
      tile: record.tile,
      seal: record.seal,
      checksSaid: record.checksSaid,
      approvals: record.approvals,
      receipt: record.signed?.receipt,
      brief: record.brief,
      repository: record.repository,
      podHolder: record.podHolder,
    }, checksPath(jobId)), { headers: HTML });
  }

  if (pathname.startsWith(ROUTES.checks)) {
    const rest = pathname.slice(ROUTES.checks.length);
    const slash = rest.indexOf("/");
    const jobId = slash === -1 ? rest : rest.slice(0, slash);
    const name = slash === -1 ? "" : rest.slice(slash + 1);
    return name === "" ? await checkIndex(store, jobId) : await oneCheck(store, jobId, name);
  }

  if (pathname.startsWith(ROUTES.receipt)) {
    const jobId = pathname.slice(ROUTES.receipt.length);
    const record = await store.read(jobId);
    if (!record) return notFound(`no job called ${jobId}`);
    if (!record.signed) return notFound(`job ${jobId} has no signed receipt`);
    return new Response(JSON.stringify(record.signed, null, 2), { headers: JSON_TYPE });
  }

  if (pathname.startsWith(ROUTES.agent)) {
    const agent = pathname.slice(ROUTES.agent.length);
    if (!/^0x[0-9a-fA-F]{40}$/.test(agent)) return notFound(`${agent} is not an address`);
    const tiles = await store.sat(agent as `0x${string}`);
    return new Response(renderAgent(agent, tiles), { headers: HTML });
  }

  return notFound(`nothing at ${pathname}`);
}

/**
 * The checks, as a list a person can read and a machine can walk.
 *
 * While a job is still running this is the one place that has to refuse, and it says why: the checks
 * are what the pod is not allowed to see until the verdict exists.
 */
async function checkIndex(store: JobStore, jobId: string): Promise<Response> {
  const record = await store.read(jobId);
  if (!record) return notFound(`no job called ${jobId}`);
  if (!checksArePublished(record)) {
    return new Response(
      `job ${jobId} is still running. Its checks are published when it has a verdict, not before.\n`,
      { status: 409, headers: TEXT },
    );
  }
  const names = await store.checkNames(jobId);
  if (names.length === 0) return notFound(`job ${jobId} published no checks`);
  return new Response(`${names.map((n) => checkFilePath(jobId, n)).join("\n")}\n`, { headers: TEXT });
}

async function oneCheck(store: JobStore, jobId: string, name: string): Promise<Response> {
  if (!isSafeName(name)) return notFound(`${name} is not a filename this server serves`);
  const contents = await store.checkFile(jobId, name);
  if (contents === undefined) return notFound(`no published check called ${name} in job ${jobId}`);
  return new Response(contents, { headers: TEXT });
}

function notFound(why: string): Response {
  return new Response(`${why}\n`, { status: 404, headers: TEXT });
}

/** Start it. The port and the directory come from the environment, and neither has a default that hides. */
export function serve(store: JobStore, port: number): ReturnType<typeof Bun.serve> {
  return Bun.serve({ port, fetch: (request) => handle(request, store) });
}

if (import.meta.main) {
  const directory = process.env.POD_JOBS;
  if (!directory) throw new Error("POD_JOBS has to name the directory the runner writes jobs to");
  const port = Number(process.env.PORT ?? 3000);
  serve(new JobStore(directory), port);
  console.log(`the wall is at http://localhost:${port}${ROUTES.wall}, reading ${directory}`);
}
