/**
 * Where a delivered website goes live.
 *
 * A host takes a folder of files and gives back an address anybody can open, on a name of its own and
 * never this site's: what a pod built runs in a visitor's browser, and on this site's address it could
 * ask that visitor for the passkey their wallet here is made from. A host can also hand the site to
 * whoever the job's poster turns out to be, with a link they open, and take it down.
 *
 * One small piece, so another host can stand beside the first without anything else changing.
 */
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** A website's files as a host takes them: each by its address on the site, starting with a slash. */
export type SiteFiles = ReadonlyMap<string, Uint8Array<ArrayBuffer>>;

export interface LiveSite {
  /** the host's own name for the site, which every later call names it by */
  readonly siteId: string;
  /** where anybody can open it */
  readonly url: string;
}

export interface SiteHost {
  /** the host's name, for a job's record and for what is said to people */
  readonly name: string;
  /**
   * Put a website live under a name of its own. `madeFor` says what the site is for, such as a job and
   * its seal: the link that hands it over is made from the same words, so one site's link never takes
   * another, and nothing that could take a site has to be kept anywhere.
   */
  publish(input: { readonly name: string; readonly files: SiteFiles; readonly madeFor: string }): Promise<LiveSite>;
  /** A link whoever opens takes the site made for this into their own account with. To be shown to the one person it is for. */
  handoverLink(madeFor: string): Promise<string>;
  /** Whether this host's own account still holds the site: no longer, once whoever it was handed to has taken it, or it is gone. */
  holds(siteId: string): Promise<boolean>;
  /** Take the site down for good. Taking down one already gone is no failure. */
  remove(siteId: string): Promise<void>;
}

/** The most a website may be, which is also what keeps a pod from filling a host in this site's name */
export const SITE_LIMITS = { files: 500, bytesEach: 5 * 1024 * 1024, bytesInAll: 25 * 1024 * 1024 } as const;

/** A file's or folder's name a host can serve at an address: no control characters, none a host reads as part of an address */
const SERVABLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._ ()@+,=-]*$/;

/** Why a folder cannot be published as a website, said for the pod that built it. */
export class NotAWebsite extends Error {}

/**
 * The files of a website, read from its folder in a checkout of the work. The pod chose every byte of
 * it, so nothing is followed and nothing is trusted: a link is left out, as the sealed run leaves it
 * out, since a link here could point at any file on this machine; a name a host could misread, and a
 * website past its limits, are refused in words.
 */
export async function siteFilesIn(folder: string, frontPage: string): Promise<SiteFiles> {
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  let bytes = 0;
  const walk = async (directory: string, address: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const found = await lstat(path);
      if (found.isSymbolicLink()) continue;
      if (!SERVABLE_NAME.test(name)) throw new NotAWebsite(`"${address}${name}" is a name no host can serve at an address: use letters, numbers, dots and dashes`);
      if (found.isDirectory()) {
        await walk(path, `${address}${name}/`);
        continue;
      }
      if (!found.isFile()) continue;
      if (found.size > SITE_LIMITS.bytesEach) throw new NotAWebsite(`"${address}${name}" is larger than a website's file may be here (${SITE_LIMITS.bytesEach} bytes)`);
      bytes += found.size;
      if (files.size + 1 > SITE_LIMITS.files) throw new NotAWebsite(`the website has more than ${SITE_LIMITS.files} files, which is the most one may have here`);
      if (bytes > SITE_LIMITS.bytesInAll) throw new NotAWebsite(`the website is larger than one may be here (${SITE_LIMITS.bytesInAll} bytes in all)`);
      files.set(`${address}${name}`, new Uint8Array(await readFile(path)));
    }
  };
  const isThere = await lstat(folder).then((found) => found.isDirectory(), () => false);
  if (!isThere) throw new NotAWebsite("the work has no website folder in it, so there is nothing to put live");
  await walk(folder, "/");
  if (!files.has(`/${frontPage}`)) throw new NotAWebsite(`the website has no ${frontPage} at its top, so there is no front page to open`);
  return files;
}

/** The longest name a live site is given, which is the longest a host's own name for one may be */
const LONGEST_SITE_NAME = 63;

/** What a job's live site is made for, in words its hand-over link is made from again: this job, under this seal. */
export const siteMadeFor = (job: { readonly jobId: string; readonly seal: string }): string => `${job.jobId}:${job.seal.toLowerCase()}`;

/** The name a job's live site goes under: the job's own, with enough of its seal that no two jobs share one. */
export function siteNameFor(job: { readonly jobId: string; readonly seal: string }): string {
  const tail = `-${job.seal.slice(2, 10).toLowerCase()}`;
  return `pod-${job.jobId}`.slice(0, LONGEST_SITE_NAME - tail.length).replace(/-+$/, "") + tail;
}
