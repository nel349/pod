/**
 * Where a seat says which ERC-8004 identity is its own, so its verdict can be written there.
 *
 * It is one number, and nothing has to be signed to say it. Whether an identity is a seat's own is a
 * fact on the chain: the identity's owner, or the wallet it says it acts with, holds a seat on this
 * job, or it does not. So anybody may name an identity here, and it can only ever be credited to the
 * seat that is truly its own, which is exactly what naming it would have done anyway.
 *
 * Nothing is written to the registry here. The worker writes it once the job is settled, from its own
 * key, so an agent working for somebody's wallet is recorded without that somebody being asked for
 * anything.
 */
import { BaseError, ContractFunctionRevertedError, isAddressEqual, type Address, type PublicClient } from "viem";
import { z } from "zod";
import { bodyWithin, tooLarge } from "../body.ts";
import { agentWalletOf, ownerOfAgent, type Registries } from "../registry.ts";
import { ROUTES } from "../routes.ts";
import type { JobStore, NamedIdentity } from "../store.ts";
import { PerMinute, type Doorkeeper } from "./Doorkeeper.ts";

/** A request naming an identity is a number and its field name, and nothing more */
const MOST_A_NAMING_MAY_WEIGH = 200;
/** How often identities may be named on one job. Each is two reads of the chain, so this is what a flood costs */
export const NAMINGS_A_JOB_MAY_TAKE_A_MINUTE = 30;

const NamingSchema = z.object({
  identity: z.union([z.string().regex(/^[0-9]+$/, "the identity is its ERC-8004 number"), z.number().int().nonnegative()]).transform(String),
}).strict();

export class IdentityDoor {
  private readonly named = new PerMinute(NAMINGS_A_JOB_MAY_TAKE_A_MINUTE);

  constructor(private readonly options: {
    readonly keeper: Doorkeeper;
    readonly store: JobStore;
    readonly client: PublicClient;
    readonly registries: Registries;
  }) {}

  async handle(request: Request): Promise<Response> {
    const { keeper, store, client, registries } = this.options;
    if (request.method !== "POST") return Response.json({ why: "an identity is named with POST" }, { status: 405 });
    const job = await keeper.job(new URL(request.url).pathname.slice(ROUTES.identity.length));
    if (!job.ok) return Response.json({ why: job.why }, { status: job.status });
    const { jobId, onChainId } = job.value;
    if (!this.named.allow(jobId)) {
      return Response.json({ why: `identities may be named on a job ${NAMINGS_A_JOB_MAY_TAKE_A_MINUTE} times a minute. Wait a moment and name yours again` }, { status: 429 });
    }

    const body = await bodyWithin(request, MOST_A_NAMING_MAY_WEIGH);
    if (body === undefined) return tooLarge("an identity is one number");
    let asked: unknown;
    try {
      asked = JSON.parse(body);
    } catch {
      return Response.json({ why: 'name an identity as { "identity": <its ERC-8004 number> }' }, { status: 400 });
    }
    const parsed = NamingSchema.safeParse(asked);
    if (!parsed.success) return Response.json({ why: parsed.error.issues[0]?.message ?? "that is not an identity" }, { status: 400 });
    const agentId = parsed.data.identity;

    let owner: Address;
    let wallet: Address;
    try {
      [owner, wallet] = await Promise.all([
        ownerOfAgent(client, BigInt(agentId), registries),
        agentWalletOf(client, BigInt(agentId), registries),
      ]);
    } catch (error) {
      // the registry refuses a number it never gave out, which is the contract answering; anything
      // else is the chain not being reached. Told apart by what kind of failure it was, never by its
      // words, which belong to whichever node and library happen to be speaking
      return wasRefusedByTheContract(error)
        ? Response.json({ why: `there is no ERC-8004 identity ${agentId}` }, { status: 404 })
        : Response.json({ why: "the chain could not be asked whose identity that is: name it again in a moment" }, { status: 503 });
    }
    // a seat taken a moment ago is asked of the chain afresh, as at the other doors
    const seats = await job.value.chain.seats(onChainId, true);
    const seat = seats.find((held) => isAddressEqual(held.agent, owner) || isAddressEqual(held.agent, wallet));
    if (!seat) {
      return Response.json({
        why: `identity ${agentId} is not the key that holds a seat on job ${onChainId}: its owner, or the wallet it says it acts with, has to be the seat`,
      }, { status: 403 });
    }

    const record = await store.read(jobId);
    if (!record) return Response.json({ why: `there is no job called ${jobId}` }, { status: 404 });
    const naming: NamedIdentity = { role: seat.role, agent: seat.agent, agentId };
    const sameSeat = (one: { readonly role: string; readonly agent: Address }): boolean => one.role === seat.role && isAddressEqual(one.agent, seat.agent);
    const before = record.identities?.find(sameSeat);
    if (before && before.agentId !== agentId) {
      return Response.json({ why: `the ${seat.role} seat already named identity ${before.agentId}, and a seat is recorded once` }, { status: 409 });
    }
    const isRecorded = record.recorded?.some((one) => sameSeat(one) && (one.key !== undefined || one.written !== undefined)) ?? false;
    if (!before && !isRecorded) await store.save({ ...record, identities: [...(record.identities ?? []), naming] });
    return Response.json({
      seat: seat.role, identity: agentId, recorded: isRecorded,
      says: isRecorded
        ? `the ${seat.role}'s verdict is on identity ${agentId}'s record`
        : `the ${seat.role}'s verdict will be written to identity ${agentId} once the job is settled, with nothing asked of whoever owns it`,
    }, { status: before || isRecorded ? 200 : 201 });
  }
}

/** Whether the contract itself said no, rather than the node failing to be reached. */
function wasRefusedByTheContract(error: unknown): boolean {
  return error instanceof BaseError && error.walk((cause) => cause instanceof ContractFunctionRevertedError) !== null;
}
