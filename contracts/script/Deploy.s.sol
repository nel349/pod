// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script } from "forge-std/Script.sol";
import { PodJobs } from "../src/PodJobs.sol";

/// @notice Deploy PodJobs with the address that will report verdicts.
/// @dev Both values are read from the environment so nothing about a deployment is hidden in code:
///      PRIVATE_KEY pays for it, POD_VALIDATOR is the only address the contract will accept a
///      verdict from. There is no default for either: a deployment nobody chose is a deployment
///      nobody can explain later.
contract Deploy is Script {
    function run() external returns (PodJobs deployed) {
        uint256 deployer = vm.envUint("PRIVATE_KEY");
        address validator = vm.envAddress("POD_VALIDATOR");

        vm.startBroadcast(deployer);
        deployed = new PodJobs(validator);
        vm.stopBroadcast();
    }
}
