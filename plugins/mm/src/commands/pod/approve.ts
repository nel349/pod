import { CommandError, type CommandIO, InputFieldType, type InputSchema, PluginCommand } from "@metamask/agent-wallet/plugin";
import { encodeFunctionData, zeroHash, type Address, type Hex } from "viem";
import { podJobsAbi, readJob, roleNumber } from "../../../../../src/jobs.ts";
import { isPutForwardByItsBuilder } from "../../../../../src/jobsV3.ts";
import { doesTheLeadNameWhoIsPaid, podJobsV4Abi } from "../../../../../src/jobsV4.ts";
import { bytes32ToCommit, commitToBytes32 } from "../../../../../src/repo.ts";
import { commitToApprove } from "../../candidate.ts";
import { fromPod, JOB, ROLE, roleFrom, SITE, siteFrom } from "../../inputs.ts";
import { AN_ACCOUNT } from "../../named.ts";
import { Pod } from "../../pod.ts";
import { whyTheContractRefused } from "../../refusal.ts";
import { MetaMaskWallet } from "../../wallet.ts";

const inputs = {
  job: JOB,
  role: ROLE,
  commit: { type: InputFieldType.Text, flag: "commit", required: false, prompt: false, message: "The full commit id, to be sure which one is approved. A seat approves the pod's candidate, which the builder puts forward" },
  account: { type: InputFieldType.Text, flag: "account", required: false, prompt: false, message: "The fingerprint of the note this seat wrote about the commit, as `mm pod note` gives it. Needed where the lead names who is paid" },
  site: SITE,
} satisfies InputSchema;

interface Approved {
  readonly job: string;
  readonly role: string;
  readonly seat: Address;
  readonly commit: string;
  readonly transaction: Hex;
}

/**
 * Approve the pod's candidate on the contract, as the seat this wallet holds: say it stands behind
 * the work. Where the builder puts its own work forward, which is asked of the contract, every seat
 * but the builder's approves the candidate the chain holds at that moment, or nothing, and only while
 * its review runs. On the contracts before, approving another commit made that one the candidate and
 * cleared every approval given so far, so only the lead may name one there.
 */
export default class PodApprove extends PluginCommand<Approved> {
  static override description = "Approve a POD job's candidate commit on the contract, as the seat this wallet holds";
  static override examples = [
    "<%= config.bin %> pod approve --job a-link-shortener --role reviewer",
    "<%= config.bin %> pod approve --job a-link-shortener --role qa --commit 1cede02ebf88bf81bfcd556351dc6fa8bdb74a5d",
  ];
  static override requiresAuth = true;
  // a wallet of our own keys may be locked with a password, and a call outside the wallet's limits waits for its owner: both are the tool's own flags
  static override flags = PluginCommand.flagsWithInputs(inputs, { includePassword: true, includeWalletTimeout: true });
  protected readonly pluginCommandId = "pod:approve";

  async execute(io: CommandIO): Promise<Approved> {
    const told = await io.resolveInputs(inputs);
    const role = roleFrom(told.role);
    const pod = new Pod(siteFrom(told.site));
    const [market, job] = await fromPod(Promise.all([pod.market(), pod.job(told.job)]));
    const wallet = new MetaMaskWallet(this.ctx, io, this.pluginCommandId, market);
    const seat = wallet.address();
    const contract = { address: job.jobs, publicClient: wallet.reads };
    // read just before approving: the candidate is whatever the chain holds now
    const [{ commit: held }, builderNames, leadNames] = await Promise.all([readJob(contract, job.onChainId), isPutForwardByItsBuilder(contract), doesTheLeadNameWhoIsPaid(contract)]);
    if (leadNames && role === "lead") {
      throw new CommandError("LEADS_CONCLUDE", "On this job the lead does not approve: it concludes the review, which is its yes and names who is paid.", "Use `mm pod conclude --job <name> --earned <seats> --account <fingerprint>`.");
    }
    const account = told.account?.trim().toLowerCase();
    if (leadNames && (!account || !AN_ACCOUNT.test(account))) {
      throw new CommandError("NO_ACCOUNT", "On this job a yes carries the account the seat wrote of what it did, and none was given.", "Write the account with `mm pod note --about <commit>`, and pass the fingerprint it gives as --account.");
    }
    const toApprove = commitToApprove(role, told.commit, held === zeroHash ? undefined : bytes32ToCommit(held), builderNames);
    if (!toApprove.ok) throw new CommandError(toApprove.code, toApprove.why, toApprove.hint);
    const { commit } = toApprove;

    // one yes, written as the job's contract takes it: with the account bound to it where the lead names who is paid
    const args = [job.onChainId, roleNumber(role), commitToBytes32(commit)] as const;
    const withAccount = leadNames && account ? { address: contract.address, abi: podJobsV4Abi, functionName: "approve", args: [...args, account as Hex] } as const : undefined;
    const plain = { address: contract.address, abi: podJobsAbi, functionName: "approve", args } as const;
    try {
      await (withAccount ? wallet.reads.simulateContract({ ...withAccount, account: seat }) : wallet.reads.simulateContract({ ...plain, account: seat }));
    } catch (error) {
      throw new CommandError("APPROVAL_REFUSED", `The contract would refuse this approval: ${whyTheContractRefused(error)}.`, `Only the address that holds the ${role} seat may approve as it, while the job is open and the candidate's review still runs.`);
    }
    io.progress?.(`Asking MetaMask to approve ${commit} as the ${role} seat on "${job.jobId}".`);
    const transaction = await wallet.send({ to: contract.address, data: withAccount ? encodeFunctionData(withAccount) : encodeFunctionData(plain) });
    return { job: job.jobId, role, seat, commit, transaction };
  }
}
