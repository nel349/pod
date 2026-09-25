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
import { acceptPosting, readerFor, type ChainReader } from "./posting.ts";
import { CheckWriting, ProvenChecks } from "./checkwriting/index.ts";
import type { MarketConfig } from "./market.ts";
import { bodyWithin } from "./body.ts";
import { PROVEN_FOLDER, REPOSITORIES_FOLDER } from "./folders.ts";
import { doorChainFor, Doorkeeper, GitDoor, JobList, NoteBoard } from "./door/index.ts";
import postPage from "./web/post/index.html";
import { renderCard } from "./card.ts";
import { renderJob } from "./jobpage.ts";
import { checksArePublished, JobStore } from "./store.ts";
import { checkFilePath, checksPath, isSafeName, jobPath, ROUTES, writingPath } from "./routes.ts";

const TEXT = { "content-type": "text/plain; charset=utf-8" } as const;
const HTML = { "content-type": "text/html; charset=utf-8" } as const;
const JSON_TYPE = { "content-type": "application/json; charset=utf-8" } as const;
const CSS = { "content-type": "text/css; charset=utf-8" } as const;
const SVG = { "content-type": "image/svg+xml; charset=utf-8" } as const;

/**
 * What a posting may weigh. The checks are small programs, not repositories; a posting larger than
 * this is somebody sending us something other than checks.
 */
export const MOST_A_POSTING_MAY_WEIGH = 1_000_000;

/**
 * What a request to write checks may weigh: an idea and a handful of sentences, not a document.
 */
export const MOST_A_REQUEST_TO_WRITE_MAY_WEIGH = 32_000;

/**
 * The chain this server takes postings for, and the writer that turns a poster's sentences into
 * checks. Without both, the wall is read-only and the posting page says so: a poster is not a
 * programmer, and a page that asked them for check programs would be asking the wrong person.
 */
export interface Market {
  readonly page: MarketConfig;
  readonly chain: ChainReader;
  readonly writing: CheckWriting;
  /** the checks the writer proved, which every posting's checks must be among */
  readonly proven: ProvenChecks;
}

/** What this server opens beyond the wall, each only when it has a chain to answer to. */
export interface Services {
  readonly market?: Market;
  /** the git door agents clone, fetch and push through */
  readonly door?: GitDoor;
  /** what the seats of a job say to each other */
  readonly notes?: NoteBoard;
  /** the open jobs, for agents looking for work */
  readonly jobList?: JobList;
}
const BUNDLE = { "content-type": "application/x-git-bundle" } as const;

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

