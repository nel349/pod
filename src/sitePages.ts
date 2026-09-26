/**
 * What the server hands each site page, from its records and, where only the chain can say, the chain.
 *
 * A chain that cannot be read right now does not take a page down: the page is drawn without what the
 * chain would have added, says so where it matters, and the reason is logged for whoever runs this.
 */
import type { Address } from "viem";
import { recordByRole } from "./agentpage.ts";
import { firstLine } from "./errors.ts";
import type { Owners } from "./owners.ts";
import { jobPath } from "./routes.ts";
import type { JobRecord, JobStore } from "./store.ts";
import {
  jobView, needsTheChainForMoney, receiptView, tileView, yoursEntry,
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
  return { ...who, ...money };
}

/** A record as a tile, linking its receipt only when a signed one is kept. */
const tileOf = (record: JobRecord): TileView => tileView(record.tile, record.signed !== undefined);

export async function wallPage(store: JobStore): Promise<SitePage> {
  return { page: "wall", tiles: (await store.inWallOrder()).map(tileOf) };
}

export async function jobData(store: JobStore, owners: Owners | undefined, jobId: string, now: Date): Promise<JobView | undefined> {
  const record = await store.read(jobId);
  if (!record) return undefined;
  return jobView(record, await store.notes(jobId), await chainSaysOf(record, owners, now));
}

export async function agentPage(store: JobStore, agent: Address): Promise<SitePage> {
  const wanted = agent.toLowerCase();
  const sat = (await store.inWallOrder()).filter((record) => record.tile.pod.some((seat) => seat.agent.toLowerCase() === wanted));
  return { page: "agent", agent, record: [...recordByRole(agent, sat.map((record) => record.tile))], tiles: sat.map(tileOf) };
}

export async function receiptData(store: JobStore, jobId: string): Promise<ReceiptView | undefined> {
  const record = await store.read(jobId);
  return record?.signed ? receiptView(record, record.signed, jobPath(jobId)) : undefined;
}

/**
 * Everything a wallet paid for and every title it holds, with the chain's word on each. Who paid and
 * who holds are asked for every job on the chain; where the money is, only for the wallet's own.
 */
export async function yoursData(store: JobStore, owners: Owners, address: Address, now: Date): Promise<YoursView> {
  const wanted = address.toLowerCase();
  const onTheChain = (await store.all()).filter((record) => record.chain);
  const read = await Promise.all(onTheChain.map(async (record) => ({ record, who: await ownersOf(record, owners) })));
  const posted = await Promise.all(read
    .filter(({ who }) => who.poster?.toLowerCase() === wanted)
    .map(async ({ record, who }) => yoursEntry(record, { ...who, ...(await moneyOnTheChain(record, owners, now)) })));
  const runningFirst = (a: YoursEntry, b: YoursEntry): number => Number(b.tile.verdict === "running") - Number(a.tile.verdict === "running");
  return {
    address,
    posted: posted.sort(runningFirst),
    holds: read.filter(({ who }) => who.holder?.toLowerCase() === wanted).map(({ record, who }) => yoursEntry(record, who)),
  };
}
