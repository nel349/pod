import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { Claims } from "../claims.ts";
import { credentialAvailable, GITHUB_OWNER_SETTING, hasCommit, publishJob } from "../github.ts";
import { claimToSign } from "../messages.ts";
import { BRANCH, commitWork, openRepository } from "../repo.ts";
import { claimApiPath } from "../routes.ts";
import { anvilAvailable, startAnvil, type Anvil } from "./support/anvil.ts";
import { COAT_IDEA, WORKING } from "./support/coat.ts";
import { aTitledJob, POSTER } from "./support/titled.ts";

/**
 * The handover for real, once, when somebody asks for it: a job published on GitHub under the owner
 * the server names, claimed by the title's holder, and handed to the account given (11E).
 *
 * It makes a public repository and sends an invitation, so it runs only when a person names who
 * receives it, in POD_GITHUB_LIVE_TO, and never on CI. Everything short of GitHub saying yes is in
 * claims.test.ts and worker.test.ts, which run everywhere.
 */

const TO = "POD_GITHUB_LIVE_TO";
const owner = process.env[GITHUB_OWNER_SETTING];
const receiver = process.env[TO];
const asked = owner !== undefined && receiver !== undefined && process.env.CI !== "true";
const available = asked && (await credentialAvailable()) && (await anvilAvailable());
if (!asked) console.log(`  (the handover on GitHub runs only when ${GITHUB_OWNER_SETTING} and ${TO} are set, off CI)`);

let anvil: Anvil | undefined;
afterAll(() => anvil?.stop());

describe.skipIf(!available)("a POD's repository, handed over on GitHub", () => {
  test("published under the server's owner, claimed by the title's holder, and on its way to the account named", async () => {
    if (!owner || !receiver) throw new Error("nothing to hand over to");
    const jobId = `a-coat-handed-over-${Date.now().toString(36)}`;

    // the pod's work, as the worker leaves it: on main, beside a seat's branch
    const repo = await openRepository(await mkdtemp(join(tmpdir(), "pod-live-handover-")), jobId);
    const workspace = await mkdtemp(join(tmpdir(), "pod-live-work-"));
    await writeFile(join(workspace, "server.js"), `${WORKING}\n`);
    const commit = await commitWork(repo, { workspace, message: "the work", agent: "builder", email: "builder@agents.pod.invalid" });
    const seatBranch = Bun.spawn(["git", `--git-dir=${repo.path}`, "update-ref", "refs/heads/builder/0x2222222222222222222222222222222222222222", commit]);
    expect(await seatBranch.exited).toBe(0);

    const published = await publishJob(repo, owner, jobId, COAT_IDEA, BRANCH);
    console.log(`  published at ${published.url}`);
    expect(await hasCommit(published, commit)).toBe(true);

    anvil = await startAnvil();
    const titled = await aTitledJob(anvil, { jobId, commit, repository: published.url });
    const claims = new Claims({ store: titled.store, token: { address: titled.token, publicClient: anvil.publicClient } });
    const signature = await privateKeyToAccount(POSTER).signMessage({ message: claimToSign({ jobId, tokenId: titled.tokenId, toAccount: receiver }) });
    const answer = await claims.handle(new Request(`http://pod.test${claimApiPath(jobId)}`, {
      method: "POST", body: JSON.stringify({ toAccount: receiver, signature }),
    }));
    const said = await answer.json();
    console.log(`  the claim was answered ${answer.status}: ${JSON.stringify(said)}`);
    expect(answer.status).toBe(201);
    expect((await titled.store.read(jobId))?.invited?.account).toBe(receiver);
  }, 240_000);
});
