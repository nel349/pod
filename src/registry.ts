/**
 * Talking to the ERC-8004 registries on Monad testnet.
 *
 * All three legs are deployed there and wired to each other: identity, which says who an agent is
 * and who owns it; validation, which records that somebody asked for work to be checked and what the
 * answer was; and reputation, where anybody but an agent's own owner may write what the agent did.
 *
 * Reputation is where POD writes a seat's verdict. Until 5 October this said reputation lived only on
 * mainnet, which was not so, and the record went to validation alone: that registry takes a request
 * from the agent's owner and nobody else, so every agent had to ask for its own record, and an agent
 * working for somebody's wallet needed that wallet to ask. Reputation needs nothing from the owner,
 * and refuses the owner outright, so what is written there is what the agent could not have said
 * about itself.
 *
 * Two rules in the deployed contracts shape everything here:
 *
 * - only an agent's owner, or an address the owner has approved, may ask for a validation. So taking
 *   a seat has to include that approval, or a doubt raised by a stranger could never be recorded.
 * - only the address named in the request may answer it. So several independent runners means
 *   several requests, which is also the honest shape of the claim.
 */
import {
  createPublicClient, encodeFunctionData, parseAbi,
  type Address, type Hex, type PublicClient, type WalletClient,
} from "viem";
import { politeHttp } from "./rpc.ts";

/** Monad testnet, checked on chain 2026-09-16. */
export const MONAD_TESTNET = {
  id: 10143,
  rpc: "https://testnet-rpc.monad.xyz",
  /** what the chain's own coin is called, which is what a price on the wall is denominated in */
  coin: "MON",
  /** where anybody can be sent testnet MON, linked from a wallet that is new and empty */
  faucet: "https://faucet.monad.xyz",
  /**
   * How a wallet has to treat the public endpoint above, measured on 2026-10-06 with throwaway
   * wallets. Asked to send for a wallet the instant its money landed, it refuses ("Signer had
   * insufficient balance") and goes on refusing that wallet: still, after five minutes of quiet. A
   * wallet whose first send came five seconds or more after its money was taken at once, four times
   * of four. And a wallet it was refusing had the same payment taken at once by the other endpoint
   * here, after which the first took its next one too.
   */
  sending: {
    settledAfterBlocks: 25,
    settledAfterSeconds: 10,
    otherRpc: "https://rpc.ankr.com/monad_testnet",
  },
  identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e" as Address,
  validationRegistry: "0x8004Cb1BF31DAf7788923b405b754f57acEB4272" as Address,
  /** version 2.0.0, wired to the identity registry above, checked on chain 2026-10-05 */
  reputationRegistry: "0x8004B663056A597Dffe9eCcC1965A193B7388713" as Address,
} as const;

/** Where the registries are. Monad's, unless a test deploys its own on a local chain */
export interface Registries {
  readonly identity: Address;
  readonly validation: Address;
  readonly reputation: Address;
}

export const MONAD_REGISTRIES: Registries = {
  identity: MONAD_TESTNET.identityRegistry,
  validation: MONAD_TESTNET.validationRegistry,
  reputation: MONAD_TESTNET.reputationRegistry,
};

export const identityAbi = parseAbi([
  "function register() external returns (uint256)",
  "function register(string agentURI) external returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "function setApprovalForAll(address operator, bool approved) external",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function getVersion() view returns (string)",
]);

/**
 * The reputation registry, read off its deployment. Two of its rules are what the design rests on: it
 * refuses an entry from an identity's own owner or operators, and every read names whose entries it
 * trusts, so a reader asks for what this grader wrote and gets only that.
 */
export const reputationAbi = parseAbi([
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
  "function readAllFeedback(uint256 agentId, address[] clientAddresses, string tag1, string tag2, bool includeRevoked) view returns (address[] clients, uint64[] feedbackIndexes, int128[] values, uint8[] valueDecimals, string[] tag1s, string[] tag2s, bool[] revokedStatuses)",
  "function getIdentityRegistry() view returns (address)",
  "function getVersion() view returns (string)",
]);

