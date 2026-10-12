import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Claims, INVITATION_LASTS_MS, isInvitationOpen, isSiteOfferOpen, noticeHandover } from "../claims.ts";
import { credentialAvailable } from "../github.ts";
import { netlify, siteMadeFor } from "../hosting/index.ts";
import { claimToSign } from "../messages.ts";
import { claimApiPath, jobPath } from "../routes.ts";
import { NotClaimableSchema } from "../web/claim/state/index.ts";
import type { JobStore } from "../store.ts";
import { podTokenAbi } from "../token.ts";
import { anvilAvailable, startAnvil, type Anvil } from "./support/anvil.ts";
import { COAT_IDEA } from "./support/coat.ts";
import { netlifySaying } from "./support/netlify.ts";
import { anAgent } from "./support/podServer.ts";
import { aTitledJob, POSTER } from "./support/titled.ts";

/**
 * The holder of a POD claims its repository (11E), against a real title on a local chain.
 *
 * Only the wallet that holds the title now may claim, so a title that was sold carries the claim with
 * it. A good claim is sent on to GitHub, and here GitHub refuses it, because this test has no right to
 * move anybody's repository: what is shown is that a claim reaches GitHub only when it is the holder's,
 * and that GitHub's refusal is said as it is, with nothing recorded as sent.
 */

const available = await anvilAvailable();
/** asking GitHub where a repository lives takes a credential GitHub knows */
const canAskGitHub = available && (await credentialAvailable());

/** A repository POD published and really handed to its title's holder, on 12 October 2026: job 21 on Monad testnet */
const MOVED = { from: "https://github.com/proof-of-development/pod-a-page-of-pokemon-cards-each-1", to: "https://github.com/nel349/pod-a-page-of-pokemon-cards-each-1", account: "nel349" };

const JOB = "a-coat-to-claim";
const COMMIT = "c0".repeat(20);
const REPOSITORY = "https://github.com/pod-an-owner-nobody-has/pod-a-coat-to-claim";

let anvil: Anvil;
let store: JobStore;
let claims: Claims;
let tokenAddress: Address;
let tokenId = 0n;

beforeAll(async () => {
  if (!available) return;
  anvil = await startAnvil();
  const titled = await aTitledJob(anvil, { jobId: JOB, commit: COMMIT, repository: REPOSITORY });
  ({ store, tokenId } = titled);
  tokenAddress = titled.token;
  claims = new Claims({ store, token: { address: tokenAddress, publicClient: anvil.publicClient } });
}, 120_000);

afterAll(() => anvil?.stop());

async function claimAs(key: Hex, toAccount: string, jobId = JOB): Promise<Response> {
  const signature = await privateKeyToAccount(key).signMessage({ message: claimToSign({ jobId, tokenId, toAccount }) });
  return claims.handle(new Request(`http://pod.test${claimApiPath(jobId)}`, { method: "POST", body: JSON.stringify({ toAccount, signature }) }));
}

const whyOf = async (answer: Response): Promise<string> => ((await answer.json()) as { why: string }).why;

/** GitHub refuses the move without a credential it knows, which is all this test may do to GitHub */
async function withGitHubRefusing<T>(run: () => Promise<T>): Promise<T> {
  const was = process.env.POD_GITHUB_TOKEN;
  process.env.POD_GITHUB_TOKEN = "not-a-token-github-knows";
  try {
    return await run();
  } finally {
    if (was === undefined) delete process.env.POD_GITHUB_TOKEN;
    else process.env.POD_GITHUB_TOKEN = was;
  }
}