export async function handle(request: Request, store: JobStore, { market, door, notes, jobList }: Services = {}): Promise<Response> {
  const { pathname } = new URL(request.url);

  // agents' work, in and out, through git. It speaks its own methods, so it is answered before the rest
  if (pathname.startsWith(ROUTES.git)) {
    return door ? await door.handle(request) : new Response("pushing work is not open on this server\n", { status: 404, headers: TEXT });
  }
  if (pathname.startsWith(ROUTES.notes)) {
    return notes ? await notes.handle(request) : Response.json({ why: "notes are not open on this server" }, { status: 404 });
  }

  // the one thing a stranger can change: posting a job they have already paid for
  if (request.method === "POST" && pathname === ROUTES.postJob) return await posted(request, store, market);
  if (request.method === "POST" && pathname === ROUTES.writeChecks) return await startWriting(request, market);
  if (request.method !== "GET") return new Response("only GET\n", { status: 405, headers: TEXT });

  if (pathname === ROUTES.jobList) {
    return jobList ? await jobList.handle() : Response.json({ why: "there is no job list on this server: it answers to no contract" }, { status: 404 });
  }

  // the posting page itself is a bundled app served by `serve`; this is what it reads first
  if (pathname === ROUTES.market) {
    if (!market) return Response.json({ why: "posting is not open on this server: it has no contract to post to" }, { status: 404 });
    return Response.json(market.page);
  }

  // whether a name is taken, so a poster hears it before they pay rather than after
  if (pathname.startsWith(`${ROUTES.postJob}/`)) {
    const jobId = pathname.slice(ROUTES.postJob.length + 1);
    if (!isSafeName(jobId)) return Response.json({ why: `${jobId} is not a name a job can have` }, { status: 400 });
    return Response.json({ taken: (await store.read(jobId)) !== undefined }, { headers: { "cache-control": "no-store" } });
  }

  if (pathname.startsWith(`${ROUTES.writeChecks}/`)) {
    const id = pathname.slice(ROUTES.writeChecks.length + 1);
    const writing = market?.writing.read(id);
    if (!writing) return Response.json({ why: "those checks are not being written here any more" }, { status: 404 });
    return Response.json(writing, { headers: { "cache-control": "no-store" } });
  }

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
      chain: record.chain,
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

  if (pathname.startsWith(ROUTES.card)) {
    const jobId = pathname.slice(ROUTES.card.length).replace(/\.svg$/, "");
    const record = await store.read(jobId);
    if (!record) return notFound(`no job called ${jobId}`);
    return new Response(renderCard(record.tile), { headers: SVG });
  }

  /**
   * The job's history, as one file.
   *
   * `git clone` against this URL gives somebody the whole repository, including the attempts that
   * failed, with no account and no server of ours in the way. It is the answer to "what if you
   * disappear", and the receipt carries its hash so a copy can be proved identical later.
   */
  if (pathname.startsWith(ROUTES.bundle)) {
    const jobId = pathname.slice(ROUTES.bundle.length);
    const record = await store.read(jobId);
    if (!record) return notFound(`no job called ${jobId}`);
    const file = await store.bundle(jobId);
    if (!file) return notFound(`job ${jobId} has no history to hand over`);
    return new Response(file, { headers: BUNDLE });
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
 * While a job is still running it lists only the checks its pod may see, and when there are none of
 * those it refuses and says why: the sealed checks are what the pod may not see until the verdict.
 */
async function checkIndex(store: JobStore, jobId: string): Promise<Response> {
  const record = await store.read(jobId);
  if (!record) return notFound(`no job called ${jobId}`);
  // while it runs, only the checks its pod may see: the sealed ones wait for the verdict
  const names = await store.checkNames(jobId);
  if (!checksArePublished(record) && names.length === 0) {
    return new Response(
      `job ${jobId} is still running. Its checks are published when it has a verdict, not before.\n`,
      { status: 409, headers: TEXT },
    );
  }
  if (names.length === 0) return notFound(`job ${jobId} published no checks`);
  return new Response(`${names.map((n) => checkFilePath(jobId, n)).join("\n")}\n`, { headers: TEXT });
}

async function oneCheck(store: JobStore, jobId: string, name: string): Promise<Response> {
  if (!isSafeName(name)) return notFound(`${name} is not a filename this server serves`);
  const contents = await store.checkFile(jobId, name);
  if (contents === undefined) return notFound(`no published check called ${name} in job ${jobId}`);
  return new Response(contents, { headers: TEXT });
}

/**
 * A posting arrives. Everything that decides whether it is published is in `acceptPosting`; this is
 * only the door, and it refuses anything too large to be checks before reading it.
 */
async function posted(request: Request, store: JobStore, market?: Market): Promise<Response> {
  if (!market) return Response.json({ why: "posting is not open on this server" }, { status: 503 });

  const body = await bodyWithin(request, MOST_A_POSTING_MAY_WEIGH);
  if (body === undefined) {
    return Response.json({ why: "that is larger than any set of checks should be" }, { status: 413 });
  }

  let posting: unknown;
  try {
    posting = JSON.parse(body);
  } catch {
    return Response.json({ why: "that is not a posting" }, { status: 400 });
  }

  const accepted = await acceptPosting(store, market.chain, posting, market.proven);
  if (!accepted.ok) return Response.json({ why: accepted.why }, { status: accepted.status });
  return Response.json({ url: jobPath(accepted.record.jobId) }, { status: 201 });
}

/** A poster's sentences arrive, to be written into checks and tried. The page asks after them later. */
async function startWriting(request: Request, market?: Market): Promise<Response> {
  if (!market) return Response.json({ why: "posting is not open on this server" }, { status: 503 });
  const body = await bodyWithin(request, MOST_A_REQUEST_TO_WRITE_MAY_WEIGH);
  if (body === undefined) {
    return Response.json({ why: "that is longer than an idea and a few sentences should be" }, { status: 413 });
  }
  let asked: unknown;
  try {
    asked = JSON.parse(body);
  } catch {
    return Response.json({ why: "that is not a request to write checks" }, { status: 400 });
  }
  const started = market.writing.start(asked);
  if (!started.ok) return Response.json({ why: started.why }, { status: started.status });
  return Response.json({ id: started.id, url: writingPath(started.id) }, { status: 202 });
}

function notFound(why: string): Response {
  return new Response(`${why}\n`, { status: 404, headers: TEXT });
}

/**
 * Start it. The port and the directory come from the environment, and neither has a default that hides.
 *
 * The posting page is an app, not a document: Bun bundles it from its HTML entry the first time it
 * is asked for, so nothing built is ever committed. While developing it also reloads as the source
 * changes; in production it is bundled once and kept.
 */
export function serve(store: JobStore, port: number, services: Services = {}): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port,
    development: process.env.NODE_ENV === "production" ? false : { hmr: true, console: true },
    routes: { [ROUTES.post]: postPage },
    fetch: (request) => handle(request, store, services),
  });
}

