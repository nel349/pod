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
import { acceptPosting, type ChainReader } from "./posting.ts";
import type { CheckWriting, ProvenChecks } from "./checkwriting/index.ts";
import type { MarketConfig } from "./market.ts";
import { isAddress, isAddressEqual } from "viem";
import { bodyWithin, tooLarge } from "./body.ts";
import { NO_STORE } from "./headers.ts";
import { firstLine } from "./errors.ts";
import { chainJobToTheWire } from "./chainJob.ts";
import { JOBS_FOLDER_SETTING } from "./folders.ts";
import type { Claims } from "./claims.ts";
import type { CreditDoor, GitDoor, JobList, NoteBoard } from "./door/index.ts";
import claimPage from "./web/claim/index.html";
import postPage from "./web/post/index.html";
import refundPage from "./web/refund/index.html";
import { renderCard } from "./card.ts";
import { isPublished, JobStore, publicRecord } from "./store.ts";
import { cardPath, checkFilePath, isSafeName, isWallName, jobPath, preparingPath, QUERY, RECEIPT_FILE, ROUTES, WRITINGS, writingPath } from "./routes.ts";
import type { Owners } from "./owners.ts";
import { preparingToTheWire, type Preparing } from "./preparing/index.ts";
import type { AgentFactsReader } from "./agentFacts.ts";
import { MONAD_TESTNET } from "./registry.ts";
import { agentPage, jobData, receiptData, wallPage, yoursData } from "./sitePages.ts";
import { renderSite, siteScript, type Head, type SitePage } from "./web/site/index.ts";
import { SITE } from "./web/site/copy.ts";

const TEXT = { "content-type": "text/plain; charset=utf-8" } as const;
const HTML = { "content-type": "text/html; charset=utf-8" } as const;
const JSON_TYPE = { "content-type": "application/json; charset=utf-8" } as const;
const CSS = { "content-type": "text/css; charset=utf-8" } as const;
const JAVASCRIPT = { "content-type": "text/javascript; charset=utf-8" } as const;
const SVG = { "content-type": "image/svg+xml; charset=utf-8" } as const;

/**
 * What a posting may weigh. The checks are small programs, not repositories; a posting larger than
 * this is somebody sending us something other than checks.
 */
export const MOST_A_POSTING_MAY_WEIGH = 1_000_000;

/** why the old way of posting is closed on a server whose contract prepares jobs */
const PAID_FIRST = "posting here is paid first: a job is paid for on the contract, set up from the posting page, and its checks are written after";

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
  /** the contract jobs were posted to before this one, still read for their money (R12) */
  readonly earlier?: ChainReader;
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
  /** which GitHub account each agent's work is credited to */
  readonly credit?: CreditDoor;
  /** where a title's holder claims its repository */
  readonly claims?: Claims;
  /** who paid for each job and who holds its title, as the chain says */
  readonly owners?: Owners;
  /** what is known of an agent beyond this wall: its ERC-8004 identity and record, and its credit */
  readonly agents?: AgentFactsReader;
  /** jobs paid for on the contract that prepares them, their checks written before a pod can start */
  readonly preparing?: Preparing;
}
const BUNDLE = { "content-type": "application/x-git-bundle" } as const;

const style = new URL("../public/wall.css", import.meta.url);
const brand = new URL("./web/brand/brand.css", import.meta.url);
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const guide = new URL("../public/llms.txt", import.meta.url);
const MARKDOWN = { "content-type": "text/markdown; charset=utf-8" } as const;

