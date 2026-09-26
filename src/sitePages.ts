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
import type { Tile } from "./gallery.ts";
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

/** What the chain says about one job: who paid, who holds the title, and where the money is if the record cannot say. */
async function chainSaysOf(record: JobRecord, owners: Owners | undefined, now: Date): Promise<ChainSays> {
  if (!owners) return {};
  const [poster, holder, onChain] = await Promise.all([
    quietly(`who posted ${record.jobId}`, () => owners.posterOf(record)),
    quietly(`who holds the title to ${record.jobId}`, () => owners.holderOf(record)),
    needsTheChainForMoney(record, now) ? quietly(`where the money for ${record.jobId} is`, () => owners.onChain(record)) : Promise.resolve(undefined),
  ]);
  return { ...(poster ? { poster } : {}), ...(holder ? { holder } : {}), ...(onChain ? { onChain } : {}) };
}

/** Tiles in the wall's order, each linking its receipt only when a signed one is kept. */
async function tilesOf(store: JobStore, tiles: readonly Tile[]): Promise<TileView[]> {
  const signed = new Set((await store.all()).filter((record) => record.signed).map((record) => record.jobId));
  return tiles.map((tile) => tileView(tile, signed.has(tile.jobId)));
}

export async function wallPage(store: JobStore): Promise<SitePage> {
  return { page: "wall", tiles: await tilesOf(store, await store.tiles()) };
}

export async function jobData(store: JobStore, owners: Owners | undefined, jobId: string, now: Date): Promise<JobView | undefined> {
  const record = await store.read(jobId);
  if (!record) return undefined;
  return jobView(record, await store.notes(jobId), await chainSaysOf(record, owners, now));
}

export async function agentPage(store: JobStore, agent: Address): Promise<SitePage> {
  const tiles = await store.sat(agent);
  return { page: "agent", agent, record: [...recordByRole(agent, tiles)], tiles: await tilesOf(store, tiles) };
}

export async function receiptData(store: JobStore, jobId: string): Promise<ReceiptView | undefined> {
  const record = await store.read(jobId);
  return record?.signed ? receiptView(record, record.signed, jobPath(jobId)) : undefined;
}

/** Everything a wallet paid for and every title it holds, with the chain's word on each. */
export async function yoursData(store: JobStore, owners: Owners, address: Address, now: Date): Promise<YoursView> {
  const wanted = address.toLowerCase();
  const onTheChain = (await store.all()).filter((record) => record.chain);
  const read = await Promise.all(onTheChain.map(async (record) => ({ record, says: await chainSaysOf(record, owners, now) })));
  const runningFirst = (a: YoursEntry, b: YoursEntry): number => Number(b.tile.verdict === "running") - Number(a.tile.verdict === "running");
  return {
    address,
    posted: read.filter(({ says }) => says.poster?.toLowerCase() === wanted).map(({ record, says }) => yoursEntry(record, says)).sort(runningFirst),
    holds: read.filter(({ says }) => says.holder?.toLowerCase() === wanted).map(({ record, says }) => yoursEntry(record, says)),
  };
}
