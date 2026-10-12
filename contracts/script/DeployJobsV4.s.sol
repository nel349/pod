// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script } from "forge-std/Script.sol";
import { PodJobsV3 } from "../src/PodJobsV3.sol";
import { PodJobsV4 } from "../src/PodJobsV4.sol";

/// @notice Deploy the jobs contract on which the lead names who is paid, and nothing else: the title
///         contract and its address stay as they are, since titles are numbered by the job's number
///         and this contract continues the numbering of the one it replaces.
/// @dev Every value is read from the environment, with no defaults, as Deploy.s.sol explains:
///      POD_DEPLOYER_KEY pays for it; POD_VALIDATOR_ADDRESS reports what the checks found and is paid
///      for writings, and must be the validator of the contract being replaced; POD_WRITER_ADDRESS
///      writes the checks, and must be that contract's writer, since the server holds one writer key;
///      POD_THIRD_JOBS_ADDRESS is the contract whose next number this one starts from, read at the
///      moment of deploying, after posting to it has been closed; POD_WRITING_PRICE_WEI is what one
///      writing costs; POD_PAYOUT_GAS is the gas sent with every payment; POD_ANSWER_SECONDS is how
///      long a poster has to accept or refuse a delivery.
contract DeployJobsV4 is Script {
    function run() external returns (PodJobsV4) {
        return deploy(
            vm.envUint("POD_DEPLOYER_KEY"),
            vm.envAddress("POD_VALIDATOR_ADDRESS"),
            vm.envAddress("POD_WRITER_ADDRESS"),
            PodJobsV3(vm.envAddress("POD_THIRD_JOBS_ADDRESS")),
            vm.envUint("POD_WRITING_PRICE_WEI"),
            vm.envUint("POD_PAYOUT_GAS"),
            uint64(vm.envUint("POD_ANSWER_SECONDS"))
        );
    }

    function deploy(
        uint256 deployer, address validator, address writer, PodJobsV3 third,
        uint256 writingPrice, uint256 payoutGas, uint64 answerSeconds
    ) public returns (PodJobsV4 jobs) {
        require(third.validator() == validator, "the new contract must answer to the validator of the one it replaces");
        require(third.writer() == writer, "the new contract must take checks from the writer of the one it replaces");
        require(answerSeconds >= 1 hours, "a poster needs at least an hour to answer");
        require(answerSeconds <= 30 days, "a poster has at most thirty days to answer: POD_ANSWER_SECONDS is in seconds");
        require(payoutGas <= 500_000, "POD_PAYOUT_GAS is more than a payment can be sent with");

        uint256 firstJobId = third.nextJobId();
        vm.startBroadcast(deployer);
        jobs = new PodJobsV4(validator, writer, firstJobId, writingPrice, payoutGas, answerSeconds);
        vm.stopBroadcast();
    }
}
