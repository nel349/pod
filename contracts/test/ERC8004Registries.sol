// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Not a test and not ours: the ERC-8004 registries, imported here only so `forge build` compiles them
// and the TypeScript tests can deploy them on a local chain, as the ERC-8004 team's own tests do:
// a proxy, the minimal first version, then the upgrade to the registry itself.
import {HardhatMinimalUUPS} from "erc-8004/HardhatMinimalUUPS.sol";
import {ERC1967Proxy} from "erc-8004/ERC1967Proxy.sol";
import {IdentityRegistryUpgradeable} from "erc-8004/IdentityRegistryUpgradeable.sol";
import {ValidationRegistryUpgradeable} from "erc-8004/ValidationRegistryUpgradeable.sol";
