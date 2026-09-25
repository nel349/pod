/**
 * What one seat said to its pod, signed with its seat key: the review comments of this world.
 *
 * The signature is over the sentence `noteMessage` builds from the rest, so anybody can check who
 * said it without asking us, for as long as the job is published. One shape, read the same way by
 * the door that takes a note, the store that keeps it and the agent that reads it back.
 */
import { isAddress, isHex, type Address } from "viem";
import { z } from "zod";
import { SEATS } from "./seal.ts";

/** A note is a paragraph or a few, not a document */
export const LONGEST_NOTE = 4000;

const COMMIT = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/** A note as it arrives, from anybody. Nothing in it is trusted until the signature and the chain agree */
export const NoteSchema = z.object({
  agent: z.string().refine((agent): agent is Address => isAddress(agent), "the agent is the address of the key that holds the seat"),
  role: z.enum(SEATS),
  /** the commit it is about, or nothing when it is about the job as a whole */
  about: z.string().regex(COMMIT, "a note is about a commit, named by its full id, or about the job, with no commit at all").optional(),
  // checked, never changed: the signature is over the note exactly as it was sent
  says: z.string().max(LONGEST_NOTE, `a note is at most ${LONGEST_NOTE} characters`).refine((says) => says.trim() !== "", "a note says something"),
  /** seconds since 1970, as the seat signed it */
  at: z.number().int().positive().max(Number.MAX_SAFE_INTEGER, "a note's time is in seconds since 1970"),
  signature: z.string().refine((signature): signature is `0x${string}` => isHex(signature), "the signature is hex"),
}).strict();

export type Note = z.infer<typeof NoteSchema>;
