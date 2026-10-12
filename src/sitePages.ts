/**
 * What the server hands each site page, from its records and, where only the chain can say, the chain.
 *
 * A chain that cannot be read right now does not take a page down: the page is drawn without what the
 * chain would have added, says so where it matters, and the reason is logged for whoever runs this.
 */
import { questionsOn } from "./door/QuestionBoard.ts";
import { isAddress, isAddressEqual, type Address } from "viem";
import { recordByRole } from "./agentpage.ts";
import { firstLine } from "./errors.ts";
import type { AgentFactsReader } from "./agentFacts.ts";
import type { Owners } from "./owners.ts";
import type { Records } from "./records.ts";
import { jobPath } from "./routes.ts";
import { isPublished, publicRecord, type JobRecord, type JobStore } from "./store.ts";
import {
  answerOf,
  agentFactsView, jobView, needsTheChainForMoney, receiptView, seatsOfYours, tileView, unpublishedView, yoursEntry,
  type ChainSays, type JobView, type ReceiptView, type SitePage, type TileView, type YoursEntry, type YoursView,
} from "./web/site/index.ts";

async function quietly<T>(what: string, read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    console.error(`${what} could not be read from the chain: ${firstLine(error)}`);
    return undefined;
  }
}

/** Who paid for a job and who holds its title, as the chain says. */
async function ownersOf(record: JobRecord, owners: Owners): Promise<Pick<ChainSays, "poster" | "holder">> {
  const [poster, holder] = await Promise.all([
    quietly(`who posted ${record.jobId}`, () => owners.posterOf(record)),
    quietly(`who holds the title to ${record.jobId}`, () => owners.holderOf(record)),
  ]);
  return { ...(poster ? { poster } : {}), ...(holder ? { holder } : {}) };
}

/** Where the money for a job is, asked of the chain only when its record cannot say. */
async function moneyOnTheChain(record: JobRecord, owners: Owners, now: Date): Promise<Pick<ChainSays, "onChain">> {
  if (!needsTheChainForMoney(record, now)) return {};
  const onChain = await quietly(`where the money for ${record.jobId} is`, () => owners.onChain(record));
  return onChain ? { onChain } : {};
}

/** What the chain says about one job: who paid, who holds the title, and where the money is if the record cannot say. */
async function chainSaysOf(record: JobRecord, owners: Owners | undefined, now: Date): Promise<ChainSays> {
  if (!owners) return {};
  const [who, money] = await Promise.all([ownersOf(record, owners), moneyOnTheChain(record, owners, now)]);
  return { ...who, ...money, ...(owners.isPreparedFirst(record) ? { takesBackBeforeASeat: true } : {}) };
}

/**
 * How a job's poster and its seated agents have fared, where the job's own contract keeps count. A
 * count that could not be read is left out, which the page says nothing about, never guessed.
 */
async function recordsOf(record: JobRecord, poster: string | undefined, records: Records | undefined): Promise<Pick<ChainSays, "posterRecord" | "agentRecords">> {
  if (!records || !record.chain || !isAddressEqual(record.chain.jobs, records.jobs)) return {};
  const agents = [...new Set(record.tile.pod.map((seat) => seat.agent.toLowerCase()))].filter((agent): agent is Address => isAddress(agent));
  const [posterRecord, counted] = await Promise.all([
    poster && isAddress(poster) ? quietly(`how ${poster}'s jobs ended`, () => records.poster(poster)) : undefined,
    Promise.all(agents.map(async (agent) => [agent, await quietly(`how ${agent}'s jobs ended`, () => records.agent(agent))] as const)),
  ]);
  const agentRecords = Object.fromEntries(counted.flatMap(([agent, found]) => (found ? [[agent, found]] : [])));
  return { ...(posterRecord ? { posterRecord } : {}), ...(Object.keys(agentRecords).length > 0 ? { agentRecords } : {}) };
}

/** Where a job's delivered website answers now: nowhere while its verdict is sealed, or once it was taken down. */
const liveAddressOf = (record: JobRecord): string | undefined =>
  record.live && record.live.removedAt === undefined && isPublished(record) ? record.live.url : undefined;

/** A record as a tile, linking its receipt only when a signed one is kept, and its website while it is live. */
const tileOf = (record: JobRecord): TileView => {
  const shown = publicRecord(record);
  return tileView(shown.tile, shown.signed !== undefined, isPublished(record) ? answerOf(record) : undefined, liveAddressOf(record));
};

/** Whether a job is shown among others, on the wall, an agent's page or your own: a retired one is not. */
const isShown = (record: JobRecord): boolean => record.retired === undefined;