describe.skipIf(!available)("a repository that has been handed over", () => {
  const HANDED = "a-coat-handed";
  const invited = { account: "octocat", by: privateKeyToAccount(POSTER).address, at: new Date().toISOString() };

  test("an invitation is open for a day, and never once the repository has moved", async () => {
    const titled = await store.read(JOB);
    if (!titled) throw new Error("the titled job is not kept");
    const sent = Date.parse(invited.at);
    expect(isInvitationOpen(titled)).toBe(false);
    expect(isInvitationOpen({ ...titled, invited }, sent + INVITATION_LASTS_MS)).toBe(true);
    expect(isInvitationOpen({ ...titled, invited }, sent + INVITATION_LASTS_MS + 1)).toBe(false);
    expect(isInvitationOpen({ ...titled, invited, handed: { account: "octocat", at: invited.at } }, sent)).toBe(false);
  }, 60_000);

  test("it says who has it and where it lives, and a claim after that is answered without asking GitHub", async () => {
    const titled = await store.read(JOB);
    if (!titled) throw new Error("the titled job is not kept");
    const handed = { account: "octocat", at: new Date().toISOString() };
    await store.save({ ...titled, jobId: HANDED, tile: { ...titled.tile, jobId: HANDED }, repository: "https://github.com/octocat/pod-a-coat-to-claim", invited, handed });

    const read = await claims.handle(new Request(`http://pod.test${claimApiPath(HANDED)}`));
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ repository: "https://github.com/octocat/pod-a-coat-to-claim", invited, handed });

    // GitHub would refuse, and is never asked: the code is already where it is going
    const again = await withGitHubRefusing(() => claimAs(POSTER, "octocat", HANDED));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ handed });
    expect((await claimAs(anAgent().key, "octocat", HANDED)).status).toBe(403);
  }, 60_000);

  test.skipIf(!canAskGitHub)("GitHub is asked where an invited repository lives: one that moved is written down as handed, one that did not is left", async () => {
    const titled = await store.read(JOB);
    if (!titled) throw new Error("the titled job is not kept");
    const moved = "a-coat-that-moved";
    await store.save({ ...titled, jobId: moved, tile: { ...titled.tile, jobId: moved }, repository: MOVED.from, invited });
    const read = await claims.handle(new Request(`http://pod.test${claimApiPath(moved)}`));
    const said = (await read.json()) as { repository: string; handed?: { account: string } };
    expect(said.repository).toBe(MOVED.to);
    expect(said.handed?.account).toBe(MOVED.account);
    expect((await store.read(moved))?.repository).toBe(MOVED.to);

    const stayed = "a-coat-that-stayed";
    const kept = { ...titled, jobId: stayed, tile: { ...titled.tile, jobId: stayed }, repository: MOVED.to, invited };
    await store.save(kept);
    expect((await noticeHandover(store, kept)).handed).toBeUndefined();
    expect((await store.read(stayed))?.handed).toBeUndefined();
  }, 60_000);
});

