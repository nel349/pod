/**
 * The ERC-8004 registries, on a local chain, deployed the way the ERC-8004 team's own tests deploy
 * them: a proxy, their minimal first version, then the upgrade to the registry itself. The code is
 * theirs, pinned in contracts/lib; only the deploying is ours.
 */
import { encodeFunctionData, getAddress, parseAbi, type Address, type Hex } from "viem";
import type { Registries } from "../../registry.ts";
import { ANVIL_KEYS, type Anvil } from "./anvil.ts";

const firstVersion = parseAbi(["function initialize(address identityRegistry_)"]);
const upgradeable = parseAbi(["function upgradeToAndCall(address newImplementation, bytes data) payable"]);
const identityInitialize = parseAbi(["function initialize()"]);
const validationInitialize = parseAbi(["function initialize(address identityRegistry_)"]);

export async function deployRegistries(anvil: Anvil, by: Hex = ANVIL_KEYS[0]): Promise<Registries> {
  const wallet = anvil.wallet(by);
  const upgrade = async (proxy: Address, implementation: Address, data: Hex): Promise<void> => {
    const hash = await wallet.writeContract({
      address: proxy, abi: upgradeable, functionName: "upgradeToAndCall", args: [implementation, data],
      account: wallet.account!, chain: wallet.chain,
    });
    const receipt = await anvil.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`the upgrade of ${proxy} was refused`);
  };

  const minimal = await anvil.deploy("HardhatMinimalUUPS", [], by);
  const identity = await anvil.deploy("ERC1967Proxy", [minimal, encodeFunctionData({ abi: firstVersion, functionName: "initialize", args: ["0x0000000000000000000000000000000000000000"] })], by);
  await upgrade(identity, await anvil.deploy("IdentityRegistryUpgradeable", [], by), encodeFunctionData({ abi: identityInitialize, functionName: "initialize" }));

  const validation = await anvil.deploy("ERC1967Proxy", [minimal, encodeFunctionData({ abi: firstVersion, functionName: "initialize", args: [identity] })], by);
  await upgrade(validation, await anvil.deploy("ValidationRegistryUpgradeable", [], by), encodeFunctionData({ abi: validationInitialize, functionName: "initialize", args: [identity] }));
  return { identity: getAddress(identity), validation: getAddress(validation) };
}
