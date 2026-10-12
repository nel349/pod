/**
 * A reference: something a poster points their pod at, such as a picture of what they want or the text
 * of a specification. POD fetches it once when the job is set up and keeps the file with the job, so
 * every agent is given the same file and it cannot change under them, whatever the link does later.
 *
 * Shared by the posting page and the server, so the page refuses a link in the server's own words.
 */
import { z } from "zod";

/** How many a job may carry, and how large each may be: enough for a few pictures and a document. */
export const MOST_REFERENCES = 5;
export const LARGEST_REFERENCE_BYTES = 5 * 1024 * 1024;
export const LONGEST_REFERENCE_LINK = 2000;

/**
 * The kinds of file kept, by the type they are served back as. Nothing that a browser would run or lay
 * out as a page of its own: a reference is served from POD's own address, where the wallet lives.
 */
export const REFERENCE_KINDS = {
  "image/png": { ending: "png", isText: false },
  "image/jpeg": { ending: "jpg", isText: false },
  "image/webp": { ending: "webp", isText: false },
  "image/gif": { ending: "gif", isText: false },
  "application/pdf": { ending: "pdf", isText: false },
  "text/plain": { ending: "txt", isText: true },
  "text/markdown": { ending: "md", isText: true },
  "text/csv": { ending: "csv", isText: true },
  "application/json": { ending: "json", isText: true },
} as const satisfies Record<string, { readonly ending: string; readonly isText: boolean }>;
export type ReferenceType = keyof typeof REFERENCE_KINDS;

export const isReferenceType = (type: string): type is ReferenceType => type in REFERENCE_KINDS;
export const isImage = (type: ReferenceType): boolean => type.startsWith("image/");

const LinkSchema = z.string().trim()
  .min(1, "a reference is a link")
  .max(LONGEST_REFERENCE_LINK, `keep each link under ${LONGEST_REFERENCE_LINK} characters`)
  .refine((link) => URL.canParse(link) && ["https:", "http:"].includes(new URL(link).protocol), "a reference is a link, such as https://example.com/sketch.png");

/**
 * The links a poster gives, as they are sent: a few, each a web address, none twice. That each is a
 * public https address is for whoever fetches it to hold it to, since only fetching can say.
 */
export const ReferenceLinksSchema = z.array(LinkSchema)
  .max(MOST_REFERENCES, `at most ${MOST_REFERENCES} references`)
  .refine((links) => new Set(links).size === links.length, "the same link is given twice");

/** A reference as it is kept and published: what it is called here, what it is, and its fingerprint. */
export const ReferenceSchema = z.object({
  /** the file's name at this job's address, made here: never the link's own, which could be anything */
  name: z.string().regex(/^reference-[1-9]\.[a-z]{2,4}$/),
  type: z.string().refine(isReferenceType, "not a kind of file POD keeps"),
  bytes: z.number().int().positive().max(LARGEST_REFERENCE_BYTES),
  /** the sha256 of the file, as 0x and hex: what anybody holds the file they were given against */
  digest: z.string().regex(/^0x[0-9a-f]{64}$/),
  /** where the poster said it was, for a person to recognise it by */
  from: z.string(),
});
export type Reference = z.infer<typeof ReferenceSchema>;

/** What reading one link came to, said to the poster before they pay. */
export const ReferenceReadSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), link: z.string(), type: z.string(), bytes: z.number() }),
  z.object({ ok: z.literal(false), link: z.string(), why: z.string() }),
]);
export type ReferenceRead = z.infer<typeof ReferenceReadSchema>;

/** The links in what a poster typed, one to a line, with nothing for an empty line. */
export function linksIn(typed: string): readonly string[] {
  return typed.split("\n").map((line) => line.trim()).filter((line) => line !== "");
}

/** The name a reference is kept under: its place among the job's, and its kind. */
export const referenceName = (place: number, type: ReferenceType): string => `reference-${place}.${REFERENCE_KINDS[type].ending}`;
