/**
 * Talking to the ERC-8004 registries on Monad testnet.
 *
 * Two of the three legs are deployed there and wired to each other: identity, which says who an agent
 * is and who owns it, and validation, which records that somebody asked for work to be checked and
 * what the answer was. Reputation lives on mainnet at a different address and we do not use it: the
 * record POD relies on is the validation summary, which is already filtered by tag.
 *
 * Two rules in the deployed contracts shape everything here:
 *
 * - only an agent's owner, or an address the owner has approved, may ask for a validation. So taking
 *   a seat has to include that approval, or a doubt raised by a stranger could never be recorded.
 * - only the address named in the request may answer it. So several independent runners means
 *   several requests, which is also the honest shape of the claim.
 */
import {
  createPublicClient, encodeFunctionData, http, parseAbi,
  type Address, type Hex, type PublicClient,
} from "viem";

/** Monad testnet, checked on chain 2026-09-16. */
export const MONAD_TESTNET = {
  id: 10143,
  rpc: "https://testnet-rpc.monad.xyz",
  identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e" as Address,
  validationRegistry: "0x8004Cb1BF31DAf7788923b405b754f57acEB4272" as Address,
} as const;

export const identityAbi = parseAbi([
  "function register() external returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function setApprovalForAll(address operator, bool approved) external",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function getVersion() view returns (string)",
]);

export const validationAbi = parseAbi([
  "function validationRequest(address validatorAddress, uint256 agentId, string requestURI, bytes32 requestHash) external",
  "function validationResponse(bytes32 requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag) external",
  "function getValidationStatus(bytes32 requestHash) view returns (address validatorAddress, uint256 agentId, uint8 response, bytes32 responseHash, string tag, uint256 lastUpdate)",
  "function getSummary(uint256 agentId, address[] validatorAddresses, string tag) view returns (uint64 count, uint8 avgResponse)",
  "function getIdentityRegistry() view returns (address)",
]);

export function readOnlyClient(rpcUrl: string = MONAD_TESTNET.rpc): PublicClient {
  return createPublicClient({ transport: http(rpcUrl) }) as PublicClient;
}

/**
 * What a seat has to do before it can be part of a job: let the platform speak for its agent in the
 * registry. Without this, nobody but the agent's owner could ever ask for its work to be checked.
 */
export function approvePlatformCall(platform: Address): Hex {
  return encodeFunctionData({ abi: identityAbi, functionName: "setApprovalForAll", args: [platform, true] });
}

/** Ask a named runner to check one job at one commit. The key is the same one the verdict uses. */
export function requestCall(input: {
  readonly runner: Address;
  readonly agentId: bigint;
  readonly evidenceURI: string;
  readonly key: Hex;
}): Hex {
  return encodeFunctionData({
    abi: validationAbi,
    functionName: "validationRequest",
    args: [input.runner, input.agentId, input.evidenceURI, input.key],
  });
}

/**
 * The verdict itself. A score of 0 to 100, where only a clean pass earns 100, plus a link to the
 * receipt and a hash of it, and the tag that makes an agent's record role-scoped.
 */
export function verdictCall(input: {
  readonly key: Hex;
  readonly score: number;
  readonly receiptURI: string;
  readonly receiptHash: Hex;
  readonly tag: string;
}): Hex {
  if (!Number.isInteger(input.score) || input.score < 0 || input.score > 100) {
    throw new Error("a verdict is a whole number from 0 to 100");
  }
  return encodeFunctionData({
    abi: validationAbi,
    functionName: "validationResponse",
    args: [input.key, input.score, input.receiptURI, input.receiptHash, input.tag],
  });
}

/** Who owns an agent, which is what decides whether a seat can be taken by that wallet. */
export async function ownerOfAgent(client: PublicClient, agentId: bigint): Promise<Address> {
  return client.readContract({
    address: MONAD_TESTNET.identityRegistry,
    abi: identityAbi,
    functionName: "ownerOf",
    args: [agentId],
  });
}

/** An agent's record in one role: how many verdicts, and their average. */
export async function record(
  client: PublicClient,
  agentId: bigint,
  tag: string,
  runners: readonly Address[] = [],
): Promise<{ readonly count: number; readonly average: number }> {
  const [count, average] = await client.readContract({
    address: MONAD_TESTNET.validationRegistry,
    abi: validationAbi,
    functionName: "getSummary",
    args: [agentId, [...runners], tag],
  });
  return { count: Number(count), average };
}

/** Which identity registry the validation registry checks ownership against. */
export async function identityRegistryOf(client: PublicClient): Promise<Address> {
  return client.readContract({
    address: MONAD_TESTNET.validationRegistry,
    abi: validationAbi,
    functionName: "getIdentityRegistry",
  });
}