export async function handle(request: Request, store: JobStore, { market, door, notes, jobList, credit, claims, owners, agents, preparing }: Services = {}): Promise<Response> {
  const { pathname } = new URL(request.url);
  const page = (head: Head, drawn: SitePage, status = 200): Response =>
    new Response(renderSite(head, { ...drawn, ...(market ? { market: market.page } : {}), coin: market?.page.coin ?? MONAD_TESTNET.coin, drawnAt: new Date().toISOString() }), { status, headers: HTML });
  const missing = (why: string): Response =>
    wantsAPage(request) ? page({ title: SITE.missing.title }, { page: "missing", why }, 404) : new Response(`${why}\n`, { status: 404, headers: TEXT });

  // agents' work, in and out, through git. It speaks its own methods, so it is answered before the rest
  if (pathname.startsWith(ROUTES.git)) {
    return door ? await door.handle(request) : new Response("pushing work is not open on this server\n", { status: 404, headers: TEXT });
  }
  if (pathname.startsWith(ROUTES.notes)) {
    return notes ? await notes.handle(request) : Response.json({ why: "notes are not open on this server" }, { status: 404 });
  }
  if (pathname.startsWith(ROUTES.claimApi)) {
    return claims ? await claims.handle(request) : Response.json({ why: "claims are not open on this server: it names no title contract" }, { status: 404 });
  }
  if (pathname === ROUTES.credit || pathname.startsWith(`${ROUTES.credit}/`)) {
    return credit ? await credit.handle(request) : Response.json({ why: "GitHub credit is not open on this server" }, { status: 404 });
  }

  // a job paid for and being prepared: only its poster sets it up, reads it and asks for its checks
  if (pathname === ROUTES.preparing || pathname.startsWith(`${ROUTES.preparing}/`)) {
    return preparing ? await answerPreparing(request, pathname, preparing) : Response.json({ why: "no job is prepared on this server: it answers to no contract that prepares them" }, { status: 404 });
  }

  // on a contract that prepares jobs, checks are written only for a job paid for, and a job opens only
  // on its poster's approval: writing for free and posting the old way round are closed
  const isPaidFirst = market?.page.writing !== undefined;
  if (isPaidFirst && (pathname === ROUTES.writeChecks || pathname.startsWith(`${ROUTES.writeChecks}/`) || (request.method === "POST" && pathname === ROUTES.postJob))) {
    return Response.json({ why: PAID_FIRST }, { status: 410 });
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
    const isTaken = (await store.read(jobId)) !== undefined || (await preparing?.isNameTaken(jobId)) === true;
    return Response.json({ taken: isTaken }, { headers: NO_STORE });
  }

  // what the refund page needs to find a job on the chain; the chain itself says where the money is
  if (pathname.startsWith(ROUTES.refundApi)) {
    const jobId = pathname.slice(ROUTES.refundApi.length);
    const record = isWallName(jobId) ? await store.read(jobId) : undefined;
    if (!record?.chain) return Response.json({ why: "there is no job with money on the chain at that address" }, { status: 404 });
    return Response.json({ jobId, idea: record.tile.idea, onChainId: record.chain.jobId, jobs: record.chain.jobs }, { headers: NO_STORE });
  }

  if (pathname.startsWith(ROUTES.chainJob)) {
    if (!market) return Response.json({ why: "this server answers to no chain" }, { status: 404 });
    const onChainId = pathname.slice(ROUTES.chainJob.length);
    if (!/^[0-9]+$/.test(onChainId)) return Response.json({ why: `${onChainId} is not a job's number on the contract` }, { status: 400 });
    // a job on the contract named, which has to be one answered here; with none named, on the one jobs
    // are posted to now, or, when it has no such number, on the one they were posted to before
    const named = new URL(request.url).searchParams.get(QUERY.jobs);
    const readers = [market.chain, ...(market.earlier ? [market.earlier] : [])];
    const asked = named === null ? readers : readers.filter((reader) => isAddress(named) && isAddressEqual(named, reader.jobs));
    if (asked.length === 0) return Response.json({ why: `${named} is not a contract this server answers to` }, { status: 400 });
    for (const reader of asked) {
      const [job, now] = await Promise.all([reader.job(BigInt(onChainId)), reader.now()]);
      if (job) return Response.json(chainJobToTheWire(job, now, reader.jobs), { headers: NO_STORE });
    }
    return Response.json({ why: `there is no job ${onChainId} on the contract` }, { status: 404 });
  }

  if (pathname.startsWith(`${ROUTES.writeChecks}/`)) {
    const id = pathname.slice(ROUTES.writeChecks.length + 1);
    const writing = market?.writing.read(id);
    if (!writing) return Response.json({ why: "those checks are not being written here any more" }, { status: 404 });
    return Response.json(writing, { headers: NO_STORE });
  }

  if (pathname === ROUTES.wall) return page({ title: SITE.wall.title }, await wallPage(store));
  if (pathname === ROUTES.yours) return page({ title: SITE.yours.title }, { page: "yours" });

  if (pathname.startsWith(ROUTES.yoursApi)) {
    const address = pathname.slice(ROUTES.yoursApi.length);
    if (!owners) return Response.json({ why: "this server answers to no chain, so nothing here is anybody's" }, { status: 404 });
    if (!isAddress(address, { strict: false })) return Response.json({ why: `${address} is not an address` }, { status: 400 });
    return Response.json(await yoursData(store, owners, address, new Date(), preparing), { headers: NO_STORE });
  }

  if (pathname.startsWith(ROUTES.jobApi)) {
    const job = await jobData(store, owners, pathname.slice(ROUTES.jobApi.length), new Date());
    return job ? Response.json(job, { headers: NO_STORE }) : Response.json({ why: "there is no job at that address" }, { status: 404 });
  }

  if (pathname === ROUTES.style) return new Response(await Bun.file(style).text(), { headers: CSS });
  if (pathname === ROUTES.brand) return new Response(await Bun.file(brand).text(), { headers: CSS });
  if (pathname === ROUTES.siteScript) {
    try {
      return new Response(await siteScript(IS_PRODUCTION), { headers: JAVASCRIPT });
    } catch (error) {
      // the pages still read without it, drawn by the server; whoever runs this is told why
      console.error(`the site script could not be built: ${firstLine(error)}`);
      return new Response(`the script for these pages could not be built: ${firstLine(error)}\n`, { status: 500, headers: TEXT });
    }
  }

  if (pathname === ROUTES.guide) {
    return new Response(await Bun.file(guide).text(), { headers: MARKDOWN });
  }

  if (pathname === ROUTES.health) {
    return new Response(`${(await store.tiles()).length} jobs\n`, { headers: TEXT });
  }

  if (pathname.startsWith(ROUTES.job)) {
    const jobId = pathname.slice(ROUTES.job.length);
    const job = await jobData(store, owners, jobId, new Date());
    if (!job) return missing(`No job called ${jobId}`);
    return page({
      title: job.idea,
      description: `${job.standing}. ${job.verdict === "running" || job.verdict === "graded" ? SITE.share.running : SITE.share.decided}`,
      image: cardPath(jobId),
    }, { page: "job", job });
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
    if (!record) return missing(`no job called ${jobId}`);
    return new Response(renderCard(publicRecord(record).tile), { headers: SVG });
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
    if (!record) return missing(`no job called ${jobId}`);
    const file = await store.bundle(jobId);
    if (!file) return missing(`job ${jobId} has no history to hand over`);
    return new Response(file, { headers: BUNDLE });
  }

  if (pathname.startsWith(ROUTES.receipt)) {
    const jobId = pathname.slice(ROUTES.receipt.length);
    // the signed file itself for a program, or asked for by name; a page for a person
    const isTheFile = jobId.endsWith(RECEIPT_FILE);
    const id = isTheFile ? jobId.slice(0, -RECEIPT_FILE.length) : jobId;
    const record = await store.read(id);
    if (!record) return missing(`No job called ${id}`);
    if (!record.signed) return missing(`Job ${id} has no signed receipt yet`);
    // the receipt names every check and what came back, the hidden ones too: public only with the rest
    if (!isPublished(record)) return missing(`Job ${id}'s receipt is made public once its money has moved`);
    if (!isTheFile && wantsAPage(request)) {
      const receipt = await receiptData(store, id);
      if (receipt) return page({ title: SITE.receipt.title(record.tile.idea) }, { page: "receipt", receipt });
    }
    return new Response(JSON.stringify(record.signed, null, 2), { headers: JSON_TYPE });
  }

  if (pathname.startsWith(ROUTES.agent)) {
    const agent = pathname.slice(ROUTES.agent.length);
    if (!isAddress(agent, { strict: false })) return missing(`${agent} is not an address`);
    return page({ title: SITE.agent.title(agent) }, await agentPage(store, agent, agents));
  }

  return missing(`Nothing at ${pathname}`);
}

