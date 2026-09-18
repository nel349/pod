// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script } from "forge-std/Script.sol";
import { PodJobs } from "../src/PodJobs.sol";
import { PodToken } from "../src/PodToken.sol";

/// @notice Deploy the two contracts a job passes through, both answering to the same validator.
/// @dev Both values are read from the environment so nothing about a deployment is hidden in code:
///      POD_DEPLOYER_KEY pays for it, POD_VALIDATOR_ADDRESS is the only address the contracts will
///      accept a verdict from. There is no default for either: a deployment nobody chose is a
///      deployment nobody can explain later. Both live in a gitignored .env.
contract Deploy is Script {
    function run() external returns (PodJobs jobs, PodToken token) {
        uint256 deployer = vm.envUint("POD_DEPLOYER_KEY");
        address validator = vm.envAddress("POD_VALIDATOR_ADDRESS");

        vm.startBroadcast(deployer);
        jobs = new PodJobs(validator);
        token = new PodToken(validator);
        vm.stopBroadcast();
    }
}