describe.skipIf(!available)("claiming a POD's repository", () => {
  test("what there is to claim: the title, who holds it now, and the repository", async () => {
    const answer = await claims.handle(new Request(`http://pod.test${claimApiPath(JOB)}`));
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({
      jobId: JOB, idea: COAT_IDEA, tokenId: tokenId.toString(), repository: REPOSITORY,
      holder: privateKeyToAccount(POSTER).address,
    });
  }, 60_000);

  test("anybody but the holder is refused before GitHub is asked", async () => {
    const answer = await claimAs(anAgent().key, "octocat");
    expect(answer.status).toBe(403);
    expect(await whyOf(answer)).toContain("not the holder's");
  }, 60_000);

  test("the holder's claim is sent on to GitHub, and GitHub's refusal is said, with nothing recorded as sent", async () => {
    const answer = await withGitHubRefusing(() => claimAs(POSTER, "octocat"));
    expect(answer.status).toBe(502);
    expect(await whyOf(answer)).toContain("GitHub would not send the invitation");
    expect((await store.read(JOB))?.invited).toBeUndefined();
  }, 60_000);

  test("a live website goes with the title: the holder is given the link that takes it, GitHub or no GitHub, and nobody else is", async () => {
    const record = await store.read(JOB);
    if (!record) throw new Error("the titled job is not on the wall");
    const live = { host: "Netlify", siteId: "site-1", url: "https://pod-a-coat-to-claim.netlify.app", at: new Date().toISOString() };
    await store.save({ ...record, live });
    // the host answers that its own account holds the site, until the last part of this test
    const host = netlifySaying();
    const taken = netlifySaying({ takenBy: { [live.siteId]: "its-holders-own-team" } });
    const hostedAt = (endpoint: string): Claims => new Claims({
      store, token: { address: tokenAddress, publicClient: anvil.publicClient },
      siteHost: netlify({ token: "t", clientId: "the-app", clientSecret: "the-secret", endpoint }),
    });
    const withASite = hostedAt(host.endpoint);
    const claim = async (key: Hex): Promise<Response> => {
      const signature = await privateKeyToAccount(key).signMessage({ message: claimToSign({ jobId: JOB, tokenId, toAccount: "octocat" }) });
      return withASite.handle(new Request(`http://pod.test${claimApiPath(JOB)}`, { method: "POST", body: JSON.stringify({ toAccount: "octocat", signature }) }));
    };
    try {
      // what there is to claim says where it is live, to everybody
      const claimable = await (await withASite.handle(new Request(`http://pod.test${claimApiPath(JOB)}`))).json() as { live?: string };
      expect(claimable.live).toBe(live.url);

      // a stranger's signature gets no link
      const stranger = await claim(anAgent().key);
      expect(stranger.status).toBe(403);
      expect(await stranger.json()).not.toHaveProperty("site");

      // the holder's does, though GitHub refuses the repository here: the site is theirs on their signature
      const held = await withGitHubRefusing(() => claim(POSTER));
      expect(held.status).toBe(502);
      const answer = await held.json() as { why: string; site?: { host: string; takeIt: string } };
      expect(answer.site?.host).toBe("Netlify");
      expect(answer.site?.takeIt).toBe(await netlify({ token: "t", clientId: "the-app", clientSecret: "the-secret" }).handoverLink(siteMadeFor(record)));
      expect(held.headers.get("cache-control")).toContain("no-store");

      // the link having been given is written down, which is what has the worker ask the host after it for a day
      const offered = await store.read(JOB);
      expect(offered?.live?.offeredAt).toBeDefined();
      expect(offered && isSiteOfferOpen(offered)).toBe(true);
      expect(offered?.live?.takenAt).toBeUndefined();

      // once the holder has taken the site into their own account, the host says so: it is written down,
      // said to whoever asks what there is to claim, and no link is given again
      const afterTaking = hostedAt(taken.endpoint);
      const said = await (await afterTaking.handle(new Request(`http://pod.test${claimApiPath(JOB)}`))).json() as { live?: string; isSiteTaken?: boolean };
      expect(said).toMatchObject({ live: live.url, isSiteTaken: true });
      const kept = await store.read(JOB);
      expect(kept?.live?.takenAt).toBeDefined();
      expect(kept && isSiteOfferOpen(kept)).toBe(false);
      const signature = await privateKeyToAccount(POSTER).signMessage({ message: claimToSign({ jobId: JOB, tokenId, toAccount: "octocat" }) });
      const again = await withGitHubRefusing(() => afterTaking.handle(new Request(`http://pod.test${claimApiPath(JOB)}`, { method: "POST", body: JSON.stringify({ toAccount: "octocat", signature }) })));
      expect(await again.json()).not.toHaveProperty("site");

      // a site taken down is not there to hand over
      await store.save({ ...record, live: { ...live, removedAt: new Date().toISOString() } });
      expect(await (await withGitHubRefusing(() => claim(POSTER))).json()).not.toHaveProperty("site");
    } finally {
      host.stop();
      taken.stop();
      await store.save(record);
    }
  });

  test("a title that was sold carries the claim: the old holder is refused, the new one reaches GitHub", async () => {
    const buyer = anAgent();
    await anvil.fund(buyer.address);
    const seller = anvil.wallet(POSTER);
    const poster = privateKeyToAccount(POSTER);
    await anvil.publicClient.waitForTransactionReceipt({
      hash: await seller.writeContract({ address: tokenAddress, abi: podTokenAbi, functionName: "transferFrom", args: [poster.address, buyer.address, tokenId], account: poster, chain: seller.chain }),
    });
    expect((await claimAs(POSTER, "octocat")).status).toBe(403);
    expect((await withGitHubRefusing(() => claimAs(buyer.key, "octocat"))).status).toBe(502);
  }, 60_000);

  test("a name GitHub would not allow is refused, and so is a job with nothing to claim", async () => {
    expect((await claimAs(POSTER, "not a name")).status).toBe(400);
    expect((await claimAs(POSTER, "-dash-first")).status).toBe(400);
    const nothing = await claims.handle(new Request(`http://pod.test${claimApiPath("no-such-job")}`));
    expect(nothing.status).toBe(404);
    expect(await nothing.json()).toEqual({ why: "There is no job at that address." });
  }, 60_000);

  test("a job with no title yet says why, in terms of where it stands, and names its page", async () => {
    const titled = await store.read(JOB);
    if (!titled) throw new Error("the titled job is not kept");
    // the same job with nothing on the chain yet, so no title
    const untitled = { ...titled, chain: undefined };
    for (const [verdict, words] of [["running", "still open"], ["failed", "checks failed"], ["withdrawn", "withdrawn before any verdict"]] as const) {
      await store.save({ ...untitled, jobId: `a-coat-${verdict}`, tile: { ...titled.tile, jobId: `a-coat-${verdict}`, verdict } });
      const answer = await claims.handle(new Request(`http://pod.test${claimApiPath(`a-coat-${verdict}`)}`));
      expect(answer.status).toBe(404);
      const said = NotClaimableSchema.parse(await answer.json());
      expect(said.why).toContain(words);
      expect(said.job).toBe(jobPath(`a-coat-${verdict}`));
    }
  }, 60_000);
});
