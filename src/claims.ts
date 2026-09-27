/**
 * Where the holder of a POD claims the repository it is title to.
 *
 *   GET  /api/claim/<jobId>    what there is to claim: the title's number, who holds it, the repository
 *   POST /api/claim/<jobId>    { toAccount, signature }: the holder's signature over `claimToSign`
 *
 * The chain says who holds the title now, not who paid, so a POD that was sold carries its
 * repository. What the holder gets is an invitation: GitHub hands a repository to a person only once
 * they accept, within a day, so the answer says an invitation was sent and never that it is done.
 */
import { isHex, type Address } from "viem";
import { z } from "zod";
import { bodyWithin, tooLarge } from "./body.ts";
import { firstLine } from "./errors.ts";
import { transferRepository, type Published } from "./github.ts";
import { checkClaim, holderOf } from "./handover.ts";
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
  /** the last invitation sent, if one was */
  readonly invited?: Invitation;
}

export interface Invitation {
  readonly account: string;
  readonly by: Address;
  /** when it was sent, as an ISO date */
  readonly at: string;
}

export class Claims {
  constructor(private readonly options: { readonly store: JobStore; readonly token: Omit<Contract, "wallet"> }) {}

  async handle(request: Request): Promise<Response> {
    const jobId = new URL(request.url).pathname.slice(ROUTES.claimApi.length);
    if (!isWallName(jobId)) return Response.json({ why: NOTHING_HERE }, { status: 404 });
    const record = await this.options.store.read(jobId);
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
        ...(record.invited ? { invited: record.invited } : {}),
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
    try {
      await transferRepository(publishedAt(repository), parsed.data.toAccount);
    } catch (error) {
      return Response.json({ why: `GitHub would not send the invitation: ${firstLine(error)}` }, { status: 502 });
    }
    const invited: Invitation = { account: parsed.data.toAccount, by: checked.holder, at: new Date().toISOString() };
    const fresh = await this.options.store.read(jobId);
    if (fresh) await this.options.store.save({ ...fresh, invited });
    return Response.json({ invited }, { status: 201 });
  }
}

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

/** A repository's owner and name, from its address on GitHub. */
function publishedAt(repository: string): Published {
  const [owner = "", name = ""] = new URL(repository).pathname.split("/").filter(Boolean);
  return { owner, name, url: repository, cloneUrl: `${repository}.git` };
}
