// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { PodJobsV3 } from "../src/PodJobsV3.sol";
import { PodJobsV4 } from "../src/PodJobsV4.sol";
import { DeployJobsV4 } from "../script/DeployJobsV4.s.sol";

contract DeployJobsV4Test is Test {
    PodJobsV3 third;
    address validator;
    address writer;
    uint256 deployerKey;

    uint256 constant FIRST_ON_THE_THIRD = 20;

    function setUp() public {
        validator = makeAddr("validator");
        writer = makeAddr("writer");
        (, deployerKey) = makeAddrAndKey("deployer");
        third = new PodJobsV3(validator, writer, FIRST_ON_THE_THIRD, 0.05 ether, 100_000, 3 days);

        // two jobs already on the contract being replaced
        address poster = makeAddr("poster");
        vm.deal(poster, 10 ether);
        vm.startPrank(poster);
        third.post{ value: 1 ether }(1 hours, 1);
        third.post{ value: 1 ether }(1 hours, 1);
        vm.stopPrank();
    }

    function test_theNewContractContinuesTheNumbering_withItsSettings() public {
        // the only test here that touches the environment, which every test in the run shares: the
        // values every deployment's test sets are the same ones, so none can read another's
        vm.setEnv("POD_DEPLOYER_KEY", vm.toString(deployerKey));
        vm.setEnv("POD_VALIDATOR_ADDRESS", vm.toString(validator));
        vm.setEnv("POD_WRITER_ADDRESS", vm.toString(writer));
        vm.setEnv("POD_THIRD_JOBS_ADDRESS", vm.toString(address(third)));
        vm.setEnv("POD_WRITING_PRICE_WEI", "50000000000000000");
        vm.setEnv("POD_PAYOUT_GAS", "100000");
        vm.setEnv("POD_ANSWER_SECONDS", "259200");

        PodJobsV4 jobs = new DeployJobsV4().run();
        assertEq(jobs.nextJobId(), FIRST_ON_THE_THIRD + 2, "the next number of the contract it replaces");
        assertEq(jobs.validator(), validator);
        assertEq(jobs.writer(), writer);
        assertEq(jobs.writingPrice(), 0.05 ether);
        assertEq(jobs.payoutGas(), 100_000);
        assertEq(jobs.answerTime(), 3 days);
        assertEq(jobs.REVIEW_SHARE_PERCENT(), 25);
        assertEq(jobs.REFUSAL_SHARE_PERCENT(), 25);
        // and it is the contract on which the lead names who is paid: the third has no such question to ask
        assertFalse(jobs.concluded(FIRST_ON_THE_THIRD + 2));
        (bool isThere, ) = address(third).staticcall(abi.encodeWithSignature("concluded(uint256)", FIRST_ON_THE_THIRD));
        assertFalse(isThere);
    }

    function test_aDifferentValidatorIsRefused() public {
        DeployJobsV4 script = new DeployJobsV4();
        vm.expectRevert("the new contract must answer to the validator of the one it replaces");
        script.deploy(deployerKey, makeAddr("somebody else"), writer, third, 0.05 ether, 100_000, 3 days);
    }

    function test_aDifferentWriterIsRefused() public {
        DeployJobsV4 script = new DeployJobsV4();
        vm.expectRevert("the new contract must take checks from the writer of the one it replaces");
        script.deploy(deployerKey, validator, makeAddr("another writer"), third, 0.05 ether, 100_000, 3 days);
    }

    function test_aPosterIsGivenAtLeastAnHourToAnswer() public {
        DeployJobsV4 script = new DeployJobsV4();
        vm.expectRevert("a poster needs at least an hour to answer");
        script.deploy(deployerKey, validator, writer, third, 0.05 ether, 100_000, 59 minutes);
    }

    function test_aSlipOfAUnitIsRefusedBeforeAnythingIsSent() public {
        DeployJobsV4 script = new DeployJobsV4();
        // milliseconds for seconds
        vm.expectRevert("a poster has at most thirty days to answer: POD_ANSWER_SECONDS is in seconds");
        script.deploy(deployerKey, validator, writer, third, 0.05 ether, 100_000, 259_200_000);
        vm.expectRevert("POD_PAYOUT_GAS is more than a payment can be sent with");
        script.deploy(deployerKey, validator, writer, third, 0.05 ether, 500_001, 3 days);
    }
}
