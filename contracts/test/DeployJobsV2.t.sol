// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { PodJobs } from "../src/PodJobs.sol";
import { PodJobsV2 } from "../src/PodJobsV2.sol";
import { DeployJobsV2 } from "../script/DeployJobsV2.s.sol";

contract DeployJobsV2Test is Test {
    PodJobs old;
    address validator;
    address writer;
    uint256 deployerKey;

    function setUp() public {
        validator = makeAddr("validator");
        writer = makeAddr("writer");
        (, deployerKey) = makeAddrAndKey("deployer");
        old = new PodJobs(validator);

        // two jobs already on the old contract
        address poster = makeAddr("poster");
        vm.deal(poster, 10 ether);
        vm.startPrank(poster);
        old.post{ value: 1 ether }(keccak256("one"), uint64(block.timestamp + 1 hours), 1);
        old.post{ value: 1 ether }(keccak256("two"), uint64(block.timestamp + 1 hours), 1);
        vm.stopPrank();
    }

    function test_theNewContractContinuesTheOldNumbering_withItsSettings() public {
        // the only test that touches the environment, which every test in the run shares
        vm.setEnv("POD_DEPLOYER_KEY", vm.toString(deployerKey));
        vm.setEnv("POD_VALIDATOR_ADDRESS", vm.toString(validator));
        vm.setEnv("POD_WRITER_ADDRESS", vm.toString(writer));
        vm.setEnv("POD_OLD_JOBS_ADDRESS", vm.toString(address(old)));
        vm.setEnv("POD_WRITING_PRICE_WEI", "50000000000000000");

        PodJobsV2 jobs = new DeployJobsV2().run();
        assertEq(jobs.nextJobId(), 3, "the old contract's next number");
        assertEq(jobs.validator(), validator);
        assertEq(jobs.writer(), writer);
        assertEq(jobs.writingPrice(), 0.05 ether);
        assertEq(jobs.payoutGas(), 100_000);
    }

    function test_aDifferentValidatorIsRefused() public {
        DeployJobsV2 script = new DeployJobsV2();
        vm.expectRevert("the new contract must answer to the old one's validator");
        script.deploy(deployerKey, makeAddr("somebody else"), writer, old, 0.05 ether);
    }

    function test_theWriterCannotBeTheValidator() public {
        DeployJobsV2 script = new DeployJobsV2();
        vm.expectRevert("the writer is its own key, so the validator's never lives on the web server");
        script.deploy(deployerKey, validator, validator, old, 0.05 ether);
    }
}
