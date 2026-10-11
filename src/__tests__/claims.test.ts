import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Claims } from "../claims.ts";
import { netlify, siteMadeFor } from "../hosting/index.ts";
import { claimToSign } from "../messages.ts";
import { claimApiPath, jobPath } from "../routes.ts";
import { NotClaimableSchema } from "../web/claim/state/index.ts";
import type { JobStore } from "../store.ts";
import { podTokenAbi } from "../token.ts";
import { anvilAvailable, startAnvil, type Anvil } from "./support/anvil.ts";
import { COAT_IDEA } from "./support/coat.ts";
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
    const withASite = new Claims({
      store, token: { address: tokenAddress, publicClient: anvil.publicClient },
      siteHost: netlify({ token: "t", clientId: "the-app", clientSecret: "the-secret" }),
    });
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

      // a site taken down is not there to hand over
      await store.save({ ...record, live: { ...live, removedAt: new Date().toISOString() } });
      expect(await (await withGitHubRefusing(() => claim(POSTER))).json()).not.toHaveProperty("site");
    } finally {
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
