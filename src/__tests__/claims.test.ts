import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Claims } from "../claims.ts";
import { claimToSign } from "../messages.ts";
import { claimApiPath } from "../routes.ts";
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
  }, 60_000);
});
