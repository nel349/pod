/**
 * A job's spec as it travels and as it is kept: the same shape either way, read through one schema.
 *
 * JSON has no bigint, and the price is money, so it moves as a string of wei and becomes a bigint
 * again only here. The poster's page sends it this way, and the store keeps it this way until the
 * job has a verdict, which is when the hidden checks and the salt in it stop being secret.
 */
import { z } from "zod";
import { KINDS, MODE_NAMES, type Spec } from "./job.ts";

const FINGERPRINT = /^0x[0-9a-f]{64}$/;

export const SpecOnTheWireSchema = z.object({
  idea: z.string(),
  kind: z.enum(KINDS).optional(),
  mode: z.enum(MODE_NAMES),
  price: z.string().regex(/^[0-9]+$/, "the price is a whole number of wei"),
  checks: z.array(z.object({
    says: z.string(),
    run: z.string(),
    hidden: z.boolean(),
    file: z.string().optional(),
    digest: z.string().refine((digest): digest is `0x${string}` => FINGERPRINT.test(digest), "a check's fingerprint is 32 bytes of hex").optional(),
  })).readonly(),
  allowed: z.array(z.object({ host: z.string(), why: z.string() })).readonly(),
  salt: z.string(),
});

export type SpecOnTheWire = z.input<typeof SpecOnTheWireSchema>;

export function specFromTheWire(wire: z.output<typeof SpecOnTheWireSchema>): Spec {
  return { ...wire, price: BigInt(wire.price) };
}

export function specToTheWire(spec: Spec): SpecOnTheWire {
  return { ...spec, price: spec.price.toString() };
}
