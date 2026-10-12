/**
 * Where the holder of a POD claims the repository it is title to.
 *
 *   GET  /api/claim/<jobId>    what there is to claim: the title's number, who holds it, the repository
 *   POST /api/claim/<jobId>    { toAccount, signature }: the holder's signature over `claimToSign`
 *
 * Once the repository has left POD's account a claim asks GitHub nothing: the holder's signature is
 * answered with who has the code, and with the link to their live website when there is one.
 *
 * The chain says who holds the title now, not who paid, so a POD that was sold carries its
 * repository. What the holder gets is an invitation: GitHub hands a repository to a person only once
 * they accept, by a link it emails them, within a day. So the answer says an invitation was sent, and
 * it is called handed over only once GitHub itself says the repository lives somewhere else. An
 * account that already owns the place it is published in is given it at once, with no email.
 */
import { isHex, type Address } from "viem";
import { z } from "zod";
import { bodyWithin, tooLarge } from "./body.ts";
import { firstLine } from "./errors.ts";
import { publishedAt, transferRepository, whereItLives } from "./github.ts";
import { checkClaim, holderOf } from "./handover.ts";
import { siteMadeFor, type SiteHost } from "./hosting/index.ts";
import { NO_STORE } from "./headers.ts";
import type { Contract } from "./jobs.ts";
import { isWallName, jobPath, ROUTES } from "./routes.ts";
import type { Tile } from "./gallery.ts";
import type { JobRecord, JobStore } from "./store.ts";

/** A GitHub account's name, as GitHub allows it: letters, numbers and single dashes, at most 39 */
const GITHUB_ACCOUNT = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const MOST_A_CLAIM_MAY_WEIGH = 2_000;

const ClaimSchema = z.object({
  toAccount: z.string().regex(GITHUB_ACCOUNT, "that is not a GitHub account's name"),
  signature: z.string().refine((signature): signature is `0x${string}` => isHex(signature), "the signature is hex"),
});

/** What the page shows before anybody signs */
export interface Claimable {
  readonly jobId: string;
  readonly idea: string;
  readonly tokenId: string;
  readonly holder: Address;
  readonly repository: string;
  /** where the work is live, when it is a website that was put live and is still there */
  readonly live?: string;
  /** the live website is already in its holder's own account at its host, so there is no link left to give */
  readonly isSiteTaken?: true;
  /** the last invitation sent, if one was */
  readonly invited?: Invitation;
  /** who has the repository now, once it has left POD's account */
  readonly handed?: Handed;
}

export interface Invitation {
  readonly account: string;
  readonly by: Address;
  /** when it was sent, as an ISO date */
  readonly at: string;
}

/** A repository that has left POD's account: the GitHub account that has it, and when POD saw that it had moved */
export interface Handed {
  readonly account: string;
  /** as an ISO date */
  readonly at: string;
}

/** How long GitHub keeps an invitation to take a repository open */
export const INVITATION_LASTS_MS = 24 * 60 * 60 * 1000;

/** Whether a job has an invitation out that may still be accepted, which is when it is worth asking GitHub where the repository is */
export function isInvitationOpen(record: JobRecord, now = Date.now()): boolean {
  return Boolean(record.invited && !record.handed && record.repository) && now - Date.parse(record.invited?.at ?? "") <= INVITATION_LASTS_MS;
}

/**
 * Ask GitHub where an invited job's repository lives, and write down that it was handed over once it
 * is no longer where POD published it. The record then names the repository where it is now. A job
 * with no invitation out, or already handed over, is left as it is and GitHub is not asked.
 */
export async function noticeHandover(store: JobStore, record: JobRecord): Promise<JobRecord> {
  if (!record.invited || record.handed || !record.repository) return record;
  const published = publishedAt(record.repository);
  const lives = await whereItLives(published);
  if (lives.owner.toLowerCase() === published.owner.toLowerCase()) return record;
  const fresh = (await store.read(record.jobId)) ?? record;
  const handed: JobRecord = { ...fresh, repository: lives.url, handed: { account: lives.owner, at: new Date().toISOString() } };
  await store.save(handed);
  return handed;
}

