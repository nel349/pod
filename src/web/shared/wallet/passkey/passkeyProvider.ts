/**
 * The passkey wallet as a wallet in the page, answering the page the way a browser wallet does.
 *
 * A page asks to send or sign as an address: the wallet that paid for a job, say. A browser wallet
 * signs for its own addresses and refuses others; this does the same with the key the page holds,
 * when the address is the open passkey wallet's. Everything else, reading the chain, goes to the
 * market's node. So every page, and every way wagmi asks, works with either wallet unchanged.
 */
import {
  hexToBigInt, hexToNumber, http, isAddress, isAddressEqual, isHex, numberToHex,
  SwitchChainError, UnauthorizedProviderError, UnsupportedProviderMethodError,
  type Address, type Chain, type EIP1193Parameters, type Hex, type LocalAccount,
} from "viem";
import { z } from "zod";
import { heldPasskeyWallet } from "./held.ts";
import { sendWithCare, type Sending } from "./sending.ts";

/** Asked to sign as an address that is not the open passkey wallet's, or with none open. */
export class NotThisPasskeyWallet extends Error {
  constructor(asked: Address, held: Address | undefined) {
    super(held ? `the passkey wallet open is ${held}, not ${asked}` : `no passkey wallet is open to sign as ${asked}`);
  }
}

const HexSchema = z.custom<Hex>((value) => typeof value === "string" && isHex(value), "not hex");
const AddressSchema = z.custom<Address>((value) => typeof value === "string" && isAddress(value, { strict: false }), "not an address");

/** a transaction as a page asks for it; what it leaves out, the node is asked for */
const TransactionSchema = z.object({
  from: AddressSchema,
  to: AddressSchema.optional(),
  data: HexSchema.optional(),
  value: HexSchema.optional(),
  gas: HexSchema.optional(),
  nonce: HexSchema.optional(),
  maxFeePerGas: HexSchema.optional(),
  maxPriorityFeePerGas: HexSchema.optional(),
});
const SendSchema = z.tuple([TransactionSchema]);
/** personal_sign: the message, as hex, then the address asked to sign it */
const SignSchema = z.tuple([HexSchema, AddressSchema]);
const SwitchSchema = z.tuple([z.object({ chainId: HexSchema })]);

/** The key that signs as this address: the open passkey wallet's, or nobody's. */
function signerFor(address: Address): LocalAccount {
  const held = heldPasskeyWallet()?.account;
  if (!held || !isAddressEqual(address, held.address)) throw new UnauthorizedProviderError(new NotThisPasskeyWallet(address, held?.address));
  return held;
}

export interface PasskeyProvider {
  readonly request: (asked: EIP1193Parameters) => Promise<unknown>;
}

/**
 * The wallet in the page for this chain, reading through its node.
 *
 * @param sending what the chain's endpoint needs allowing for when a payment is sent through it
 */
export function passkeyProvider(chain: Chain, sending?: Sending): PasskeyProvider {
  const node = http(chain.rpcUrls.default.http[0])({ chain, retryCount: 0 });

  return {
    async request(asked) {
      const { method, params } = asked;
      switch (method) {
        case "eth_accounts":
        case "eth_requestAccounts": {
          const held = heldPasskeyWallet();
          return held ? [held.account.address] : [];
        }
        case "eth_chainId":
          return numberToHex(chain.id);
        case "wallet_switchEthereumChain": {
          const [{ chainId }] = SwitchSchema.parse(params);
          if (hexToNumber(chainId) !== chain.id) throw new SwitchChainError(new Error(`this wallet is for ${chain.name} only`));
          return null;
        }
        case "eth_sendTransaction": {
          const [sent] = SendSchema.parse(params);
          return sendWithCare(signerFor(sent.from), chain, {
            to: sent.to,
            data: sent.data,
            value: sent.value === undefined ? undefined : hexToBigInt(sent.value),
            gas: sent.gas === undefined ? undefined : hexToBigInt(sent.gas),
            nonce: sent.nonce === undefined ? undefined : hexToNumber(sent.nonce),
            maxFeePerGas: sent.maxFeePerGas === undefined ? undefined : hexToBigInt(sent.maxFeePerGas),
            maxPriorityFeePerGas: sent.maxPriorityFeePerGas === undefined ? undefined : hexToBigInt(sent.maxPriorityFeePerGas),
          }, sending);
        }
        case "personal_sign": {
          const [message, address] = SignSchema.parse(params);
          return signerFor(address).signMessage({ message: { raw: message } });
        }
        // no page signs anything else; a request for it is refused rather than half done
        case "eth_sign":
        case "eth_signTransaction":
        case "eth_signTypedData_v4":
        case "wallet_sendTransaction":
        case "wallet_sendCalls":
          throw new UnsupportedProviderMethodError(new Error(`the passkey wallet does not do ${method}`), { method });
        default:
          return node.request(asked);
      }
    },
  };
}
