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
import { REPOSITORIES_FOLDER, WORKER_FOLDER } from "../folders.ts";
import { live } from "../live.ts";
import { MONAD_REGISTRIES } from "../registry.ts";
import { IMAGE } from "../sandbox.ts";
import { JobStore } from "../store.ts";
import { holdTheLock } from "./lock.ts";
import { Worker } from "./Worker.ts";

const directory = process.env.POD_JOBS;
if (!directory) throw new Error("POD_JOBS has to name the folder the server serves jobs from");
const key = process.env.POD_VALIDATOR_KEY;
if (!key || !isHex(key)) throw new Error("POD_VALIDATOR_KEY is not set. It is the key verdicts are signed and settled with");
// live() checks the key against the validator the contracts were deployed with, and says so if not
const contracts = live();

const worker = new Worker({
  store: new JobStore(directory),
  repositories: join(directory, REPOSITORIES_FOLDER),
  jobs: contracts.jobs,
  token: contracts.token,
  runnerKey: key,
  image: IMAGE,
  ...(process.env.POD_SITE ? { site: process.env.POD_SITE } : {}),
  registry: { registries: MONAD_REGISTRIES, stateFolder: join(directory, WORKER_FOLDER) },
});

const lock = await holdTheLock(join(directory, WORKER_FOLDER));
const stop = new AbortController();
process.once("SIGINT", () => stop.abort());
process.once("SIGTERM", () => stop.abort());
console.log(`the worker is watching ${contracts.jobs.address}, grading as ${contracts.validator}`);
try {
  await worker.run(stop.signal);
} finally {
  await lock.release();
}
