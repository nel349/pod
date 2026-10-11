// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { PodJobsV2 } from "../src/PodJobsV2.sol";
import { PodJobsV3 } from "../src/PodJobsV3.sol";
import { DeployJobsV3 } from "../script/DeployJobsV3.s.sol";

contract DeployJobsV3Test is Test {
    PodJobsV2 second;
    address validator;
    address writer;
    uint256 deployerKey;

    uint256 constant FIRST_ON_THE_SECOND = 10;

    function setUp() public {
        validator = makeAddr("validator");
        writer = makeAddr("writer");
        (, deployerKey) = makeAddrAndKey("deployer");
        second = new PodJobsV2(validator, writer, FIRST_ON_THE_SECOND, 0.05 ether, 100_000);

        // two jobs already on the contract being replaced
        address poster = makeAddr("poster");
        vm.deal(poster, 10 ether);
        vm.startPrank(poster);
        second.post{ value: 1 ether }(1 hours, 1);
        second.post{ value: 1 ether }(1 hours, 1);
        vm.stopPrank();
    }

    function test_theNewContractContinuesTheNumbering_withItsSettings() public {
        // the only test here that touches the environment, which every test in the run shares
        vm.setEnv("POD_DEPLOYER_KEY", vm.toString(deployerKey));
        vm.setEnv("POD_VALIDATOR_ADDRESS", vm.toString(validator));
        vm.setEnv("POD_WRITER_ADDRESS", vm.toString(writer));
        vm.setEnv("POD_SECOND_JOBS_ADDRESS", vm.toString(address(second)));
        vm.setEnv("POD_WRITING_PRICE_WEI", "50000000000000000");
        vm.setEnv("POD_PAYOUT_GAS", "100000");
        vm.setEnv("POD_ANSWER_SECONDS", "259200");

        PodJobsV3 jobs = new DeployJobsV3().run();
        assertEq(jobs.nextJobId(), FIRST_ON_THE_SECOND + 2, "the next number of the contract it replaces");
        assertEq(jobs.validator(), validator);
        assertEq(jobs.writer(), writer);
        assertEq(jobs.writingPrice(), 0.05 ether);
        assertEq(jobs.payoutGas(), 100_000);
        assertEq(jobs.answerTime(), 3 days);
        assertEq(jobs.REVIEW_SHARE_PERCENT(), 25);
    }

    function test_aDifferentValidatorIsRefused() public {
        DeployJobsV3 script = new DeployJobsV3();
        vm.expectRevert("the new contract must answer to the validator of the one it replaces");
        script.deploy(deployerKey, makeAddr("somebody else"), writer, second, 0.05 ether, 100_000, 3 days);
    }

    function test_aDifferentWriterIsRefused() public {
        DeployJobsV3 script = new DeployJobsV3();
        vm.expectRevert("the new contract must take checks from the writer of the one it replaces");
        script.deploy(deployerKey, validator, makeAddr("another writer"), second, 0.05 ether, 100_000, 3 days);
    }

    function test_aPosterIsGivenAtLeastAnHourToAnswer() public {
        DeployJobsV3 script = new DeployJobsV3();
        vm.expectRevert("a poster needs at least an hour to answer");
        script.deploy(deployerKey, validator, writer, second, 0.05 ether, 100_000, 59 minutes);
    }

    function test_aSlipOfAUnitIsRefusedBeforeAnythingIsSent() public {
        DeployJobsV3 script = new DeployJobsV3();
        // milliseconds for seconds
        vm.expectRevert("a poster has at most thirty days to answer: POD_ANSWER_SECONDS is in seconds");
        script.deploy(deployerKey, validator, writer, second, 0.05 ether, 100_000, 259_200_000);
        vm.expectRevert("POD_PAYOUT_GAS is more than a payment can be sent with");
        script.deploy(deployerKey, validator, writer, second, 0.05 ether, 500_001, 3 days);
    }
}
