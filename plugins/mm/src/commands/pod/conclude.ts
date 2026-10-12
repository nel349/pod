import { CommandError, type CommandIO, InputFieldType, type InputSchema, PluginCommand } from "@metamask/agent-wallet/plugin";
import { encodeFunctionData, zeroHash, type Address, type Hex } from "viem";
import { readJob } from "../../../../../src/jobs.ts";
import { doesTheLeadNameWhoIsPaid, earnedSeats, podJobsV4Abi } from "../../../../../src/jobsV4.ts";
import { bytes32ToCommit, commitToBytes32 } from "../../../../../src/repo.ts";
import { commitToApprove } from "../../candidate.ts";
import { fromPod, JOB, SITE, siteFrom } from "../../inputs.ts";
import { AN_ACCOUNT, seatsNamed } from "../../named.ts";
import { Pod } from "../../pod.ts";
import { whyTheContractRefused } from "../../refusal.ts";
import { MetaMaskWallet } from "../../wallet.ts";

const inputs = {
  job: JOB,
  earned: { type: InputFieldType.Text, flag: "earned", required: true, message: 'The seats that earned their pay, as "reviewer, qa, security", or "none"' },
  account: { type: InputFieldType.Text, flag: "account", required: true, message: "The fingerprint of the note the lead wrote of its reasons, as `mm pod note` gives it" },
  commit: { type: InputFieldType.Text, flag: "commit", required: false, prompt: false, message: "The full commit id, to be sure which review is concluded" },
  site: SITE,
} satisfies InputSchema;

interface Concluded {
  readonly job: string;
  readonly seat: Address;
  readonly commit: string;
  readonly earned: readonly string[];
  readonly transaction: Hex;
}

/**
 * Conclude the review of a POD job's candidate, as the lead's seat this wallet holds: stand behind
 * the work, name the seats that earned their pay, and bind the lead's written reasons. The work is
 * graded at once. Only where the job's contract has its lead name who is paid, which is asked of it.
 */
export default class PodConclude extends PluginCommand<Concluded> {
  static override description = "Conclude the review of a POD job's candidate as its lead, naming the seats that earned their pay";
  static override examples = [
    '<%= config.bin %> pod conclude --job a-link-shortener --earned "reviewer, qa" --account 0x5f1c…',
    "<%= config.bin %> pod conclude --job a-link-shortener --earned none --account 0x5f1c…",
  ];
  static override requiresAuth = true;
  // a wallet of our own keys may be locked with a password, and a call outside the wallet's limits waits for its owner: both are the tool's own flags
  static override flags = PluginCommand.flagsWithInputs(inputs, { includePassword: true, includeWalletTimeout: true });
  protected readonly pluginCommandId = "pod:conclude";

  async execute(io: CommandIO): Promise<Concluded> {
    const told = await io.resolveInputs(inputs);
    const named = seatsNamed(told.earned);
    if (!named.ok) throw new CommandError(named.code, named.why, named.hint);
    const account = told.account.trim().toLowerCase();
    if (!AN_ACCOUNT.test(account)) {
      throw new CommandError("NO_ACCOUNT", "A conclusion carries the fingerprint of the lead's written reasons, and this is not one.", "Write the reasons with `mm pod note --role lead --about <commit>`, and pass the fingerprint it gives as --account.");
    }
    const pod = new Pod(siteFrom(told.site));
    const [market, job] = await fromPod(Promise.all([pod.market(), pod.job(told.job)]));
    const wallet = new MetaMaskWallet(this.ctx, io, this.pluginCommandId, market);
    const seat = wallet.address();
    const contract = { address: job.jobs, publicClient: wallet.reads };
    const [{ commit: held }, leadNames] = await Promise.all([readJob(contract, job.onChainId), doesTheLeadNameWhoIsPaid(contract)]);
    if (!leadNames) {
      throw new CommandError("LEADS_APPROVE_HERE", "On this job's contract every seat that says yes is paid, and the lead says yes like any other.", "Use `mm pod approve --job <name> --role lead`.");
    }
    // the lead concludes the review of the candidate the chain holds, and of no other commit
    const toConclude = commitToApprove("lead", told.commit, held === zeroHash ? undefined : bytes32ToCommit(held), true);
    if (!toConclude.ok) throw new CommandError(toConclude.code, toConclude.why, toConclude.hint);
    const { commit } = toConclude;

    const concluding = { address: contract.address, abi: podJobsV4Abi, functionName: "conclude", args: [job.onChainId, commitToBytes32(commit), earnedSeats(named.seats), account as Hex] } as const;
    try {
      await wallet.reads.simulateContract({ ...concluding, account: seat });
    } catch (error) {
      throw new CommandError("CONCLUSION_REFUSED", `The contract would refuse this conclusion: ${whyTheContractRefused(error)}.`, "Only the lead's seat concludes, while the review runs, once every other seat taken has said yes or half the review has gone, and it names only seats that stand behind this commit.");
    }
    io.progress?.(`Asking MetaMask to conclude the review of ${commit} on "${job.jobId}".`);
    const transaction = await wallet.send({ to: contract.address, data: encodeFunctionData(concluding) });
    return { job: job.jobId, seat, commit, earned: named.seats.map((one) => `${one.role} ${one.index + 1}`), transaction };
  }
}
