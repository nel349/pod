/**
 * Who has done what, as the contract counts it: how a poster's jobs ended, and how the jobs an agent
 * held a seat on ended. Kept by the contract on which the poster has the last word, so nobody takes
 * this server's word for it: a poster who refuses by habit is known to an agent before it takes a
 * seat, and an agent whose work is refused is known to a poster before they accept.
 *
 * It counts jobs on that one contract. A wallet with nothing counted has no record yet, which is all
 * that can be said of it.
 */
import type { Address } from "viem";
import type { ContractV2 } from "./jobsV2.ts";
import { readAgentRecord, readPosterRecord, type AgentRecord, type PosterRecord } from "./jobsV3.ts";

export interface Records {
  /** the contract that keeps count */
  readonly jobs: Address;
  poster(address: Address): Promise<PosterRecord>;
  agent(address: Address): Promise<AgentRecord>;
}

export function recordsAt(at: ContractV2): Records {
  return {
    jobs: at.address,
    poster: (address) => readPosterRecord(at, address),
    agent: (address) => readAgentRecord(at, address),
  };
}
