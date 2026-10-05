/**
 * The worker's answers in ERC-8004: each seat's verdict on its agent's record.
 *
 * Two ways there, and a seat is recorded by whichever comes first, once.
 *
 * The worker writes it. A seat says which identity is its own, the worker checks that against the
 * chain, and once the job is settled it writes the verdict to the reputation registry from its own
 * key. Nothing is asked of the agent's owner, and the registry would refuse the owner: what is
 * written there is what the agent could not have said about itself. This is how an agent working for
 * somebody's wallet is recorded, since nobody should have to reach for their phone to be told their
 * agent did well (5 Oct).
 *
 * Or the agent asks. Only an agent's owner may ask the validation registry for a verdict, and outside
 * agents are their owners', so the worker never asks for anybody (decided 24 Sep, Y12). An agent
 * asks, naming this worker and pointing at the job's receipt; the worker reads the registry for
 * requests that name it, and answers. It answers only for an identity that is the seat's own key, as its owner or as the
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
import { isAddressEqual, zeroHash, type Address, type Hex } from "viem";
import { z } from "zod";
import { errorCode, firstLine } from "../errors.ts";
import { MOST_BLOCKS_A_LOG_READ_COVERS, readJob, readSeats, type Contract, type HeldSeat } from "../jobs.ts";
import { agentWalletOf, feedbackFrom, ownerOfAgent, validationAbi, verdictOnChain, writeFeedback, writeVerdict, type Registries } from "../registry.ts";
import { isWallName, receiptPath, ROUTES } from "../routes.ts";
import type { SignedReceipt } from "../receipt.ts";
import type { JobRecord, JobStore, NamedIdentity } from "../store.ts";
import { registryResponse, registryTag } from "../verdict.ts";

/** How many slices of blocks one look reads: a long catch-up goes on over several looks, never holding up the rest */
export const MOST_READS_A_LOOK = 50;
/** How many requests are held at once. Asking is free, so this is what stops a flood of asks from filling the worker */
export const MOST_HELD = 500;

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
  /** the contract that prepares jobs before a pod can start, whose jobs are answered for the same way */
  readonly prepared?: Contract;
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
type Settled = { readonly is: "yes"; readonly signed: SignedReceipt } | { readonly is: "not yet" } | { readonly is: "never" };

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
    await this.writeForTheSeatsThatNamedThemselves();
  }

  /** Every seat that said which identity is its own, on a job the chain now agrees with: its verdict, written. */
  private async writeForTheSeatsThatNamedThemselves(): Promise<void> {
    for (const record of await this.options.store.all()) {
      for (const named of record.identities ?? []) {
        try {
          await this.write(record.jobId, named);
        } catch (error) {
          this.options.say(`${record.jobId}: the ${named.role}'s verdict could not be written to agent #${named.agentId} yet: ${firstLine(error)}`);
        }
      }
    }
  }

  /**
   * One seat's verdict on its agent's record, written once however many times the worker looks, and
   * however it was stopped. The seat is written down before the entry is sent, with how many entries
   * were there; a worker that starts again reads the chain, and one more means it landed.
   */
  private async write(jobId: string, named: NamedIdentity): Promise<void> {
    const { store, jobs, registries, runner, say } = this.options;
    const record = await store.read(jobId);
    const contract = record?.chain ? this.contractOf(record.chain.jobs) : undefined;
    if (!record?.chain || !contract) return;
    const sameSeat = (one: { readonly role: string; readonly agent: Address }): boolean => one.role === named.role && isAddressEqual(one.agent, named.agent);
    const already = record.recorded?.find(sameSeat);
    if (already && (already.key !== undefined || already.written !== undefined)) return;

    const onChainId = BigInt(record.chain.jobId);
    const settled = await this.settledAsGraded(record, onChainId, contract);
    if (settled.is === "not yet") return;
    if (settled.is === "never") {
      // it ended some other way than its verdict says, so there is nothing true to write: let go of it
      await store.save({ ...record, identities: (record.identities ?? []).filter((one) => !sameSeat(one)) });
      say(`${jobId}: nothing is written for agent #${named.agentId}, since the job did not settle as it was graded`);
      return;
    }
    const agentId = BigInt(named.agentId);
    // asked again now: an identity can change hands between a seat naming it and the job settling
    const seat = await this.seatOf(agentId, await readSeats(contract, onChainId));
    if (!seat || !sameSeat(seat)) {
      await store.save({ ...record, identities: (record.identities ?? []).filter((one) => !sameSeat(one)) });
      say(`${jobId}: agent #${named.agentId} is no longer the ${named.role}'s own, so nothing is written`);
      return;
    }

    const verdict = { kind: settled.signed.receipt.verdict };
    const tag = registryTag(verdict, seat.role);
    const entries = async (): Promise<number> => (await feedbackFrom(jobs.publicClient, agentId, runner, registries)).filter((entry) => entry.tag === tag).length;
    const written = await this.options.onTheChain(async () => {
      const there = await entries();
      if (already?.entriesBefore !== undefined) {
        // stopped after sending and before writing it down: the chain says whether it landed
        if (there > already.entriesBefore) return "landed" as const;
      } else {
        await this.remember(jobId, { role: seat.role, agent: seat.agent, agentId: named.agentId, entriesBefore: there });
      }
      return writeFeedback({ publicClient: jobs.publicClient, wallet: jobs.wallet }, {
        agentId, score: registryResponse(verdict), tag,
        site: this.options.site ?? "",
        receiptURI: `${this.options.site ?? ""}${receiptPath(jobId)}`,
        receiptHash: settled.signed.hash,
      }, registries);
    });
    await this.wroteDown(jobId, seat, written === "landed" ? undefined : written);
    say(`recorded ${settled.signed.receipt.verdict} for agent #${named.agentId}, the ${seat.role} on ${jobId}, with nothing asked of its owner`);
  }

  /** Mark a seat's entry as written, reading the record fresh so nothing written meanwhile is lost. */
  private async wroteDown(jobId: string, seat: { readonly role: string; readonly agent: Address }, hash: Hex | undefined): Promise<void> {
    const record = await this.options.store.read(jobId);
    if (!record) return;
    await this.options.store.save({
      ...record,
      recorded: (record.recorded ?? []).map((one) =>
        one.role === seat.role && isAddressEqual(one.agent, seat.agent) ? { ...one, written: hash ? { hash } : {} } : one),
    });
  }

  private async answer(request: Request): Promise<Outcome> {
    const { store, jobs, registries, say } = this.options;
    const jobId = jobNamedIn(request.link);
    if (!jobId) {
      say(`agent #${request.agentId} asked about ${request.link}, which is not a job's receipt here`);
      return "ignored";
    }
    const record = await store.read(jobId);
    const contract = record?.chain ? this.contractOf(record.chain.jobs) : undefined;
    if (!record?.chain || !contract) {
      say(`agent #${request.agentId} asked about ${jobId}, which is not a job on this contract`);
      return "ignored";
    }
    if ((await verdictOnChain(jobs.publicClient, request.key, registries)).responseHash !== zeroHash) return "ignored";
    const onChainId = BigInt(record.chain.jobId);
    const settled = await this.settledAsGraded(record, onChainId, contract);
    if (settled.is === "not yet") return "held";
    if (settled.is === "never") {
      say(`agent #${request.agentId} asked about ${jobId}, whose verdict was never settled, so nothing is recorded`);
      return "ignored";
    }
    const { signed } = settled;

    const agentId = BigInt(request.agentId);
    const seat = await this.seatOf(agentId, await readSeats(contract, onChainId));
    if (!seat) {
      say(`agent #${request.agentId} asked about ${jobId}, and is not the key that held a seat on it, so nothing is recorded`);
      return "ignored";
    }
    const already = record.recorded?.find((recorded) => recorded.role === seat.role && isAddressEqual(recorded.agent, seat.agent));
    // recorded once, whichever way it was: an entry this worker wrote itself answers no request at all
    if (already && already.key?.toLowerCase() !== request.key.toLowerCase()) {
      say(`agent #${request.agentId} asked about ${jobId} again, and the ${seat.role}'s verdict is recorded once`);
      return "ignored";
    }

    // the seat is written down before the answer is sent: a worker stopped between the two answers
    // this same request again, and no other
    if (!already) await this.remember(jobId, { role: seat.role, agent: seat.agent, agentId: request.agentId, key: request.key });
    const verdict = { kind: signed.receipt.verdict };
    const answered = await this.options.onTheChain(async () => {
      // read again inside the queue: another look may have answered it while this one waited
      if ((await verdictOnChain(jobs.publicClient, request.key, registries)).responseHash !== zeroHash) return false;
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
  private async settledAsGraded(record: JobRecord, onChainId: bigint, contract: Contract): Promise<Settled> {
    const state = (await readJob(contract, onChainId)).state;
    const signed = record.signed;
    if (!signed || record.tile.verdict === "running") return { is: state === "working" ? "not yet" : "never" };
    if (state === "working" || state === "open") return { is: "not yet" };
    const verdict = signed.receipt.verdict;
    if (verdict === "passed") return state === "settled" ? { is: "yes", signed } : { is: "never" };
    if (verdict === "failed") return state === "refunded" && record.chain?.settled !== undefined ? { is: "yes", signed } : { is: "never" };
    return { is: "yes", signed };
  }

  /** Which of the contracts this worker answers for a job is on, if either. */
  private contractOf(address: Address): Contract | undefined {
    const { jobs, prepared } = this.options;
    return [jobs, prepared].find((contract): contract is Contract => contract !== undefined && isAddressEqual(contract.address, address));
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
      if (errorCode(error) !== "ENOENT") throw error;
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
