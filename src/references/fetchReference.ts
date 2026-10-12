/**
 * Fetching a reference, as a server that takes links from strangers has to.
 *
 * A link from a stranger is a request this server makes on their behalf, so it may only go where a
 * stranger could go themselves: a public address, over https, never this machine or anything beside
 * it. It follows a few redirects, checking each stop the same way, reads no more than a reference may
 * weigh, and keeps only kinds of file that are safe to hand back from POD's own address.
 */
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { firstLine } from "../errors.ts";
import { isReferenceType, LARGEST_REFERENCE_BYTES, type ReferenceType } from "./Reference.ts";

const MOST_REDIRECTS = 3;
const MAY_TAKE_MS = 15_000;
/** how this server names itself to whoever serves the file */
const USER_AGENT = "POD (proof of development): fetching a reference a poster gave";

/** Why a link was not kept, in words for the person who gave it. */
export class ReferenceRefused extends Error {}

export interface FetchedReference {
  readonly type: ReferenceType;
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly digest: `0x${string}`;
}

export interface FetchOptions {
  /**
   * Whether an address may be asked. Left out, only public ones: a test names its own stand-in, which
   * is on this machine and so would otherwise be refused, as it should be.
   */
  readonly mayAsk?: (address: string) => boolean;
  readonly largestBytes?: number;
}

/** Whether an IPv4 address is one only this machine or its own network can reach. */
function isPrivateV4(address: string): boolean {
  const [a = 0, b = 0] = address.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

/** Whether an address is public: not this machine, not a private network, not a link-local or reserved one. */
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) return !isPrivateV4(address);
  const lower = address.toLowerCase();
  // an IPv4 address written as IPv6 is judged as the IPv4 address it is
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return !isPrivateV4(mapped[1]);
  if (lower === "::" || lower === "::1") return false;
  // unique local (fc00::/7), link local (fe80::/10), multicast (ff00::/8)
  return !/^(f[cd]|fe[89ab]|ff)/.test(lower);
}

/** What some hosts are, said at once: a page that needs signing in is never a file. */
const NOT_FILES: readonly { readonly host: RegExp; readonly why: string }[] = [
  { host: /(^|\.)figma\.com$/, why: "a Figma link opens Figma, which no agent can sign in to. Export the frame as an image, put the image somewhere public, and give that link" },
  { host: /(^|\.)(docs|drive)\.google\.com$/, why: "a Google Docs or Drive link opens a page that needs signing in. Export it as a PDF or an image, put it somewhere public, and give that link" },
  { host: /(^|\.)notion\.(so|site)$/, why: "a Notion link opens a page, not a file. Export it as a PDF or Markdown, put it somewhere public, and give that link" },
];

async function everyAddressIsPublic(hostname: string, mayAsk: (address: string) => boolean): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((found) => found.address);
  if (addresses.length === 0) throw new ReferenceRefused("that address could not be found");
  if (!addresses.every(mayAsk)) throw new ReferenceRefused("that address is not a public one, so POD does not fetch from it");
}

/** What a file's first bytes say it is, for the kinds that say: a picture named as text is not kept as either. */
function startsAs(bytes: Uint8Array): ReferenceType | undefined {
  const starts = (...with_: number[]): boolean => with_.every((byte, at) => bytes[at] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  if (starts(0x25, 0x50, 0x44, 0x46)) return "application/pdf";
  return undefined;
}

/** The kind a file is kept as: what it was served as, held against what its own bytes say. */
function kindOf(served: string, bytes: Uint8Array): ReferenceType {
  const said = served.split(";")[0]?.trim().toLowerCase() ?? "";
  const shown = startsAs(bytes);
  if (said === "text/html" || said === "application/xhtml+xml") {
    throw new ReferenceRefused("that link opens a web page, not a file. Give the address of the picture, PDF or text itself");
  }
  if (said === "image/svg+xml") throw new ReferenceRefused("an SVG can carry a program, so POD does not keep one. Export it as a PNG");
  if (shown) return shown;
  if (!isReferenceType(said) || said.startsWith("image/") || said === "application/pdf") {
    throw new ReferenceRefused(`that is ${said || "a kind of file POD cannot name"}, and POD keeps pictures (PNG, JPEG, WebP, GIF), PDFs, and text (plain, Markdown, CSV, JSON)`);
  }
  // served as text: it has to be text, since it will be read to an agent as that
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ReferenceRefused("that was served as text and is not text");
  }
  return said;
}

/** Read a response's body, giving up as soon as it is more than a reference may weigh. */
async function bodyOf(response: Response, largest: number): Promise<Uint8Array<ArrayBuffer>> {
  const tooLarge = new ReferenceRefused(`that file is over ${Math.round(largest / (1024 * 1024))} MB, the most a reference may be`);
  if (Number(response.headers.get("content-length") ?? 0) > largest) throw tooLarge;
  const reader = response.body?.getReader();
  if (!reader) throw new ReferenceRefused("that link answered with nothing");
  const parts: Uint8Array[] = [];
  let read = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    read += value.byteLength;
    if (read > largest) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge;
    }
    parts.push(value);
  }
  if (read === 0) throw new ReferenceRefused("that link answered with an empty file");
  const whole = new Uint8Array(read);
  let at = 0;
  for (const part of parts) { whole.set(part, at); at += part.byteLength; }
  return whole;
}

/**
 * Fetch one reference. Throws ReferenceRefused, with why in words for the poster, when the link is not
 * one POD fetches from, does not answer with a file, or the file is not a kind or a size it keeps.
 */
export async function fetchReference(link: string, options: FetchOptions = {}): Promise<FetchedReference> {
  const mayAsk = options.mayAsk ?? isPublicAddress;
  const largest = options.largestBytes ?? LARGEST_REFERENCE_BYTES;
  let at = new URL(link);
  for (let hops = 0; ; hops++) {
    if (at.protocol !== "https:" && options.mayAsk === undefined) throw new ReferenceRefused("a reference is a link that starts with https://");
    const notAFile = NOT_FILES.find((one) => one.host.test(at.hostname));
    if (notAFile) throw new ReferenceRefused(notAFile.why);
    await everyAddressIsPublic(at.hostname, mayAsk);
    let response: Response;
    try {
      response = await fetch(at, { redirect: "manual", headers: { "user-agent": USER_AGENT, accept: "*/*" }, signal: AbortSignal.timeout(MAY_TAKE_MS) });
    } catch (error) {
      throw new ReferenceRefused(`that link did not answer: ${firstLine(error)}`);
    }
    const next = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    if (next) {
      await response.body?.cancel().catch(() => undefined);
      if (hops >= MOST_REDIRECTS) throw new ReferenceRefused("that link sends on to another, and that one to another, more times than POD follows");
      at = new URL(next, at);
      continue;
    }
    if (response.status === 401 || response.status === 403) throw new ReferenceRefused("that link needs signing in, and no agent can sign in. Put the file somewhere public and give that link");
    if (!response.ok) throw new ReferenceRefused(`that link answered ${response.status}, not a file`);
    const bytes = await bodyOf(response, largest);
    const type = kindOf(response.headers.get("content-type") ?? "", bytes);
    return { type, bytes, digest: `0x${createHash("sha256").update(bytes).digest("hex")}` };
  }
}
