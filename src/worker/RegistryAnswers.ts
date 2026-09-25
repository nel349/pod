/**
 * The worker's answers in ERC-8004: each seat's verdict in the registry, for the agents that ask.
 *
 * Only an agent's owner may ask the registry for a verdict, and outside agents are their owners', so
 * the worker never asks for anybody (decided 24 Sep, Y12). An agent asks, naming this worker and
 * pointing at the job's receipt; the worker reads the registry for requests that name it, and answers
 * each one once, and only for an identity that holds a seat on that job, whether as the seat's key,
 * as the key's owner, or as the wallet the identity says it acts with.
 *
 * The registry keeps which runner a request names but not which job it is about: that is in the
 * request's link, which only the event carries. So the worker reads the events, a little further each
 * time it looks, in slices as wide as Monad's public node allows, and remembers how far it got. A
 * request that arrives before its job has a verdict is held until it has one.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { isWallName, receiptPath, ROUTES } from "../routes.ts";
import { readSeats, type Contract } from "../jobs.ts";
import { agentWalletOf, ownerOfAgent, validationAbi, verdictOnChain, writeVerdict, type Registries } from "../registry.ts";
import type { JobStore } from "../store.ts";
import { registryResponse, registryTag } from "../verdict.ts";

/** The widest range of blocks Monad's public node will read events from in one go */
export const MOST_BLOCKS_A_READ_COVERS = 100n;

const NOTHING = /^0x0{64}$/i;
const STATE = "registry.json";

interface Request {
  readonly key: Hex;
  readonly agentId: string;
  readonly link: string;
}

interface State {
  /** the last block whose requests have been read */
  readonly readTo: string;
  /** requests read before their job had a verdict */
  readonly holding: readonly Request[];
}

export interface RegistryAnswersOptions {
  readonly store: JobStore;
  /** the jobs contract, with the validator's wallet, which is also the runner every answer comes from */
  readonly jobs: Contract;
  readonly registries: Registries;
  readonly runner: Address;
  /** where job pages are served, so an answer points at the receipt it is about */
  readonly site?: string;
  /** where the worker keeps how far it has read */
  readonly stateFolder: string;
  /** one chain write at a time, shared with the rest of the worker */
  readonly onTheChain: <T>(write: () => Promise<T>) => Promise<T>;
  readonly say: (what: string) => void;
}

type Outcome = "answered" | "held" | "ignored";

export class RegistryAnswers {
  constructor(private readonly options: RegistryAnswersOptions) {}

  /** Read what has been asked since the last look, and answer what can be answered. */
  async look(): Promise<void> {
    const { jobs, registries, runner } = this.options;
    // asked fresh: the client otherwise answers from a copy a few seconds old, and a look would miss the newest requests
    const latest = await jobs.publicClient.getBlockNumber({ cacheTime: 0 });
    const state = await this.state(latest);
    let readTo = BigInt(state.readTo);
    const waiting: Request[] = [...state.holding];

    while (readTo < latest) {
      const from = readTo + 1n;
      const to = from + MOST_BLOCKS_A_READ_COVERS - 1n < latest ? from + MOST_BLOCKS_A_READ_COVERS - 1n : latest;
      const logs = await jobs.publicClient.getContractEvents({
        address: registries.validation, abi: validationAbi, eventName: "ValidationRequest",
        args: { validatorAddress: runner }, fromBlock: from, toBlock: to, strict: true,
      });
      for (const log of logs) waiting.push({ key: log.args.requestHash, agentId: log.args.agentId.toString(), link: log.args.requestURI });
      readTo = to;
      // saved as it goes, so a worker stopped half way through a long catch-up does not start it again
      await this.save({ readTo: readTo.toString(), holding: waiting });
    }

    const holding: Request[] = [];
    for (const request of waiting) {
      try {
        if ((await this.answer(request)) === "held") holding.push(request);
      } catch (error) {
        holding.push(request);
        this.options.say(`the request for agent #${request.agentId} could not be answered yet: ${(error as Error).message.split("\n")[0]}`);
      }
    }
    await this.save({ readTo: readTo.toString(), holding });
  }

  private async answer(request: Request): Promise<Outcome> {
    const { store, jobs, registries, say } = this.options;
    const jobId = jobNamedIn(request.link);
    if (!jobId) {
      say(`agent #${request.agentId} asked about ${request.link}, which is not a job's receipt here`);
      return "ignored";
    }
    if (!NOTHING.test((await verdictOnChain(jobs.publicClient, request.key, registries)).responseHash)) return "ignored";
    const record = await store.read(jobId);
    if (!record?.chain) {
      say(`agent #${request.agentId} asked about ${jobId}, which is not a job on this contract`);
      return "ignored";
    }
    if (!record.signed || record.tile.verdict === "running") return "held";

    const agentId = BigInt(request.agentId);
    const [owner, wallet] = await Promise.all([
      ownerOfAgent(jobs.publicClient, agentId, registries),
      agentWalletOf(jobs.publicClient, agentId, registries),
    ]);
    const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
    const seat = (await readSeats(jobs, BigInt(record.chain.jobId))).find((held) =>
      same(held.agent, wallet) || same(held.agent, owner) || same(held.owner, owner));
    if (!seat) {
      say(`agent #${request.agentId} asked about ${jobId}, and holds no seat on it, so nothing is recorded`);
      return "ignored";
    }

    const verdict = { kind: record.signed.receipt.verdict };
    const answered = await this.options.onTheChain(async () => {
      // read again inside the queue: another look may have answered it while this one waited
      if (!NOTHING.test((await verdictOnChain(jobs.publicClient, request.key, registries)).responseHash)) return false;
      await writeVerdict({ publicClient: jobs.publicClient, wallet: jobs.wallet }, {
        key: request.key,
        score: registryResponse(verdict),
        receiptURI: `${this.options.site ?? ""}${receiptPath(jobId)}`,
        receiptHash: record.signed!.hash,
        tag: registryTag(verdict, seat.role),
      }, registries);
      return true;
    });
    if (answered) say(`recorded ${record.signed.receipt.verdict} for agent #${request.agentId}, the ${seat.role} on ${jobId}`);
    return "answered";
  }

  /** How far the registry has been read, and what is held. A worker that never looked starts where the chain is now. */
  private async state(latest: bigint): Promise<State> {
    try {
      return JSON.parse(await readFile(join(this.options.stateFolder, STATE), "utf8")) as State;
    } catch {
      return { readTo: (latest > 0n ? latest - 1n : 0n).toString(), holding: [] };
    }
  }

  private async save(state: State): Promise<void> {
    await mkdir(this.options.stateFolder, { recursive: true });
    await writeFile(join(this.options.stateFolder, STATE), JSON.stringify(state, null, 2));
  }
}

/** The job a request's link is about: the name after the receipt route, whatever the host. */
function jobNamedIn(link: string): string | undefined {
  let path: string;
  try {
    path = new URL(link, "http://any.invalid").pathname;
  } catch {
    return undefined;
  }
  if (!path.startsWith(ROUTES.receipt)) return undefined;
  const jobId = path.slice(ROUTES.receipt.length);
  return isWallName(jobId) ? jobId : undefined;
}