/**
 * The second tag on every entry POD writes: what the number is out of. A number on a chain with no
 * unit beside it is a number somebody will read the wrong way round.
 */
export const SCORE_TAG = "out-of-100";

export const validationAbi = parseAbi([
  "function validationRequest(address validatorAddress, uint256 agentId, string requestURI, bytes32 requestHash) external",
  "function validationResponse(bytes32 requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag) external",
  "function getValidationStatus(bytes32 requestHash) view returns (address validatorAddress, uint256 agentId, uint8 response, bytes32 responseHash, string tag, uint256 lastUpdate)",
  "function getSummary(uint256 agentId, address[] validatorAddresses, string tag) view returns (uint64 count, uint8 avgResponse)",
  "function getIdentityRegistry() view returns (address)",
  "function getValidatorRequests(address validatorAddress) view returns (bytes32[])",
  "event ValidationRequest(address indexed validatorAddress, uint256 indexed agentId, string requestURI, bytes32 indexed requestHash)",
]);

export function readOnlyClient(rpcUrl: string = MONAD_TESTNET.rpc): PublicClient {
  return createPublicClient({ transport: politeHttp(rpcUrl) }) as PublicClient;
}

/**
 * Let an address speak for all of an owner's agents in the registry. The registry has no narrower
 * approval: it also lets that address move the owner's identities. So outside agents are never asked
 * for it (decided 24 Sep, Y12): each asks for its own verdict instead. Kept for identities we own.
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
export async function ownerOfAgent(client: PublicClient, agentId: bigint, at: Registries = MONAD_REGISTRIES): Promise<Address> {
  return client.readContract({
    address: at.identity,
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
  at: Registries = MONAD_REGISTRIES,
): Promise<{ readonly count: number; readonly average: number }> {
  const [count, average] = await client.readContract({
    address: at.validation,
    abi: validationAbi,
    functionName: "getSummary",
    args: [agentId, [...runners], tag],
  });
  return { count: Number(count), average };
}

/** Which identity registry the validation registry checks ownership against. */
export async function identityRegistryOf(client: PublicClient, at: Registries = MONAD_REGISTRIES): Promise<Address> {
  return client.readContract({
    address: at.validation,
    abi: validationAbi,
    functionName: "getIdentityRegistry",
  });
}

/**
 * Sending, rather than building.
 *
 * Everything above makes calldata and reads. These three put it on the chain, and they are separate
 * on purpose: a call that can be inspected before it is sent is a call somebody can check, and the
 * simulation is what turns a revert into a sentence instead of a receipt with status 0.
 */
export interface Sender {
  readonly publicClient: PublicClient;
  readonly wallet: WalletClient;
}

async function send(by: Sender, to: Address, data: Hex): Promise<Hex> {
  const account = by.wallet.account;
  if (!account) throw new Error("that wallet has no account to sign with");
  // simulate first: the registries revert with reasons worth reading
  await by.publicClient.call({ account, to, data });
  const hash = await by.wallet.sendTransaction({ account, chain: by.wallet.chain, to, data });
  const receipt = await by.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`the chain rejected ${hash}`);
  return hash;
}

/**
 * Give an agent an identity, and hand back the id the registry gave it.
 *
 * Registering is permissionless: whoever sends this owns the agent that comes out of it, which is
 * what makes "the agent is owned by a person" a fact on the chain rather than a claim on a page.
 */
export async function registerAgent(by: Sender, at: Registries = MONAD_REGISTRIES): Promise<{ readonly agentId: bigint; readonly hash: Hex }> {
  const account = by.wallet.account;
  if (!account) throw new Error("that wallet has no account to sign with");
  const { request, result } = await by.publicClient.simulateContract({
    address: at.identity,
    abi: identityAbi,
    functionName: "register",
    account,
  });
  const hash = await by.wallet.writeContract(request);
  const receipt = await by.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`the chain rejected the registration ${hash}`);
  return { agentId: result, hash };
}

