/**
 * The handover: whoever holds the POD can claim the repository.
 *
 * The token is the title. This is what makes that mean something: the holder proves they hold it by
 * signing a sentence with the wallet that owns it, and the repository is transferred to the account
 * they name.
 *
 * A claim rather than a push, because a repository cannot be handed to somebody who has not accepted
 * it — that is GitHub's rule, not ours. And a signature rather than a login, because the thing that
 * decides ownership is already on chain and asking somebody to make an account here would be asking
 * them to trust us with something they already hold.
 */
import { verifyMessage, type Address, type Hex } from "viem";
import { podTokenAbi } from "./token.ts";
import type { Contract } from "./jobs.ts";
import type { Published } from "./github.ts";
import { claimToSign } from "./messages.ts";

export { claimToSign };

export interface Claim {
  readonly jobId: string;
  readonly tokenId: bigint;
  readonly toAccount: string;
  readonly signature: Hex;
}

export interface ClaimOutcome {
  readonly allowed: boolean;
  /** the address that signed, whether or not it was the right one */
  readonly signedBy?: Address;
  readonly holder?: Address;
  readonly why?: string;
}

/**
 * Whether a claim is good: the signature has to be the current holder's.
 *
 * Current, not the one who paid. A sold POD carries the repository, so the check reads the owner now
 * rather than remembering who it was.
 */
export async function checkClaim(token: Omit<Contract, "wallet">, claim: Claim): Promise<ClaimOutcome> {
  let signedBy: Address;
  try {
    const message = claimToSign(claim);
    const valid = await verifyMessage({
      address: await holderOf(token, claim.tokenId),
      message,
      signature: claim.signature,
    });
    if (!valid) {
      signedBy = await recover(message, claim.signature);
      return {
        allowed: false,
        signedBy,
        holder: await holderOf(token, claim.tokenId),
        why: "that signature is not the holder's",
      };
    }
  } catch (error) {
    return { allowed: false, why: (error as Error).message };
  }

  const holder = await holderOf(token, claim.tokenId);
  return { allowed: true, holder, signedBy: holder };
}

async function recover(message: string, signature: Hex): Promise<Address> {
  const { recoverMessageAddress } = await import("viem");
  return recoverMessageAddress({ message, signature });
}

/** Who holds the title right now. */
export async function holderOf(token: Omit<Contract, "wallet">, tokenId: bigint): Promise<Address> {
  return token.publicClient.readContract({
    address: token.address, abi: podTokenAbi, functionName: "ownerOf", args: [tokenId],
  });
}

/**
 * Hand the repository over, once the claim is good.
 *
 * The transfer is an invitation: GitHub sends it to the account named, and it belongs to them when
 * they accept. Until then it is still ours, which is worth saying on the page rather than claiming
 * the handover is finished the moment somebody clicks.
 */
export async function transfer(to: Published, account: string): Promise<{ readonly invited: string }> {
  const { transferRepository } = await import("./github.ts");
  await transferRepository(to, account);
  return { invited: account };
}