/** The market this server takes postings for, and the door its agents push through, from the environment, or neither, and it says which. */
async function servicesFromTheEnvironment(store: JobStore, jobsDirectory: string): Promise<Services> {
  const configured = process.env.POD_JOBS_ADDRESS;
  if (!configured) return {};
  const { createPublicClient, http, isAddress } = await import("viem");
  if (!isAddress(configured)) throw new Error(`POD_JOBS_ADDRESS is not an address: ${configured}`);
  const jobs = configured;
  const { readJob, readSeats, readTerms } = await import("./jobs.ts");
  const { monadTestnet } = await import("./live.ts");
  const { MONAD_TESTNET } = await import("./registry.ts");
  const rpc = process.env.MONAD_TESTNET_RPC ?? MONAD_TESTNET.rpc;
  const publicClient = createPublicClient({ chain: monadTestnet, transport: http(rpc) });
  const { claudeOnThisMachine } = await import("./broker.ts");
  const { IMAGE } = await import("./sandbox.ts");
  const { join } = await import("node:path");
  // beside the jobs, so a poster who paid can still publish after the server restarts
  const proven = new ProvenChecks(join(jobsDirectory, PROVEN_FOLDER));
  const contract = { address: jobs, publicClient: publicClient as never };
  // one doorkeeper for both of an agent's doors, so a seat is the same seat at each
  const keeper = new Doorkeeper({
    store,
    chain: doorChainFor({
      jobs,
      readJob: (id) => readJob(contract, id),
      readSeats: (id) => readSeats(contract, id),
      readTerms: (id) => readTerms(contract, id),
      latestBlockTime: async () => (await publicClient.getBlock()).timestamp,
    }),
  });
  const door = new GitDoor({ repositories: join(jobsDirectory, REPOSITORIES_FOLDER), keeper });
  const notes = new NoteBoard({ keeper, store });
  const jobList = new JobList({ keeper, store });
  const market: Market = {
    page: {
      chainId: MONAD_TESTNET.id, chainName: "Monad testnet", rpc, jobs,
      explorer: "https://testnet.monadscan.com", coin: MONAD_TESTNET.coin,
    },
    chain: readerFor({
      jobs,
      read: (id) => readJob(contract, id),
    }),
    writing: new CheckWriting({
      writer: { model: claudeOnThisMachine(), image: IMAGE, agents: new URL("../agents", import.meta.url).pathname },
      proven,
    }),
    proven,
  };
  return { market, door, notes, jobList };
}


if (import.meta.main) {
  const directory = process.env.POD_JOBS;
  if (!directory) throw new Error("POD_JOBS has to name the directory the runner writes jobs to");
  const port = Number(process.env.PORT ?? 3000);
  const store = new JobStore(directory);
  const services = await servicesFromTheEnvironment(store, directory);
  const { market } = services;
  const server = serve(store, port, services);
  console.log(`the wall is at http://localhost:${port}${ROUTES.wall}, reading ${directory}`);
  console.log(market
    ? `posting is open, against ${market.page.jobs}; checks are written by Claude, through the CLI signed in on this machine`
    : "posting is closed: no POD_JOBS_ADDRESS");
  if (services.door) console.log(`agents push their work to http://localhost:${port}${ROUTES.git}<job>.git, and write notes to ${ROUTES.notes}<job>. Open jobs are listed at ${ROUTES.jobList}`);

  // stopping: take no new requests, let any writing under way finish and take its boxes down, then go
  const stop = async (): Promise<void> => {
    await server.stop();
    await market?.writing.whenIdle();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}
