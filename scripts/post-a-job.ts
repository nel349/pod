/**
 * Post a job the way the posting page does, from a terminal, against a running server.
 *
 * The same steps and the same code as the page: the server writes the checks and proves them, the
 * job is sealed from the form and those checks, paid for on the chain from the poster's key, signed
 * and published. Nothing here is a side door: a server refuses a posting whose checks it never proved,
 * whoever sends it. For a dry run before a person posts from the page, and for anybody without a
 * browser wallet.
 *
 *   bun run scripts/post-a-job.ts --server http://localhost:3000 --name a-coat-dry-run
 *
 * The poster's key is POD_DEPLOYER_KEY. It prints each step, and the job's page at the end.
 */
import { parseArgs } from "node:util";
import { createPublicClient, createWalletClient, http, isHex, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { WriteRequestSchema } from "../src/checkwriting/request.ts";
import { isStillWriting, WritingSchema, type Written } from "../src/checkwriting/written.ts";
import { DEFAULT_MODE, MODES } from "../src/job.ts";
import { podJobsAbi } from "../src/jobs.ts";
import { monadTestnet } from "../src/live.ts";
import { MarketConfigSchema } from "../src/market.ts";
import { postingMessage } from "../src/messages.ts";
import { ROUTES } from "../src/routes.ts";
import { freshSalt, PostFormSchema, sealJob, toWriteRequest, type PostForm } from "../src/web/post/state/index.ts";

/** how many reviewer seats a job opens with: the page's own number */
const REVIEWER_SEATS = 1;
const ASK_EVERY_MS = 3_000;
const GIVE_UP_AFTER_MS = 15 * 60_000;

const { values } = parseArgs({
  options: {
    server: { type: "string", default: "http://localhost:3000" },
    name: { type: "string" },
    price: { type: "string", default: "0.1" },
  },
});
if (!values.name) throw new Error("--name <job> names the job on the wall");
const key = process.env.POD_DEPLOYER_KEY;
if (!key || !isHex(key)) throw new Error("POD_DEPLOYER_KEY is not set. It is the poster's key");
const server = values.server;
const say = (what: string): void => console.log(`[post] ${what}`);

const form: PostForm = PostFormSchema.parse({
  idea: "A service that tells me whether to take a coat, given whether it is raining",
  kind: "service",
  brief: [{ says: "When it is raining, it tells me to take a coat" }],
  exam: [{ says: "When it is dry, it tells me I do not need one" }],
  price: values.price, mode: DEFAULT_MODE, name: values.name,
});

const market = MarketConfigSchema.parse(await (await fetch(new URL(ROUTES.market, server))).json());
if (market.chainId !== monadTestnet.id) throw new Error(`the server answers to chain ${market.chainId}, not Monad testnet`);

// 1. the checks, written and proven by the server, as the page asks for them
const request = WriteRequestSchema.parse(toWriteRequest(form));
const started = await fetch(new URL(ROUTES.writeChecks, server), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
const { url, why } = (await started.json()) as { url?: string; why?: string };
if (!started.ok || !url) throw new Error(`the server would not write the checks: ${why ?? started.status}`);
say("the checks are being written and tried; this takes minutes");
const deadline = Date.now() + GIVE_UP_AFTER_MS;
let checks: readonly Written[] | undefined;
while (!checks) {
  if (Date.now() > deadline) throw new Error("the checks took longer than fifteen minutes");
  await Bun.sleep(ASK_EVERY_MS);
  const writing = WritingSchema.parse(await (await fetch(new URL(url, server), { cache: "no-store" })).json());
  if (writing.stage === "failed") throw new Error(`writing the checks failed: ${writing.why}`);
  if (isStillWriting(writing)) continue;
  if (!writing.ready) throw new Error(`the checks were written but did not all prove themselves: ${JSON.stringify(writing.checks.map((check) => check.says))}`);
  checks = writing.checks;
}
say(`${checks.length} checks written and proven`);

// 2. sealed from the form and those checks, exactly as the page seals them
const sealed = await sealJob(form, checks, freshSalt());
say(`sealed as ${sealed.seal}`);

// 3. paid for on the chain, from the poster's key
const poster = privateKeyToAccount(key);
const publicClient = createPublicClient({ chain: monadTestnet, transport: http(market.rpc) });
const wallet = createWalletClient({ account: poster, chain: monadTestnet, transport: http(market.rpc) });
const now = (await publicClient.getBlock()).timestamp;
const endsAt = now + BigInt(MODES[sealed.spec.mode].windowMinutes * 60);
const hash = await wallet.writeContract({
  address: market.jobs, abi: podJobsAbi, functionName: "post", args: [sealed.seal, endsAt, REVIEWER_SEATS], value: sealed.spec.price,
});
const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") throw new Error(`the chain refused the payment: ${hash}`);
const [posted] = parseEventLogs({ abi: podJobsAbi, eventName: "Posted", logs: receipt.logs });
if (!posted) throw new Error("the payment went through but the contract did not say which job it made");
const onChainId = posted.args.jobId.toString();
say(`paid: job ${onChainId} on the contract, in ${hash}, open until ${new Date(Number(endsAt) * 1000).toISOString()}`);

// 4. signed and published
const signature = await poster.signMessage({ message: postingMessage({ jobId: form.name, onChainId, jobs: market.jobs, seal: sealed.seal }) });
const published = await fetch(new URL(ROUTES.postJob, server), {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ jobId: form.name, onChainId, poster: poster.address, signature, files: sealed.files, spec: { ...sealed.spec, price: sealed.spec.price.toString() } }),
});
const answer = (await published.json()) as { url?: string; why?: string };
if (!published.ok || !answer.url) throw new Error(`the server would not publish it: ${answer.why ?? published.status}`);
say(`published at ${new URL(answer.url, server).toString()}`);
