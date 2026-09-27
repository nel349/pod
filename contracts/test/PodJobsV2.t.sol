// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { PodJobsV2 } from "../src/PodJobsV2.sol";

/// @dev a payee that will not be paid
contract Refuser {
    receive() external payable { revert("not taking it"); }
}

/// @dev a payee that uses up every bit of gas it is sent
contract GasBurner {
    receive() external payable { while (true) {} }
}

/// @dev a payee that takes the money and answers with as much data as it can afford
contract Flood {
    receive() external payable {
        assembly { return(0, 65536) }
    }
}

/// @dev a poster that, on being refunded, tries to take the same money back again
contract GreedyPoster {
    PodJobsV2 immutable jobs;
    uint256 public jobId;
    uint256 public triedAgain;

    constructor(PodJobsV2 jobs_) { jobs = jobs_; }

    function post(uint64 window) external payable { jobId = jobs.post{ value: msg.value }(window, 1); }

    function takeBack() external { jobs.takeBack(jobId); }

    receive() external payable {
        triedAgain++;
        try jobs.takeBack(jobId) {} catch {}
    }
}

/// @dev What every test of the new contract shares: its parties, and how a job is walked through.
abstract contract PodJobsV2Fixture is Test {
    PodJobsV2 jobs;
    address validator;
    address writer;
    uint256 writerKey;
    address poster;
    address stranger;

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

    uint256 constant FIRST_JOB = 10;
    uint256 constant WRITING = 0.05 ether;
    uint256 constant PAYOUT_GAS = 100_000;
    uint256 constant PRICE = 20 ether;
    uint64 constant WINDOW = 2 hours;
    bytes32 constant SEAL = keccak256("a site that rates my excuses");
    bytes32 constant COMMIT = keccak256("c0ffee");
    bytes32 constant RECEIPT = keccak256("the signed receipt");

    function setUp() public virtual {
        validator = makeAddr("validator");
        (writer, writerKey) = makeAddrAndKey("writer");
        poster = makeAddr("poster");
        stranger = makeAddr("stranger");
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

        jobs = new PodJobsV2(validator, writer, FIRST_JOB, WRITING, PAYOUT_GAS);
        vm.deal(poster, 100 ether);
        vm.deal(stranger, 100 ether);
        address[5] memory agents = [leadAgent, builderAgent, reviewerAgent, qaAgent, securityAgent];
        for (uint256 i; i < agents.length; i++) vm.deal(agents[i], 10 ether);
    }

    function _post() internal returns (uint256 id) {
        vm.prank(poster);
        id = jobs.post{ value: PRICE + 3 * WRITING }(WINDOW, 1);
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest)));
        return abi.encodePacked(r, s, v);
    }

    function _written(uint256 id, bytes32 seal) internal view returns (bytes memory) {
        return _sign(writerKey, jobs.checksDigest(id, seal));
    }

    /// @dev one writing done and charged, as the server does it
    function _write(uint256 id) internal {
        vm.prank(writer);
        jobs.reserveWriting(id);
        vm.prank(writer);
        jobs.keepWriting(id);
    }

    function _open(uint256 id) internal {
        bytes memory signature = _written(id, SEAL);
        vm.prank(poster);
        jobs.approveChecks(id, SEAL, signature);
    }

    function _openJob() internal returns (uint256 id) {
        id = _post();
        _write(id);
        _open(id);
    }

    /// @dev the deposit is read BEFORE the prank: a view call in the same expression would eat it
    function _take(uint256 id, PodJobsV2.Role role, address agent, address owner) internal {
        uint256 deposit = jobs.seatDeposit(id, role);
        vm.prank(agent);
        jobs.takeSeat{ value: deposit }(id, role, owner);
    }

    function _fillEverySeat(uint256 id) internal {
        _take(id, PodJobsV2.Role.Lead, leadAgent, leadOwner);
        _take(id, PodJobsV2.Role.Builder, builderAgent, builderOwner);
        _take(id, PodJobsV2.Role.Reviewer, reviewerAgent, reviewerOwner);
        _take(id, PodJobsV2.Role.QA, qaAgent, qaOwner);
        _take(id, PodJobsV2.Role.Security, securityAgent, securityOwner);
    }

    function _approveAll(uint256 id, bytes32 commitHash) internal {
        vm.prank(leadAgent); jobs.approve(id, PodJobsV2.Role.Lead, commitHash);
        vm.prank(reviewerAgent); jobs.approve(id, PodJobsV2.Role.Reviewer, commitHash);
        vm.prank(qaAgent); jobs.approve(id, PodJobsV2.Role.QA, commitHash);
        vm.prank(securityAgent); jobs.approve(id, PodJobsV2.Role.Security, commitHash);
    }

    function _lockedJob() internal returns (uint256 id) {
        id = _openJob();
        _fillEverySeat(id);
        _approveAll(id, COMMIT);
    }

    function _settle(uint256 id, PodJobsV2.Verdict verdict) internal {
        vm.prank(validator);
        jobs.settle(id, COMMIT, verdict, RECEIPT);
    }

    function _state(uint256 id) internal view returns (PodJobsV2.State state) {
        (, , , , state, , , ) = jobs.jobs(id);
    }

    function _commit(uint256 id) internal view returns (bytes32 commit) {
        (, , , , , commit, , ) = jobs.jobs(id);
    }

    function _balance(uint256 id) internal view returns (uint256 balance) {
        (balance, , , ) = jobs.writings(id);
    }

    function _reserved(uint256 id) internal view returns (uint256 reserved) {
        (, reserved, , ) = jobs.writings(id);
    }

    function _kept(uint256 id) internal view returns (uint32 kept) {
        (, , , kept) = jobs.writings(id);
    }

    function _approved(uint256 id, PodJobsV2.Role role) internal view returns (bool) {
        return jobs.seatAt(id, role, 0).approved;
    }

    /// @dev What the contract still owes, worked out from what it says about every job it has
    ///      numbered: a job's price until it settles or is refunded, its writing money, every deposit
    ///      it still holds, and what payments could not deliver.
    function _stillOwed() internal view returns (uint256 total) {
        for (uint256 id = FIRST_JOB; id < jobs.nextJobId(); id++) {
            PodJobsV2.State state = _state(id);
            if (state == PodJobsV2.State.Preparing || state == PodJobsV2.State.Open || state == PodJobsV2.State.Working) {
                (, uint256 price, , , , , , ) = jobs.jobs(id);
                total += price;
            }
            total += _balance(id) + _reserved(id);
            for (uint8 r; r < 5; r++) {
                uint256 count = jobs.seatCount(id, PodJobsV2.Role(r));
                for (uint256 i; i < count; i++) total += jobs.seatAt(id, PodJobsV2.Role(r), i).deposit;
            }
        }
        total += jobs.totalOwed();
    }

    function _assertConserved() internal view {
        assertEq(address(jobs).balance, _stillOwed(), "the contract holds exactly what it still owes");
    }
}

