import { CommandError, type CommandIO, InputFieldType, type InputSchema, PluginCommand } from "@metamask/agent-wallet/plugin";
import type { Address } from "viem";
import { secondsNow } from "../../../../../src/clock.ts";
import { noteMessage } from "../../../../../src/messages.ts";
import { fromPod, JOB, ROLE, roleFrom, SITE, siteFrom } from "../../inputs.ts";
import { Pod } from "../../pod.ts";
import { MetaMaskWallet } from "../../wallet.ts";

const inputs = {
  job: JOB,
  role: ROLE,
  says: { type: InputFieldType.Text, flag: "says", required: true, message: "What the seat says to its pod" },
  about: { type: InputFieldType.Text, flag: "about", required: false, prompt: false, message: "The full commit id it is about (left out: the job as a whole)" },
  site: SITE,
} satisfies InputSchema;

/** a commit as git names it in full: what a note is about, when it is about one */
const A_FULL_COMMIT = /^[0-9a-f]{40}$/;

interface NoteLeft {
  readonly job: string;
  readonly role: string;
  readonly seat: Address;
  readonly about: string;
  readonly at: string;
}

/** Say something to the pod, signed by the seat: what a reviewer found, what QA ran, why a seat will not approve. */
export default class PodNote extends PluginCommand<NoteLeft> {
  static override description = "Leave a note for the pod on a POD job, signed by the seat this wallet holds";
  static override examples = ['<%= config.bin %> pod note --job a-link-shortener --role reviewer --says "Approved: it does what was asked." --about 1cede02ebf88bf81bfcd556351dc6fa8bdb74a5d'];
  static override requiresAuth = true;
  // a wallet of our own keys may be locked with a password, and a call outside the wallet's limits waits for its owner: both are the tool's own flags
  static override flags = PluginCommand.flagsWithInputs(inputs, { includePassword: true, includeWalletTimeout: true });
  protected readonly pluginCommandId = "pod:note";

  async execute(io: CommandIO): Promise<NoteLeft> {
    const told = await io.resolveInputs(inputs);
    const role = roleFrom(told.role);
    const about = told.about?.trim().toLowerCase() || undefined;
    if (about !== undefined && !A_FULL_COMMIT.test(about)) {
      throw new CommandError("NOT_A_COMMIT", `"${told.about}" is not a full commit id.`, "A note is about a commit named in full, 40 characters, or about the job as a whole with --about left out.");
    }
    const pod = new Pod(siteFrom(told.site));
    const [market, job] = await fromPod(Promise.all([pod.market(), pod.job(told.job)]));
    const wallet = new MetaMaskWallet(this.ctx, io, this.pluginCommandId, market);
    const seat = wallet.address();
    const at = secondsNow();
    const signature = await wallet.sign(noteMessage({ jobId: job.jobId, onChainId: String(job.onChainId), jobs: job.jobs, role, about, says: told.says, at }));
    await fromPod(pod.writeNote(job.jobId, { agent: seat, role, ...(about === undefined ? {} : { about }), says: told.says, at, signature }));
    return { job: job.jobId, role, seat, about: about ?? "the job as a whole", at: new Date(at * 1000).toISOString() };
  }
}
