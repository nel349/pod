/**
 * The worker's answers in ERC-8004: each seat's verdict in the registry, for the agents that ask.
 *
 * Only an agent's owner may ask the registry for a verdict, and outside agents are their owners', so
 * the worker never asks for anybody (decided 24 Sep, Y12). An agent asks, naming this worker and
 * pointing at the job's receipt; the worker reads the registry for requests that name it, and answers
 * each seat once. It answers only for an identity that is the seat's own key, as its owner or as the
 * wallet it says it acts with: the owner a seat names for itself is anybody it likes, and an identity
 * is cheap to make, so neither may stand in for the key that held the seat. And it answers only once
 * the chain agrees with the verdict: work paid for a pass, a poster refunded for a failure.
 *
 * The registry keeps which runner a request names but not which job it is about: that is in the
 * request's link, which only the event carries. So the worker reads the events, a little further each
 * time it looks, in slices as wide as Monad's public node allows, and remembers how far it got. A
 * request that arrives before its job is settled is held until it is.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isAddressEqual, type Address, type Hex } from "viem";
import { z } from "zod";
import { firstLine } from "../errors.ts";
import { MOST_BLOCKS_A_LOG_READ_COVERS, readJob, readSeats, type Contract, type HeldSeat } from "../jobs.ts";
import { agentWalletOf, ownerOfAgent, validationAbi, verdictOnChain, writeVerdict, type Registries } from "../registry.ts";
import { isWallName, receiptPath, ROUTES } from "../routes.ts";
import type { JobRecord, JobStore } from "../store.ts";
import { registryResponse, registryTag } from "../verdict.ts";

/** How many slices of blocks one look reads: a long catch-up goes on over several looks, never holding up the rest */
export const MOST_READS_A_LOOK = 50;
/** How many requests are held at once. Asking is free, so this is what stops a flood of asks from filling the worker */
export const MOST_HELD = 500;

const NOTHING = /^0x0{64}$/i;
const STATE = "registry.json";

const RequestSchema = z.object({
  key: z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((key) => key as Hex),
  agentId: z.string().regex(/^[0-9]+$/),
  link: z.string(),
});
const StateSchema = z.object({ readTo: z.string().regex(/^[0-9]+$/), holding: z.array(RequestSchema) });