/** Whether whoever asked is a browser, which is shown a page, rather than a program, which is given the thing itself. */
function wantsAPage(request: Request): boolean {
  return (request.headers.get("accept") ?? "").includes("text/html");
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
  if (!isPublished(record) && names.length === 0) {
    return new Response(
      `job ${jobId}'s checks are published once it has a verdict and its money has moved, not before.\n`,
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
    return tooLarge("that is larger than any set of checks should be");
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
    return tooLarge("that is longer than an idea and a few sentences should be");
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

/**
 * A preparing job's three doors: setting it up after paying, reading it, and asking for its checks to
 * be written again. Everything that decides is in Preparing; this reads the body, within a limit.
 */
async function answerPreparing(request: Request, pathname: string, preparing: Preparing): Promise<Response> {
  const [onChainId = "", rest, ...more] = pathname.slice(ROUTES.preparing.length + 1).split("/");
  const isSetUp = pathname === ROUTES.preparing && request.method === "POST";
  const isRead = onChainId !== "" && rest === undefined && request.method === "GET";
  const isWrite = onChainId !== "" && rest === WRITINGS && more.length === 0 && request.method === "POST";
  if (!isSetUp && !isRead && !isWrite) return Response.json({ why: `nothing answers ${request.method} at ${pathname}` }, { status: 404 });

  if (isRead) {
    const read = await preparing.read(onChainId, request.headers.get("authorization"));
    return read.ok ? Response.json(preparingToTheWire(read.value), { headers: NO_STORE }) : Response.json({ why: read.why }, { status: read.status });
  }

  const body = await bodyWithin(request, MOST_A_REQUEST_TO_WRITE_MAY_WEIGH);
  if (body === undefined) return tooLarge("that is longer than a job and a few sentences should be");
  let asked: unknown;
  try {
    asked = JSON.parse(body);
  } catch {
    return Response.json({ why: "that is not JSON" }, { status: 400 });
  }
  if (isSetUp) {
    const setUp = await preparing.setUp(asked);
    return setUp.ok
      ? Response.json({ ...setUp.value, url: preparingPath(setUp.value.onChainId) }, { status: 201 })
      : Response.json({ why: setUp.why }, { status: setUp.status });
  }
  const written = await preparing.write(onChainId, request.headers.get("authorization"), asked);
  return written.ok ? Response.json(written.value, { status: 202 }) : Response.json({ why: written.why }, { status: written.status });
}

/** For the files programs fetch, checks and cards and histories: a line of text they can print. */
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
    routes: { [ROUTES.post]: postPage, [`${ROUTES.post}/*`]: postPage, [`${ROUTES.claim}*`]: claimPage, [`${ROUTES.refund}*`]: refundPage },
    fetch: (request) => handle(request, store, services),
  });
}

