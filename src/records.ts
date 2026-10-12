/**
 * Who has done what, as the contracts count it: how a poster's jobs ended, and how the jobs an agent
 * held a seat on ended. Kept by the contracts on which the poster has the last word, so nobody takes
 * this server's word for it: a poster who refuses by habit is known to an agent before it takes a
 * seat, and an agent whose work is refused is known to a poster before they accept.
 *
 * It counts jobs on those contracts, the one jobs are posted to and the ones before it that kept
 * count, added together: a record does not start again because the contract was replaced. A wallet
 * with nothing counted has no record yet, which is all that can be said of it.
 */
import type { Address } from "viem";
import type { ContractV2 } from "./jobsV2.ts";
import { readAgentRecord, readPosterRecord, type AgentRecord, type PosterRecord } from "./jobsV3.ts";
import { readCutRecord } from "./jobsV4.ts";

export interface Records {
  /** the contract jobs are posted to, which keeps count from here on */
  readonly jobs: Address;
  poster(address: Address): Promise<PosterRecord>;
  agent(address: Address): Promise<AgentRecord>;
}

function postersTogether(records: readonly PosterRecord[]): PosterRecord {
  return records.reduce((sum, one) => ({
    posted: sum.posted + one.posted, accepted: sum.accepted + one.accepted, refusedPassed: sum.refusedPassed + one.refusedPassed,
    refusedFailed: sum.refusedFailed + one.refusedFailed, unanswered: sum.unanswered + one.unanswered,
  }));
}

function agentsTogether(records: readonly AgentRecord[]): AgentRecord {
  return records.reduce((sum, one) => ({
    accepted: sum.accepted + one.accepted, paidUnanswered: sum.paidUnanswered + one.paidUnanswered, refusedPassed: sum.refusedPassed + one.refusedPassed,
    failed: sum.failed + one.failed, undelivered: sum.undelivered + one.undelivered,
  }));
}

/**
 * @param also the contracts that kept count before `at`, whose jobs are finished and still counted
 * @param countsCuts whether `at` is a contract on which a lead names who is paid, and so counts the pay kept from a seat
 */
export function recordsAt(at: ContractV2, options: { readonly also?: readonly ContractV2[]; readonly countsCuts?: boolean } = {}): Records {
  const everywhere = [at, ...(options.also ?? [])];
  return {
    jobs: at.address,
    poster: async (address) => postersTogether(await Promise.all(everywhere.map((one) => readPosterRecord(one, address)))),
    agent: async (address) => {
      const [ended, cuts] = await Promise.all([
        Promise.all(everywhere.map((one) => readAgentRecord(one, address))),
        options.countsCuts ? readCutRecord(at, address) : undefined,
      ]);
      return { ...agentsTogether(ended), ...(cuts ?? {}) };
    },
  };
}
