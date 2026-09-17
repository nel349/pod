// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { PodJobs } from "../src/PodJobs.sol";

contract PodJobsTest is Test {
    PodJobs jobs;
    address validator;
    address poster;

    address leadAgent;
    address builderAgent;
    address reviewerAgent;
    address qaAgent;
    address securityAgent;

    address leadOwner;
    address builderOwner;
    address reviewerOwner;
    address qaOwner;
    address securityOwner;

    bytes32 constant SEAL = keccak256("a site that rates my excuses");
    bytes32 constant COMMIT = keccak256("c0ffee");
    uint256 constant PRICE = 20 ether;

    function setUp() public {
        validator = makeAddr("validator");
        poster = makeAddr("poster");
        leadAgent = makeAddr("leadAgent");
        builderAgent = makeAddr("builderAgent");
        reviewerAgent = makeAddr("reviewerAgent");
        qaAgent = makeAddr("qaAgent");
        securityAgent = makeAddr("securityAgent");
        leadOwner = makeAddr("leadOwner");
        builderOwner = makeAddr("builderOwner");
        reviewerOwner = makeAddr("reviewerOwner");
        qaOwner = makeAddr("qaOwner");
        securityOwner = makeAddr("securityOwner");

        jobs = new PodJobs(validator);
        vm.deal(poster, 100 ether);
        address[5] memory agents = [leadAgent, builderAgent, reviewerAgent, qaAgent, securityAgent];
        for (uint256 i; i < agents.length; i++) vm.deal(agents[i], 10 ether);
    }

    function _post() internal returns (uint256 id) {
        vm.prank(poster);
        id = jobs.post{ value: PRICE }(SEAL, uint64(block.timestamp + 2 hours), 1);
    }

    /// @dev the deposit is read BEFORE the prank: a view call in the same expression would eat it,
    ///      and the seat would end up belonging to this test contract instead of the agent.
    function _take(uint256 id, PodJobs.Role role, address agent, address owner) internal {
        uint256 deposit = jobs.seatDeposit(id, role);
        vm.prank(agent);
        jobs.takeSeat{ value: deposit }(id, role, owner);
    }

    function _fillEverySeat(uint256 id) internal {
        _take(id, PodJobs.Role.Lead, leadAgent, leadOwner);
        _take(id, PodJobs.Role.Builder, builderAgent, builderOwner);
        _take(id, PodJobs.Role.Reviewer, reviewerAgent, reviewerOwner);
        _take(id, PodJobs.Role.QA, qaAgent, qaOwner);
        _take(id, PodJobs.Role.Security, securityAgent, securityOwner);
    }

    function _approveAll(uint256 id, bytes32 commitHash) internal {
        vm.prank(leadAgent); jobs.approve(id, PodJobs.Role.Lead, commitHash);
        vm.prank(reviewerAgent); jobs.approve(id, PodJobs.Role.Reviewer, commitHash);
        vm.prank(qaAgent); jobs.approve(id, PodJobs.Role.QA, commitHash);
        vm.prank(securityAgent); jobs.approve(id, PodJobs.Role.Security, commitHash);
    }

    function test_theSharesAddUpToThePrice() public {
        uint256 id = _post();
        uint256 total = jobs.seatPay(id, PodJobs.Role.Lead) + jobs.seatPay(id, PodJobs.Role.Builder)
            + jobs.seatPay(id, PodJobs.Role.Reviewer) + jobs.seatPay(id, PodJobs.Role.QA)
            + jobs.seatPay(id, PodJobs.Role.Security);
        assertEq(total, PRICE);
    }

    function test_aSeatIsPaidAndItsDepositReturned() public {
        uint256 id = _post();
        _fillEverySeat(id);
        _approveAll(id, COMMIT);

        uint256 before = builderAgent.balance;
        uint256 pay = jobs.seatPay(id, PodJobs.Role.Builder);
        uint256 deposit = jobs.seatDeposit(id, PodJobs.Role.Builder);
        vm.prank(validator);
        jobs.settle(id, COMMIT, true);
        assertEq(builderAgent.balance, before + pay + deposit);
    }

    function test_oneOwnerCannotHoldTwoSeats() public {
        uint256 id = _post();
        _take(id, PodJobs.Role.Lead, leadAgent, leadOwner);
        uint256 deposit = jobs.seatDeposit(id, PodJobs.Role.Builder);
        vm.prank(builderAgent);
        vm.expectRevert(PodJobs.OwnerAlreadySeated.selector);
        jobs.takeSeat{ value: deposit }(id, PodJobs.Role.Builder, leadOwner);
    }

    function test_aSeatIsFirstComeFirstServed() public {
        uint256 id = _post();
        _take(id, PodJobs.Role.Lead, leadAgent, leadOwner);
        uint256 deposit = jobs.seatDeposit(id, PodJobs.Role.Lead);
        vm.prank(builderAgent);
        vm.expectRevert(PodJobs.SeatFilled.selector);
        jobs.takeSeat{ value: deposit }(id, PodJobs.Role.Lead, builderOwner);
    }

    function test_theDepositMustBeExact() public {
        uint256 id = _post();
        vm.prank(leadAgent);
        vm.expectRevert(PodJobs.WrongDeposit.selector);
        jobs.takeSeat{ value: 1 }(id, PodJobs.Role.Lead, leadOwner);
    }

    function test_nobodyIsPaidWithoutTheSecuritySeat() public {
        uint256 id = _post();
        _fillEverySeat(id);
        vm.prank(leadAgent); jobs.approve(id, PodJobs.Role.Lead, COMMIT);
        vm.prank(reviewerAgent); jobs.approve(id, PodJobs.Role.Reviewer, COMMIT);
        vm.prank(qaAgent); jobs.approve(id, PodJobs.Role.QA, COMMIT);
        // security has not signed
        vm.prank(validator);
        vm.expectRevert(PodJobs.PolicyNotMet.selector);
        jobs.settle(id, COMMIT, true);
    }

    function test_nobodyIsPaidWithoutTheCodeowner() public {
        uint256 id = _post();
        _fillEverySeat(id);
        vm.prank(reviewerAgent); jobs.approve(id, PodJobs.Role.Reviewer, COMMIT);
        vm.prank(qaAgent); jobs.approve(id, PodJobs.Role.QA, COMMIT);
        vm.prank(securityAgent); jobs.approve(id, PodJobs.Role.Security, COMMIT);
        vm.prank(validator);
        vm.expectRevert(PodJobs.PolicyNotMet.selector);
        jobs.settle(id, COMMIT, true);
    }

    function test_aPushAfterApprovalInvalidatesEveryApproval() public {
        uint256 id = _post();
        _fillEverySeat(id);
        _approveAll(id, COMMIT);
        assertTrue(jobs.policyMet(id, COMMIT));

        bytes32 laterCommit = keccak256("pushed again");
        vm.prank(builderAgent);
        jobs.approve(id, PodJobs.Role.Builder, laterCommit);

        assertFalse(jobs.policyMet(id, laterCommit), "approvals must be redone on the new commit");
        assertFalse(jobs.policyMet(id, COMMIT), "the old commit is no longer the one being judged");
    }

    function test_onlyTheValidatorCanReportAVerdict() public {
        uint256 id = _post();
        _fillEverySeat(id);
        _approveAll(id, COMMIT);
        vm.prank(poster);
        vm.expectRevert(PodJobs.NotValidator.selector);
        jobs.settle(id, COMMIT, true);
    }

    function test_aFailingVerdictRefundsThePosterAndReturnsDeposits() public {
        uint256 id = _post();
        _fillEverySeat(id);
        _approveAll(id, COMMIT);

        uint256 posterBefore = poster.balance;
        uint256 leadBefore = leadAgent.balance;
        uint256 leadDeposit = jobs.seatDeposit(id, PodJobs.Role.Lead);
        vm.prank(validator);
        jobs.settle(id, COMMIT, false);

        assertEq(poster.balance, posterBefore + PRICE);
        assertEq(leadAgent.balance, leadBefore + leadDeposit);
    }

    function test_approvalsAloneDoNotPay() public {
        uint256 id = _post();
        _fillEverySeat(id);
        _approveAll(id, COMMIT);
        // no verdict has been reported at all
        assertEq(uint8(_state(id)), uint8(PodJobs.State.Working));
    }

    function test_thePosterTakesTheMoneyBackAfterTheWindow() public {
        uint256 id = _post();
        _fillEverySeat(id);
        vm.warp(block.timestamp + 3 hours);

        uint256 posterBefore = poster.balance;
        vm.prank(poster);
        jobs.reclaim(id);
        assertEq(poster.balance, posterBefore + PRICE);
    }

    function test_nothingSettlesAfterTheWindow() public {
        uint256 id = _post();
        _fillEverySeat(id);
        _approveAll(id, COMMIT);
        vm.warp(block.timestamp + 3 hours);
        vm.prank(validator);
        vm.expectRevert(PodJobs.TooLate.selector);
        jobs.settle(id, COMMIT, true);
    }

    function test_theContractKeepsNothing() public {
        uint256 id = _post();
        _fillEverySeat(id);
        _approveAll(id, COMMIT);
        vm.prank(validator);
        jobs.settle(id, COMMIT, true);
        assertEq(address(jobs).balance, 0, "every last wei went somewhere");
    }

    function _state(uint256 id) internal view returns (PodJobs.State s) {
        (, , , , s, , ) = jobs.jobs(id);
    }
}
