/**
 * The contracts a server or a worker is told about, checked against what is on the chain before either
 * answers anybody: settings that cannot work are refused with a sentence, never found at the first job.
 *
 * Before the switch-over the jobs contract is the first one and nothing is prepared. After it, the jobs
 * contract prepares jobs and the old setting names the first one. Either way round, a contract named
 * in the wrong place, or a writer that is the validator, would only show up as reverts or, worse, as
 * the validator's key living on the web server.
 */
import { isAddressEqual, type Address, type PublicClient } from "viem";
import { readValidator } from "./jobs.ts";
import { readWriter } from "./jobsV2.ts";
import { OLD_JOBS_SETTING, WRITER_KEY_SETTING } from "./live.ts";

/** The setting naming the contract new jobs are posted to */
export const JOBS_ADDRESS_SETTING = "POD_JOBS_ADDRESS";

/** The writer a contract takes checks from, or nothing when it is a contract that does not prepare jobs. */
async function writerOf(publicClient: PublicClient, address: Address, setting: string): Promise<Address | undefined> {
  const code = await publicClient.getCode({ address });
  if (!code || code === "0x") throw new Error(`${setting} names ${address}, where there is no contract`);
  // only a contract that prepares jobs has a writer; asked of the first one, the call is refused
  return readWriter({ address, publicClient }).catch(() => undefined);
}

export async function confirmTheContracts(input: {
  readonly publicClient: PublicClient;
  readonly jobs: Address;
  readonly earlier?: Address;
  /** the writer's address, on a server that writes checks */
  readonly writer?: Address;
}): Promise<void> {
  const { publicClient, jobs, earlier, writer } = input;
  if (earlier && isAddressEqual(earlier, jobs)) {
    throw new Error(`${OLD_JOBS_SETTING} and ${JOBS_ADDRESS_SETTING} both name ${jobs}: the old setting is the contract jobs were posted to before this one`);
  }
  const answersTo = await writerOf(publicClient, jobs, JOBS_ADDRESS_SETTING);
  if (!earlier) {
    if (answersTo) throw new Error(`${JOBS_ADDRESS_SETTING} names ${jobs}, which prepares jobs: set ${OLD_JOBS_SETTING} to the contract jobs were posted to before it`);
    return;
  }
  if (!answersTo) throw new Error(`${JOBS_ADDRESS_SETTING} names ${jobs}, which does not prepare jobs; with ${OLD_JOBS_SETTING} set it has to be the contract that replaced ${earlier}`);
  if (await writerOf(publicClient, earlier, OLD_JOBS_SETTING)) {
    throw new Error(`${OLD_JOBS_SETTING} names ${earlier}, which prepares jobs: it has to be the first contract`);
  }
  // the writer's key lives on the web server; the validator's never may
  if (isAddressEqual(answersTo, await readValidator({ address: jobs, publicClient }))) {
    throw new Error(`the contract at ${jobs} takes written checks from its validator: the writer must be a key of its own, so the validator's never lives on the web server`);
  }
  if (writer && !isAddressEqual(answersTo, writer)) {
    throw new Error(`${WRITER_KEY_SETTING} is the key for ${writer}, but the contract at ${jobs} takes written checks only from ${answersTo}`);
  }
}
