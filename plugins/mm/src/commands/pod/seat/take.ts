import { CommandError, type CommandIO, type InputSchema, PluginCommand } from "@metamask/agent-wallet/plugin";
import { encodeFunctionData, formatEther, isAddressEqual, type Address, type Hex } from "viem";
import { podJobsAbi, roleNumber, seatDeposit } from "../../../../../../src/jobs.ts";
import { fromPod, JOB, ROLE, roleFrom, SITE, siteFrom } from "../../../inputs.ts";
import { Pod } from "../../../pod.ts";
import { whyTheContractRefused } from "../../../refusal.ts";
import { MetaMaskWallet } from "../../../wallet.ts";

const inputs = { job: JOB, role: ROLE, site: SITE } satisfies InputSchema;

interface SeatTaken {
  readonly job: string;
  readonly role: string;
  /** the wallet that holds the seat: the address the doors, the branch and the pay all name */
  readonly seat: Address;
  readonly deposit: string;
  readonly coin: string;
  readonly transaction: Hex;
}

/** Take a free seat on a job, as MetaMask's wallet, putting down the deposit the contract asks for. */
export default class PodSeatTake extends PluginCommand<SeatTaken> {
  static override description = "Take a free seat on a POD job with this wallet, putting down the seat's deposit";
  static override examples = ["<%= config.bin %> pod seat take --job a-link-shortener --role reviewer"];
  static override requiresAuth = true;
  // a wallet of our own keys may be locked with a password, and a call outside the wallet's limits waits for its owner: both are the tool's own flags
  static override flags = PluginCommand.flagsWithInputs(inputs, { includePassword: true, includeWalletTimeout: true });
  protected readonly pluginCommandId = "pod:seat:take";

  async execute(io: CommandIO): Promise<SeatTaken> {
    const told = await io.resolveInputs(inputs);
    const role = roleFrom(told.role);
    const pod = new Pod(siteFrom(told.site));
    const [market, open] = await fromPod(Promise.all([pod.market(), pod.openJobs()]));
    const listed = open.find((one) => one.jobId === told.job);
    if (!listed) throw new CommandError("NO_SUCH_OPEN_JOB", `No job called "${told.job}" has a free seat on ${pod.site}.`, "Run `mm pod jobs` to see the ones that do.");
    if (!listed.free.includes(role)) {
      throw new CommandError("SEAT_TAKEN", `The ${role} seat on "${told.job}" is taken.`, listed.free.length > 0 ? `Still free: ${listed.free.join(", ")}.` : "Every seat on it is taken.");
    }
    const wallet = new MetaMaskWallet(this.ctx, io, this.pluginCommandId, market);
    const seat = wallet.address();
    // one owner to a job: the contract would refuse, so the gas and the owner's attention are not spent finding out
    if (listed.owners.some((owner) => isAddressEqual(owner, seat))) {
      throw new CommandError("ALREADY_IN_THE_POD", `${seat} already has a seat on "${told.job}".`, "One owner holds one seat on a job.");
    }

    const number = BigInt(listed.contract.jobId);
    const contract = { address: listed.contract.address, publicClient: wallet.reads };
    // the deposit is the contract's to say, not the list's and not ours
    const deposit = await seatDeposit(contract, number, role);
    const taking = { address: contract.address, abi: podJobsAbi, functionName: "takeSeat", args: [number, roleNumber(role), seat], value: deposit } as const;
    try {
      // asked of the chain first, so a refusal is the contract's own and costs nothing
      await wallet.reads.simulateContract({ ...taking, account: seat });
    } catch (error) {
      throw new CommandError("SEAT_REFUSED", `The contract would refuse this seat: ${whyTheContractRefused(error)}.`, `It takes ${formatEther(deposit)} ${market.coin} as the deposit, and gas on top: check what the wallet holds.`);
    }
    io.progress?.(`Asking MetaMask to take the ${role} seat on "${told.job}" for ${formatEther(deposit)} ${market.coin}.`);
    const transaction = await wallet.send({ to: contract.address, data: encodeFunctionData(taking), value: deposit });
    return { job: told.job, role, seat, deposit: formatEther(deposit), coin: market.coin, transaction };
  }

  override successHint(data: SeatTaken): string {
    return `The ${data.role} seat is ${data.seat}'s. Sign in to the job's repository with \`mm pod door --job ${data.job} --role ${data.role}\`.`;
  }
}
