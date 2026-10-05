/**
 * What is known about an agent beyond the jobs it sat on here: the ERC-8004 identity it answers to,
 * who owns that identity, the record the chain keeps of it seat by seat, and the GitHub account its
 * work is credited to.
 *
 * The identity is the one a seat named as its own, or named when it asked for a verdict itself, which
 * the worker wrote down beside the job; an agent that did neither has none known here. The chain's
 * record is read from both registries as our runner wrote it, per seat, and counted rather than
 * averaged: what this server wrote to the agent's reputation unasked, and what it answered in the
 * validation registry when the agent asked. A seat is recorded once, in one or the other.
 */
import type { Address, PublicClient } from "viem";
import type { CreditBook } from "./door/index.ts";
import { feedbackFrom, ownerOfAgent, record, type Registries } from "./registry.ts";
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
    // what this server wrote unasked, read once for every seat
    const written = await feedbackFrom(read.client, id, runner, read.registries);
    const seats = await Promise.all(SEATS.map(async (role): Promise<SeatOnChain> => {
      const [judgedTag, disagreedTag] = [registryTag({ kind: "passed" }, role), registryTag({ kind: "not-reproducible" }, role)];
      const [judged, disagreed] = await Promise.all([
        record(read.client, id, judgedTag, [runner], read.registries),
        record(read.client, id, disagreedTag, [runner], read.registries),
      ]);
      const judgedHere = written.filter((entry) => entry.tag === judgedTag);
      const unsureHere = written.filter((entry) => entry.tag === disagreedTag).length;
      const passed = Math.round((judged.count * judged.average) / PASS_SCORE) + judgedHere.filter((entry) => entry.score === PASS_SCORE).length;
      return { role, recorded: judged.count + disagreed.count + judgedHere.length + unsureHere, passed, unsure: disagreed.count + unsureHere };
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
