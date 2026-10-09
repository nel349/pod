/**
 * Sending everything an address holds back to its owner.
 *
 * A payment's gas is paid by the address that sends it, so "everything" is what it holds less the most
 * that gas can cost. Monad charges for the gas a payment allows itself, not the gas it uses, so the
 * gas is stated exactly and the fee is fixed before the sum is worked out: what is sent and what the
 * gas costs then add up to what the address held, and it is left with nothing.
 */

/** the gas a plain payment from one wallet to another takes, on every EVM chain */
export const PLAIN_PAYMENT_GAS = 21_000n;

/** What an address can send when it sends everything at this fee for each unit of gas: nothing, when it could not pay for the sending. */
export function allButTheGas(holds: bigint, feePerGas: bigint): bigint {
  const gasCosts = PLAIN_PAYMENT_GAS * feePerGas;
  return holds > gasCosts ? holds - gasCosts : 0n;
}
