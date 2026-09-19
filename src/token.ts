/**
 * Minting the title, once the verdict has paid the crew.
 *
 * The token holds what the receipt holds, in the two fields a chain can check: the commit and the
 * hash of the receipt. Everything else a reader wants is at the URI, which is the job's own page,
 * and that page carries the checks and the command to run them again.
 *
 * Nothing here decides who gets it. The person who paid is read from the job, on chain, because a
 * title minted to whoever the runner felt like would be worth nothing.
 */
import { parseAbi, type Address, type Hex } from "viem";
import { podJobsAbi, type Contract } from "./jobs.ts";
import type { Role } from "./job.ts";
import { roleNumber } from "./jobs.ts";

export const podTokenAbi = parseAbi([
  "struct Seat { address agent; uint8 role; }",
  "struct Pod { bytes32 seal; bytes32 commitHash; bytes32 receiptHash; uint64 mintedAt; string uri; }",
  "function mint(address to, uint256 jobId, bytes32 seal, bytes32 commitHash, bytes32 receiptHash, Seat[] crew, string uri) returns (uint256)",
  "function pod(uint256 tokenId) view returns (Pod)",
  "function crew(uint256 tokenId) view returns (Seat[])",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  // the title is transferable on purpose: a sale carries the repository with it
  "function transferFrom(address from, address to, uint256 tokenId)",
  "function tokenOfJob(uint256 jobId) view returns (uint256)",
  "function minter() view returns (address)",
]);

export interface MintPod {
  /** the job as the jobs contract knows it, which is also where the person who paid comes from */
  readonly jobs: Contract;
  readonly jobId: bigint;
  readonly seal: Hex;
  readonly commit: Hex;
  readonly receiptHash: Hex;
  readonly crew: readonly { readonly role: Role; readonly agent: Address }[];
  /** the job's page: where the checks, the receipt and the command to repeat it all live */
  readonly uri: string;
}

/** Who paid for this job, read from the contract rather than passed in. */
export async function posterOf(jobs: Omit<Contract, "wallet">, jobId: bigint): Promise<Address> {
  const [poster] = await jobs.publicClient.readContract({
    address: jobs.address, abi: podJobsAbi, functionName: "jobs", args: [jobId],
  });
  return poster;
}

export async function mintPod(token: Contract, mint: MintPod): Promise<Hex> {
  const to = await posterOf(mint.jobs, mint.jobId);
  const { request } = await token.publicClient.simulateContract({
    address: token.address,
    abi: podTokenAbi,
    functionName: "mint",
    args: [
      to,
      mint.jobId,
      mint.seal,
      mint.commit,
      mint.receiptHash,
      mint.crew.map((seat) => ({ agent: seat.agent, role: roleNumber(seat.role) })),
      mint.uri,
    ],
    account: token.wallet.account!,
  });
  const hash = await token.wallet.writeContract(request);
  const receipt = await token.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`the chain rejected the mint: ${hash}`);
  return hash;
}

export function tokenOfJob(token: Omit<Contract, "wallet">, jobId: bigint): Promise<bigint> {
  return token.publicClient.readContract({
    address: token.address, abi: podTokenAbi, functionName: "tokenOfJob", args: [jobId],
  });
}
