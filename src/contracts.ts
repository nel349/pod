/**
 * The contracts a server or a worker is told about, checked against what is on the chain before either
 * answers anybody: settings that cannot work are refused with a sentence, never found at the first job.
 *
 * Before the switch-over the jobs contract is the first one and nothing is prepared. After it, the jobs
 * contract prepares jobs and the old setting names the first one. Once the contract on which the
 * poster has the last word replaces the one that settled on the verdict alone, that one is named as
 * the second. Once the contract on which the lead names who is paid replaces that one in turn, it is
 * named as the third. Whichever way round, a contract named in the wrong place, or a writer that is the
 * validator, would only show up as reverts or, worse, as the validator's key living on the web server.
 */
import { isAddressEqual, type Address, type PublicClient } from "viem";
import { readValidator } from "./jobs.ts";
import { readWriter } from "./jobsV2.ts";
import { hasTheLastWord } from "./jobsV3.ts";
import { doesTheLeadNameWhoIsPaid } from "./jobsV4.ts";
import { OLD_JOBS_SETTING, SECOND_JOBS_SETTING, THIRD_JOBS_SETTING, WRITER_KEY_SETTING } from "./live.ts";

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
  /** the contract that prepared jobs before `jobs`, when `jobs` is the one on which the poster has the last word */
  readonly second?: Address;
  /** the contract on which the poster had the last word before `jobs`, when `jobs` is the one on which the lead names who is paid */
  readonly third?: Address;
  /** the writer's address, on a server that writes checks */
  readonly writer?: Address;
}): Promise<void> {
  const { publicClient, jobs, earlier, second, third, writer } = input;
  if (third && !second) {
    throw new Error(`${THIRD_JOBS_SETTING} is set and ${SECOND_JOBS_SETTING} is not: the third contract came after the second, which has to be named too`);
  }
  if (second && !earlier) {
    throw new Error(`${SECOND_JOBS_SETTING} is set and ${OLD_JOBS_SETTING} is not: the second contract came after the first, which has to be named too`);
  }
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
  if (!second) return;
  if (isAddressEqual(second, jobs) || (earlier && isAddressEqual(second, earlier))) {
    throw new Error(`${SECOND_JOBS_SETTING} names ${second}, which another setting names too: it is the contract that prepared jobs between the first and the one they are posted to now`);
  }
  if (!(await writerOf(publicClient, second, SECOND_JOBS_SETTING))) {
    throw new Error(`${SECOND_JOBS_SETTING} names ${second}, which does not prepare jobs: it has to be the contract that did before ${jobs}`);
  }
  const at = (address: Address): { readonly address: Address; readonly publicClient: PublicClient } => ({ address, publicClient });
  if (await hasTheLastWord(at(second))) {
    throw new Error(`${SECOND_JOBS_SETTING} names ${second}, on which the poster has the last word: it has to be the contract that settled on the verdict alone`);
  }
  if (!(await hasTheLastWord(at(jobs)))) {
    throw new Error(`${JOBS_ADDRESS_SETTING} names ${jobs}, which settles on the verdict alone; with ${SECOND_JOBS_SETTING} set it has to be the contract that replaced ${second}`);
  }
  if (!third) {
    if (await doesTheLeadNameWhoIsPaid(at(jobs))) {
      throw new Error(`${JOBS_ADDRESS_SETTING} names ${jobs}, on which the lead names who is paid: set ${THIRD_JOBS_SETTING} to the contract jobs were posted to before it`);
    }
    return;
  }
  if (isAddressEqual(third, jobs) || isAddressEqual(third, second) || (earlier && isAddressEqual(third, earlier))) {
    throw new Error(`${THIRD_JOBS_SETTING} names ${third}, which another setting names too: it is the contract jobs were posted to between the second and the one they are posted to now`);
  }
  if (!(await writerOf(publicClient, third, THIRD_JOBS_SETTING))) {
    throw new Error(`${THIRD_JOBS_SETTING} names ${third}, which does not prepare jobs: it has to be the contract that replaced ${second}`);
  }
  if (!(await hasTheLastWord(at(third)))) {
    throw new Error(`${THIRD_JOBS_SETTING} names ${third}, on which the poster does not have the last word: it has to be the contract that replaced ${second}`);
  }
  if (await doesTheLeadNameWhoIsPaid(at(third))) {
    throw new Error(`${THIRD_JOBS_SETTING} names ${third}, on which the lead names who is paid: it has to be the contract that paid every seat that said yes`);
  }
  if (!(await doesTheLeadNameWhoIsPaid(at(jobs)))) {
    throw new Error(`${JOBS_ADDRESS_SETTING} names ${jobs}, which pays every seat that said yes; with ${THIRD_JOBS_SETTING} set it has to be the contract that replaced ${third}`);
  }
}
