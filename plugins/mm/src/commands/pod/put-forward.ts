import { CommandError, type CommandIO, InputFieldType, type InputSchema, PluginCommand } from "@metamask/agent-wallet/plugin";
import { encodeFunctionData, zeroHash, type Address, type Hex } from "viem";
import { readJob } from "../../../../../src/jobs.ts";
import { isPutForwardByItsBuilder, podJobsV3Abi, readReviewBy } from "../../../../../src/jobsV3.ts";
import { bytes32ToCommit, commitToBytes32 } from "../../../../../src/repo.ts";
import { commitToPutForward } from "../../candidate.ts";
import { fromPod, JOB, SITE, siteFrom } from "../../inputs.ts";
import { Pod } from "../../pod.ts";
import { whyTheContractRefused } from "../../refusal.ts";
import { MetaMaskWallet } from "../../wallet.ts";

const inputs = {
  job: JOB,
  commit: { type: InputFieldType.Text, flag: "commit", required: true, message: "The full commit id of the work, already pushed to the builder's branch" },
  site: SITE,
} satisfies InputSchema;

interface PutForward {
  readonly job: string;
  readonly seat: Address;
  readonly commit: string;
  /** until when the other seats may say whether they stand behind it, after which it is graded whoever does */
  readonly reviewBy: string;
  readonly transaction: Hex;
}

/**
 * Put the builder's work forward on the contract, as the builder's seat this wallet holds: name the
 * one commit to be reviewed and graded. Nobody else can name it, so no seat can hold the work back:
 * it is graded when the whole pod stands behind it, or when its review has run out, whoever does.
 * Putting it forward is standing behind it, and it can be locked at once, so it is for work its
 * builder would have graded as it is.
 */
export default class PodPutForward extends PluginCommand<PutForward> {
  static override description = "Put a POD job's work forward to be reviewed and graded, as the builder's seat this wallet holds";
  static override examples = ["<%= config.bin %> pod put-forward --job a-link-shortener --commit 1cede02ebf88bf81bfcd556351dc6fa8bdb74a5d"];
  static override requiresAuth = true;
  // a wallet of our own keys may be locked with a password, and a call outside the wallet's limits waits for its owner: both are the tool's own flags
  static override flags = PluginCommand.flagsWithInputs(inputs, { includePassword: true, includeWalletTimeout: true });
  protected readonly pluginCommandId = "pod:put-forward";

  async execute(io: CommandIO): Promise<PutForward> {
    const told = await io.resolveInputs(inputs);
    const pod = new Pod(siteFrom(told.site));
    const [market, job] = await fromPod(Promise.all([pod.market(), pod.job(told.job)]));
    const wallet = new MetaMaskWallet(this.ctx, io, this.pluginCommandId, market);
    const seat = wallet.address();
    const contract = { address: job.jobs, publicClient: wallet.reads };
    if (!(await isPutForwardByItsBuilder(contract))) {
      throw new CommandError("LEAD_NAMES_IT_HERE", "On this job's contract the lead names the candidate, and the builder puts nothing forward.", "The lead names it with `mm pod approve --role lead --commit <id>`.");
    }
    // read just before: the candidate is whatever the chain holds now
    const held = (await readJob(contract, job.onChainId)).commit;
    const named = commitToPutForward("builder", told.commit, held === zeroHash ? undefined : bytes32ToCommit(held));
    if (!named.ok) throw new CommandError(named.code, named.why, named.hint);
    const { commit } = named;

    const putting = { address: contract.address, abi: podJobsV3Abi, functionName: "putForward", args: [job.onChainId, commitToBytes32(commit)] } as const;
    try {
      await wallet.reads.simulateContract({ ...putting, account: seat });
    } catch (error) {
      throw new CommandError("NOT_PUT_FORWARD", `The contract would refuse this: ${whyTheContractRefused(error)}.`, "Only the address that holds the builder's seat may put work forward, while the job is open and no earlier candidate is locked for grading.");
    }
    io.progress?.(`Asking MetaMask to put ${commit} forward as the builder of "${job.jobId}".`);
    const transaction = await wallet.send({ to: contract.address, data: encodeFunctionData(putting) });
    const reviewBy = await readReviewBy(contract, job.onChainId);
    return { job: job.jobId, seat, commit, reviewBy: reviewBy === undefined ? "" : new Date(Number(reviewBy) * 1000).toISOString(), transaction };
  }
}
