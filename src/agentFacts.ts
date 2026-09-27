/**
 * What is known about an agent beyond the jobs it sat on here: the ERC-8004 identity it answers to,
 * who owns that identity, the record the chain keeps of it seat by seat, and the GitHub account its
 * work is credited to.
 *
 * The identity is the one it named when it asked for a verdict to be recorded, which the worker wrote
 * down beside the job; an agent that never asked has none known here. The chain's record is read
 * from the validation registry as our runner answered it, per seat, and counted rather than averaged.
 */
import type { Address, PublicClient } from "viem";
import type { CreditBook } from "./door/index.ts";
import { ownerOfAgent, record, type Registries } from "./registry.ts";
import { SEATS } from "./seal.ts";
import type { JobRecord } from "./store.ts";
import { registryTag } from "./verdict.ts";

/** A full score in the registry: only a clean pass earns it */
const PASS_SCORE = 100;

export interface SeatOnChain {
  readonly role: string;
  /** verdicts the chain holds for this seat */
  readonly recorded: number;
  readonly passed: number;
  /** runs that disagreed, which are filed apart */
  readonly unsure: number;
}

export interface AgentFacts {
  readonly identity?: { readonly id: bigint; readonly owner: Address; readonly seats: readonly SeatOnChain[] };
  readonly github?: { readonly login: string; readonly gist: string };
}

export interface AgentFactsReader {
  of(agent: Address, records: readonly JobRecord[]): Promise<AgentFacts>;
}

/** The identity an agent named when it asked for its verdict to be recorded here, if it ever did. */
function identityOf(agent: Address, records: readonly JobRecord[]): bigint | undefined {
  const wanted = agent.toLowerCase();
  for (const job of records) {
    const named = job.recorded?.find((recorded) => recorded.agent.toLowerCase() === wanted);
    if (named) return BigInt(named.agentId);
  }
  return undefined;
}

export function agentFactsFrom(read: {
  readonly client: PublicClient;
  readonly registries: Registries;
  /** the runner whose answers make the record */
  readonly validator: () => Promise<Address>;
  readonly credit?: CreditBook;
}): AgentFactsReader {
  const seatsOf = async (id: bigint): Promise<readonly SeatOnChain[]> => {
    const runner = await read.validator();
    const seats = await Promise.all(SEATS.map(async (role): Promise<SeatOnChain> => {
      const [judged, disagreed] = await Promise.all([
        record(read.client, id, registryTag({ kind: "passed" }, role), [runner], read.registries),
        record(read.client, id, registryTag({ kind: "not-reproducible" }, role), [runner], read.registries),
      ]);
      const passed = Math.round((judged.count * judged.average) / PASS_SCORE);
      return { role, recorded: judged.count + disagreed.count, passed, unsure: disagreed.count };
    }));
    return seats.filter((seat) => seat.recorded > 0);
  };
  return {
    async of(agent, records) {
      const id = identityOf(agent, records);
      const [identity, link] = await Promise.all([
        id === undefined ? undefined : Promise.all([ownerOfAgent(read.client, id, read.registries), seatsOf(id)]).then(([owner, seats]) => ({ id, owner, seats })),
        read.credit?.of(agent),
      ]);
      return { ...(identity ? { identity } : {}), ...(link ? { github: { login: link.login, gist: link.gist } } : {}) };
    },
  };
}
