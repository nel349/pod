import { type CommandIO, type InputSchema, PluginCommand } from "@metamask/agent-wallet/plugin";
import type { Address } from "viem";
import { secondsNow } from "../../../../../src/clock.ts";
import { agentEmail, branchFor } from "../../../../../src/door/seat.ts";
import { doorMessage } from "../../../../../src/messages.ts";
import { gitPath } from "../../../../../src/routes.ts";
import { fromPod, JOB, ROLE, roleFrom, SITE, siteFrom } from "../../inputs.ts";
import { Pod } from "../../pod.ts";
import { MetaMaskWallet } from "../../wallet.ts";

const inputs = { job: JOB, role: ROLE, site: SITE } satisfies InputSchema;

/** how long a statement opens the doors for. The doors take one good for an hour at most */
const A_STATEMENT_LASTS_SECONDS = 50 * 60;

interface DoorOpened {
  readonly job: string;
  readonly role: string;
  readonly seat: Address;
  /** when the password stops opening anything */
  readonly until: string;
  readonly git: {
    readonly url: string;
    /** git's name: the seat's address */
    readonly name: Address;
    /** git's password: the seat's signed statement. Good until `until`, for this job and this seat only */
    readonly password: string;
    /** the one branch this seat may write */
    readonly branch: string;
    /** who every commit has to be written and committed as */
    readonly commitAs: string;
  };
  readonly clone: string;
}

/** Sign in to a job's repository as the seat this wallet holds: a statement the wallet signs, good for a while. */
export default class PodDoor extends PluginCommand<DoorOpened> {
  static override description = "Sign in to a POD job's repository and notes as the seat this wallet holds";
  static override examples = ["<%= config.bin %> pod door --job a-link-shortener --role reviewer --json"];
  static override requiresAuth = true;
  // a wallet of our own keys may be locked with a password, and a call outside the wallet's limits waits for its owner: both are the tool's own flags
  static override flags = PluginCommand.flagsWithInputs(inputs, { includePassword: true, includeWalletTimeout: true });
  protected readonly pluginCommandId = "pod:door";

  async execute(io: CommandIO): Promise<DoorOpened> {
    const told = await io.resolveInputs(inputs);
    const role = roleFrom(told.role);
    const pod = new Pod(siteFrom(told.site));
    const [market, job] = await fromPod(Promise.all([pod.market(), pod.job(told.job)]));
    const wallet = new MetaMaskWallet(this.ctx, io, this.pluginCommandId, market);
    const seat = wallet.address();
    const branch = branchFor(role, seat);
    const until = secondsNow() + A_STATEMENT_LASTS_SECONDS;
    const signature = await wallet.sign(doorMessage({ jobId: job.jobId, onChainId: String(job.onChainId), jobs: job.jobs, role, branch, until }));
    const password = `${role}.${until}.${signature}`;
    const url = pod.url(gitPath(job.jobId));
    const withSignIn = new URL(url);
    withSignIn.username = seat;
    withSignIn.password = password;
    return {
      job: job.jobId, role, seat, until: new Date(until * 1000).toISOString(),
      git: { url, name: seat, password, branch, commitAs: agentEmail(seat) },
      clone: `git clone ${withSignIn.toString()}`,
    };
  }

  override successHint(data: DoorOpened): string {
    return `Push only to ${data.git.branch}, with every commit written and committed as ${data.git.commitAs}. The password is good until ${data.until}.`;
  }
}
