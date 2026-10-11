// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { PodJobsV3 } from "../src/PodJobsV3.sol";

/// @dev a payee that will not be paid
contract Refuser {
    receive() external payable { revert("not taking it"); }
}

/// @dev a payee that uses up every bit of gas it is sent
contract GasBurner {
    receive() external payable { while (true) {} }
}

/// @dev a payee that takes the money and answers with nearly as much data as the gas it is sent can pay for
contract Flood {
    receive() external payable {
        assembly { return(0, 163840) }
    }
}

/// @dev a payee that takes the money and says nothing, to measure the flood against
contract Quiet {
    receive() external payable {}
}

/// @dev a poster that, on being refunded, tries to take the same money back again
contract GreedyPoster {
    PodJobsV3 immutable jobs;
    uint256 public jobId;
    uint256 public triedAgain;

    constructor(PodJobsV3 jobs_) { jobs = jobs_; }

    function post(uint64 window) external payable { jobId = jobs.post{ value: msg.value }(window, 1); }

    function takeBack() external { jobs.takeBack(jobId); }

    receive() external payable {
        triedAgain++;
        try jobs.takeBack(jobId) {} catch {}
    }
}

/// @dev What every test of the third contract shares: its parties, and how a job is walked through.
abstract contract PodJobsV3Fixture is Test {
    PodJobsV3 jobs;
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
    /// @dev how many roles a job has seats for
    uint8 constant ROLES = 5;
    uint256 constant WRITING = 0.05 ether;
    uint256 constant PAYOUT_GAS = 100_000;
    uint256 constant PRICE = 20 ether;
    uint64 constant WINDOW = 2 hours;
    /// @dev how long a poster has to answer a delivery
    uint64 constant ANSWER_TIME = 3 days;
    /// @dev how long the other seats have to say whether they stand behind what the builder put forward:
    ///      a quarter of the window every job here is posted with, unless a test posts its own
    uint64 constant REVIEW_TIME = WINDOW / 4;
    /// @dev what a pod keeps of each seat's pay when its poster refuses work whose checks passed
    uint256 constant REFUSAL_SHARE = 25;
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

        jobs = new PodJobsV3(validator, writer, FIRST_JOB, WRITING, PAYOUT_GAS, ANSWER_TIME);
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
    function _take(uint256 id, PodJobsV3.Role role, address agent, address owner) internal {
        uint256 deposit = jobs.seatDeposit(id, role);
        vm.prank(agent);
        jobs.takeSeat{ value: deposit }(id, role, owner);
    }

    function _fillEverySeat(uint256 id) internal {
        _take(id, PodJobsV3.Role.Lead, leadAgent, leadOwner);
        _take(id, PodJobsV3.Role.Builder, builderAgent, builderOwner);
        _take(id, PodJobsV3.Role.Reviewer, reviewerAgent, reviewerOwner);
        _take(id, PodJobsV3.Role.QA, qaAgent, qaOwner);
        _take(id, PodJobsV3.Role.Security, securityAgent, securityOwner);
    }

    /// @dev the builder names its work, which is the only way a commit comes to be reviewed and graded
    function _putForward(uint256 id, bytes32 commitHash) internal {
        // read before the prank, which the read would spend
        address builder = jobs.seatAt(id, PodJobsV3.Role.Builder, 0).agent;
        vm.prank(builder);
        jobs.putForward(id, commitHash);
    }

    function _poster() internal view returns (PodJobsV3.PosterRecord memory record) {
        (record.posted, record.accepted, record.refusedPassed, record.refusedFailed, record.unanswered) = jobs.posters(poster);
    }

    function _agent(address agent) internal view returns (PodJobsV3.AgentRecord memory record) {
        (record.accepted, record.paidUnanswered, record.refusedPassed, record.failed, record.undelivered) = jobs.agents(agent);
    }

    /// @dev how many jobs an agent has had counted for it, of any ending
    function _counted(address agent) internal view returns (uint256) {
        PodJobsV3.AgentRecord memory record = _agent(agent);
        return uint256(record.accepted) + record.paidUnanswered + record.refusedPassed + record.failed + record.undelivered;
    }

    /// @dev the builder puts the commit forward, unless it already has, and every other seat stands behind it
    function _approveAll(uint256 id, bytes32 commitHash) internal {
        if (_commit(id) != commitHash) _putForward(id, commitHash);
        vm.prank(leadAgent); jobs.approve(id, PodJobsV3.Role.Lead, commitHash);
        vm.prank(reviewerAgent); jobs.approve(id, PodJobsV3.Role.Reviewer, commitHash);
        vm.prank(qaAgent); jobs.approve(id, PodJobsV3.Role.QA, commitHash);
        vm.prank(securityAgent); jobs.approve(id, PodJobsV3.Role.Security, commitHash);
    }

    function _lockedJob() internal returns (uint256 id) {
        id = _openJob();
        _fillEverySeat(id);
        _approveAll(id, COMMIT);
    }

    /// @dev the validator reports what the re-run found. No money moves
    function _report(uint256 id, PodJobsV3.Verdict verdict) internal {
        vm.prank(validator);
        jobs.report(id, COMMIT, verdict, RECEIPT);
    }

    /// @dev a job its pod delivered, with what the checks found, waiting for its poster
    function _delivered(PodJobsV3.Verdict verdict) internal returns (uint256 id) {
        id = _lockedJob();
        _report(id, verdict);
    }

    /// @dev the poster says nothing, and a stranger settles the job as the checks found: the same
    ///      money, to the same people, as the second contract moved on the verdict alone
    function _settle(uint256 id, PodJobsV3.Verdict verdict) internal {
        _report(id, verdict);
        vm.warp(jobs.answerBy(id));
        vm.prank(stranger);
        jobs.settleUnanswered(id);
    }

    function _state(uint256 id) internal view returns (PodJobsV3.State state) {
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

    function _approved(uint256 id, PodJobsV3.Role role) internal view returns (bool) {
        return jobs.seatAt(id, role, 0).approved;
    }

    /// @dev What the contract still owes, worked out from what it says about every job it has
    ///      numbered: a job's price until it settles or is refunded, its writing money, every deposit
    ///      it still holds, and what payments could not deliver.
    function _stillOwed() internal view returns (uint256 total) {
        for (uint256 id = FIRST_JOB; id < jobs.nextJobId(); id++) {
            PodJobsV3.State state = _state(id);
            if (state == PodJobsV3.State.Preparing || state == PodJobsV3.State.Open || state == PodJobsV3.State.Working || state == PodJobsV3.State.Delivered) {
                (, uint256 price, , , , , , ) = jobs.jobs(id);
                total += price;
            }
            total += _balance(id) + _reserved(id);
            for (uint8 r; r < ROLES; r++) {
                uint256 count = jobs.seatCount(id, PodJobsV3.Role(r));
                for (uint256 i; i < count; i++) total += jobs.seatAt(id, PodJobsV3.Role(r), i).deposit;
            }
        }
        total += jobs.totalOwed();
    }

    function _assertConserved() internal view {
        assertEq(address(jobs).balance, _stillOwed(), "the contract holds exactly what it still owes");
        // writing money not yet spent belongs to a job still preparing; once it is not, it has gone back
        for (uint256 id = FIRST_JOB; id < jobs.nextJobId(); id++) {
            if (_state(id) != PodJobsV3.State.Preparing) assertEq(_balance(id), 0, "no writing money is left in a job that is not preparing");
        }
    }
}

contract PodJobsV3Test is PodJobsV3Fixture {
    // --- numbering and creating ---

    function test_numberingStartsWhereItIsTold() public {
        assertEq(_post(), FIRST_JOB);
        assertEq(_post(), FIRST_JOB + 1);
        assertEq(jobs.nextJobId(), FIRST_JOB + 2);
    }

    function test_oneJobIsPaidForOnceWithThreeWritings() public {
        uint256 id = _post();
        (address who, uint256 price, bytes32 seal, uint64 endsAt, PodJobsV3.State state, , , uint64 window) = jobs.jobs(id);
        assertEq(who, poster);
        assertEq(price, PRICE);
        assertEq(seal, bytes32(0), "nothing is fixed before the poster approves");
        assertEq(endsAt, 0, "the window has not started");
        assertEq(uint8(state), uint8(PodJobsV3.State.Preparing));
        assertEq(window, WINDOW);
        assertEq(_balance(id), 3 * WRITING);
        _assertConserved();
    }

    function test_aJobThatPaysOnlyForWritingIsRefused() public {
        vm.prank(poster);
        vm.expectRevert(PodJobsV3.WrongAmount.selector);
        jobs.post{ value: 3 * WRITING }(WINDOW, 1);
    }

    function test_aJobWithNoWindowIsRefused() public {
        vm.prank(poster);
        vm.expectRevert(PodJobsV3.NoWindow.selector);
        jobs.post{ value: PRICE + 3 * WRITING }(0, 1);
    }

    function test_tooManyReviewerSeatsIsRefused() public {
        uint8 tooMany = jobs.MAX_REVIEWERS() + 1;
        vm.prank(poster);
        vm.expectRevert(PodJobsV3.TooManyReviewers.selector);
        jobs.post{ value: PRICE + 3 * WRITING }(WINDOW, tooMany);
    }

    // --- preparing, and the poster's approval ---

    function test_noSeatCanBeTakenWhilePreparing() public {
        uint256 id = _post();
        uint256 deposit = jobs.seatDeposit(id, PodJobsV3.Role.Lead);
        vm.prank(leadAgent);
        vm.expectRevert(PodJobsV3.WrongState.selector);
        jobs.takeSeat{ value: deposit }(id, PodJobsV3.Role.Lead, leadOwner);
    }

    function test_approvalFixesTheSealStartsTheWindowAndReturnsWhatWasNotUsed() public {
        uint256 id = _post();
        _write(id);
        vm.warp(block.timestamp + 5 days); // a slow start never eats the pod's time

        uint256 before = poster.balance;
        _open(id);

        (, , bytes32 seal, uint64 endsAt, PodJobsV3.State state, , , ) = jobs.jobs(id);
        assertEq(seal, SEAL);
        assertEq(endsAt, block.timestamp + WINDOW);
        assertEq(uint8(state), uint8(PodJobsV3.State.Open));
        assertEq(poster.balance, before + 2 * WRITING, "two writings were not used");
        assertEq(_balance(id), 0);
        _take(id, PodJobsV3.Role.Lead, leadAgent, leadOwner);
        _assertConserved();
    }

    function test_anApprovalTheWriterDidNotSignIsRefused() public {
        uint256 id = _post();
        (, uint256 somebodyKey) = makeAddrAndKey("somebody else");
        bytes memory forged = _sign(somebodyKey, jobs.checksDigest(id, SEAL));
        vm.prank(poster);
        vm.expectRevert(PodJobsV3.NotWritten.selector);
        jobs.approveChecks(id, SEAL, forged);
    }

    function test_anApprovalSignedForAnotherJobOrSealIsRefused() public {
        uint256 id = _post();
        uint256 other = _post();
        bytes memory forOtherJob = _written(other, SEAL);
        bytes memory forOtherSeal = _written(id, keccak256("different checks"));

        vm.startPrank(poster);
        vm.expectRevert(PodJobsV3.NotWritten.selector);
        jobs.approveChecks(id, SEAL, forOtherJob);
        vm.expectRevert(PodJobsV3.NotWritten.selector);
        jobs.approveChecks(id, SEAL, forOtherSeal);
        vm.stopPrank();
    }

    function test_anApprovalSignedForAnotherContractIsRefused() public {
        PodJobsV3 elsewhere = new PodJobsV3(validator, writer, FIRST_JOB, WRITING, PAYOUT_GAS, ANSWER_TIME);
        uint256 id = _post();
        bytes memory forElsewhere = _sign(writerKey, elsewhere.checksDigest(id, SEAL));
        vm.prank(poster);
        vm.expectRevert(PodJobsV3.NotWritten.selector);
        jobs.approveChecks(id, SEAL, forElsewhere);
    }

    function test_aSignatureInItsOtherFormIsRefused() public {
        uint256 id = _post();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(writerKey, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", jobs.checksDigest(id, SEAL))));
        // the same signature, mirrored onto the upper half of the curve
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes memory mirrored = abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.prank(poster);
        vm.expectRevert(PodJobsV3.NotWritten.selector);
        jobs.approveChecks(id, SEAL, mirrored);
    }

    function test_aSignatureForAnotherChainIsRefused() public {
        uint256 id = _post();
        bytes memory signedHere = _written(id, SEAL);
        vm.chainId(block.chainid + 1);
        vm.prank(poster);
        vm.expectRevert(PodJobsV3.NotWritten.selector);
        jobs.approveChecks(id, SEAL, signedHere);
    }

    function test_aSignatureOverTheSameFactsForAnotherPurposeIsRefused() public {
        uint256 id = _post();
        // everything the approval names, but not what the signature is for
        bytes32 noPurpose = keccak256(abi.encode(address(jobs), block.chainid, id, SEAL));
        bytes memory signed = _sign(writerKey, noPurpose);
        vm.prank(poster);
        vm.expectRevert(PodJobsV3.NotWritten.selector);
        jobs.approveChecks(id, SEAL, signed);
    }

    function test_onlyThePosterApprovesTheChecks_andOnlyOnce() public {
        uint256 id = _post();
        bytes memory signature = _written(id, SEAL);
        vm.prank(stranger);
        vm.expectRevert(PodJobsV3.NotPoster.selector);
        jobs.approveChecks(id, SEAL, signature);

        _open(id);
        bytes memory again = _written(id, keccak256("changed afterwards"));
        vm.prank(poster);
        vm.expectRevert(PodJobsV3.WrongState.selector);
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
        vm.expectRevert(PodJobsV3.NothingToWriteWith.selector);
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
        vm.expectRevert(PodJobsV3.WritingUnderWay.selector);
        jobs.reserveWriting(id);
        vm.stopPrank();
    }

    function test_noWritingStartsOnceTheJobLeftPreparing() public {
        uint256 id = _openJob();
        vm.prank(writer);
        vm.expectRevert(PodJobsV3.WrongState.selector);
        jobs.reserveWriting(id);
    }

    function test_aTopUpIsExactlyOneWriting_fromThePoster_whilePreparing() public {
        uint256 id = _post();
        vm.prank(poster);
        vm.expectRevert(PodJobsV3.WrongAmount.selector);
        jobs.topUp{ value: WRITING + 1 }(id);
        vm.prank(stranger);
        vm.expectRevert(PodJobsV3.NotPoster.selector);
        jobs.topUp{ value: WRITING }(id);

        _open(id);
        vm.prank(poster);
        vm.expectRevert(PodJobsV3.WrongState.selector);
        jobs.topUp{ value: WRITING }(id);
    }

    function test_aTakeBackReturnsThePriceAndWhatWasNotUsed() public {
        uint256 id = _post();
        _write(id);
        uint256 before = poster.balance;
        vm.prank(poster);
        jobs.takeBack(id);
        assertEq(poster.balance, before + PRICE + 2 * WRITING);
        assertEq(uint8(_state(id)), uint8(PodJobsV3.State.Refunded));
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

    function test_aWritingReleasedAfterATakeBackPaysThePoster_notTheJob() public {
        uint256 id = _post();
        vm.prank(writer);
        jobs.reserveWriting(id);
        vm.prank(poster);
        jobs.takeBack(id);

        uint256 before = poster.balance;
        vm.prank(writer);
        jobs.releaseWriting(id);
        assertEq(poster.balance, before + WRITING, "released after the job ended, it goes to the poster");
        assertEq(_balance(id), 0);
        assertEq(address(jobs).balance, 0, "nothing is stranded in a job taken back");
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
        vm.expectRevert(PodJobsV3.NotWriter.selector);
        jobs.releaseWriting(id);

        vm.warp(block.timestamp + 1);
        vm.prank(poster);
        jobs.releaseWriting(id);
        assertEq(_balance(id), 3 * WRITING);
        _assertConserved();
    }

    function test_onlyThePosterMayReleaseAWritingLeftADay() public {
        uint256 id = _post();
        vm.prank(writer);
        jobs.reserveWriting(id);
        vm.warp(block.timestamp + 2 days);
        address[2] memory others = [stranger, validator];
        for (uint256 i; i < others.length; i++) {
            vm.prank(others[i]);
            vm.expectRevert(PodJobsV3.NotWriter.selector);
            jobs.releaseWriting(id);
        }
        vm.prank(poster);
        jobs.releaseWriting(id);
    }

    function test_onlyTheWriterReservesKeepsAndReleases() public {
        uint256 id = _post();
        address[3] memory others = [poster, validator, stranger];
        for (uint256 i; i < others.length; i++) {
            vm.prank(others[i]);
            vm.expectRevert(PodJobsV3.NotWriter.selector);
            jobs.reserveWriting(id);
        }
        vm.prank(writer);
        jobs.reserveWriting(id);
        for (uint256 i; i < others.length; i++) {
            vm.prank(others[i]);
            vm.expectRevert(PodJobsV3.NotWriter.selector);
            jobs.keepWriting(id);
            vm.prank(others[i]);
            vm.expectRevert(PodJobsV3.NotWriter.selector);
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
        _take(id, PodJobsV3.Role.Builder, builderAgent, builderOwner);
        vm.prank(poster);
        vm.expectRevert(PodJobsV3.WrongState.selector);
        jobs.takeBack(id);
    }

    function test_onlyThePosterTakesTheMoneyBack() public {
        uint256 id = _post();
        vm.prank(stranger);
        vm.expectRevert(PodJobsV3.NotPoster.selector);
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

    function test_beforeTheLockANewCommitPutForwardStartsTheReviewAgain() public {
        uint256 id = _openJob();
        _fillEverySeat(id);
        _putForward(id, COMMIT);
        vm.prank(leadAgent); jobs.approve(id, PodJobsV3.Role.Lead, COMMIT);
        vm.warp(block.timestamp + 10 minutes);

        bytes32 later = keccak256("pushed again, answering a refusal");
        _putForward(id, later);
        assertEq(_commit(id), later);
        assertFalse(_approved(id, PodJobsV3.Role.Lead), "what was said of the old commit is not said of the new one");
        assertTrue(_approved(id, PodJobsV3.Role.Builder), "the builder stands behind what it put forward");
        assertEq(jobs.reviewBy(id), block.timestamp + REVIEW_TIME, "and the seats have the whole time again to review it");
        // the old commit is nobody's to approve any more
        vm.prank(leadAgent);
        vm.expectRevert(PodJobsV3.CommitMismatch.selector);
        jobs.approve(id, PodJobsV3.Role.Lead, COMMIT);
    }

    function test_onceLockedNothingElseIsPutForwardOrApproved() public {
        uint256 id = _lockedJob();
        assertTrue(jobs.locked(id));
        vm.prank(builderAgent);
        vm.expectRevert(PodJobsV3.Locked.selector);
        jobs.putForward(id, keccak256("swapped while being graded"));
        vm.prank(reviewerAgent);
        vm.expectRevert(PodJobsV3.CommitMismatch.selector);
        jobs.approve(id, PodJobsV3.Role.Reviewer, keccak256("swapped while being graded"));
        // the commit that is locked is still fine to stand behind, for as long as its review runs
        vm.prank(reviewerAgent);
        jobs.approve(id, PodJobsV3.Role.Reviewer, COMMIT);
        assertEq(_commit(id), COMMIT);
    }

    function test_noSeatIsTakenWhileTheJobIsLocked_oneOpensAgainOnceItIsReleased() public {
        // a job with a spare reviewer seat, locked on its commit with that seat still free
        vm.prank(poster);
        uint256 id = jobs.post{ value: PRICE + 3 * WRITING }(WINDOW, 2);
        _open(id);
        _fillEverySeat(id);
        _approveAll(id, COMMIT);
        assertTrue(jobs.locked(id));

        uint256 deposit = jobs.seatDeposit(id, PodJobsV3.Role.Reviewer);
        vm.deal(stranger, deposit);
        vm.prank(stranger);
        vm.expectRevert(PodJobsV3.Locked.selector);
        jobs.takeSeat{ value: deposit }(id, PodJobsV3.Role.Reviewer, stranger);

        vm.prank(validator);
        jobs.releaseLock(id);
        vm.prank(stranger);
        jobs.takeSeat{ value: deposit }(id, PodJobsV3.Role.Reviewer, stranger);
        assertEq(jobs.seatCount(id, PodJobsV3.Role.Reviewer), 2);
        _assertConserved();
    }

    function test_theLockEndsWithTheSettlement() public {
        uint256 id = _lockedJob();
        _settle(id, PodJobsV3.Verdict.Passed);
        vm.prank(reviewerAgent);
        vm.expectRevert(PodJobsV3.WrongState.selector);
        jobs.approve(id, PodJobsV3.Role.Reviewer, keccak256("after the fact"));
    }

    function test_theLockEndsWithTheWindow() public {
        uint256 id = _lockedJob();
        vm.warp(block.timestamp + WINDOW);
        vm.prank(reviewerAgent);
        vm.expectRevert(PodJobsV3.TooLate.selector);
        jobs.approve(id, PodJobsV3.Role.Reviewer, COMMIT);
        vm.prank(builderAgent);
        vm.expectRevert(PodJobsV3.TooLate.selector);
        jobs.putForward(id, keccak256("after the window"));
    }

    function test_aReleaseClearsTheCommit_andANewCommitPutForwardStartsAfresh() public {
        uint256 id = _lockedJob();
        vm.prank(validator);
        jobs.releaseLock(id);
        assertEq(_commit(id), bytes32(0));
        assertEq(jobs.released(id), COMMIT);
        assertFalse(jobs.locked(id));
        // what the seats said of the commit let go of stands until the builder puts work forward again
        for (uint8 r; r < ROLES; r++) assertTrue(_approved(id, PodJobsV3.Role(r)));

        // a different commit is new work: nothing said of the old one is said of it
        bytes32 fixedUp = keccak256("fixed after the hold");
        _putForward(id, fixedUp);
        assertEq(jobs.released(id), bytes32(0));
        assertTrue(_approved(id, PodJobsV3.Role.Builder));
        assertFalse(_approved(id, PodJobsV3.Role.Lead));
        assertFalse(jobs.locked(id));
        _approveAll(id, fixedUp);
        assertTrue(jobs.policyMet(id, fixedUp));
    }

    function test_onlyTheValidatorReleases_andOnlyALockedJob() public {
        uint256 id = _openJob();
        _fillEverySeat(id);
        vm.prank(validator);
        vm.expectRevert(PodJobsV3.NotLocked.selector);
        jobs.releaseLock(id);

        _approveAll(id, COMMIT);
        address[3] memory others = [poster, writer, leadAgent];
        for (uint256 i; i < others.length; i++) {
            vm.prank(others[i]);
            vm.expectRevert(PodJobsV3.NotValidator.selector);
            jobs.releaseLock(id);
        }
    }

    // --- the verdict ---

    function test_aReportOnAnyCommitButTheCurrentOneIsRefused() public {
        uint256 id = _lockedJob();
        vm.prank(validator);
        jobs.releaseLock(id);
        bytes32 fixedUp = keccak256("fixed after the hold");
        _approveAll(id, fixedUp);

        vm.startPrank(validator);
        vm.expectRevert(PodJobsV3.CommitMismatch.selector);
        jobs.report(id, COMMIT, PodJobsV3.Verdict.Passed, RECEIPT);
        vm.expectRevert(PodJobsV3.CommitMismatch.selector);
        jobs.report(id, COMMIT, PodJobsV3.Verdict.VisibleFailed, RECEIPT);
        jobs.report(id, fixedUp, PodJobsV3.Verdict.Passed, RECEIPT);
        vm.stopPrank();
    }

    function test_nothingIsReportedBeforeItIsLocked() public {
        uint256 id = _openJob();
        _fillEverySeat(id);
        // nothing put forward at all
        vm.prank(validator);
        vm.expectRevert(PodJobsV3.CommitMismatch.selector);
        jobs.report(id, COMMIT, PodJobsV3.Verdict.Passed, RECEIPT);

        _putForward(id, COMMIT);
        vm.prank(leadAgent); jobs.approve(id, PodJobsV3.Role.Lead, COMMIT);
        vm.startPrank(validator);
        vm.expectRevert(PodJobsV3.NotLocked.selector);
        jobs.report(id, COMMIT, PodJobsV3.Verdict.Passed, RECEIPT);
        vm.expectRevert(PodJobsV3.NotLocked.selector);
        jobs.report(id, COMMIT, PodJobsV3.Verdict.VisibleFailed, RECEIPT);
        vm.expectRevert(PodJobsV3.NoVerdict.selector);
        jobs.report(id, COMMIT, PodJobsV3.Verdict.None, RECEIPT);
        vm.stopPrank();
    }

    function test_onlyTheValidatorReportsAVerdict() public {
        uint256 id = _lockedJob();
        address[3] memory others = [poster, writer, leadAgent];
        for (uint256 i; i < others.length; i++) {
            vm.prank(others[i]);
            vm.expectRevert(PodJobsV3.NotValidator.selector);
            jobs.report(id, COMMIT, PodJobsV3.Verdict.Passed, RECEIPT);
        }
    }

    function test_nothingIsReportedAfterTheWindow() public {
        uint256 id = _lockedJob();
        vm.warp(block.timestamp + WINDOW);
        vm.prank(validator);
        vm.expectRevert(PodJobsV3.TooLate.selector);
        jobs.report(id, COMMIT, PodJobsV3.Verdict.Passed, RECEIPT);
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
        uint256 builderDue = jobs.seatPay(id, PodJobsV3.Role.Builder) + jobs.seatDeposit(id, PodJobsV3.Role.Builder);
        uint256 paid;
        for (uint8 r; r < ROLES; r++) paid += jobs.seatPay(id, PodJobsV3.Role(r));

        _settle(id, PodJobsV3.Verdict.Passed);
        assertEq(builderAgent.balance, builderBefore + builderDue);
        assertEq(poster.balance, posterBefore + price - paid);
        assertGt(price - paid, jobs.seatPay(id, PodJobsV3.Role.Reviewer), "the untaken reviewer's share went back");
        assertEq(address(jobs).balance, 0, "every last wei went somewhere");
        _assertConserved();
    }

    function test_aVerdictIsRecordedWithItsReceipt() public {
        uint256 id = _lockedJob();
        _settle(id, PodJobsV3.Verdict.VisibleFailed);
        (PodJobsV3.Verdict verdict, bytes32 receiptHash) = jobs.reports(id);
        assertEq(uint8(verdict), uint8(PodJobsV3.Verdict.VisibleFailed));
        assertEq(receiptHash, RECEIPT);
    }

    // --- item 14: an approval that costs something ---

    function test_aCheckThePodCouldSeeFailing_costsEverySeatBehindTheWorkItsDeposit_theBuilderToo() public {
        uint256 id = _lockedJob();
        uint256 forfeited = jobs.seatDeposit(id, PodJobsV3.Role.Lead) + jobs.seatDeposit(id, PodJobsV3.Role.Builder)
            + jobs.seatDeposit(id, PodJobsV3.Role.Reviewer) + jobs.seatDeposit(id, PodJobsV3.Role.QA) + jobs.seatDeposit(id, PodJobsV3.Role.Security);

        uint256 posterBefore = poster.balance;
        uint256 leadBefore = leadAgent.balance;
        uint256 builderBefore = builderAgent.balance;
        _settle(id, PodJobsV3.Verdict.VisibleFailed);

        assertEq(leadAgent.balance, leadBefore, "the lead stood behind it, and loses its deposit");
        assertEq(builderAgent.balance, builderBefore, "the builder put it forward, and loses its deposit");
        assertEq(poster.balance, posterBefore + PRICE + forfeited, "the poster gets the price and the forfeits");
        assertEq(address(jobs).balance, 0);
        _assertConserved();
    }

    function test_onlyAHiddenCheckFailing_sendsEveryDepositHome() public {
        uint256 id = _lockedJob();
        uint256 leadDeposit = jobs.seatDeposit(id, PodJobsV3.Role.Lead);
        uint256 posterBefore = poster.balance;
        uint256 leadBefore = leadAgent.balance;
        _settle(id, PodJobsV3.Verdict.HiddenFailed);

        assertEq(leadAgent.balance, leadBefore + leadDeposit);
        assertEq(poster.balance, posterBefore + PRICE, "a poster cannot profit from an exam made to fail");
        assertEq(address(jobs).balance, 0);
        _assertConserved();
    }

    function test_theWindowClosingSendsEveryDepositHome() public {
        uint256 id = _lockedJob();
        uint256 leadDeposit = jobs.seatDeposit(id, PodJobsV3.Role.Lead);
        uint256 leadBefore = leadAgent.balance;
        uint256 posterBefore = poster.balance;
        vm.warp(block.timestamp + WINDOW);
        vm.prank(stranger);
        jobs.close(id);

        assertEq(leadAgent.balance, leadBefore + leadDeposit);
        assertEq(poster.balance, posterBefore + PRICE);
        assertEq(uint8(_state(id)), uint8(PodJobsV3.State.Refunded));
        _assertConserved();
    }

    // --- closing ---

    function test_anybodyMayCloseAfterTheWindow_nobodyBefore() public {
        uint256 id = _openJob();
        _take(id, PodJobsV3.Role.Builder, builderAgent, builderOwner);
        vm.warp(block.timestamp + WINDOW - 1);
        vm.prank(stranger);
        vm.expectRevert(PodJobsV3.TooEarly.selector);
        jobs.close(id);

        vm.warp(block.timestamp + 1);
        vm.prank(stranger);
        jobs.close(id);
        vm.prank(stranger);
        vm.expectRevert(PodJobsV3.WrongState.selector);
        jobs.close(id);
        _assertConserved();
    }

    function test_aNumberNobodyWasGivenCannotBeClosed() public {
        vm.prank(stranger);
        vm.expectRevert(PodJobsV3.NoSuchJob.selector);
        jobs.close(FIRST_JOB - 1);
        uint256 next = jobs.nextJobId();
        vm.prank(stranger);
        vm.expectRevert(PodJobsV3.NoSuchJob.selector);
        jobs.close(next);
    }

    function test_aJobStillPreparingHasNoWindowToClose() public {
        uint256 id = _post();
        vm.warp(block.timestamp + 30 days);
        vm.prank(stranger);
        vm.expectRevert(PodJobsV3.WrongState.selector);
        jobs.close(id);
    }

    // --- payments that do not arrive ---

    function _seatAPayee(address payee) internal returns (uint256 id) {
        id = _openJob();
        vm.deal(payee, 10 ether);
        _take(id, PodJobsV3.Role.Lead, leadAgent, leadOwner);
        _take(id, PodJobsV3.Role.Builder, payee, builderOwner);
        _take(id, PodJobsV3.Role.Reviewer, reviewerAgent, reviewerOwner);
        _take(id, PodJobsV3.Role.QA, qaAgent, qaOwner);
        _take(id, PodJobsV3.Role.Security, securityAgent, securityOwner);
        _approveAll(id, COMMIT);
    }

    function _assertEverybodyElsePaid(uint256 id, address payee) internal {
        uint256 leadBefore = leadAgent.balance;
        uint256 securityBefore = securityAgent.balance;
        uint256 payeeBefore = payee.balance;
        uint256 payeeDue = jobs.seatPay(id, PodJobsV3.Role.Builder) + jobs.seatDeposit(id, PodJobsV3.Role.Builder);
        _settle(id, PodJobsV3.Verdict.Passed);

        assertEq(uint8(_state(id)), uint8(PodJobsV3.State.Settled));
        assertEq(leadAgent.balance, leadBefore + jobs.seatPay(id, PodJobsV3.Role.Lead) + jobs.seatDeposit(id, PodJobsV3.Role.Lead));
        assertEq(securityAgent.balance, securityBefore + jobs.seatPay(id, PodJobsV3.Role.Security) + jobs.seatDeposit(id, PodJobsV3.Role.Security));
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

    function test_aFloodOfDataIsNeverReadBack_soItCostsTheSettlementNoMoreThanItsOwnGas() public {
        // one job settled first, so the other seats' records are already being counted when the two
        // settlements measured against each other run: the first count an agent is given costs more
        _settle(_seatAPayee(address(new Quiet())), PodJobsV3.Verdict.Passed);
        uint256 quietJob = _seatAPayee(address(new Quiet()));
        uint256 floodJob = _seatAPayee(address(new Flood()));
        _report(quietJob, PodJobsV3.Verdict.Passed);
        _report(floodJob, PodJobsV3.Verdict.Passed);
        vm.warp(jobs.answerBy(floodJob));
        vm.startPrank(stranger);
        uint256 before = gasleft();
        jobs.settleUnanswered(quietJob);
        uint256 quiet = before - gasleft();
        before = gasleft();
        jobs.settleUnanswered(floodJob);
        uint256 flooded = before - gasleft();
        vm.stopPrank();
        // the flood spends the payee's own gas; copied back, it would cost the settlement as much again
        assertLt(flooded - quiet, PAYOUT_GAS, "reading the flood back would cost the settlement more than the payee's own gas");
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
        vm.expectRevert(PodJobsV3.PaymentFailed.selector);
        jobs.withdraw(address(refuser));

        vm.prank(address(refuser));
        jobs.withdraw(stranger);
        assertEq(jobs.owed(address(refuser)), 0);
        _assertConserved();
    }

    function test_nothingOwedIsNothingToWithdraw() public {
        vm.prank(stranger);
        vm.expectRevert(PodJobsV3.NothingOwed.selector);
        jobs.withdraw(stranger);
    }

    // --- seats, as before ---

    function test_theSharesAddUpToThePrice() public {
        uint256 id = _openJob();
        uint256 total;
        for (uint8 r; r < ROLES; r++) total += jobs.seatPay(id, PodJobsV3.Role(r));
        assertEq(total, PRICE);
    }

    function test_oneOwnerCannotHoldTwoSeats() public {
        uint256 id = _openJob();
        _take(id, PodJobsV3.Role.Lead, leadAgent, leadOwner);
        uint256 deposit = jobs.seatDeposit(id, PodJobsV3.Role.Builder);
        vm.prank(builderAgent);
        vm.expectRevert(PodJobsV3.OwnerAlreadySeated.selector);
        jobs.takeSeat{ value: deposit }(id, PodJobsV3.Role.Builder, leadOwner);
    }

    function test_aSeatIsFirstComeFirstServed() public {
        uint256 id = _openJob();
        _take(id, PodJobsV3.Role.Lead, leadAgent, leadOwner);
        uint256 deposit = jobs.seatDeposit(id, PodJobsV3.Role.Lead);
        vm.prank(builderAgent);
        vm.expectRevert(PodJobsV3.SeatFilled.selector);
        jobs.takeSeat{ value: deposit }(id, PodJobsV3.Role.Lead, builderOwner);
    }

    function test_theDepositMustBeExact() public {
        uint256 id = _openJob();
        vm.prank(leadAgent);
        vm.expectRevert(PodJobsV3.WrongAmount.selector);
        jobs.takeSeat{ value: 1 }(id, PodJobsV3.Role.Lead, leadOwner);
    }

    function test_noSeatAfterTheWindow() public {
        uint256 id = _openJob();
        vm.warp(block.timestamp + WINDOW);
        uint256 deposit = jobs.seatDeposit(id, PodJobsV3.Role.Lead);
        vm.prank(leadAgent);
        vm.expectRevert(PodJobsV3.TooLate.selector);
        jobs.takeSeat{ value: deposit }(id, PodJobsV3.Role.Lead, leadOwner);
    }

    function test_withoutEverySeatThePodHasNotAgreed_soItIsNotGradedAtOnce() public {
        uint256 id = _openJob();
        _fillEverySeat(id);
        _putForward(id, COMMIT);
        vm.prank(leadAgent); jobs.approve(id, PodJobsV3.Role.Lead, COMMIT);
        vm.prank(reviewerAgent); jobs.approve(id, PodJobsV3.Role.Reviewer, COMMIT);
        vm.prank(qaAgent); jobs.approve(id, PodJobsV3.Role.QA, COMMIT);
        assertFalse(jobs.policyMet(id, COMMIT), "security has not said it stands behind it");
        assertFalse(jobs.locked(id));
        vm.prank(securityAgent); jobs.approve(id, PodJobsV3.Role.Security, COMMIT);
        assertTrue(jobs.policyMet(id, COMMIT));
        assertTrue(jobs.locked(id), "the whole pod behind it: graded at once");
    }

    function test_theBuilderStandsBehindItsWorkByPuttingItForward_andByNothingElse() public {
        uint256 id = _openJob();
        _fillEverySeat(id);
        assertFalse(_approved(id, PodJobsV3.Role.Builder));
        _putForward(id, COMMIT);
        assertTrue(_approved(id, PodJobsV3.Role.Builder), "putting it forward is standing behind it");
        vm.prank(builderAgent);
        vm.expectRevert(PodJobsV3.BuildersDoNotApprove.selector);
        jobs.approve(id, PodJobsV3.Role.Builder, COMMIT);
        // the same commit again changes nothing, and is refused rather than clearing what the pod said
        vm.prank(leadAgent); jobs.approve(id, PodJobsV3.Role.Lead, COMMIT);
        vm.prank(builderAgent);
        vm.expectRevert(PodJobsV3.CommitMismatch.selector);
        jobs.putForward(id, COMMIT);
        assertTrue(_approved(id, PodJobsV3.Role.Lead));

        // only a hidden check fails: nobody could have seen it, and the builder's deposit comes home with the others
        _approveAll(id, COMMIT);
        uint256 before = builderAgent.balance;
        _settle(id, PodJobsV3.Verdict.HiddenFailed);
        assertEq(builderAgent.balance, before + jobs.seatDeposit(id, PodJobsV3.Role.Builder));
    }

    function test_onlyASeatHolderApproves_andOnlyTheBuilderPutsWorkForward() public {
        uint256 id = _openJob();
        _fillEverySeat(id);
        // the lead, a judge and a stranger each try to name what is graded
        address[3] memory notTheBuilder = [leadAgent, securityAgent, stranger];
        for (uint256 i; i < notTheBuilder.length; i++) {
            vm.prank(notTheBuilder[i]);
            vm.expectRevert(PodJobsV3.NotTheSeat.selector);
            jobs.putForward(id, COMMIT);
        }
        assertEq(_commit(id), bytes32(0));
        // and nothing is approved that the builder has not put forward
        vm.prank(leadAgent);
        vm.expectRevert(PodJobsV3.CommitMismatch.selector);
        jobs.approve(id, PodJobsV3.Role.Lead, COMMIT);

        _putForward(id, COMMIT);
        vm.prank(stranger);
        vm.expectRevert(PodJobsV3.NotTheSeat.selector);
        jobs.approve(id, PodJobsV3.Role.Lead, COMMIT);
        // a seat approves as the seat it holds, not as another
        vm.prank(qaAgent);
        vm.expectRevert(PodJobsV3.NotTheSeat.selector);
        jobs.approve(id, PodJobsV3.Role.Security, COMMIT);
    }
}

/// @dev a poster that, on being paid anything, tries to answer its delivered job again
contract TwiceAnsweringPoster {
    PodJobsV3 immutable jobs;
    uint256 public jobId;
    uint256 public triedAgain;

    constructor(PodJobsV3 jobs_) { jobs = jobs_; }

    function post(uint64 window) external payable { jobId = jobs.post{ value: msg.value }(window, 1); }

    function approveChecks(bytes32 seal, bytes calldata signature) external { jobs.approveChecks(jobId, seal, signature); }

    function refuse() external { jobs.refuse(jobId); }

    receive() external payable {
        triedAgain++;
        try jobs.refuse(jobId) {} catch {}
        try jobs.accept(jobId) {} catch {}
    }
}

/// @notice What the third contract adds: the validator reports and moves nothing, the poster has the
///         last word, silence follows the checks, and the contract keeps count of how jobs ended.
/// @dev An agent in the lead's seat that, each time it is paid, tries every door of the contract
///      from inside the payment: settling, closing, answering, seating, approving and withdrawing.
contract GreedyAgent {
    PodJobsV3 immutable jobs;
    uint256 id;
    uint256 public paid;
    uint256 public landed;

    constructor(PodJobsV3 jobs_) {
        jobs = jobs_;
    }

    function sit(uint256 id_) external {
        id = id_;
        jobs.takeSeat{ value: jobs.seatDeposit(id_, PodJobsV3.Role.Lead) }(id_, PodJobsV3.Role.Lead, address(this));
    }

    function approve(bytes32 commit) external {
        jobs.approve(id, PodJobsV3.Role.Lead, commit);
    }

    receive() external payable {
        paid++;
        try jobs.settleUnanswered(id) { landed++; } catch {}
        try jobs.close(id) { landed++; } catch {}
        try jobs.accept(id) { landed++; } catch {}
        try jobs.refuse(id) { landed++; } catch {}
        try jobs.takeSeat(id, PodJobsV3.Role.Reviewer, address(uint160(paid + 1000))) { landed++; } catch {}
        try jobs.approve(id, PodJobsV3.Role.Lead, keccak256("another commit")) { landed++; } catch {}
        try jobs.withdraw(address(this)) { landed++; } catch {}
    }
}

contract PodJobsV3LastWordTest is PodJobsV3Fixture {
    PodJobsV3.Verdict constant PASSED = PodJobsV3.Verdict.Passed;
    PodJobsV3.Verdict constant HIDDEN_FAILED = PodJobsV3.Verdict.HiddenFailed;
    PodJobsV3.Verdict constant VISIBLE_FAILED = PodJobsV3.Verdict.VisibleFailed;

    function _seatHolders() internal view returns (address[5] memory) {
        return [leadAgent, builderAgent, reviewerAgent, qaAgent, securityAgent];
    }

    function _balances() internal view returns (uint256[6] memory held) {
        address[5] memory holders = _seatHolders();
        for (uint256 i; i < holders.length; i++) held[i] = holders[i].balance;
        held[5] = poster.balance;
    }

    // --- the report ---

    function test_aReportMovesNoMoney_andStartsThePostersTime() public {
        uint256 id = _lockedJob();
        uint256[6] memory before = _balances();
        uint256 validatorBefore = validator.balance;
        uint256 held = address(jobs).balance;

        _report(id, PASSED);

        uint256[6] memory afterwards = _balances();
        for (uint256 i; i < before.length; i++) assertEq(afterwards[i], before[i], "a report pays nobody");
        assertEq(validator.balance, validatorBefore);
        assertEq(address(jobs).balance, held);
        assertEq(uint8(_state(id)), uint8(PodJobsV3.State.Delivered));
        assertEq(jobs.answerBy(id), block.timestamp + ANSWER_TIME);
        (PodJobsV3.Verdict verdict, bytes32 receiptHash) = jobs.reports(id);
        assertEq(uint8(verdict), uint8(PASSED));
        assertEq(receiptHash, RECEIPT);
        _assertConserved();
    }

    function test_theValidatorCanMoveNoJobsMoney() public {
        uint256 id = _delivered(PASSED);
        vm.startPrank(validator);
        vm.expectRevert(PodJobsV3.NotPoster.selector);
        jobs.accept(id);
        vm.expectRevert(PodJobsV3.NotPoster.selector);
        jobs.refuse(id);
        vm.expectRevert(PodJobsV3.TooEarly.selector);
        jobs.settleUnanswered(id);
        // the second contract's way of settling on the verdict alone is not here to be called
        (bool isThere, ) = address(jobs).call(abi.encodeWithSignature("settle(uint256,bytes32,uint8,bytes32)", id, COMMIT, uint8(1), RECEIPT));
        assertFalse(isThere);
        vm.stopPrank();
        assertEq(uint8(_state(id)), uint8(PodJobsV3.State.Delivered));
    }

    function test_nothingElseHappensToADeliveredJob() public {
        uint256 id = _delivered(PASSED);
        address late = makeAddr("a late agent");
        vm.deal(late, 1 ether);

        vm.prank(late);
        vm.expectRevert(PodJobsV3.WrongState.selector);
        jobs.takeSeat{ value: 0 }(id, PodJobsV3.Role.Reviewer, late);
        vm.prank(reviewerAgent);
        vm.expectRevert(PodJobsV3.WrongState.selector);
        jobs.approve(id, PodJobsV3.Role.Reviewer, keccak256("another commit"));
        vm.prank(poster);
        vm.expectRevert(PodJobsV3.WrongState.selector);
        jobs.takeBack(id);
        vm.startPrank(validator);
        vm.expectRevert(PodJobsV3.WrongState.selector);
        jobs.releaseLock(id);
        vm.expectRevert(PodJobsV3.WrongState.selector);
        jobs.report(id, COMMIT, HIDDEN_FAILED, RECEIPT);
        vm.stopPrank();
    }

    function test_aDeliveredJobIsNotClosed_notEvenAfterItsWindow() public {
        uint256 id = _delivered(PASSED);
        vm.warp(block.timestamp + WINDOW + 1);
        vm.prank(stranger);
        vm.expectRevert(PodJobsV3.WrongState.selector);
        jobs.close(id);
    }

    // --- accepting ---

    function _assertAcceptedPays(PodJobsV3.Verdict verdict) internal {
        uint256 id = _delivered(verdict);
        uint256[6] memory before = _balances();
        address[5] memory holders = _seatHolders();

        vm.prank(poster);
        jobs.accept(id);

        uint256 paid;
        for (uint8 r; r < ROLES; r++) {
            uint256 pay = jobs.seatPay(id, PodJobsV3.Role(r));
            assertEq(holders[r].balance, before[r] + pay + jobs.seatDeposit(id, PodJobsV3.Role(r)), "every seat is paid, with its deposit home");
            paid += pay;
        }
        assertEq(poster.balance, before[5] + PRICE - paid);
        assertEq(uint8(_state(id)), uint8(PodJobsV3.State.Settled));
        _assertConserved();
    }

    function test_acceptingPaysThePod_whenTheChecksPassed() public { _assertAcceptedPays(PASSED); }

    function test_acceptingPaysThePod_thoughAHiddenCheckFailed() public { _assertAcceptedPays(HIDDEN_FAILED); }

    function test_acceptingPaysThePod_thoughACheckThePodCouldSeeFailed_andNoDepositIsLost() public { _assertAcceptedPays(VISIBLE_FAILED); }

    function test_onlyThePosterAccepts_andOnlyADeliveredJob_andOnlyOnce() public {
        uint256 id = _lockedJob();
        vm.prank(poster);
        vm.expectRevert(PodJobsV3.WrongState.selector);
        jobs.accept(id);

        _report(id, PASSED);
        address[3] memory others = [stranger, validator, leadAgent];
        for (uint256 i; i < others.length; i++) {
            vm.prank(others[i]);
            vm.expectRevert(PodJobsV3.NotPoster.selector);
            jobs.accept(id);
        }

        vm.startPrank(poster);
        jobs.accept(id);
        vm.expectRevert(PodJobsV3.WrongState.selector);
        jobs.accept(id);
        vm.expectRevert(PodJobsV3.WrongState.selector);
        jobs.refuse(id);
        vm.stopPrank();
    }

    function test_aLateYesStillPaysThePod_untilSomebodySettles() public {
        uint256 id = _delivered(HIDDEN_FAILED);
        vm.warp(jobs.answerBy(id) + 1 days);
        uint256 leadBefore = leadAgent.balance;
        vm.prank(poster);
        jobs.accept(id);
        assertEq(leadAgent.balance, leadBefore + jobs.seatPay(id, PodJobsV3.Role.Lead) + jobs.seatDeposit(id, PodJobsV3.Role.Lead));
        _assertConserved();
    }

    // --- refusing ---

    function test_refusingWhatPassedLeavesThePodAQuarter_andThePosterTheRest() public {
        uint256 id = _delivered(PASSED);
        uint256[6] memory before = _balances();
        address[5] memory holders = _seatHolders();

        vm.prank(poster);
        jobs.refuse(id);

        uint256 kept;
        for (uint8 r; r < ROLES; r++) {
            uint256 share = (jobs.seatPay(id, PodJobsV3.Role(r)) * REFUSAL_SHARE) / 100;
            assertEq(holders[r].balance, before[r] + share + jobs.seatDeposit(id, PodJobsV3.Role(r)), "each seat keeps a quarter of its pay, and its deposit comes home");
            kept += share;
        }
        // the shares add to the whole price here, so a quarter of each is a quarter of it
        assertEq(kept, (PRICE * REFUSAL_SHARE) / 100);
        assertEq(poster.balance, before[5] + PRICE - kept);
        assertEq(uint8(_state(id)), uint8(PodJobsV3.State.Refunded));
        _assertConserved();
    }

    function test_refusingAfterOnlyAHiddenCheckFailed_returnsEverything() public {
        uint256 id = _delivered(HIDDEN_FAILED);
        uint256[6] memory before = _balances();
        address[5] memory holders = _seatHolders();

        vm.prank(poster);
        jobs.refuse(id);

        for (uint8 r; r < ROLES; r++) assertEq(holders[r].balance, before[r] + jobs.seatDeposit(id, PodJobsV3.Role(r)), "a seat gets its deposit home and nothing more");
        assertEq(poster.balance, before[5] + PRICE);
        _assertConserved();
    }

    function test_refusingAfterACheckThePodCouldSeeFailed_costsEverySeatBehindItItsDeposit_asSilenceWould() public {
        uint256 id = _delivered(VISIBLE_FAILED);
        uint256[6] memory before = _balances();
        address[5] memory holders = _seatHolders();
        uint256 forfeited;
        for (uint8 r; r < ROLES; r++) forfeited += jobs.seatDeposit(id, PodJobsV3.Role(r));

        vm.prank(poster);
        jobs.refuse(id);

        // the whole pod stood behind it, the builder by putting it forward
        for (uint8 r; r < ROLES; r++) assertEq(holders[r].balance, before[r]);
        assertEq(poster.balance, before[5] + PRICE + forfeited);
        _assertConserved();
    }

    function test_onlyThePosterRefuses_andOnlyADeliveredJob() public {
        uint256 id = _lockedJob();
        vm.prank(poster);
        vm.expectRevert(PodJobsV3.WrongState.selector);
        jobs.refuse(id);

        _report(id, PASSED);
        address[3] memory others = [stranger, validator, leadAgent];
        for (uint256 i; i < others.length; i++) {
            vm.prank(others[i]);
            vm.expectRevert(PodJobsV3.NotPoster.selector);
            jobs.refuse(id);
        }
    }

    function test_aRefusalIsOnlyInTime_afterThatTheChecksDecide() public {
        uint256 id = _delivered(PASSED);
        vm.warp(jobs.answerBy(id) - 1);
        vm.prank(stranger);
        vm.expectRevert(PodJobsV3.TooEarly.selector);
        jobs.settleUnanswered(id);

        vm.warp(jobs.answerBy(id));
        vm.prank(poster);
        vm.expectRevert(PodJobsV3.TooLate.selector);
        jobs.refuse(id);

        uint256 leadBefore = leadAgent.balance;
        vm.prank(stranger);
        jobs.settleUnanswered(id);
        assertEq(leadAgent.balance, leadBefore + jobs.seatPay(id, PodJobsV3.Role.Lead) + jobs.seatDeposit(id, PodJobsV3.Role.Lead), "a pass the poster never answered pays the pod in full");
        assertEq(uint8(_state(id)), uint8(PodJobsV3.State.Settled));

        vm.prank(stranger);
        vm.expectRevert(PodJobsV3.WrongState.selector);
        jobs.settleUnanswered(id);
    }

    function test_aRefusalOnTheLastSecondStillCounts() public {
        uint256 id = _delivered(PASSED);
        vm.warp(jobs.answerBy(id) - 1);
        vm.prank(poster);
        jobs.refuse(id);
        assertEq(uint8(_state(id)), uint8(PodJobsV3.State.Refunded));
    }

    function test_aPosterCannotAnswerTwice_evenFromInsideItsRefund() public {
        TwiceAnsweringPoster twice = new TwiceAnsweringPoster(jobs);
        vm.deal(address(this), 100 ether);
        twice.post{ value: PRICE + 3 * WRITING }(WINDOW);
        uint256 id = twice.jobId();
        _write(id);
        // the unused writing money comes back here, and its attempt to answer a job not delivered is refused
        twice.approveChecks(SEAL, _written(id, SEAL));
        _fillEverySeat(id);
        _approveAll(id, COMMIT);
        _report(id, PASSED);
        uint256 triedBefore = twice.triedAgain();
        uint256 leadBefore = leadAgent.balance;

        twice.refuse();

        assertEq(twice.triedAgain(), triedBefore + 1, "it did try again, from inside its own refund");
        assertEq(leadAgent.balance, leadBefore + (jobs.seatPay(id, PodJobsV3.Role.Lead) * REFUSAL_SHARE) / 100 + jobs.seatDeposit(id, PodJobsV3.Role.Lead), "and the pod was paid its quarter once");
        (uint32 posted, uint32 accepted, uint32 refusedPassed, , ) = jobs.posters(address(twice));
        assertEq(posted, 1);
        assertEq(accepted, 0);
        assertEq(refusedPassed, 1);
        _assertConserved();
    }

    // --- who has done what ---

    function test_aPostersRecordCountsEveryWayTheirJobsEnded() public {
        uint256 accepted = _delivered(PASSED);
        vm.prank(poster); jobs.accept(accepted);
        uint256 refusedPassed = _delivered(PASSED);
        vm.prank(poster); jobs.refuse(refusedPassed);
        uint256 refusedFailed = _delivered(HIDDEN_FAILED);
        vm.prank(poster); jobs.refuse(refusedFailed);
        _settle(_lockedJob(), PASSED);
        _post();

        PodJobsV3.PosterRecord memory record = _poster();
        assertEq(record.posted, 5);
        assertEq(record.accepted, 1);
        assertEq(record.refusedPassed, 1);
        assertEq(record.refusedFailed, 1);
        assertEq(record.unanswered, 1);

        (uint32 strangersPosted, , , , ) = jobs.posters(stranger);
        assertEq(strangersPosted, 0, "somebody who posted nothing has no record");
    }

    function test_anAgentsRecordCountsEveryWayItsJobsEnded() public {
        uint256 id = _delivered(PASSED);
        vm.prank(poster); jobs.accept(id);
        id = _delivered(VISIBLE_FAILED);
        vm.prank(poster); jobs.accept(id);
        _settle(_lockedJob(), PASSED);
        id = _delivered(PASSED);
        vm.prank(poster); jobs.refuse(id);
        id = _delivered(HIDDEN_FAILED);
        vm.prank(poster); jobs.refuse(id);
        _settle(_lockedJob(), VISIBLE_FAILED);

        address[5] memory holders = _seatHolders();
        for (uint256 i; i < holders.length; i++) {
            PodJobsV3.AgentRecord memory record = _agent(holders[i]);
            assertEq(record.accepted, 2, "accepted counts whatever the checks found");
            assertEq(record.paidUnanswered, 1);
            assertEq(record.refusedPassed, 1);
            assertEq(record.failed, 2, "failed counts a refusal and a silence alike");
            assertEq(record.undelivered, 0);
        }
    }

    function test_aJobNothingWasPutForwardOnIsCountedForItsBuilderAlone_andNotOnceWorkReachedGrading() public {
        // seats taken, nothing put forward: the window closes on a builder that delivered nothing
        uint256 idle = _openJob();
        _fillEverySeat(idle);
        // put forward, the whole pod behind it, and never reported on: the builder did its part
        uint256 locked = _lockedJob();
        vm.warp(block.timestamp + WINDOW);
        vm.startPrank(stranger);
        jobs.close(idle);
        jobs.close(locked);
        vm.stopPrank();

        assertEq(_agent(builderAgent).undelivered, 1, "counted once, for the job nothing was put forward on");
        // nothing any other seat does or leaves undone keeps work back, so it is no other seat's count
        address[4] memory others = [leadAgent, reviewerAgent, qaAgent, securityAgent];
        for (uint256 i; i < others.length; i++) assertEq(_counted(others[i]), 0);
        _assertConserved();
    }

    function test_howEachDeliveredJobEndedCanBeAskedOfTheContract() public {
        uint256 waiting = _delivered(PASSED);
        assertEq(uint8(jobs.answers(waiting)), uint8(PodJobsV3.Answer.None), "delivered, and not answered yet");
        uint256 accepted = _delivered(HIDDEN_FAILED);
        vm.prank(poster); jobs.accept(accepted);
        uint256 refused = _delivered(PASSED);
        vm.prank(poster); jobs.refuse(refused);
        uint256 refusedAfterFailing = _delivered(VISIBLE_FAILED);
        vm.prank(poster); jobs.refuse(refusedAfterFailing);
        uint256 unanswered = _lockedJob();
        _settle(unanswered, PASSED);
        uint256 neverDelivered = _openJob();
        vm.prank(poster); jobs.takeBack(neverDelivered);

        assertEq(uint8(jobs.answers(accepted)), uint8(PodJobsV3.Answer.Accepted));
        assertEq(uint8(jobs.answers(refused)), uint8(PodJobsV3.Answer.Refused));
        assertEq(uint8(jobs.answers(refusedAfterFailing)), uint8(PodJobsV3.Answer.Refused));
        assertEq(uint8(jobs.answers(unanswered)), uint8(PodJobsV3.Answer.Unanswered));
        assertEq(uint8(jobs.answers(neverDelivered)), uint8(PodJobsV3.Answer.None));
    }

    function test_aJobTakenBackOrNeverTakenCountsAgainstNobody() public {
        uint256 id = _openJob();
        vm.prank(poster);
        jobs.takeBack(id);
        PodJobsV3.PosterRecord memory record = _poster();
        assertEq(record.posted, 1);
        assertEq(record.accepted + record.refusedPassed + record.refusedFailed + record.unanswered, 0);
    }

    // --- what an independent reading of the contract found, 11 Oct ---

    /// @dev One agent in all nine seats of a job, each under an owner it made up, with the pod's
    ///      approvals in place. A count is for a job: nine seats on one job are one job.
    function _aJobOneAgentHoldsEverySeatOf(address solo) internal returns (uint256 id) {
        vm.prank(poster);
        id = jobs.post{ value: PRICE + 3 * WRITING }(WINDOW, 5);
        _write(id);
        _open(id);
        // the one-owner rule goes by the owner a seat names, which nothing stops an agent making up
        uint160 madeUp = uint160(uint256(keccak256(abi.encode("a made-up owner", id))));
        _take(id, PodJobsV3.Role.Lead, solo, address(madeUp++));
        _take(id, PodJobsV3.Role.Builder, solo, address(madeUp++));
        for (uint256 i; i < 5; i++) _take(id, PodJobsV3.Role.Reviewer, solo, address(madeUp++));
        _take(id, PodJobsV3.Role.QA, solo, address(madeUp++));
        _take(id, PodJobsV3.Role.Security, solo, address(madeUp++));
    }

    function _approveAsEverySeat(uint256 id, address solo) internal {
        vm.startPrank(solo);
        jobs.putForward(id, COMMIT);
        jobs.approve(id, PodJobsV3.Role.Lead, COMMIT);
        jobs.approve(id, PodJobsV3.Role.Reviewer, COMMIT);
        jobs.approve(id, PodJobsV3.Role.QA, COMMIT);
        jobs.approve(id, PodJobsV3.Role.Security, COMMIT);
        vm.stopPrank();
    }

    function test_anAgentHoldingEverySeatOfAJobIsCountedOnceForIt_howeverItEnds() public {
        address solo = makeAddr("one agent in every seat");
        vm.deal(solo, 1_000 ether);
        vm.deal(poster, 1_000 ether);

        uint256 id = _aJobOneAgentHoldsEverySeatOf(solo);
        _approveAsEverySeat(id, solo);
        _report(id, PASSED);
        vm.prank(poster); jobs.accept(id);

        id = _aJobOneAgentHoldsEverySeatOf(solo);
        _approveAsEverySeat(id, solo);
        _settle(id, PASSED);

        id = _aJobOneAgentHoldsEverySeatOf(solo);
        _approveAsEverySeat(id, solo);
        _report(id, PASSED);
        vm.prank(poster); jobs.refuse(id);

        id = _aJobOneAgentHoldsEverySeatOf(solo);
        _approveAsEverySeat(id, solo);
        _settle(id, VISIBLE_FAILED);

        // the last one it holds every seat of and puts nothing forward on
        id = _aJobOneAgentHoldsEverySeatOf(solo);
        vm.warp(block.timestamp + WINDOW);
        jobs.close(id);

        PodJobsV3.AgentRecord memory record = _agent(solo);
        assertEq(record.accepted, 1, "nine seats on one job are one job");
        assertEq(record.paidUnanswered, 1);
        assertEq(record.refusedPassed, 1);
        assertEq(record.failed, 1);
        assertEq(record.undelivered, 1);
        // the money is not counted the same way: every seat is paid, and nothing is left behind
        _assertConserved();
        assertEq(address(jobs).balance, jobs.totalOwed());
    }

    function test_anAgentInTwoSeatsIsCountedOnce_andTheAgentsBesideItOnceEach() public {
        uint256 id = _openJob();
        // the lead's agent also sits as QA, under another owner
        _take(id, PodJobsV3.Role.Lead, leadAgent, leadOwner);
        _take(id, PodJobsV3.Role.Builder, builderAgent, builderOwner);
        _take(id, PodJobsV3.Role.Reviewer, reviewerAgent, reviewerOwner);
        _take(id, PodJobsV3.Role.QA, leadAgent, qaOwner);
        _take(id, PodJobsV3.Role.Security, securityAgent, securityOwner);
        _putForward(id, COMMIT);
        vm.startPrank(leadAgent);
        jobs.approve(id, PodJobsV3.Role.Lead, COMMIT);
        jobs.approve(id, PodJobsV3.Role.QA, COMMIT);
        vm.stopPrank();
        vm.prank(reviewerAgent); jobs.approve(id, PodJobsV3.Role.Reviewer, COMMIT);
        vm.prank(securityAgent); jobs.approve(id, PodJobsV3.Role.Security, COMMIT);
        _report(id, PASSED);
        vm.prank(poster); jobs.accept(id);

        assertEq(_agent(leadAgent).accepted, 1, "two seats, one job");
        assertEq(_agent(builderAgent).accepted, 1);
        assertEq(_agent(reviewerAgent).accepted, 1);
        assertEq(_agent(securityAgent).accepted, 1);
        assertEq(_agent(qaAgent).accepted, 0, "it held no seat");
    }

    function test_aPodWhoseAgreedWorkTheValidatorLetGoIsNotCountedAsDeliveringNothing() public {
        uint256 id = _lockedJob();
        assertTrue(jobs.wasLocked(id), "the pod agreed on work to be graded");
        // the validator could not grade it, late in the window, and the window ran out before the pod could agree again
        vm.warp(block.timestamp + WINDOW - 1);
        vm.prank(validator);
        jobs.releaseLock(id);
        assertFalse(jobs.locked(id));
        vm.warp(block.timestamp + 1);
        vm.prank(stranger);
        jobs.close(id);

        address[5] memory holders = _seatHolders();
        for (uint256 i; i < holders.length; i++) assertEq(_agent(holders[i]).undelivered, 0, "letting go of its work was not the pod's doing");
        _assertConserved();
    }

    function test_aPodIsOnlySaidToHaveAgreedOnceEveryApprovalIsIn() public {
        uint256 id = _openJob();
        _fillEverySeat(id);
        assertFalse(jobs.wasLocked(id));
        _putForward(id, COMMIT);
        vm.prank(leadAgent); jobs.approve(id, PodJobsV3.Role.Lead, COMMIT);
        vm.prank(reviewerAgent); jobs.approve(id, PodJobsV3.Role.Reviewer, COMMIT);
        vm.prank(qaAgent); jobs.approve(id, PodJobsV3.Role.QA, COMMIT);
        assertFalse(jobs.wasLocked(id), "one approval short is not agreed");
        vm.prank(securityAgent); jobs.approve(id, PodJobsV3.Role.Security, COMMIT);
        assertTrue(jobs.wasLocked(id));
    }

    /// @dev A chain refuses a contract whose code is longer than this (EIP-170), and a test here would
    ///      not: the contract is made inside the test's own machine, which does not hold it to the limit.
    function test_theContractIsSmallEnoughToBeDeployedOnAnyChain() public view {
        uint256 mostAChainAllows = 24_576;
        assertLe(address(jobs).code.length, mostAChainAllows, "too large to deploy: no chain would take it");
        // and with room to spare, so that the next rule added does not find this out the hard way
        assertLe(address(jobs).code.length, mostAChainAllows - 2_000, "within 2,000 bytes of the most a chain allows");
    }

    function test_theTimeToAnswerAndThePaymentGasAreKeptWithinLimits_whichCannotBeChangedAfter() public {
        // a slip of a unit: milliseconds for seconds would hold a silent poster's pod for years
        vm.expectRevert("a poster answers within an hour to thirty days");
        new PodJobsV3(validator, writer, FIRST_JOB, WRITING, PAYOUT_GAS, 259_200_000);
        vm.expectRevert("a poster answers within an hour to thirty days");
        new PodJobsV3(validator, writer, FIRST_JOB, WRITING, PAYOUT_GAS, 1 hours - 1);
        vm.expectRevert("a poster answers within an hour to thirty days");
        new PodJobsV3(validator, writer, FIRST_JOB, WRITING, PAYOUT_GAS, 0);
        // gas that ten payments in one call could not carry
        vm.expectRevert("too much gas for a payment");
        new PodJobsV3(validator, writer, FIRST_JOB, WRITING, 500_001, ANSWER_TIME);
        vm.expectRevert("bad setting");
        new PodJobsV3(validator, writer, FIRST_JOB, WRITING, 0, ANSWER_TIME);
        vm.expectRevert("bad setting");
        new PodJobsV3(validator, writer, FIRST_JOB, 0, PAYOUT_GAS, ANSWER_TIME);
        vm.expectRevert("bad address");
        new PodJobsV3(address(0), writer, FIRST_JOB, WRITING, PAYOUT_GAS, ANSWER_TIME);
        vm.expectRevert("jobs are numbered from 1");
        new PodJobsV3(validator, writer, 0, WRITING, PAYOUT_GAS, ANSWER_TIME);

        // the edges themselves are allowed
        assertEq(new PodJobsV3(validator, writer, FIRST_JOB, WRITING, 500_000, 1 hours).answerTime(), 1 hours);
        assertEq(new PodJobsV3(validator, writer, FIRST_JOB, WRITING, PAYOUT_GAS, 30 days).answerTime(), 30 days);
    }

    /// @dev An agent that, on being paid, tries every door of the contract from inside its payment.
    function test_anAgentPaidFirstCanDoNothingFromInsideItsPayment_inAnyEnding() public {
        // enough gas for the attempt to be a real one
        jobs = new PodJobsV3(validator, writer, FIRST_JOB, WRITING, 500_000, ANSWER_TIME);
        for (uint8 ending; ending < 5; ending++) {
            uint256 id = _openJob();
            GreedyAgent greedy = new GreedyAgent(jobs);
            vm.deal(address(greedy), 10 ether);
            greedy.sit(id);
            _take(id, PodJobsV3.Role.Builder, builderAgent, builderOwner);
            _take(id, PodJobsV3.Role.Reviewer, reviewerAgent, reviewerOwner);
            _take(id, PodJobsV3.Role.QA, qaAgent, qaOwner);
            _take(id, PodJobsV3.Role.Security, securityAgent, securityOwner);
            _putForward(id, COMMIT);
            greedy.approve(COMMIT);
            vm.prank(reviewerAgent); jobs.approve(id, PodJobsV3.Role.Reviewer, COMMIT);
            vm.prank(qaAgent); jobs.approve(id, PodJobsV3.Role.QA, COMMIT);
            vm.prank(securityAgent); jobs.approve(id, PodJobsV3.Role.Security, COMMIT);

            uint256 before = address(greedy).balance;
            uint256 pay = jobs.seatPay(id, PodJobsV3.Role.Lead);
            uint256 deposit = jobs.seatDeposit(id, PodJobsV3.Role.Lead);
            uint256 due;
            if (ending == 0) { _report(id, PASSED); vm.prank(poster); jobs.accept(id); due = pay + deposit; }
            if (ending == 1) { _report(id, PASSED); vm.prank(poster); jobs.refuse(id); due = (pay * REFUSAL_SHARE) / 100 + deposit; }
            if (ending == 2) { _report(id, HIDDEN_FAILED); vm.prank(poster); jobs.refuse(id); due = deposit; }
            if (ending == 3) { _settle(id, PASSED); due = pay + deposit; }
            if (ending == 4) { vm.warp(block.timestamp + WINDOW); jobs.close(id); due = deposit; }

            assertEq(greedy.paid(), 1, "paid once");
            assertEq(greedy.landed(), 0, "and nothing it tried from inside a payment landed");
            assertEq(address(greedy).balance - before + jobs.owed(address(greedy)), due, "what it was due, and no more");
            _assertConserved();
        }
    }
}

/// @notice No seat can stop a delivery. The builder puts its work forward; the other seats stand
///         behind it or do not; and it is graded when the whole pod agrees or the time for reviewing
///         runs out, whichever comes first. Pay, risk and record follow who stood behind it.
contract PodJobsV3NoSeatStopsADeliveryTest is PodJobsV3Fixture {
    PodJobsV3.Verdict constant PASSED = PodJobsV3.Verdict.Passed;
    PodJobsV3.Verdict constant HIDDEN_FAILED = PodJobsV3.Verdict.HiddenFailed;
    PodJobsV3.Verdict constant VISIBLE_FAILED = PodJobsV3.Verdict.VisibleFailed;

    function _pay(uint256 id, PodJobsV3.Role role) internal view returns (uint256) {
        return jobs.seatPay(id, role);
    }

    function _deposit(uint256 id, PodJobsV3.Role role) internal view returns (uint256) {
        return jobs.seatDeposit(id, role);
    }

    /// @dev a full pod seated, the builder's work put forward, and security saying nothing: the seat
    ///      a poster's own wallet would sit in to hold the work back
    function _putForwardWithSecuritySilent() internal returns (uint256 id) {
        id = _openJob();
        _fillEverySeat(id);
        _putForward(id, COMMIT);
        vm.prank(leadAgent); jobs.approve(id, PodJobsV3.Role.Lead, COMMIT);
        vm.prank(reviewerAgent); jobs.approve(id, PodJobsV3.Role.Reviewer, COMMIT);
        vm.prank(qaAgent); jobs.approve(id, PodJobsV3.Role.QA, COMMIT);
    }

    // --- nobody can hold the work back ---

    function test_aSeatThatSaysNothingHoldsNothingBack_theWorkIsGradedOnceItsReviewHasRunOut() public {
        uint256 id = _putForwardWithSecuritySilent();
        assertFalse(jobs.locked(id), "not agreed, and its review still runs");
        vm.prank(validator);
        vm.expectRevert(PodJobsV3.NotLocked.selector);
        jobs.report(id, COMMIT, PASSED, RECEIPT);

        vm.warp(jobs.reviewBy(id));
        assertTrue(jobs.locked(id), "the time for reviewing has run out: it is graded, whoever is behind it");
        _report(id, PASSED);
        assertEq(uint8(_state(id)), uint8(PodJobsV3.State.Delivered));
    }

    function test_theSilentSeatIsPaidNothing_andItsShareGoesBackToThePoster() public {
        uint256 id = _putForwardWithSecuritySilent();
        vm.warp(jobs.reviewBy(id));
        _report(id, PASSED);
        uint256 securityBefore = securityAgent.balance;
        uint256 builderBefore = builderAgent.balance;
        uint256 leadBefore = leadAgent.balance;
        uint256 posterBefore = poster.balance;

        vm.prank(poster);
        jobs.accept(id);

        assertEq(securityAgent.balance, securityBefore + _deposit(id, PodJobsV3.Role.Security), "its deposit home, and no pay for work it did not stand behind");
        assertEq(builderAgent.balance, builderBefore + _pay(id, PodJobsV3.Role.Builder) + _deposit(id, PodJobsV3.Role.Builder));
        assertEq(leadAgent.balance, leadBefore + _pay(id, PodJobsV3.Role.Lead) + _deposit(id, PodJobsV3.Role.Lead));
        assertEq(poster.balance, posterBefore + _pay(id, PodJobsV3.Role.Security), "the share nobody earned goes back to who paid it");
        assertEq(_counted(securityAgent), 0, "and the job is not on its record, as a pass or as anything");
        assertEq(_agent(leadAgent).accepted, 1);
        assertEq(address(jobs).balance, 0);
        _assertConserved();
    }

    /// @dev The attack this rule is for: a poster fills every seat but the builder's with wallets of
    ///      their own, which read the work and say nothing, to let the window run out and take the
    ///      money back with the work in hand.
    function test_everyOtherSeatSayingNothingStopsNothing_andRefusingWhatPassedStillLeavesTheBuilderItsQuarter() public {
        uint256 id = _openJob();
        _take(id, PodJobsV3.Role.Builder, builderAgent, builderOwner);
        address[4] memory silent = [makeAddr("the poster's second wallet"), makeAddr("their third"), makeAddr("their fourth"), makeAddr("their fifth")];
        PodJobsV3.Role[4] memory roles = [PodJobsV3.Role.Lead, PodJobsV3.Role.Reviewer, PodJobsV3.Role.QA, PodJobsV3.Role.Security];
        for (uint256 i; i < silent.length; i++) {
            vm.deal(silent[i], 10 ether);
            _take(id, roles[i], silent[i], silent[i]);
        }

        _putForward(id, COMMIT);
        vm.warp(jobs.reviewBy(id));
        _report(id, PASSED);

        // the poster has the work, and it passed: the least it costs them is the builder's quarter
        uint256 builderBefore = builderAgent.balance;
        uint256 posterBefore = poster.balance;
        uint256 quarter = (_pay(id, PodJobsV3.Role.Builder) * REFUSAL_SHARE) / 100;
        vm.prank(poster);
        jobs.refuse(id);
        assertEq(builderAgent.balance, builderBefore + quarter + _deposit(id, PodJobsV3.Role.Builder));
        assertEq(poster.balance, posterBefore + PRICE - quarter);
        for (uint256 i; i < silent.length; i++) {
            assertEq(silent[i].balance, 10 ether, "a silent seat gets back exactly what it put down");
            assertEq(_counted(silent[i]), 0);
        }
        assertEq(_agent(builderAgent).refusedPassed, 1);
        _assertConserved();
    }

    function test_aBuilderAloneIsGradedTheMomentItPutsItsWorkForward_andIsPaidItsOwnShare() public {
        uint256 id = _openJob();
        _take(id, PodJobsV3.Role.Builder, builderAgent, builderOwner);
        _putForward(id, COMMIT);
        assertTrue(jobs.locked(id), "nobody waits for a seat nobody took");
        assertTrue(jobs.wasLocked(id));
        // and nobody sits down now to be paid for work they were not there to review
        uint256 deposit = _deposit(id, PodJobsV3.Role.QA);
        vm.prank(qaAgent);
        vm.expectRevert(PodJobsV3.Locked.selector);
        jobs.takeSeat{ value: deposit }(id, PodJobsV3.Role.QA, qaOwner);
        _report(id, PASSED);

        uint256 builderBefore = builderAgent.balance;
        uint256 posterBefore = poster.balance;
        vm.prank(poster);
        jobs.accept(id);
        uint256 pay = _pay(id, PodJobsV3.Role.Builder);
        assertEq(builderAgent.balance, builderBefore + pay + _deposit(id, PodJobsV3.Role.Builder));
        assertEq(poster.balance, posterBefore + PRICE - pay, "the shares of seats nobody took go back");
        assertEq(_agent(builderAgent).accepted, 1);
        assertEq(address(jobs).balance, 0);
    }

    function test_everySeatThatIsTakenBehindItSendsItToGradingAtOnce_howeverFewAreTaken() public {
        uint256 id = _openJob();
        _take(id, PodJobsV3.Role.Builder, builderAgent, builderOwner);
        _take(id, PodJobsV3.Role.QA, qaAgent, qaOwner);
        _putForward(id, COMMIT);
        assertFalse(jobs.locked(id), "QA holds a seat and has not answered");
        vm.prank(qaAgent);
        jobs.approve(id, PodJobsV3.Role.QA, COMMIT);
        assertTrue(jobs.policyMet(id, COMMIT));
        assertTrue(jobs.locked(id), "the lead's, the reviewer's and security's seats are empty, and nobody waits for them");
        assertLt(block.timestamp, jobs.reviewBy(id));
        _report(id, PASSED);

        uint256 qaBefore = qaAgent.balance;
        uint256 posterBefore = poster.balance;
        vm.prank(poster);
        jobs.accept(id);
        assertEq(qaAgent.balance, qaBefore + _pay(id, PodJobsV3.Role.QA) + _deposit(id, PodJobsV3.Role.QA));
        assertEq(poster.balance, posterBefore + PRICE - _pay(id, PodJobsV3.Role.Builder) - _pay(id, PodJobsV3.Role.QA));
        _assertConserved();
    }

    function test_aSilentPosterAndAPassPayTheBuilderAndTheSeatsBehindIt_andNobodyElse() public {
        uint256 id = _putForwardWithSecuritySilent();
        vm.warp(jobs.reviewBy(id));
        uint256 securityBefore = securityAgent.balance;
        uint256 qaBefore = qaAgent.balance;
        _settle(id, PASSED);
        assertEq(qaAgent.balance, qaBefore + _pay(id, PodJobsV3.Role.QA) + _deposit(id, PodJobsV3.Role.QA));
        assertEq(securityAgent.balance, securityBefore + _deposit(id, PodJobsV3.Role.Security));
        assertEq(_agent(qaAgent).paidUnanswered, 1);
        assertEq(_counted(securityAgent), 0);
        _assertConserved();
    }

    // --- the review ---

    function test_theWholePodBehindItSendsItToGradingAtOnce() public {
        uint256 id = _openJob();
        _fillEverySeat(id);
        _approveAll(id, COMMIT);
        assertLt(block.timestamp, jobs.reviewBy(id));
        assertTrue(jobs.locked(id));
        _report(id, PASSED);
    }

    function test_theReviewEndsOnTheSecond_andNobodySignsOnAfterIt() public {
        uint256 id = _putForwardWithSecuritySilent();
        uint64 until = jobs.reviewBy(id);
        assertEq(until, block.timestamp + REVIEW_TIME);

        // one second before: still open to a voice, and not yet graded
        vm.warp(until - 1);
        assertFalse(jobs.locked(id));
        uint256 snapshot = vm.snapshotState();
        vm.prank(securityAgent);
        jobs.approve(id, PodJobsV3.Role.Security, COMMIT);
        assertTrue(_approved(id, PodJobsV3.Role.Security));
        vm.revertToState(snapshot);

        // on the second: graded, and closed to anybody who would rather see the verdict first
        vm.warp(until);
        assertTrue(jobs.locked(id));
        vm.prank(securityAgent);
        vm.expectRevert(PodJobsV3.TooLate.selector);
        jobs.approve(id, PodJobsV3.Role.Security, COMMIT);

        // nor once it is reported: the job is delivered, and nothing is added to it
        _report(id, PASSED);
        vm.prank(securityAgent);
        vm.expectRevert(PodJobsV3.WrongState.selector);
        jobs.approve(id, PodJobsV3.Role.Security, COMMIT);
    }

    function test_aSeatedReviewerStillReadingIsNotLockedOut_theWholePodMeansEveryReviewerSeated() public {
        vm.prank(poster);
        uint256 id = jobs.post{ value: PRICE + 3 * WRITING }(WINDOW, 2);
        _write(id);
        _open(id);
        _fillEverySeat(id);
        address second = makeAddr("a second reviewer");
        vm.deal(second, 10 ether);
        _take(id, PodJobsV3.Role.Reviewer, second, second);

        _approveAll(id, COMMIT);
        assertFalse(jobs.policyMet(id, COMMIT), "one reviewer seated has not spoken");
        assertFalse(jobs.locked(id));
        vm.prank(second);
        jobs.approve(id, PodJobsV3.Role.Reviewer, COMMIT);
        assertTrue(jobs.locked(id));

        // and both are paid: half the reviewers' share each
        _report(id, PASSED);
        uint256 before = second.balance;
        vm.prank(poster);
        jobs.accept(id);
        assertEq(second.balance, before + _pay(id, PodJobsV3.Role.Reviewer) + _deposit(id, PodJobsV3.Role.Reviewer));
        assertEq(_pay(id, PodJobsV3.Role.Reviewer) * 2, (PRICE * 15) / 100);
    }

    function test_aSeatCanBeTakenWhileTheReviewRuns_andNotOnceItIsLocked() public {
        uint256 id = _openJob();
        _take(id, PodJobsV3.Role.Builder, builderAgent, builderOwner);
        _take(id, PodJobsV3.Role.Lead, leadAgent, leadOwner);
        _putForward(id, COMMIT);
        // the lead has not answered, so the review runs: a judge arrives, reads the work, and stands behind it
        _take(id, PodJobsV3.Role.QA, qaAgent, qaOwner);
        vm.prank(qaAgent);
        jobs.approve(id, PodJobsV3.Role.QA, COMMIT);
        assertFalse(jobs.locked(id));

        vm.warp(jobs.reviewBy(id));
        uint256 deposit = _deposit(id, PodJobsV3.Role.Security);
        vm.prank(securityAgent);
        vm.expectRevert(PodJobsV3.Locked.selector);
        jobs.takeSeat{ value: deposit }(id, PodJobsV3.Role.Security, securityOwner);
    }

    function test_onceTheReviewHasRunOutTheBuilderCannotSwapTheWork() public {
        uint256 id = _putForwardWithSecuritySilent();
        vm.warp(jobs.reviewBy(id));
        vm.prank(builderAgent);
        vm.expectRevert(PodJobsV3.Locked.selector);
        jobs.putForward(id, keccak256("swapped while being graded"));
    }

    function test_afterTheValidatorLetsGoNothingIsGradedUntilTheBuilderPutsWorkForwardAgain() public {
        uint256 id = _putForwardWithSecuritySilent();
        vm.warp(jobs.reviewBy(id));
        vm.prank(validator);
        jobs.releaseLock(id);
        assertEq(_commit(id), bytes32(0));
        assertEq(jobs.reviewBy(id), 0);
        assertFalse(jobs.locked(id));
        vm.prank(validator);
        vm.expectRevert(PodJobsV3.CommitMismatch.selector);
        jobs.report(id, COMMIT, PASSED, RECEIPT);
        // nothing is put forward, so there is nothing to stand behind, for a seat that had not or one that had
        vm.prank(securityAgent);
        vm.expectRevert(PodJobsV3.CommitMismatch.selector);
        jobs.approve(id, PodJobsV3.Role.Security, COMMIT);
    }

    /// @dev What an outsider's reading of this contract found, and how it was closed. The validator
    ///      lets go of work late in the window; were the same commit given a whole review again,
    ///      there would be no time for it, and the seats that say nothing would have run the window
    ///      out after all.
    function test_aReleaseLateInTheWindowHandsNothingToTheSeatsThatSayNothing() public {
        uint256 id = _openJob();
        _take(id, PodJobsV3.Role.Builder, builderAgent, builderOwner);
        address[4] memory silent = [makeAddr("the poster's second wallet"), makeAddr("their third"), makeAddr("their fourth"), makeAddr("their fifth")];
        PodJobsV3.Role[4] memory roles = [PodJobsV3.Role.Lead, PodJobsV3.Role.Reviewer, PodJobsV3.Role.QA, PodJobsV3.Role.Security];
        for (uint256 i; i < silent.length; i++) {
            vm.deal(silent[i], 10 ether);
            _take(id, roles[i], silent[i], silent[i]);
        }
        (, , , uint64 endsAt, , , , ) = jobs.jobs(id);

        // put forward leaving the review and ten minutes, as a builder is told to
        vm.warp(endsAt - REVIEW_TIME - 10 minutes);
        _putForward(id, COMMIT);
        vm.warp(jobs.reviewBy(id));
        assertTrue(jobs.locked(id));
        // a minute later the validator lets go of it: it could not grade it this time
        vm.warp(block.timestamp + 1 minutes);
        vm.prank(validator);
        jobs.releaseLock(id);

        // nine minutes are left, and a review is fifteen. The same commit has had its review
        _putForward(id, COMMIT);
        assertEq(jobs.reviewBy(id), block.timestamp, "no second review of what was already reviewed");
        assertTrue(jobs.locked(id));
        _report(id, PASSED);

        uint256 builderBefore = builderAgent.balance;
        uint256 quarter = (_pay(id, PodJobsV3.Role.Builder) * REFUSAL_SHARE) / 100;
        vm.prank(poster);
        jobs.refuse(id);
        assertEq(builderAgent.balance, builderBefore + quarter + _deposit(id, PodJobsV3.Role.Builder), "its quarter, though the poster held every other seat and said nothing from any");
        _assertConserved();
    }

    function test_theCommitLetGoOfPutForwardAgainKeepsTheSeatsBehindIt_andTakesNoOthers() public {
        uint256 id = _putForwardWithSecuritySilent();
        vm.warp(jobs.reviewBy(id));
        vm.prank(validator);
        jobs.releaseLock(id);
        // what the three said of it stands while nothing is put forward
        assertTrue(_approved(id, PodJobsV3.Role.Lead));
        assertTrue(_approved(id, PodJobsV3.Role.QA));
        assertFalse(_approved(id, PodJobsV3.Role.Security));

        vm.warp(block.timestamp + 5 minutes);
        _putForward(id, COMMIT);
        assertTrue(jobs.locked(id), "back to grading at once");
        assertTrue(_approved(id, PodJobsV3.Role.Lead), "with the same seats behind it");
        // security had its time to stand behind this commit, and did not: it has no second one
        vm.prank(securityAgent);
        vm.expectRevert(PodJobsV3.TooLate.selector);
        jobs.approve(id, PodJobsV3.Role.Security, COMMIT);

        _report(id, PASSED);
        uint256 leadBefore = leadAgent.balance;
        uint256 securityBefore = securityAgent.balance;
        vm.prank(poster);
        jobs.accept(id);
        assertEq(leadAgent.balance, leadBefore + _pay(id, PodJobsV3.Role.Lead) + _deposit(id, PodJobsV3.Role.Lead));
        assertEq(securityAgent.balance, securityBefore + _deposit(id, PodJobsV3.Role.Security));
        _assertConserved();
    }

    function test_onlyTheCommitLastLetGoOfSkipsItsReview_andOnlyOnce() public {
        uint256 id = _lockedJob();
        vm.prank(validator);
        jobs.releaseLock(id);
        bytes32 other = keccak256("something else");
        _putForward(id, other);
        assertEq(jobs.reviewBy(id), block.timestamp + REVIEW_TIME, "new work has a review of its own");
        // back to the first commit: it is no longer the one let go of, and is reviewed like any other
        _putForward(id, COMMIT);
        assertEq(jobs.reviewBy(id), block.timestamp + REVIEW_TIME);
        assertFalse(_approved(id, PodJobsV3.Role.Lead));
        assertFalse(jobs.locked(id));
    }

    function test_nothingIsLetGoOfOnceTheWindowHasClosed_soWorkPutForwardTooLateIsNeverSaidToHaveReachedGrading() public {
        uint256 id = _openJob();
        _take(id, PodJobsV3.Role.Builder, builderAgent, builderOwner);
        _take(id, PodJobsV3.Role.Lead, leadAgent, leadOwner);
        (, , , uint64 endsAt, , , , ) = jobs.jobs(id);
        // five minutes before the end, beside a seat that never answers: its review would end long after the window does
        vm.warp(endsAt - 5 minutes);
        _putForward(id, COMMIT);
        vm.warp(jobs.reviewBy(id));
        // it reads as locked, since its review has run out, and still nothing can be done with it
        vm.prank(validator);
        vm.expectRevert(PodJobsV3.TooLate.selector);
        jobs.report(id, COMMIT, PASSED, RECEIPT);
        vm.prank(validator);
        vm.expectRevert(PodJobsV3.TooLate.selector);
        jobs.releaseLock(id);
        assertFalse(jobs.wasLocked(id));
        jobs.close(id);
        assertEq(_agent(builderAgent).undelivered, 1);
    }

    function test_aFreeSeatTakenDuringTheReviewAndLeftSilentDelaysTheWorkAndDoesNotStopIt() public {
        vm.prank(poster);
        uint256 id = jobs.post{ value: PRICE + 3 * WRITING }(WINDOW, 2);
        _write(id);
        _open(id);
        _fillEverySeat(id);
        _putForward(id, COMMIT);
        vm.prank(leadAgent); jobs.approve(id, PodJobsV3.Role.Lead, COMMIT);
        vm.prank(reviewerAgent); jobs.approve(id, PodJobsV3.Role.Reviewer, COMMIT);
        vm.prank(qaAgent); jobs.approve(id, PodJobsV3.Role.QA, COMMIT);
        // in front of the last approval, somebody takes the reviewer seat still free, and says nothing
        address late = makeAddr("the poster's second wallet");
        vm.deal(late, 10 ether);
        _take(id, PodJobsV3.Role.Reviewer, late, late);
        vm.prank(securityAgent); jobs.approve(id, PodJobsV3.Role.Security, COMMIT);
        assertFalse(jobs.locked(id), "the whole pod is one voice short now");

        vm.warp(jobs.reviewBy(id));
        _report(id, PASSED);
        uint256 securityBefore = securityAgent.balance;
        uint256 lateBefore = late.balance;
        vm.prank(poster);
        jobs.accept(id);
        assertEq(securityAgent.balance, securityBefore + _pay(id, PodJobsV3.Role.Security) + _deposit(id, PodJobsV3.Role.Security));
        assertEq(late.balance, lateBefore + _deposit(id, PodJobsV3.Role.Reviewer), "the seat that came to say nothing leaves with what it put down");
        _assertConserved();
    }

    /// @dev The other side of "the whole pod behind it is graded at once": a builder cannot count on
    ///      time to replace what it put forward. What it puts forward is what it stands behind.
    function test_whatABuilderPutsForwardCanBeLockedAtOnce_soItPutsForwardOnlyWhatItWouldHaveGraded() public {
        uint256 id = _openJob();
        _fillEverySeat(id);
        bytes32 draft = keccak256("a first try, put forward to see what the pod says");
        _approveAll(id, draft);
        assertTrue(jobs.locked(id));
        vm.prank(builderAgent);
        vm.expectRevert(PodJobsV3.Locked.selector);
        jobs.putForward(id, COMMIT);
    }

    function test_nobodyStandsBehindWorkOnceItsWindowHasClosed_evenWhileItsReviewStillRuns() public {
        uint256 id = _openJob();
        _fillEverySeat(id);
        (, , , uint64 endsAt, , , , ) = jobs.jobs(id);
        vm.warp(endsAt - 5 minutes);
        _putForward(id, COMMIT);
        vm.warp(endsAt);
        assertLt(block.timestamp, jobs.reviewBy(id), "its review outlives its window");
        vm.prank(leadAgent);
        vm.expectRevert(PodJobsV3.TooLate.selector);
        jobs.approve(id, PodJobsV3.Role.Lead, COMMIT);
    }

    function test_aBuilderCannotTakeBackWhatItPutForward_onlyReplaceIt() public {
        uint256 id = _openJob();
        _fillEverySeat(id);
        _putForward(id, COMMIT);
        vm.prank(builderAgent);
        vm.expectRevert(PodJobsV3.CommitMismatch.selector);
        jobs.putForward(id, bytes32(0));
        assertEq(_commit(id), COMMIT);
    }

    function test_aReviewAlwaysEndsInsideAWindowItStartedEarlyEnoughIn_howeverShortTheJob() public {
        vm.deal(poster, 1_000 ether);
        uint64[3] memory windows = [uint64(1 minutes), uint64(10 minutes), uint64(3 days)];
        for (uint256 i; i < windows.length; i++) {
            vm.prank(poster);
            uint256 id = jobs.post{ value: PRICE + 3 * WRITING }(windows[i], 1);
            assertLt(jobs.reviewTimeOf(id), windows[i], "shorter than the job, whatever the job");
            assertEq(jobs.reviewTimeOf(id) * 4, windows[i]);
        }
    }

    // --- risk follows who stood behind it ---

    function test_aVisibleFailureCostsTheBuilderAndTheSeatsBehindIt_andNotTheSeatThatDidNotSignOn() public {
        uint256 id = _putForwardWithSecuritySilent();
        vm.warp(jobs.reviewBy(id));
        uint256 securityBefore = securityAgent.balance;
        uint256 builderBefore = builderAgent.balance;
        uint256 qaBefore = qaAgent.balance;
        uint256 posterBefore = poster.balance;
        uint256 forfeited = _deposit(id, PodJobsV3.Role.Lead) + _deposit(id, PodJobsV3.Role.Builder)
            + _deposit(id, PodJobsV3.Role.Reviewer) + _deposit(id, PodJobsV3.Role.QA);

        _settle(id, VISIBLE_FAILED);

        assertEq(builderAgent.balance, builderBefore, "it put forward work that failed a check it could see");
        assertEq(qaAgent.balance, qaBefore, "it said yes to it");
        assertEq(securityAgent.balance, securityBefore + _deposit(id, PodJobsV3.Role.Security), "it did not, and answers for nothing");
        assertEq(poster.balance, posterBefore + PRICE + forfeited);
        assertEq(_agent(builderAgent).failed, 1);
        assertEq(_agent(qaAgent).failed, 1);
        assertEq(_counted(securityAgent), 0, "failed work it did not stand behind is not on its record");
        _assertConserved();
    }

    function test_workPutForwardWithNobodyBehindItThatFailsACheckItCouldSeeCostsItsBuilderItsDeposit() public {
        uint256 id = _openJob();
        _fillEverySeat(id);
        _putForward(id, keccak256("junk, put forward to burn the job"));
        vm.warp(jobs.reviewBy(id));
        vm.prank(validator);
        jobs.report(id, keccak256("junk, put forward to burn the job"), VISIBLE_FAILED, RECEIPT);

        uint256 builderBefore = builderAgent.balance;
        uint256 leadBefore = leadAgent.balance;
        uint256 posterBefore = poster.balance;
        vm.prank(poster);
        jobs.refuse(id);
        assertEq(builderAgent.balance, builderBefore, "its deposit is the poster's");
        assertEq(leadAgent.balance, leadBefore + _deposit(id, PodJobsV3.Role.Lead), "a seat that did not sign on loses nothing");
        assertEq(poster.balance, posterBefore + PRICE + _deposit(id, PodJobsV3.Role.Builder));
        assertEq(_agent(builderAgent).failed, 1);
        assertEq(_counted(leadAgent), 0);
        _assertConserved();
    }

    function test_aHiddenFailureCostsNobodyADeposit_andIsCountedOnlyForWhoStoodBehindIt() public {
        uint256 id = _putForwardWithSecuritySilent();
        vm.warp(jobs.reviewBy(id));
        uint256 builderBefore = builderAgent.balance;
        _settle(id, HIDDEN_FAILED);
        assertEq(builderAgent.balance, builderBefore + _deposit(id, PodJobsV3.Role.Builder));
        assertEq(_agent(builderAgent).failed, 1);
        assertEq(_agent(leadAgent).failed, 1);
        assertEq(_counted(securityAgent), 0);
        _assertConserved();
    }

    function test_refusingWhatPassedLeavesAQuarterToWhoStoodBehindIt_andOnlyThem() public {
        uint256 id = _putForwardWithSecuritySilent();
        vm.warp(jobs.reviewBy(id));
        _report(id, PASSED);
        uint256 securityBefore = securityAgent.balance;
        uint256 reviewerBefore = reviewerAgent.balance;
        uint256 posterBefore = poster.balance;

        vm.prank(poster);
        jobs.refuse(id);

        uint256 kept;
        PodJobsV3.Role[4] memory behind = [PodJobsV3.Role.Lead, PodJobsV3.Role.Builder, PodJobsV3.Role.Reviewer, PodJobsV3.Role.QA];
        for (uint256 i; i < behind.length; i++) kept += (_pay(id, behind[i]) * REFUSAL_SHARE) / 100;
        assertEq(reviewerAgent.balance, reviewerBefore + (_pay(id, PodJobsV3.Role.Reviewer) * REFUSAL_SHARE) / 100 + _deposit(id, PodJobsV3.Role.Reviewer));
        assertEq(securityAgent.balance, securityBefore + _deposit(id, PodJobsV3.Role.Security));
        assertEq(poster.balance, posterBefore + PRICE - kept);
        assertEq(_agent(reviewerAgent).refusedPassed, 1);
        assertEq(_counted(securityAgent), 0);
        _assertConserved();
    }

    // --- the record of a job nothing reached grading on is its builder's alone ---

    function test_workPutForwardTooLateToBeReviewedInTheWindowIsNotDelivered() public {
        uint256 id = _openJob();
        _fillEverySeat(id);
        // put forward with less than the time for reviewing left, and not the whole pod behind it
        vm.warp(block.timestamp + WINDOW - 5 minutes);
        _putForward(id, COMMIT);
        vm.prank(leadAgent); jobs.approve(id, PodJobsV3.Role.Lead, COMMIT);
        assertGt(jobs.reviewBy(id), block.timestamp + 5 minutes, "its review would end after the window does");
        assertFalse(jobs.locked(id));
        vm.warp(block.timestamp + 5 minutes);
        vm.prank(stranger);
        jobs.close(id);
        assertEq(_agent(builderAgent).undelivered, 1, "leaving time for the review is the builder's to do");
        assertEq(_counted(leadAgent), 0);
        _assertConserved();
    }

    function test_workWhoseReviewRanOutInTheWindowWasDelivered_evenIfNobodyEverReportedOnIt() public {
        uint256 id = _putForwardWithSecuritySilent();
        // the validator never comes; the window closes long after the review ran out
        vm.warp(block.timestamp + WINDOW);
        vm.prank(stranger);
        jobs.close(id);
        assertEq(_agent(builderAgent).undelivered, 0, "it reached grading, which is all a builder can do");
        _assertConserved();
    }

    function test_workTheValidatorLetGoOfAfterItsReviewRanOutWasDelivered_whateverBecameOfIt() public {
        // not the whole pod behind it, so nothing but the review running out sent it to grading
        uint256 id = _putForwardWithSecuritySilent();
        vm.warp(jobs.reviewBy(id));
        assertFalse(jobs.wasLocked(id));
        // the validator could not grade it, and the window ran out before the builder put it forward again
        vm.prank(validator);
        jobs.releaseLock(id);
        assertTrue(jobs.wasLocked(id), "it reached grading");
        vm.warp(block.timestamp + WINDOW);
        vm.prank(stranger);
        jobs.close(id);
        assertEq(_agent(builderAgent).undelivered, 0, "what became of the grading was not the builder's doing");
        _assertConserved();
    }

    function test_theLastMinuteIsStillInTimeWhenTheWholePodIsBehindIt() public {
        uint256 id = _openJob();
        _fillEverySeat(id);
        vm.warp(block.timestamp + WINDOW - 2 minutes);
        _approveAll(id, COMMIT);
        assertTrue(jobs.locked(id));
        vm.warp(block.timestamp + 2 minutes);
        vm.prank(stranger);
        jobs.close(id);
        assertEq(_agent(builderAgent).undelivered, 0);
    }

    function test_inTimeMeansTheReviewEndsBeforeTheWindowDoes_toTheSecond() public {
        // beside a seat that never answers, put forward so that its review ends on the very second the
        // window does: too late to be reported on
        uint256 late = _openJob();
        _take(late, PodJobsV3.Role.Builder, builderAgent, builderOwner);
        _take(late, PodJobsV3.Role.Lead, leadAgent, leadOwner);
        (, , , uint64 endsAt, , , , ) = jobs.jobs(late);
        vm.warp(endsAt - REVIEW_TIME);
        _putForward(late, COMMIT);
        assertEq(jobs.reviewBy(late), endsAt);
        vm.warp(endsAt);
        jobs.close(late);
        assertEq(_agent(builderAgent).undelivered, 1);

        // one second sooner, and there was a second in which it could have been
        uint256 inTime = _openJob();
        _take(inTime, PodJobsV3.Role.Builder, builderAgent, builderOwner);
        _take(inTime, PodJobsV3.Role.Lead, leadAgent, leadOwner);
        (, , , endsAt, , , , ) = jobs.jobs(inTime);
        vm.warp(endsAt - REVIEW_TIME - 1);
        _putForward(inTime, COMMIT);
        vm.warp(endsAt - 1);
        assertTrue(jobs.locked(inTime));
        vm.warp(endsAt);
        jobs.close(inTime);
        assertEq(_agent(builderAgent).undelivered, 1, "still only the first");
    }

    function test_anAgentInTwoSeatsThatStandsBehindItFromOneIsCountedOnce_andPaidForThatSeatAlone() public {
        uint256 id = _openJob();
        // the lead's agent also sits as QA, under another owner, and says yes only as QA
        _take(id, PodJobsV3.Role.Lead, leadAgent, leadOwner);
        _take(id, PodJobsV3.Role.Builder, builderAgent, builderOwner);
        _take(id, PodJobsV3.Role.QA, leadAgent, qaOwner);
        _putForward(id, COMMIT);
        vm.prank(leadAgent);
        jobs.approve(id, PodJobsV3.Role.QA, COMMIT);
        vm.warp(jobs.reviewBy(id));
        _report(id, PASSED);

        uint256 before = leadAgent.balance;
        vm.prank(poster);
        jobs.accept(id);
        assertEq(_agent(leadAgent).accepted, 1, "behind it from one seat is behind it");
        assertEq(leadAgent.balance, before + _pay(id, PodJobsV3.Role.QA) + _deposit(id, PodJobsV3.Role.QA) + _deposit(id, PodJobsV3.Role.Lead), "paid as QA, and only its deposit back as lead");
        _assertConserved();
    }

    // --- the setting ---

    function test_aReviewIsAQuarterOfTheJobsWindow_soItGrowsWithTheJobAndIsAlwaysShorterThanIt() public {
        assertEq(jobs.REVIEW_SHARE_PERCENT(), 25);
        uint64[3] memory windows = [uint64(2 hours), uint64(24 hours), uint64(7 days)];
        uint64[3] memory reviews = [uint64(30 minutes), uint64(6 hours), uint64(42 hours)];
        vm.deal(poster, 1_000 ether);
        for (uint256 i; i < windows.length; i++) {
            vm.prank(poster);
            uint256 id = jobs.post{ value: PRICE + 3 * WRITING }(windows[i], 1);
            assertEq(jobs.reviewTimeOf(id), reviews[i]);
            _write(id);
            _open(id);
            // with a seat beside it that has not answered, the work waits that long and no longer
            _take(id, PodJobsV3.Role.Builder, builderAgent, builderOwner);
            _take(id, PodJobsV3.Role.Lead, leadAgent, leadOwner);
            _putForward(id, COMMIT);
            assertEq(jobs.reviewBy(id), block.timestamp + reviews[i]);
            assertFalse(jobs.locked(id));
            vm.warp(block.timestamp + reviews[i]);
            assertTrue(jobs.locked(id));
        }
    }
}
