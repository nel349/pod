/**
 * Post a job the way the posting page does, from a terminal, against a running server whose contract
 * prepares jobs.
 *
 * The same steps and the same code as the page: pay the job's price and its first writings from the
 * poster's key, sign that it is theirs and send the lines to be written, follow the writing, and
 * approve the set only if its seal is the seal of what was written, worked out here as the page works
 * it out (F10). The worker then puts it on the wall. Nothing here is a side door: the server writes
 * checks only for a job paid for, and the contract opens it only on a seal the writer signed. For a
 * dry run before a person posts from the page, and for anybody without a browser wallet.
 *
 *   bun run scripts/post-a-job.ts --server http://localhost:3000 --name a-coat-dry-run
 *
 * The poster's key is POD_DEPLOYER_KEY. It prints each step, and the job's page at the end.
 */
import { parseArgs } from "node:util";
import { createPublicClient, createWalletClient, http, isHex, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { WriteRequestSchema } from "../src/checkwriting/request.ts";
import { DEFAULT_MODE, MODES } from "../src/job.ts";
import { podJobsV2Abi } from "../src/jobsV2.ts";
import { monadTestnet } from "../src/live.ts";
import { MarketConfigSchema } from "../src/market.ts";
import { preparingMessage, setUpMessage } from "../src/messages.ts";
import { PreparingOnTheWireSchema, preparingFromTheWire, type PreparingView } from "../src/preparing/records.ts";
import { jobPath, preparingPath, ROUTES } from "../src/routes.ts";
import {
  freshSalt, isWritingAsked, latestWriting, PostFormSchema, priceInWei, sealToApprove, toWriteRequest, whatIsPaid, whyNotApprove,
  type PostForm,
} from "../src/web/post/state/index.ts";

/** how many reviewer seats a job opens with: the page's own number */
const REVIEWER_SEATS = 1;
const ASK_EVERY_MS = 3_000;
const GIVE_UP_AFTER_MS = 15 * 60_000;
/** how long the poster's note lets this script read the job: the most the server takes */
const NOTE_SECONDS = 3600;

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
if (!market.writing) throw new Error("the server's contract does not prepare jobs, so posting is the old way round there");
const request = WriteRequestSchema.parse(toWriteRequest(form));
const price = priceInWei(form.price);
if (price === undefined) throw new Error("the price is more than nothing");

// 1. paid for on the chain, from the poster's key: the job's price and its first writings
const poster = privateKeyToAccount(key);
const publicClient = createPublicClient({ chain: monadTestnet, transport: http(market.rpc) });
const wallet = createWalletClient({ account: poster, chain: monadTestnet, transport: http(market.rpc) });
const paid = whatIsPaid(price, market.writing);
const hash = await wallet.writeContract({
  address: market.jobs, abi: podJobsV2Abi, functionName: "post",
  args: [BigInt(MODES[form.mode].windowMinutes * 60), REVIEWER_SEATS], value: paid.total,
});
const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") throw new Error(`the chain refused the payment: ${hash}`);
const [created] = parseEventLogs({ abi: podJobsV2Abi, eventName: "Created", logs: receipt.logs });
if (!created) throw new Error("the payment went through but the contract did not say which job it made");
const onChainId = created.args.jobId.toString();
say(`paid ${paid.total} wei: job ${onChainId} on the contract, in ${hash}`);

// 2. set up: signed as the poster's, and the lines sent to be written
const salt = freshSalt();
const setUpSignature = await poster.signMessage({ message: setUpMessage({ jobs: market.jobs, onChainId, name: form.name, mode: form.mode, salt }) });
const setUp = await fetch(new URL(ROUTES.preparing, server), {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ onChainId, name: form.name, mode: form.mode, salt, request, poster: poster.address, signature: setUpSignature }),
});
if (!setUp.ok) throw new Error(`the server would not set it up: ${((await setUp.json()) as { why?: string }).why ?? setUp.status}`);
say("set up; the checks are being written and tried, which takes minutes");

// 3. followed, on a note the poster signs, until a writing has finished
const until = Math.floor(Date.now() / 1000) + NOTE_SECONDS;
const note = await poster.signMessage({ message: preparingMessage({ jobs: market.jobs, onChainId, until }) });
const authorization = `Basic ${btoa(`${poster.address}:${until}.${note}`)}`;
const deadline = Date.now() + GIVE_UP_AFTER_MS;
let view: PreparingView | undefined;
while (!view || isWritingAsked(view) || view.writings.length === 0) {
  if (Date.now() > deadline) throw new Error("the checks took longer than fifteen minutes");
  await Bun.sleep(ASK_EVERY_MS);
  const answer = await fetch(new URL(preparingPath(onChainId), server), { cache: "no-store", headers: { authorization } });
  if (!answer.ok) throw new Error(`the server would not show the job: ${((await answer.json()) as { why?: string }).why ?? answer.status}`);
  view = preparingFromTheWire(PreparingOnTheWireSchema.parse(await answer.json()));
}
const writing = latestWriting(view);
const whyNot = whyNotApprove(writing, request);
if (!writing || whyNot) throw new Error(`the checks cannot be approved: ${whyNot ?? "nothing was written"}. Take the money back from /post/${onChainId}`);

// 4. approved, on the seal worked out here from what was written, as the page does
const job = await publicClient.readContract({ address: market.jobs, abi: podJobsV2Abi, functionName: "jobs", args: [BigInt(onChainId)] });
const toApprove = await sealToApprove({ writing, view, price: job[1] });
if (!toApprove.ok) throw new Error(toApprove.why);
const approved = await wallet.writeContract({
  address: market.jobs, abi: podJobsV2Abi, functionName: "approveChecks", args: [BigInt(onChainId), toApprove.seal, toApprove.approval.signature],
});
if ((await publicClient.waitForTransactionReceipt({ hash: approved })).status !== "success") throw new Error(`the chain refused the approval: ${approved}`);
say(`approved in ${approved}; the worker puts it on the wall`);

// 5. on the wall, once the worker has seen the approval
const onTheWall = new URL(jobPath(form.name), server);
for (let i = 0; i < 40; i++) {
  if ((await fetch(onTheWall)).ok) break;
  await Bun.sleep(ASK_EVERY_MS);
}
say(`its page: ${onTheWall.toString()}`);