/** Whether the link to a job's live website was given lately enough that it is worth asking its host whether the site was taken */
export function isSiteOfferOpen(record: JobRecord, now = Date.now()): boolean {
  const { live } = record;
  if (!live || live.removedAt || live.takenAt) return false;
  const since = live.offeredAt ?? record.handed?.at;
  return since !== undefined && now - Date.parse(since) <= INVITATION_LASTS_MS;
}

/**
 * Ask the host whether a job's live website is still in POD's account there, and write down that it
 * was taken once it is not. A job with no live site, or one already taken or taken down, is left as
 * it is and the host is not asked.
 */
export async function noticeSiteTaken(store: JobStore, siteHost: SiteHost, record: JobRecord): Promise<JobRecord> {
  if (!record.live || record.live.removedAt || record.live.takenAt) return record;
  if (await siteHost.holds(record.live.siteId)) return record;
  const fresh = (await store.read(record.jobId)) ?? record;
  if (!fresh.live) return fresh;
  const taken: JobRecord = { ...fresh, live: { ...fresh.live, takenAt: new Date().toISOString() } };
  await store.save(taken);
  return taken;
}

/** How often, at most, a job's claim page has GitHub and the host asked where its code and its site are */
const ASKED_AGAIN_AFTER_MS = 30_000;

export class Claims {
  /** when each job's repository and site were last asked after, so a page opened over and over asks once */
  private readonly askedAt = new Map<string, number>();

  constructor(private readonly options: {
    readonly store: JobStore;
    readonly token: Omit<Contract, "wallet">;
    /** where delivered websites are live, which hands one to its title's holder with the repository */
    readonly siteHost?: SiteHost;
  }) {}

  async handle(request: Request): Promise<Response> {
    const jobId = new URL(request.url).pathname.slice(ROUTES.claimApi.length);
    if (!isWallName(jobId)) return Response.json({ why: NOTHING_HERE }, { status: 404 });
    const kept = await this.options.store.read(jobId);
    const record = kept && (await this.noticed(kept));
    const parts = claimable(record);
    if (!record || !parts.ok) {
      const why = parts.ok ? NOTHING_HERE : parts.why;
      return Response.json({ why, ...(record ? { job: jobPath(jobId) } : {}) }, { status: 404 });
    }
    const { tokenId, repository } = parts;

    if (request.method === "GET") {
      const answer: Claimable = {
        jobId, idea: record.tile.idea, tokenId: tokenId.toString(), repository,
        holder: await holderOf(this.options.token, tokenId),
        ...(liveOf(record) ? { live: liveOf(record) } : {}),
        ...(liveOf(record) && record.live?.takenAt ? { isSiteTaken: true as const } : {}),
        ...(record.invited ? { invited: record.invited } : {}),
        ...(record.handed ? { handed: record.handed } : {}),
      };
      return Response.json(answer, { headers: NO_STORE });
    }
    if (request.method !== "POST") return Response.json({ why: "a claim is read with GET and made with POST" }, { status: 405 });

    const body = await bodyWithin(request, MOST_A_CLAIM_MAY_WEIGH);
    if (body === undefined) return tooLarge("a claim is an account's name and a signature, and nothing more");
    let asked: unknown;
    try {
      asked = JSON.parse(body);
    } catch {
      return Response.json({ why: "that is not a claim" }, { status: 400 });
    }
    const parsed = ClaimSchema.safeParse(asked);
    if (!parsed.success) return Response.json({ why: parsed.error.issues[0]?.message ?? "that is not a claim" }, { status: 400 });

    const checked = await checkClaim(this.options.token, { jobId, tokenId, ...parsed.data });
    if (!checked.allowed || !checked.holder) {
      return Response.json({ why: checked.why ?? "that signature is not the holder's" }, { status: 403 });
    }
    // the holder's signature is what the live site is handed over on: GitHub having a bad moment, or the
    // holder having no account there, does not keep their own website from them
    const site = await this.siteFor(record);
    // the repository is already with its holder's account: GitHub has nothing more to be asked, and the
    // holder's signature still gets them their live website
    if (record.handed) return Response.json({ handed: record.handed, ...site }, { headers: NO_STORE });
    try {
      await transferRepository(publishedAt(repository), parsed.data.toAccount);
    } catch (error) {
      return Response.json({ why: `GitHub would not send the invitation: ${firstLine(error)}`, ...site }, { status: 502, headers: NO_STORE });
    }
    const invited: Invitation = { account: parsed.data.toAccount, by: checked.holder, at: new Date().toISOString() };
    const fresh = await this.options.store.read(jobId);
    if (fresh) {
      await this.options.store.save({ ...fresh, invited });
      // an account that already owns where it was published is given it there and then
      await this.noticed({ ...fresh, invited }, true);
    }
    return Response.json({ invited, ...site }, { status: 201, headers: NO_STORE });
  }

