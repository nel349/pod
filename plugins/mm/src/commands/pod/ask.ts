import { CommandError, type CommandIO, InputFieldType, type InputSchema, PluginCommand } from "@metamask/agent-wallet/plugin";
import type { Address } from "viem";
import { secondsNow } from "../../../../../src/clock.ts";
import { noteMessage } from "../../../../../src/messages.ts";
import { ASKS_THE_POSTER, questionNote, raisedNote } from "../../../../../src/triage.ts";
import { fromPod, JOB, ROLE, roleFrom, SITE, siteFrom } from "../../inputs.ts";
import { Pod } from "../../pod.ts";
import { MetaMaskWallet } from "../../wallet.ts";

const inputs = {
  job: JOB,
  role: ROLE,
  asks: { type: InputFieldType.Text, flag: "asks", required: true, message: "The question for whoever posted the job" },
  assumes: { type: InputFieldType.Text, flag: "assumes", required: true, message: "What will be assumed if nobody answers within a day" },
  site: SITE,
} satisfies InputSchema;

interface Asked {
  readonly job: string;
  readonly role: string;
  readonly seat: Address;
  /** where the question went: to the job's poster, from the lead, or to the lead, from any other seat */
  readonly to: "the poster" | "the lead";
  readonly at: string;
}

/**
 * Ask whoever posted a week's job what their words left open, the way a pod does: from the lead's
 * seat the question goes to the poster, and from any other seat it is raised with the lead, who puts
 * the pod's one list to them. Either way it is a signed note in the form POD reads as one.
 */
export default class PodAsk extends PluginCommand<Asked> {
  static override description = "On a week's job, ask its poster a question: from the lead's seat it goes to the poster, from any other it is raised with the lead";
  static override examples = ['<%= config.bin %> pod ask --job a-bakery-shop --role builder --asks "Is there a list of the bread and its prices?" --assumes "No list: example prices, marked as examples."'];
  static override requiresAuth = true;
  // a wallet of our own keys may be locked with a password, and a call outside the wallet's limits waits for its owner: both are the tool's own flags
  static override flags = PluginCommand.flagsWithInputs(inputs, { includePassword: true, includeWalletTimeout: true });
  protected readonly pluginCommandId = "pod:ask";

  async execute(io: CommandIO): Promise<Asked> {
    const told = await io.resolveInputs(inputs);
    const role = roleFrom(told.role);
    const [asks, assumes] = [told.asks.trim(), told.assumes.trim()];
    if (asks === "" || assumes === "") {
      throw new CommandError("NOT_A_QUESTION", "A question says what is asked and what will be assumed.", "Give both --asks and --assumes: the assumption is what the pod builds on if nobody answers within a day.");
    }
    const pod = new Pod(siteFrom(told.site));
    const [market, job] = await fromPod(Promise.all([pod.market(), pod.job(told.job)]));
    if (!job.asksItsPoster) {
      throw new CommandError("ONE_SHOT", `"${job.jobId}" is too short a job for questions: it is built from what its poster gave.`, "Only a job of a week lets its pod ask. On a shorter one, choose the smallest honest reading and say what you assumed in a note: mm pod note.");
    }
    const isTheLead = role === ASKS_THE_POSTER;
    const says = isTheLead ? questionNote(asks, assumes) : raisedNote(asks, assumes);
    const wallet = new MetaMaskWallet(this.ctx, io, this.pluginCommandId, market);
    const seat = wallet.address();
    const at = secondsNow();
    const signature = await wallet.sign(noteMessage({ jobId: job.jobId, onChainId: String(job.onChainId), jobs: job.jobs, role, about: undefined, says, at }));
    await fromPod(pod.writeNote(job.jobId, { agent: seat, role, says, at, signature }));
    return { job: job.jobId, role, seat, to: isTheLead ? "the poster" : "the lead", at: new Date(at * 1000).toISOString() };
  }
}
