/**
 * The worker, as a process of its own beside the server:
 *
 *   POD_JOBS=… bun run src/worker/main.ts
 *
 * It reads the same jobs folder the server serves, and the deployment and the validator's key from
 * the environment, the way everything that writes to the chain does (see live.ts). POD_SITE is where
 * the wall is served, so a title minted here points at its job's page. Stopping it lets grading under
 * way finish; whatever it had not done yet, the next start does.
 */
import { join } from "node:path";
import { isHex } from "viem";
import { BoxSlots } from "../docker/index.ts";
import { BOX_SLOTS_FOLDER, JOBS_FOLDER_SETTING, PREPARING_FOLDER, REPOSITORIES_FOLDER, WORKER_FOLDER } from "../folders.ts";
import { GITHUB_OWNER_SETTING } from "../github.ts";
import { confirmTheContracts } from "../contracts.ts";
import { live } from "../live.ts";
import { PreparingStore } from "../preparing/index.ts";
import { MONAD_REGISTRIES } from "../registry.ts";
import { IMAGE } from "../sandbox.ts";
import { JobStore } from "../store.ts";
import { holdTheLock } from "./lock.ts";
import { Worker } from "./Worker.ts";

const directory = process.env[JOBS_FOLDER_SETTING];
if (!directory) throw new Error(`${JOBS_FOLDER_SETTING} has to name the folder the server serves jobs from`);
const key = process.env.POD_VALIDATOR_KEY;
if (!key || !isHex(key)) throw new Error("POD_VALIDATOR_KEY is not set. It is the key verdicts are signed and settled with");
// live() checks the key against the validator the contracts were deployed with, and says so if not
const contracts = live();
// a contract named in the wrong place is found now, not at its first job
await confirmTheContracts({
  publicClient: contracts.publicClient, jobs: contracts.jobs.address,
  ...(contracts.earlier ? { earlier: contracts.earlier.address } : {}),
});
const publishTo = process.env[GITHUB_OWNER_SETTING];

const worker = new Worker({
  store: new JobStore(directory),
  repositories: join(directory, REPOSITORIES_FOLDER),
  // after the switch-over the contract new jobs go to prepares them, and the first one is graded still
  ...(contracts.earlier
    ? { jobs: contracts.earlier, prepared: contracts.jobs, preparing: new PreparingStore(join(directory, PREPARING_FOLDER)) }
    : { jobs: contracts.jobs }),
  boxes: new BoxSlots(join(directory, BOX_SLOTS_FOLDER)),
  token: contracts.token,
  runnerKey: key,
  image: IMAGE,
  ...(process.env.POD_SITE ? { site: process.env.POD_SITE } : {}),
  registry: { registries: MONAD_REGISTRIES, stateFolder: join(directory, WORKER_FOLDER) },
  ...(publishTo ? { publishTo: { owner: publishTo } } : {}),
});

const lock = await holdTheLock(join(directory, WORKER_FOLDER));
const stop = new AbortController();
process.once("SIGINT", () => stop.abort());
process.once("SIGTERM", () => stop.abort());
console.log(contracts.earlier
  ? `the worker is watching ${contracts.jobs.address}, which prepares jobs, and ${contracts.earlier.address}, grading as ${contracts.validator}`
  : `the worker is watching ${contracts.jobs.address}, grading as ${contracts.validator}`);
console.log(publishTo
  ? `work that passes is published on GitHub under ${publishTo}`
  : `work that passes stays on this server: ${GITHUB_OWNER_SETTING} names no GitHub account to publish it under`);
try {
  await worker.run(stop.signal);
} finally {
  await lock.release();
}