contract PodJobsV2Test is PodJobsV2Fixture {
    // --- numbering and creating ---

    function test_numberingStartsWhereItIsTold() public {
        assertEq(_post(), FIRST_JOB);
        assertEq(_post(), FIRST_JOB + 1);
        assertEq(jobs.nextJobId(), FIRST_JOB + 2);
    }

    function test_oneJobIsPaidForOnceWithThreeWritings() public {
        uint256 id = _post();
        (address who, uint256 price, bytes32 seal, uint64 endsAt, PodJobsV2.State state, , , uint64 window) = jobs.jobs(id);
        assertEq(who, poster);
        assertEq(price, PRICE);
        assertEq(seal, bytes32(0), "nothing is fixed before the poster approves");
        assertEq(endsAt, 0, "the window has not started");
        assertEq(uint8(state), uint8(PodJobsV2.State.Preparing));
        assertEq(window, WINDOW);
        assertEq(_balance(id), 3 * WRITING);
        _assertConserved();
    }

    function test_aJobThatPaysOnlyForWritingIsRefused() public {
        vm.prank(poster);
        vm.expectRevert(PodJobsV2.WrongAmount.selector);
        jobs.post{ value: 3 * WRITING }(WINDOW, 1);
    }

    function test_aJobWithNoWindowIsRefused() public {
        vm.prank(poster);
        vm.expectRevert(PodJobsV2.NoWindow.selector);
        jobs.post{ value: PRICE + 3 * WRITING }(0, 1);
    }

    function test_tooManyReviewerSeatsIsRefused() public {
        uint8 tooMany = jobs.MAX_REVIEWERS() + 1;
        vm.prank(poster);
        vm.expectRevert(PodJobsV2.TooManyReviewers.selector);
        jobs.post{ value: PRICE + 3 * WRITING }(WINDOW, tooMany);
    }

    // --- preparing, and the poster's approval ---

    function test_noSeatCanBeTakenWhilePreparing() public {
        uint256 id = _post();
        uint256 deposit = jobs.seatDeposit(id, PodJobsV2.Role.Lead);
        vm.prank(leadAgent);
        vm.expectRevert(PodJobsV2.WrongState.selector);
        jobs.takeSeat{ value: deposit }(id, PodJobsV2.Role.Lead, leadOwner);
    }

    function test_approvalFixesTheSealStartsTheWindowAndReturnsWhatWasNotUsed() public {
        uint256 id = _post();
        _write(id);
        vm.warp(block.timestamp + 5 days); // a slow start never eats the pod's time

        uint256 before = poster.balance;
        _open(id);

        (, , bytes32 seal, uint64 endsAt, PodJobsV2.State state, , , ) = jobs.jobs(id);
        assertEq(seal, SEAL);
        assertEq(endsAt, block.timestamp + WINDOW);
        assertEq(uint8(state), uint8(PodJobsV2.State.Open));
        assertEq(poster.balance, before + 2 * WRITING, "two writings were not used");
        assertEq(_balance(id), 0);
        _take(id, PodJobsV2.Role.Lead, leadAgent, leadOwner);
        _assertConserved();
    }

    function test_anApprovalTheWriterDidNotSignIsRefused() public {
        uint256 id = _post();
        (, uint256 somebodyKey) = makeAddrAndKey("somebody else");
        bytes memory forged = _sign(somebodyKey, jobs.checksDigest(id, SEAL));
        vm.prank(poster);
        vm.expectRevert(PodJobsV2.NotWritten.selector);
        jobs.approveChecks(id, SEAL, forged);
    }

    function test_anApprovalSignedForAnotherJobOrSealIsRefused() public {
        uint256 id = _post();
        uint256 other = _post();
        bytes memory forOtherJob = _written(other, SEAL);
        bytes memory forOtherSeal = _written(id, keccak256("different checks"));

        vm.startPrank(poster);
        vm.expectRevert(PodJobsV2.NotWritten.selector);
        jobs.approveChecks(id, SEAL, forOtherJob);
        vm.expectRevert(PodJobsV2.NotWritten.selector);
        jobs.approveChecks(id, SEAL, forOtherSeal);
        vm.stopPrank();
    }

    function test_anApprovalSignedForAnotherContractIsRefused() public {
        PodJobsV2 elsewhere = new PodJobsV2(validator, writer, FIRST_JOB, WRITING, PAYOUT_GAS);
        uint256 id = _post();
        bytes memory forElsewhere = _sign(writerKey, elsewhere.checksDigest(id, SEAL));
        vm.prank(poster);
        vm.expectRevert(PodJobsV2.NotWritten.selector);
        jobs.approveChecks(id, SEAL, forElsewhere);
    }

    function test_aSignatureInItsOtherFormIsRefused() public {
        uint256 id = _post();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(writerKey, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", jobs.checksDigest(id, SEAL))));
        // the same signature, mirrored onto the upper half of the curve
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes memory mirrored = abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.prank(poster);
        vm.expectRevert(PodJobsV2.NotWritten.selector);
        jobs.approveChecks(id, SEAL, mirrored);
    }

    function test_onlyThePosterApprovesTheChecks_andOnlyOnce() public {
        uint256 id = _post();
        bytes memory signature = _written(id, SEAL);
        vm.prank(stranger);
        vm.expectRevert(PodJobsV2.NotPoster.selector);
        jobs.approveChecks(id, SEAL, signature);

        _open(id);
        bytes memory again = _written(id, keccak256("changed afterwards"));
        vm.prank(poster);
        vm.expectRevert(PodJobsV2.WrongState.selector);
        jobs.approveChecks(id, keccak256("changed afterwards"), again);
    }

    // --- the writing balance ---

    function test_aKeptWritingPaysTheValidator() public {
        uint256 id = _post();
        uint256 before = validator.balance;
        _write(id);
        assertEq(validator.balance, before + WRITING);
        assertEq(_kept(id), 1);
        assertEq(_balance(id), 2 * WRITING);
        _assertConserved();
    }

    function test_aReleasedWritingGoesBackToTheBalanceWhilePreparing() public {
        uint256 id = _post();
        vm.prank(writer);
        jobs.reserveWriting(id);
        assertEq(_balance(id), 2 * WRITING);
        vm.prank(writer);
        jobs.releaseWriting(id);
        assertEq(_balance(id), 3 * WRITING);
        assertEq(_kept(id), 0);
        _assertConserved();
    }

    function test_threeWritingsAreCovered_theFourthNeedsATopUp() public {
        uint256 id = _post();
        _write(id);
        _write(id);
        _write(id);
        vm.prank(writer);
        vm.expectRevert(PodJobsV2.NothingToWriteWith.selector);
        jobs.reserveWriting(id);

        vm.prank(poster);
        jobs.topUp{ value: WRITING }(id);
        _write(id);
        assertEq(_kept(id), 4);
        _assertConserved();
    }

    function test_oneWritingAtATime() public {
        uint256 id = _post();
        vm.startPrank(writer);
        jobs.reserveWriting(id);
        vm.expectRevert(PodJobsV2.WritingUnderWay.selector);
        jobs.reserveWriting(id);
        vm.stopPrank();
    }

    function test_noWritingStartsOnceTheJobLeftPreparing() public {
        uint256 id = _openJob();
        vm.prank(writer);
        vm.expectRevert(PodJobsV2.WrongState.selector);
        jobs.reserveWriting(id);
    }

    function test_aTopUpIsExactlyOneWriting_fromThePoster_whilePreparing() public {
        uint256 id = _post();
        vm.prank(poster);
        vm.expectRevert(PodJobsV2.WrongAmount.selector);
        jobs.topUp{ value: WRITING + 1 }(id);
        vm.prank(stranger);
        vm.expectRevert(PodJobsV2.NotPoster.selector);
        jobs.topUp{ value: WRITING }(id);

        _open(id);
        vm.prank(poster);
        vm.expectRevert(PodJobsV2.WrongState.selector);
        jobs.topUp{ value: WRITING }(id);
    }

    function test_aTakeBackReturnsThePriceAndWhatWasNotUsed() public {
        uint256 id = _post();
        _write(id);
        uint256 before = poster.balance;
        vm.prank(poster);
        jobs.takeBack(id);
        assertEq(poster.balance, before + PRICE + 2 * WRITING);
        assertEq(uint8(_state(id)), uint8(PodJobsV2.State.Refunded));
        _assertConserved();
    }

    function test_aTakeBackCannotReturnAWritingUnderWay_whichIsKeptAfterwards() public {
        uint256 id = _post();
        vm.prank(writer);
        jobs.reserveWriting(id);

        uint256 posterBefore = poster.balance;
        vm.prank(poster);
        jobs.takeBack(id);
        assertEq(poster.balance, posterBefore + PRICE + 2 * WRITING, "the reservation stays reserved");
        _assertConserved();

        uint256 validatorBefore = validator.balance;
        vm.prank(writer);
        jobs.keepWriting(id);
        assertEq(validator.balance, validatorBefore + WRITING);
        _assertConserved();
    }

    function test_aWritingReleasedAfterTheJobLeftPreparingPaysThePoster() public {
        uint256 id = _post();
        vm.prank(writer);
        jobs.reserveWriting(id);
        _open(id);

        uint256 before = poster.balance;
        vm.prank(writer);
        jobs.releaseWriting(id);
        assertEq(poster.balance, before + WRITING);
        _assertConserved();
    }

    function test_aWritingKeptAfterApprovalPaysTheValidator() public {
        uint256 id = _post();
        vm.prank(writer);
        jobs.reserveWriting(id);
        _open(id);

        uint256 before = validator.balance;
        vm.prank(writer);
        jobs.keepWriting(id);
        assertEq(validator.balance, before + WRITING);
        _assertConserved();
    }

    function test_aWritingLeftADayCanBeReleasedByThePoster_notBefore() public {
        uint256 id = _post();
        vm.prank(writer);
        jobs.reserveWriting(id);

        vm.warp(block.timestamp + 1 days - 1);
        vm.prank(poster);
        vm.expectRevert(PodJobsV2.NotWriter.selector);
        jobs.releaseWriting(id);

        vm.warp(block.timestamp + 1);
        vm.prank(poster);
        jobs.releaseWriting(id);
        assertEq(_balance(id), 3 * WRITING);
        _assertConserved();
    }

    function test_onlyTheWriterReservesKeepsAndReleases() public {
        uint256 id = _post();
        address[3] memory others = [poster, validator, stranger];
        for (uint256 i; i < others.length; i++) {
            vm.prank(others[i]);
            vm.expectRevert(PodJobsV2.NotWriter.selector);
            jobs.reserveWriting(id);
        }
        vm.prank(writer);
        jobs.reserveWriting(id);
        for (uint256 i; i < others.length; i++) {
            vm.prank(others[i]);
            vm.expectRevert(PodJobsV2.NotWriter.selector);
            jobs.keepWriting(id);
            vm.prank(others[i]);
            vm.expectRevert(PodJobsV2.NotWriter.selector);
            jobs.releaseWriting(id);
        }
    }

    // --- taking the money back ---

    function test_aTakeBackWhileOpenWithNoSeatWorks() public {
        uint256 id = _openJob();
        uint256 before = poster.balance;
        vm.prank(poster);
        jobs.takeBack(id);
        assertEq(poster.balance, before + PRICE, "the unused writings came back at approval");
        _assertConserved();
    }

    function test_aTakeBackFailsOnceASeatIsTaken() public {
        uint256 id = _openJob();
        _take(id, PodJobsV2.Role.Builder, builderAgent, builderOwner);
        vm.prank(poster);
        vm.expectRevert(PodJobsV2.WrongState.selector);
        jobs.takeBack(id);
    }

    function test_onlyThePosterTakesTheMoneyBack() public {
        uint256 id = _post();
        vm.prank(stranger);
        vm.expectRevert(PodJobsV2.NotPoster.selector);
        jobs.takeBack(id);
    }

    function test_aPosterCannotTakeTheSameMoneyBackTwice_evenFromInsideItsRefund() public {
        GreedyPoster greedy = new GreedyPoster(jobs);
        vm.deal(address(greedy), 0);
        greedy.post{ value: PRICE + 3 * WRITING }(WINDOW);

        greedy.takeBack();
        assertEq(greedy.triedAgain(), 1);
        assertEq(address(greedy).balance, PRICE + 3 * WRITING, "paid once, and only once");
        _assertConserved();
    }

    // --- the lock ---

    function test_beforeTheLockANewCommitStartsTheApprovalsAgain() public {
        uint256 id = _openJob();
        _fillEverySeat(id);
        vm.prank(leadAgent); jobs.approve(id, PodJobsV2.Role.Lead, COMMIT);
        bytes32 later = keccak256("pushed again");
        vm.prank(builderAgent); jobs.approve(id, PodJobsV2.Role.Builder, later);
        assertEq(_commit(id), later);
        assertFalse(_approved(id, PodJobsV2.Role.Lead));
    }

    function test_onceTheApprovalsAreInPlaceADifferentCommitIsRefused() public {
        uint256 id = _lockedJob();
        assertTrue(jobs.locked(id));
        vm.prank(builderAgent);
        vm.expectRevert(PodJobsV2.Locked.selector);
        jobs.approve(id, PodJobsV2.Role.Builder, keccak256("swapped while being graded"));
        // the same commit is still fine to approve
        vm.prank(builderAgent);
        jobs.approve(id, PodJobsV2.Role.Builder, COMMIT);
    }

    function test_theLockEndsWithTheSettlement() public {
        uint256 id = _lockedJob();
        _settle(id, PodJobsV2.Verdict.Passed);
        vm.prank(builderAgent);
        vm.expectRevert(PodJobsV2.WrongState.selector);
        jobs.approve(id, PodJobsV2.Role.Builder, keccak256("after the fact"));
    }

    function test_theLockEndsWithTheWindow() public {
        uint256 id = _lockedJob();
        vm.warp(block.timestamp + WINDOW);
        vm.prank(builderAgent);
        vm.expectRevert(PodJobsV2.TooLate.selector);
        jobs.approve(id, PodJobsV2.Role.Builder, keccak256("after the window"));
    }

    function test_aReleaseClearsTheCommitAndEveryApproval_thenANewCommitIsTaken() public {
        uint256 id = _lockedJob();
        vm.prank(validator);
        jobs.releaseLock(id);
        assertEq(_commit(id), bytes32(0));
        assertFalse(jobs.locked(id));
        for (uint8 r; r < 5; r++) assertFalse(_approved(id, PodJobsV2.Role(r)));

        bytes32 fixedUp = keccak256("fixed after the hold");
        _approveAll(id, fixedUp);
        assertTrue(jobs.policyMet(id, fixedUp));
    }

    function test_onlyTheValidatorReleases_andOnlyALockedJob() public {
        uint256 id = _openJob();
        _fillEverySeat(id);
        vm.prank(validator);
        vm.expectRevert(PodJobsV2.NotLocked.selector);
        jobs.releaseLock(id);

        _approveAll(id, COMMIT);
        address[3] memory others = [poster, writer, leadAgent];
        for (uint256 i; i < others.length; i++) {
            vm.prank(others[i]);
            vm.expectRevert(PodJobsV2.NotValidator.selector);
            jobs.releaseLock(id);
        }
    }

    // --- the verdict ---

    function test_aSettlementOnAnyCommitButTheCurrentOneIsRefused() public {
        uint256 id = _lockedJob();
        vm.prank(validator);
        jobs.releaseLock(id);
        bytes32 fixedUp = keccak256("fixed after the hold");
        _approveAll(id, fixedUp);

        vm.startPrank(validator);
        vm.expectRevert(PodJobsV2.CommitMismatch.selector);
        jobs.settle(id, COMMIT, PodJobsV2.Verdict.Passed, RECEIPT);
        vm.expectRevert(PodJobsV2.CommitMismatch.selector);
        jobs.settle(id, COMMIT, PodJobsV2.Verdict.VisibleFailed, RECEIPT);
        jobs.settle(id, fixedUp, PodJobsV2.Verdict.Passed, RECEIPT);
        vm.stopPrank();
    }

    function test_noVerdictSettlesWithoutThePolicy() public {
        uint256 id = _openJob();
        _fillEverySeat(id);
        vm.prank(leadAgent); jobs.approve(id, PodJobsV2.Role.Lead, COMMIT);
        vm.startPrank(validator);
        vm.expectRevert(PodJobsV2.PolicyNotMet.selector);
        jobs.settle(id, COMMIT, PodJobsV2.Verdict.Passed, RECEIPT);
        vm.expectRevert(PodJobsV2.PolicyNotMet.selector);
        jobs.settle(id, COMMIT, PodJobsV2.Verdict.VisibleFailed, RECEIPT);
        vm.expectRevert(PodJobsV2.NoVerdict.selector);
        jobs.settle(id, COMMIT, PodJobsV2.Verdict.None, RECEIPT);
        vm.stopPrank();
    }

    function test_onlyTheValidatorReportsAVerdict() public {
        uint256 id = _lockedJob();
        address[3] memory others = [poster, writer, leadAgent];
        for (uint256 i; i < others.length; i++) {
            vm.prank(others[i]);
            vm.expectRevert(PodJobsV2.NotValidator.selector);
            jobs.settle(id, COMMIT, PodJobsV2.Verdict.Passed, RECEIPT);
        }
    }

    function test_nothingSettlesAfterTheWindow() public {
        uint256 id = _lockedJob();
        vm.warp(block.timestamp + WINDOW);
        vm.prank(validator);
        vm.expectRevert(PodJobsV2.TooLate.selector);
        jobs.settle(id, COMMIT, PodJobsV2.Verdict.Passed, RECEIPT);
    }

    function test_aPassPaysEverySeat_andThePosterGetsWhatTheSharesLeave() public {
        // two reviewer seats, only one taken, and a price that does not divide evenly
        uint256 price = 20 ether + 7;
        vm.prank(poster);
        uint256 id = jobs.post{ value: price + 3 * WRITING }(WINDOW, 2);
        _open(id);
        _fillEverySeat(id);
        _approveAll(id, COMMIT);

        uint256 builderBefore = builderAgent.balance;
        uint256 posterBefore = poster.balance;
        uint256 builderDue = jobs.seatPay(id, PodJobsV2.Role.Builder) + jobs.seatDeposit(id, PodJobsV2.Role.Builder);
        uint256 paid;
        for (uint8 r; r < 5; r++) paid += jobs.seatPay(id, PodJobsV2.Role(r));

        _settle(id, PodJobsV2.Verdict.Passed);
        assertEq(builderAgent.balance, builderBefore + builderDue);
        assertEq(poster.balance, posterBefore + price - paid);
        assertGt(price - paid, jobs.seatPay(id, PodJobsV2.Role.Reviewer), "the untaken reviewer's share went back");
        assertEq(address(jobs).balance, 0, "every last wei went somewhere");
        _assertConserved();
    }

    function test_aVerdictIsRecordedWithItsReceipt() public {
        uint256 id = _lockedJob();
        _settle(id, PodJobsV2.Verdict.VisibleFailed);
        (PodJobsV2.Verdict verdict, bytes32 receiptHash) = jobs.reports(id);
        assertEq(uint8(verdict), uint8(PodJobsV2.Verdict.VisibleFailed));
        assertEq(receiptHash, RECEIPT);
    }

    // --- item 14: an approval that costs something ---

    function test_aCheckThePodCouldSeeFailing_costsTheApproversTheirDeposits() public {
        uint256 id = _lockedJob(); // the builder never approved
        uint256 leadDeposit = jobs.seatDeposit(id, PodJobsV2.Role.Lead);
        uint256 builderDeposit = jobs.seatDeposit(id, PodJobsV2.Role.Builder);
        uint256 forfeited = leadDeposit + jobs.seatDeposit(id, PodJobsV2.Role.Reviewer)
            + jobs.seatDeposit(id, PodJobsV2.Role.QA) + jobs.seatDeposit(id, PodJobsV2.Role.Security);

        uint256 posterBefore = poster.balance;
        uint256 leadBefore = leadAgent.balance;
        uint256 builderBefore = builderAgent.balance;
        _settle(id, PodJobsV2.Verdict.VisibleFailed);

        assertEq(leadAgent.balance, leadBefore, "the lead approved, and loses its deposit");
        assertEq(builderAgent.balance, builderBefore + builderDeposit, "the builder never approved, and gets it back");
        assertEq(poster.balance, posterBefore + PRICE + forfeited, "the poster gets the price and the forfeits");
        assertEq(address(jobs).balance, 0);
        _assertConserved();
    }

    function test_onlyAHiddenCheckFailing_sendsEveryDepositHome() public {
        uint256 id = _lockedJob();
        uint256 leadDeposit = jobs.seatDeposit(id, PodJobsV2.Role.Lead);
        uint256 posterBefore = poster.balance;
        uint256 leadBefore = leadAgent.balance;
        _settle(id, PodJobsV2.Verdict.HiddenFailed);

        assertEq(leadAgent.balance, leadBefore + leadDeposit);
        assertEq(poster.balance, posterBefore + PRICE, "a poster cannot profit from an exam made to fail");
        assertEq(address(jobs).balance, 0);
        _assertConserved();
    }

    function test_theWindowClosingSendsEveryDepositHome() public {
        uint256 id = _lockedJob();
        uint256 leadDeposit = jobs.seatDeposit(id, PodJobsV2.Role.Lead);
        uint256 leadBefore = leadAgent.balance;
        uint256 posterBefore = poster.balance;
        vm.warp(block.timestamp + WINDOW);
        vm.prank(stranger);
        jobs.close(id);

        assertEq(leadAgent.balance, leadBefore + leadDeposit);
        assertEq(poster.balance, posterBefore + PRICE);
        assertEq(uint8(_state(id)), uint8(PodJobsV2.State.Refunded));
        _assertConserved();
    }

    // --- closing ---

    function test_anybodyMayCloseAfterTheWindow_nobodyBefore() public {
        uint256 id = _openJob();
        _take(id, PodJobsV2.Role.Builder, builderAgent, builderOwner);
        vm.warp(block.timestamp + WINDOW - 1);
        vm.prank(stranger);
        vm.expectRevert(PodJobsV2.TooEarly.selector);
        jobs.close(id);

        vm.warp(block.timestamp + 1);
        vm.prank(stranger);
        jobs.close(id);
        vm.prank(stranger);
        vm.expectRevert(PodJobsV2.WrongState.selector);
        jobs.close(id);
        _assertConserved();
    }

    function test_aJobStillPreparingHasNoWindowToClose() public {
        uint256 id = _post();
        vm.warp(block.timestamp + 30 days);
        vm.prank(stranger);
        vm.expectRevert(PodJobsV2.WrongState.selector);
        jobs.close(id);
    }

    // --- payments that do not arrive ---

    function _seatAPayee(address payee) internal returns (uint256 id) {
        id = _openJob();
        vm.deal(payee, 10 ether);
        _take(id, PodJobsV2.Role.Lead, leadAgent, leadOwner);
        _take(id, PodJobsV2.Role.Builder, payee, builderOwner);
        _take(id, PodJobsV2.Role.Reviewer, reviewerAgent, reviewerOwner);
        _take(id, PodJobsV2.Role.QA, qaAgent, qaOwner);
        _take(id, PodJobsV2.Role.Security, securityAgent, securityOwner);
        _approveAll(id, COMMIT);
    }

    function _assertEverybodyElsePaid(uint256 id, address payee) internal {
        uint256 leadBefore = leadAgent.balance;
        uint256 securityBefore = securityAgent.balance;
        uint256 payeeBefore = payee.balance;
        uint256 payeeDue = jobs.seatPay(id, PodJobsV2.Role.Builder) + jobs.seatDeposit(id, PodJobsV2.Role.Builder);
        _settle(id, PodJobsV2.Verdict.Passed);

        assertEq(uint8(_state(id)), uint8(PodJobsV2.State.Settled));
        assertEq(leadAgent.balance, leadBefore + jobs.seatPay(id, PodJobsV2.Role.Lead) + jobs.seatDeposit(id, PodJobsV2.Role.Lead));
        assertEq(securityAgent.balance, securityBefore + jobs.seatPay(id, PodJobsV2.Role.Security) + jobs.seatDeposit(id, PodJobsV2.Role.Security));
        assertEq(payee.balance - payeeBefore + jobs.owed(payee), payeeDue, "the payee is paid or owed, never both, never neither");
        _assertConserved();

        if (jobs.owed(payee) == 0) return;
        address elsewhere = makeAddr("where the payee wants it");
        vm.prank(payee);
        jobs.withdraw(elsewhere);
        assertEq(elsewhere.balance, payeeDue);
        assertEq(jobs.owed(payee), 0);
        _assertConserved();
    }

    function test_aPayeeThatRefuses_leavesEverybodyElsePaid_andCanWithdraw() public {
        address payee = address(new Refuser());
        _assertEverybodyElsePaid(_seatAPayee(payee), payee);
        assertEq(jobs.totalOwed(), 0);
    }

    function test_aPayeeThatBurnsItsGas_leavesEverybodyElsePaid_andCanWithdraw() public {
        address payee = address(new GasBurner());
        uint256 id = _seatAPayee(payee);
        uint256 gasBefore = gasleft();
        _assertEverybodyElsePaid(id, payee);
        assertLt(gasBefore - gasleft(), 5_000_000, "a payee cannot make a settlement cost more than its fixed gas");
    }

    function test_aPayeeThatAnswersWithAFlood_leavesEverybodyElsePaid() public {
        address payee = address(new Flood());
        _assertEverybodyElsePaid(_seatAPayee(payee), payee);
    }

    function test_aPosterThatRefuses_canWithdrawItsRefund() public {
        Refuser refuser = new Refuser();
        vm.deal(address(refuser), 100 ether);
        vm.prank(address(refuser));
        uint256 id = jobs.post{ value: PRICE + 3 * WRITING }(WINDOW, 1);
        vm.prank(address(refuser));
        jobs.takeBack(id);
        assertEq(jobs.owed(address(refuser)), PRICE + 3 * WRITING);
        _assertConserved();

        vm.prank(address(refuser));
        vm.expectRevert(PodJobsV2.PaymentFailed.selector);
        jobs.withdraw(address(refuser));

        vm.prank(address(refuser));
        jobs.withdraw(stranger);
        assertEq(jobs.owed(address(refuser)), 0);
        _assertConserved();
    }

    function test_nothingOwedIsNothingToWithdraw() public {
        vm.prank(stranger);
        vm.expectRevert(PodJobsV2.NothingOwed.selector);
        jobs.withdraw(stranger);
    }

    // --- seats, as before ---

    function test_theSharesAddUpToThePrice() public {
        uint256 id = _openJob();
        uint256 total;
        for (uint8 r; r < 5; r++) total += jobs.seatPay(id, PodJobsV2.Role(r));
        assertEq(total, PRICE);
    }

    function test_oneOwnerCannotHoldTwoSeats() public {
        uint256 id = _openJob();
        _take(id, PodJobsV2.Role.Lead, leadAgent, leadOwner);
        uint256 deposit = jobs.seatDeposit(id, PodJobsV2.Role.Builder);
        vm.prank(builderAgent);
        vm.expectRevert(PodJobsV2.OwnerAlreadySeated.selector);
        jobs.takeSeat{ value: deposit }(id, PodJobsV2.Role.Builder, leadOwner);
    }

    function test_aSeatIsFirstComeFirstServed() public {
        uint256 id = _openJob();
        _take(id, PodJobsV2.Role.Lead, leadAgent, leadOwner);
        uint256 deposit = jobs.seatDeposit(id, PodJobsV2.Role.Lead);
        vm.prank(builderAgent);
        vm.expectRevert(PodJobsV2.SeatFilled.selector);
        jobs.takeSeat{ value: deposit }(id, PodJobsV2.Role.Lead, builderOwner);
    }

    function test_theDepositMustBeExact() public {
        uint256 id = _openJob();
        vm.prank(leadAgent);
        vm.expectRevert(PodJobsV2.WrongAmount.selector);
        jobs.takeSeat{ value: 1 }(id, PodJobsV2.Role.Lead, leadOwner);
    }

    function test_noSeatAfterTheWindow() public {
        uint256 id = _openJob();
        vm.warp(block.timestamp + WINDOW);
        uint256 deposit = jobs.seatDeposit(id, PodJobsV2.Role.Lead);
        vm.prank(leadAgent);
        vm.expectRevert(PodJobsV2.TooLate.selector);
        jobs.takeSeat{ value: deposit }(id, PodJobsV2.Role.Lead, leadOwner);
    }

    function test_nobodyIsPaidWithoutTheSecuritySeat() public {
        uint256 id = _openJob();
        _fillEverySeat(id);
        vm.prank(leadAgent); jobs.approve(id, PodJobsV2.Role.Lead, COMMIT);
        vm.prank(reviewerAgent); jobs.approve(id, PodJobsV2.Role.Reviewer, COMMIT);
        vm.prank(qaAgent); jobs.approve(id, PodJobsV2.Role.QA, COMMIT);
        assertFalse(jobs.policyMet(id, COMMIT));
    }

    function test_onlyASeatHolderApproves() public {
        uint256 id = _openJob();
        _fillEverySeat(id);
        vm.prank(stranger);
        vm.expectRevert(PodJobsV2.NotTheSeat.selector);
        jobs.approve(id, PodJobsV2.Role.Lead, COMMIT);
    }
}