export async function wallPage(store: JobStore): Promise<SitePage> {
  return { page: "wall", tiles: (await store.inWallOrder()).filter(isShown).map(tileOf) };
}

/** The front door, with the same jobs the wall lists, of which it shows the newest. */
export async function welcomePage(store: JobStore): Promise<SitePage> {
  return { page: "welcome", tiles: (await store.inWallOrder()).filter(isShown).map(tileOf) };
}

export async function jobData(store: JobStore, owners: Owners | undefined, jobId: string, now: Date, records?: Records): Promise<JobView | undefined> {
  const record = await store.read(jobId);
  if (!record) return undefined;
  const chainSays = await chainSaysOf(record, owners, now);
  return jobView(publicRecord(record, now), await store.notes(jobId), { ...chainSays, ...(await recordsOf(record, chainSays.poster, records)) }, await store.answers(jobId));
}

export async function agentPage(store: JobStore, agent: Address, agents: AgentFactsReader | undefined, records?: Records): Promise<SitePage> {
  const wanted = agent.toLowerCase();
  const all = await store.inWallOrder();
  const sat = all.filter(isShown).filter((record) => record.tile.pod.some((seat) => seat.agent.toLowerCase() === wanted));
  // with no chain to answer to, nothing is known beyond this wall, and that is not a failure to read
  const [facts, answered] = await Promise.all([
    agents ? quietly(`what is known of ${agent}`, () => agents.of(agent, all)) : {},
    records ? quietly(`how ${agent}'s jobs ended`, () => records.agent(agent)) : undefined,
  ]);
  return {
    page: "agent", agent, record: [...recordByRole(agent, sat.map((record) => publicRecord(record).tile))],
    facts: agentFactsView(facts), tiles: sat.map(tileOf), ...(answered ? { answered } : {}),
  };
}

export async function receiptData(store: JobStore, jobId: string): Promise<ReceiptView | undefined> {
  const record = await store.read(jobId);
  return record?.signed && isPublished(record) ? receiptView(record, record.signed, jobPath(jobId)) : undefined;
}

/**
 * Everything a wallet paid for and every title it holds, with the chain's word on each. Who paid and
 * who holds are asked for every job on the chain; where the money is, only for the wallet's own.
 */
/**
 * @param preparing the jobs this server prepares, which say whether a paid job still preparing was ever
 *                  sent its lines; left out, none was
 */
export async function yoursData(
  store: JobStore, owners: Owners, address: Address, now: Date, preparing?: { isSetUp(onChainId: string): Promise<boolean> },
): Promise<YoursView> {
  const wanted = address.toLowerCase();
  const onTheChain = (await store.all()).filter((record) => record.chain);
  const read = await Promise.all(onTheChain.filter(isShown).map(async (record) => ({ record, who: await ownersOf(record, owners) })));
  const posted = await Promise.all(read
    .filter(({ who }) => who.poster?.toLowerCase() === wanted)
    .map(async ({ record, who }) => yoursEntry(publicRecord(record, now), {
      ...who, ...(await moneyOnTheChain(record, owners, now)), ...(owners.isPreparedFirst(record) ? { takesBackBeforeASeat: true } : {}),
    }, await questionsOn(store, record))));
  const runningFirst = (a: YoursEntry, b: YoursEntry): number => Number(b.tile.verdict === "running") - Number(a.tile.verdict === "running");
  // what it paid for that is not on the wall: on a contract answered here, by a number no record here has
  const paid = await quietly(`what ${address} paid for`, () => owners.paidBy(address));
  const onContract = (jobs: string, onChainId: string): string => `${jobs.toLowerCase()}:${onChainId}`;
  const published = new Set(onTheChain.filter(owners.isAnswered).map((record) => onContract(record.chain?.jobs ?? "", record.chain?.jobId ?? "")));
  const unpublished = paid === undefined ? undefined : await Promise.all(paid
    .filter((one) => !published.has(onContract(one.jobs, one.onChainId.toString())))
    .map(async (one) => unpublishedView(one, one.job.state === "preparing" && (await preparing?.isSetUp(one.onChainId.toString())) === true)));
  return {
    address,
    posted: posted.sort(runningFirst),
    ...(unpublished ? { unpublished } : {}),
    holds: read.filter(({ who }) => who.holder?.toLowerCase() === wanted).map(({ record, who }) => yoursEntry(publicRecord(record, now), who)),
    // every job, on a chain or not: a seat is on the record whichever contract the job is on
    seats: (await store.all()).filter(isShown).flatMap((record) => seatsOfYours(publicRecord(record, now), address)),
  };
}