type Request = z.infer<typeof RequestSchema>;
type State = z.infer<typeof StateSchema>;

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

  /** Read some of what has been asked since the last look, and answer what can be answered. */
  async look(): Promise<void> {
    const { jobs, registries, runner } = this.options;
    // asked fresh: the client otherwise answers from a copy a few seconds old, and a look would miss the newest requests
    const latest = await jobs.publicClient.getBlockNumber({ cacheTime: 0 });
    const state = await this.state(latest);
    let readTo = BigInt(state.readTo);
    const waiting: Request[] = [...state.holding];

    for (let reads = 0; readTo < latest && reads < MOST_READS_A_LOOK; reads++) {
      const from = readTo + 1n;
      const to = from + MOST_BLOCKS_A_LOG_READ_COVERS - 1n < latest ? from + MOST_BLOCKS_A_LOG_READ_COVERS - 1n : latest;
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
        this.options.say(`the request for agent #${request.agentId} could not be answered yet: ${firstLine(error)}`);
      }
    }
    if (holding.length > MOST_HELD) {
      this.options.say(`${holding.length - MOST_HELD} of the oldest requests waiting for a verdict were let go: more are held than may be`);
    }
    await this.save({ readTo: readTo.toString(), holding: holding.slice(-MOST_HELD) });
  }

  private async answer(request: Request): Promise<Outcome> {
    const { store, jobs, registries, say } = this.options;
    const jobId = jobNamedIn(request.link);
    if (!jobId) {
      say(`agent #${request.agentId} asked about ${request.link}, which is not a job's receipt here`);
      return "ignored";
    }
    const record = await store.read(jobId);
    if (!record?.chain || !isAddressEqual(record.chain.jobs as Address, jobs.address)) {
      say(`agent #${request.agentId} asked about ${jobId}, which is not a job on this contract`);
      return "ignored";
    }
    if (!NOTHING.test((await verdictOnChain(jobs.publicClient, request.key, registries)).responseHash)) return "ignored";
    const onChainId = BigInt(record.chain.jobId);
    const settled = await this.settledAsGraded(record, onChainId);
    if (settled === "not yet") return "held";
    if (settled === "never") {
      say(`agent #${request.agentId} asked about ${jobId}, whose verdict was never settled, so nothing is recorded`);
      return "ignored";
    }

    const agentId = BigInt(request.agentId);
    const seat = await this.seatOf(agentId, await readSeats(jobs, onChainId));
    if (!seat) {
      say(`agent #${request.agentId} asked about ${jobId}, and is not the key that held a seat on it, so nothing is recorded`);
      return "ignored";
    }
    const already = record.recorded?.find((recorded) => recorded.role === seat.role && isAddressEqual(recorded.agent, seat.agent));
    if (already && already.key.toLowerCase() !== request.key.toLowerCase()) {
      say(`agent #${request.agentId} asked about ${jobId} again, and the ${seat.role}'s verdict is recorded once`);
      return "ignored";
    }

    // the seat is written down before the answer is sent: a worker stopped between the two answers
    // this same request again, and no other
    if (!already) await this.remember(jobId, { role: seat.role, agent: seat.agent, agentId: request.agentId, key: request.key });
    const signed = record.signed!;
    const verdict = { kind: signed.receipt.verdict };
    const answered = await this.options.onTheChain(async () => {
      // read again inside the queue: another look may have answered it while this one waited
      if (!NOTHING.test((await verdictOnChain(jobs.publicClient, request.key, registries)).responseHash)) return false;
      await writeVerdict({ publicClient: jobs.publicClient, wallet: jobs.wallet }, {
        key: request.key,
        score: registryResponse(verdict),
        receiptURI: `${this.options.site ?? ""}${receiptPath(jobId)}`,
        receiptHash: signed.hash,
        tag: registryTag(verdict, seat.role),
      }, registries);
      return true;
    });
    if (answered) say(`recorded ${signed.receipt.verdict} for agent #${request.agentId}, the ${seat.role} on ${jobId}`);
    return "answered";
  }

  /**
   * Whether the chain agrees with the job's verdict yet: a pass paid, a failure refunded by the
   * worker, runs that disagreed left to end. "never" when it ended some other way, such as a verdict
   * that came too late and the poster taking the money back.
   */
  private async settledAsGraded(record: JobRecord, onChainId: bigint): Promise<"yes" | "not yet" | "never"> {
    if (!record.signed || record.tile.verdict === "running") {
      return (await readJob(this.options.jobs, onChainId)).state === "working" ? "not yet" : "never";
    }
    const state = (await readJob(this.options.jobs, onChainId)).state;
    if (state === "working" || state === "open") return "not yet";
    const verdict = record.signed.receipt.verdict;
    if (verdict === "passed") return state === "settled" ? "yes" : "never";
    if (verdict === "failed") return state === "refunded" && record.chain?.settled !== undefined ? "yes" : "never";
    return "yes";
  }

  /** The seat an identity held, if it is that seat's own key: as the identity's owner, or as the wallet it acts with. */
  private async seatOf(agentId: bigint, seats: readonly HeldSeat[]): Promise<HeldSeat | undefined> {
    const { jobs, registries } = this.options;
    const [owner, wallet] = await Promise.all([
      ownerOfAgent(jobs.publicClient, agentId, registries),
      agentWalletOf(jobs.publicClient, agentId, registries),
    ]);
    return seats.find((held) => isAddressEqual(held.agent, owner) || isAddressEqual(held.agent, wallet));
  }

  /** Write down that a seat's verdict is recorded, reading the record fresh so nothing written meanwhile is lost. */
  private async remember(jobId: string, recorded: NonNullable<JobRecord["recorded"]>[number]): Promise<void> {
    const record = await this.options.store.read(jobId);
    if (!record) return;
    await this.options.store.save({ ...record, recorded: [...(record.recorded ?? []), recorded] });
  }

  /**
   * How far the registry has been read, and what is held. A worker that never looked starts where the
   * chain is now; a record that cannot be read stops it, rather than quietly starting again and
   * losing what it held.
   */
  private async state(latest: bigint): Promise<State> {
    let text: string;
    try {
      text = await readFile(join(this.options.stateFolder, STATE), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { readTo: (latest > 0n ? latest - 1n : 0n).toString(), holding: [] };
    }
    const parsed = StateSchema.safeParse(JSON.parse(text));
    if (!parsed.success) throw new Error(`what the worker kept of the registry, in ${STATE}, cannot be read: ${parsed.error.issues[0]?.message}`);
    return parsed.data;
  }

  /** Written whole or not at all: to a file beside it, then moved into place. */
  private async save(state: State): Promise<void> {
    await mkdir(this.options.stateFolder, { recursive: true });
    const next = join(this.options.stateFolder, `${STATE}.next`);
    await writeFile(next, JSON.stringify(state, null, 2));
    await rename(next, join(this.options.stateFolder, STATE));
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
