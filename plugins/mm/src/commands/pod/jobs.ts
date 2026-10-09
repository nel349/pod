import { type CommandIO, type InputSchema, PluginCommand, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { formatEther } from "viem";
import { SITE, siteFrom } from "../../inputs.ts";
import { Pod } from "../../pod.ts";

const inputs = { site: SITE } satisfies InputSchema;

interface OpenJob {
  readonly job: string;
  readonly idea: string;
  readonly price: string;
  readonly endsAt: string;
  /** the seats still free, with what each pays and puts down */
  readonly free: readonly { readonly role: string; readonly pay: string; readonly deposit: string }[];
  readonly page: string;
}

/** The jobs a seat can still be taken on: what each asks for, what each seat pays, and what it puts down. */
export default class PodJobs extends PluginCommand<{ site: string; coin: string; jobs: readonly OpenJob[] }> {
  static override description = "List the POD jobs a seat can still be taken on, with what each free seat pays and puts down";
  static override examples = ["<%= config.bin %> pod jobs", "<%= config.bin %> pod jobs --json"];
  static override requiresAuth = false;
  static override requiresInit = false;
  static override flags = schemaToFlags(inputs);
  protected readonly pluginCommandId = "pod:jobs";

  async execute(io: CommandIO): Promise<{ site: string; coin: string; jobs: readonly OpenJob[] }> {
    const { site } = await io.resolveInputs(inputs);
    const pod = new Pod(siteFrom(site));
    const [market, open] = await Promise.all([pod.market(), pod.openJobs()]);
    return {
      site: pod.site,
      coin: market.coin,
      jobs: open.map((listed) => ({
        job: listed.jobId,
        idea: listed.idea,
        price: formatEther(BigInt(listed.price)),
        endsAt: listed.endsAt,
        free: listed.seats.filter((seat) => listed.free.includes(seat.role) && !seat.heldBy)
          .map((seat) => ({ role: seat.role, pay: formatEther(BigInt(seat.pay)), deposit: formatEther(BigInt(seat.deposit)) })),
        page: pod.url(listed.at.page),
      })),
    };
  }

  override successHint(data: { jobs: readonly OpenJob[] }): string {
    return data.jobs.length === 0
      ? "No job has a free seat right now."
      : "Take one with `mm pod seat take --job <name> --role <seat>`.";
  }
}