/** Let an address speak for an agent, which a seat has to do before its work can be checked. */
export function approvePlatform(by: Sender, platform: Address, at: Registries = MONAD_REGISTRIES): Promise<Hex> {
  return send(by, at.identity, approvePlatformCall(platform));
}

/** Ask a named runner to check one job at one commit. Sent by the agent's owner, or by its operator. */
export function requestValidation(by: Sender, input: Parameters<typeof requestCall>[0], at: Registries = MONAD_REGISTRIES): Promise<Hex> {
  return send(by, at.validation, requestCall(input));
}

/** The verdict itself, which only the runner the request named may send. */
export function writeVerdict(by: Sender, input: Parameters<typeof verdictCall>[0], at: Registries = MONAD_REGISTRIES): Promise<Hex> {
  return send(by, at.validation, verdictCall(input));
}

/** One entry POD writes about a seat: how it ended, under which seat's tag, and the receipt that says so. */
export interface Feedback {
  readonly agentId: bigint;
  /** out of 100, as every answer POD has ever given a registry */
  readonly score: number;
  /** which seat, and whether the runs disagreed: `pod.reviewer`, say */
  readonly tag: string;
  /** where this server is, which is who is speaking */
  readonly site: string;
  readonly receiptURI: string;
  readonly receiptHash: Hex;
}

/**
 * Write what a seat did to the agent's record, from the grader's own key. Nothing is asked of the
 * agent or of whoever owns it, and the registry would refuse them if they tried: an entry here is one
 * the agent could not have written about itself.
 */
export function writeFeedback(by: Sender, entry: Feedback, at: Registries = MONAD_REGISTRIES): Promise<Hex> {
  return send(by, at.reputation, encodeFunctionData({
    abi: reputationAbi,
    functionName: "giveFeedback",
    args: [entry.agentId, BigInt(entry.score), 0, entry.tag, SCORE_TAG, entry.site, entry.receiptURI, entry.receiptHash],
  }));
}

/** One entry as it reads back: what was scored, and under which seat's tag. */
export interface FeedbackRead {
  readonly score: number;
  readonly tag: string;
}

/**
 * What one writer has put on an agent's record, entries taken back left out. The writer is named
 * because the registry trusts nobody by itself: a reader says whose entries count, and anybody else
 * writing about the same agent cannot move what POD says of it.
 */
export async function feedbackFrom(client: PublicClient, agentId: bigint, writer: Address, at: Registries = MONAD_REGISTRIES): Promise<readonly FeedbackRead[]> {
  const [, , values, , tags, units] = await client.readContract({
    address: at.reputation, abi: reputationAbi, functionName: "readAllFeedback",
    args: [agentId, [writer], "", SCORE_TAG, false],
  });
  return values.map((value, index) => ({ score: Number(value), tag: tags[index] ?? "" })).filter((_, index) => units[index] === SCORE_TAG);
}

/** What the registry says about one request: who answered, with what, and under which tag. */
export async function verdictOnChain(client: PublicClient, key: Hex, at: Registries = MONAD_REGISTRIES): Promise<{
  readonly validator: Address;
  readonly agentId: bigint;
  readonly response: number;
  /** all zeroes until the named runner has answered: every answer we send carries the receipt's hash */
  readonly responseHash: Hex;
  readonly tag: string;
  readonly lastUpdate: bigint;
}> {
  const [validator, agentId, response, responseHash, tag, lastUpdate] = await client.readContract({
    address: at.validation,
    abi: validationAbi,
    functionName: "getValidationStatus",
    args: [key],
  });
  return { validator, agentId, response, responseHash, tag, lastUpdate };
}

/**
 * The wallet an agent says it acts with, which the registry records on its identity: a seat is held
 * by a key, and this is how an identity names its key. The zero address when none was set.
 */
export async function agentWalletOf(client: PublicClient, agentId: bigint, at: Registries = MONAD_REGISTRIES): Promise<Address> {
  return client.readContract({ address: at.identity, abi: identityAbi, functionName: "getAgentWallet", args: [agentId] });
}
