// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script } from "forge-std/Script.sol";
import { PodJobs } from "../src/PodJobs.sol";
import { PodJobsV2 } from "../src/PodJobsV2.sol";

/// @notice Deploy the jobs contract that replaces PodJobs for new jobs, and nothing else: the title
///         contract and its address stay as they are, since titles are numbered by the job's number
///         and the new contract continues the old one's numbering.
/// @dev Every value is read from the environment, with no defaults, as Deploy.s.sol explains:
///      POD_DEPLOYER_KEY pays for it; POD_VALIDATOR_ADDRESS grades and is paid for writings, and must
///      be the old contract's validator; POD_WRITER_ADDRESS writes the checks; POD_OLD_JOBS_ADDRESS is
///      the contract whose next number this one starts from, read at the moment of deploying, after
///      posting to it has been closed; POD_WRITING_PRICE_WEI is what one writing costs; POD_PAYOUT_GAS is
///      the gas sent with every payment, a payee that needs more withdrawing instead. 100,000 was tried
///      on Monad testnet with a wallet behind a proxy before the switch-over (V4, TryPayoutGas.s.sol).
contract DeployJobsV2 is Script {
    function run() external returns (PodJobsV2) {
        return deploy(
            vm.envUint("POD_DEPLOYER_KEY"),
            vm.envAddress("POD_VALIDATOR_ADDRESS"),
            vm.envAddress("POD_WRITER_ADDRESS"),
            PodJobs(vm.envAddress("POD_OLD_JOBS_ADDRESS")),
            vm.envUint("POD_WRITING_PRICE_WEI"),
            vm.envUint("POD_PAYOUT_GAS")
        );
    }

    function deploy(uint256 deployer, address validator, address writer, PodJobs old, uint256 writingPrice, uint256 payoutGas)
        public
        returns (PodJobsV2 jobs)
    {
        require(old.validator() == validator, "the new contract must answer to the old one's validator");
        require(writer != validator, "the writer is its own key, so the validator's never lives on the web server");

        uint256 firstJobId = old.nextJobId();
        vm.startBroadcast(deployer);
        jobs = new PodJobsV2(validator, writer, firstJobId, writingPrice, payoutGas);
        vm.stopBroadcast();
    }
}
