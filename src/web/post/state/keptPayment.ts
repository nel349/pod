/**
 * A payment kept in the browser until its job is on the wall.
 *
 * Once the wallet hands back a payment, the money is in the contract whatever happens to the page. If
 * the page is reloaded or closed before the job is signed and published, the job exists only on the
 * chain, where nobody can find it by name. So the payment, and the job exactly as it was sealed and
 * paid for, is kept in this browser until the job is published, and the page finishes it on return.
 *
 * Kept per chain and contract: a payment on one deployment means nothing on another. Read through a
 * schema, because a browser's storage is anybody's to edit, and whatever cannot be read is ignored.
 */
import { formatEther, isAddress, isHex, type Address } from "viem";
import { z } from "zod";
import { isWallName } from "../../../routes.ts";
import { SpecOnTheWireSchema, specFromTheWire, specToTheWire } from "../../../specWire.ts";
import type { PostForm } from "./form.ts";
import type { Payment } from "./posting.ts";

const HexSchema = z.string().refine((value): value is `0x${string}` => isHex(value), "hex");
const AddressSchema = z.string().refine((value): value is Address => isAddress(value), "an address");

const KeptSchema = z.object({
  version: z.literal(1),
  hash: HexSchema,
  poster: AddressSchema,
  onChainId: z.string().regex(/^[0-9]+$/).optional(),
  /** the name it was to have on the wall, which the poster may still change before publishing */
  name: z.string(),
  sealed: z.object({ spec: SpecOnTheWireSchema, files: z.record(z.string(), z.string()), seal: HexSchema }),
});

export interface Kept {
  readonly payment: Payment;
  readonly name: string;
}

/** Where a payment on this chain and contract is kept. */
export function keptPaymentKey(chainId: number, jobs: Address): string {
  return `pod.payment.${chainId}.${jobs.toLowerCase()}`;
}

export function keepPayment(kept: Kept): string {
  const { payment, name } = kept;
  return JSON.stringify({
    version: 1,
    hash: payment.hash,
    poster: payment.poster,
    ...(payment.onChainId === undefined ? {} : { onChainId: payment.onChainId }),
    name,
    sealed: { spec: specToTheWire(payment.sealed.spec), files: payment.sealed.files, seal: payment.sealed.seal },
  });
}

/** The kept payment, or nothing if there is none or it cannot be read. */
export function readKeptPayment(text: string | null): Kept | undefined {
  if (text === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const kept = KeptSchema.safeParse(parsed);
  if (!kept.success) return undefined;
  const { hash, poster, onChainId, name, sealed } = kept.data;
  return {
    name,
    payment: {
      hash, poster, ...(onChainId === undefined ? {} : { onChainId }),
      sealed: { spec: specFromTheWire(sealed.spec), files: sealed.files, seal: sealed.seal },
    },
  };
}

/**
 * The form as it was when the job was paid for, rebuilt from what was sealed, so the page a poster
 * comes back to shows the job they paid for and can publish it.
 */
export function formOfPaidJob(kept: Kept): PostForm {
  const { spec } = kept.payment.sealed;
  // a list the poster left empty still shows one empty line, as a blank form does
  const lines = (hidden: boolean): { says: string }[] => {
    const said = spec.checks.filter((check) => check.hidden === hidden).map((check) => ({ says: check.says }));
    return said.length > 0 ? said : [{ says: "" }];
  };
  return {
    idea: spec.idea,
    kind: spec.kind ?? "service",
    brief: lines(false),
    exam: lines(true),
    price: formatEther(spec.price),
    mode: spec.mode,
    name: isWallName(kept.name) ? kept.name : "",
  };
}