  /**
   * The record, with what GitHub and the host have finished written into it: the repository moved to
   * its holder's account, the live site taken into theirs. Either not answering leaves it as it was.
   */
  private async noticed(record: JobRecord, isAskedNow = false): Promise<JobRecord> {
    const { store, siteHost } = this.options;
    if (!isAskedNow && Date.now() - (this.askedAt.get(record.jobId) ?? 0) < ASKED_AGAIN_AFTER_MS) return record;
    this.askedAt.set(record.jobId, Date.now());
    const moved = await noticeHandover(store, record).catch((error: unknown) => {
      console.error(`[claims] ${record.jobId}: GitHub did not say where its repository is: ${firstLine(error)}`);
      return record;
    });
    if (!siteHost) return moved;
    return noticeSiteTaken(store, siteHost, moved).catch((error: unknown) => {
      console.error(`[claims] ${record.jobId}: ${siteHost.name} did not say who holds its live site: ${firstLine(error)}`);
      return moved;
    });
  }

  /**
   * The link that takes the job's live website into the holder's own account, for the one answer that
   * has just checked their signature: whoever opens it takes the site, so it is never written down or
   * shown to anybody else. A host having a bad moment costs the holder the link, not the repository.
   */
  private async siteFor(record: JobRecord): Promise<{ readonly site?: { readonly host: string; readonly takeIt: string } }> {
    const { siteHost } = this.options;
    if (!siteHost || !record.live || !liveOf(record) || record.live.takenAt) return {};
    try {
      const takeIt = await siteHost.handoverLink(siteMadeFor(record));
      const fresh = await this.options.store.read(record.jobId);
      if (fresh?.live) await this.options.store.save({ ...fresh, live: { ...fresh.live, offeredAt: new Date().toISOString() } });
      return { site: { host: siteHost.name, takeIt } };
    } catch (error) {
      console.error(`[claims] ${record.jobId}: no link to hand its live site over: ${firstLine(error)}`);
      return {};
    }
  }
}

/** Where a job's website is live now, if it was put live and has not been taken down. */
const liveOf = (record: JobRecord): string | undefined => (record.live && !record.live.removedAt ? record.live.url : undefined);

const NOTHING_HERE = "There is no job at that address.";

/** Why a job with no title has nothing to claim, in terms of where it stands. */
const NO_TITLE: Record<Tile["verdict"], string> = {
  running: "Not yet: this job is still open. Its title is minted to whoever posted it once the work passes, and then the repository can be claimed here.",
  passed: "This job passed, and no title was minted for it, so there is nothing to claim.",
  failed: "This job's checks failed, so no title was minted and there is nothing to claim.",
  "not-reproducible": "This job's runs disagreed, so it has no verdict, no title was minted, and there is nothing to claim.",
  withdrawn: "This job was withdrawn before any verdict, so no title was minted and there is nothing to claim.",
  graded: "This job has been graded and its verdict is being settled. If it passed, its title is minted once that is done.",
};

/** What a claim needs, a title and a repository on GitHub, or why the job has nothing to claim yet. */
function claimable(record: JobRecord | undefined):
  | { readonly ok: true; readonly tokenId: bigint; readonly repository: string }
  | { readonly ok: false; readonly why: string } {
  if (!record) return { ok: false, why: NOTHING_HERE };
  const tokenId = record.chain?.tokenId;
  if (tokenId === undefined) return { ok: false, why: NO_TITLE[record.tile.verdict] };
  if (!record.repository) return { ok: false, why: "This job's title is minted, and its repository is not on GitHub yet. Try again in a while." };
  return { ok: true, tokenId: BigInt(tokenId), repository: record.repository };
}