if (import.meta.main) {
  const directory = process.env[JOBS_FOLDER_SETTING];
  if (!directory) throw new Error(`${JOBS_FOLDER_SETTING} has to name the directory the runner writes jobs to`);
  const port = Number(process.env.PORT ?? 3000);
  const store = new JobStore(directory);
  const { servicesFromTheEnvironment, JOBS_ADDRESS_SETTING } = await import("./services.ts");
  const services = await servicesFromTheEnvironment(store, directory);
  const { market } = services;
  const server = serve(store, port, services);
  console.log(`the wall is at http://localhost:${port}${ROUTES.wall}, reading ${directory}`);
  console.log(market
    ? `posting is open, against ${market.page.jobs}; checks are written by Claude, through the CLI signed in on this machine`
    : `posting is closed: no ${JOBS_ADDRESS_SETTING}`);
  if (services.preparing) console.log(`jobs are prepared on ${services.preparing.jobs}: their checks are written before a pod can start`);
  if (services.door) console.log(`agents push their work to http://localhost:${port}${ROUTES.git}<job>.git, and write notes to ${ROUTES.notes}<job>. Open jobs are listed at ${ROUTES.jobList}, and owners link GitHub accounts at ${ROUTES.credit}`);

  // stopping: take no new requests, let any writing under way finish and take its boxes down, then go
  const stop = async (): Promise<void> => {
    await server.stop();
    await Promise.all([market?.writing.whenIdle(), services.preparing?.whenIdle()]);
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}
