// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { PodJobsV4 } from "../src/PodJobsV4.sol";

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
    PodJobsV4 immutable jobs;
    uint256 public jobId;
    uint256 public triedAgain;

    constructor(PodJobsV4 jobs_) { jobs = jobs_; }

    function post(uint64 window) external payable { jobId = jobs.post{ value: msg.value }(window, 1); }

    function takeBack() external { jobs.takeBack(jobId); }

    receive() external payable {
        triedAgain++;
        try jobs.takeBack(jobId) {} catch {}
    }
}

/// @dev What every test of the fourth contract shares: its parties, and how a job is walked through.
abstract contract PodJobsV4Fixture is Test {
    PodJobsV4 jobs;
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
    /// @dev the fingerprint of what a seat wrote of its own work, bound to its yes
    bytes32 constant ACCOUNT = keccak256("what this seat did, and what it found");
    /// @dev the fingerprint of the lead's reasons, bound to its conclusion
    bytes32 constant REASONS = keccak256("who earned their pay, and why");

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

        jobs = new PodJobsV4(validator, writer, FIRST_JOB, WRITING, PAYOUT_GAS, ANSWER_TIME);
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
    function _take(uint256 id, PodJobsV4.Role role, address agent, address owner) internal {
        uint256 deposit = jobs.seatDeposit(id, role);
        vm.prank(agent);
        jobs.takeSeat{ value: deposit }(id, role, owner);
    }

    function _fillEverySeat(uint256 id) internal {
        _take(id, PodJobsV4.Role.Lead, leadAgent, leadOwner);
        _take(id, PodJobsV4.Role.Builder, builderAgent, builderOwner);
        _take(id, PodJobsV4.Role.Reviewer, reviewerAgent, reviewerOwner);
        _take(id, PodJobsV4.Role.QA, qaAgent, qaOwner);
        _take(id, PodJobsV4.Role.Security, securityAgent, securityOwner);
    }

    /// @dev the builder names its work, which is the only way a commit comes to be reviewed and graded
    function _putForward(uint256 id, bytes32 commitHash) internal {
        // read before the prank, which the read would spend
        address builder = jobs.seatAt(id, PodJobsV4.Role.Builder, 0).agent;
        vm.prank(builder);
        jobs.putForward(id, commitHash);
    }

    function _poster() internal view returns (PodJobsV4.PosterRecord memory record) {
        (record.posted, record.accepted, record.refusedPassed, record.refusedFailed, record.unanswered) = jobs.posters(poster);
    }

    function _agent(address agent) internal view returns (PodJobsV4.AgentRecord memory record) {
        (record.accepted, record.paidUnanswered, record.refusedPassed, record.failed, record.undelivered) = jobs.agents(agent);
    }

    /// @dev how many jobs an agent has had counted for it, of any ending
    function _counted(address agent) internal view returns (uint256) {
        PodJobsV4.AgentRecord memory record = _agent(agent);
        return uint256(record.accepted) + record.paidUnanswered + record.refusedPassed + record.failed + record.undelivered;
    }

    /// @dev every reviewer, QA and security seat that stands behind the commit put forward, as the
    ///      bits a lead names them by
    function _behind(uint256 id) internal view returns (uint256 mask) {
        for (uint8 r = uint8(PodJobsV4.Role.Reviewer); r < ROLES; r++) {
            uint256 count = jobs.seatCount(id, PodJobsV4.Role(r));
            for (uint256 i; i < count; i++) {
                if (jobs.seatAt(id, PodJobsV4.Role(r), i).approved) mask |= jobs.seatBit(PodJobsV4.Role(r), i);
            }
        }
    }

    /// @dev the bit a lead names a seat by, read here so a prank is never spent on reading it
    function _bit(PodJobsV4.Role role) internal view returns (uint256) {
        return jobs.seatBit(role, 0);
    }

    /// @dev the lead concludes the review of the commit, naming the seats given as having earned their pay
    function _conclude(uint256 id, bytes32 commitHash, uint256 named) internal {
        // read before the prank, which the read would spend
        address lead = jobs.seatAt(id, PodJobsV4.Role.Lead, 0).agent;
        vm.prank(lead);
        jobs.conclude(id, commitHash, named, REASONS);
    }

    /// @dev the time from which a lead may conclude with a seat still silent: half the review gone
    function _halfTheReview(uint256 id) internal view returns (uint256) {
        return uint256(jobs.reviewBy(id)) - jobs.reviewTimeOf(id) / 2;
    }

    /// @dev the builder puts the commit forward, unless it already has, every other seat stands behind
    ///      it, and the lead, who speaks last, concludes the review naming every one of them
    function _approveAll(uint256 id, bytes32 commitHash) internal {
        if (_commit(id) != commitHash) _putForward(id, commitHash);
        vm.prank(reviewerAgent); jobs.approve(id, PodJobsV4.Role.Reviewer, commitHash, ACCOUNT);
        vm.prank(qaAgent); jobs.approve(id, PodJobsV4.Role.QA, commitHash, ACCOUNT);
        vm.prank(securityAgent); jobs.approve(id, PodJobsV4.Role.Security, commitHash, ACCOUNT);
        _conclude(id, commitHash, _behind(id));
    }

    function _lockedJob() internal returns (uint256 id) {
        id = _openJob();
        _fillEverySeat(id);
        _approveAll(id, COMMIT);
    }

    /// @dev the validator reports what the re-run found. No money moves
    function _report(uint256 id, PodJobsV4.Verdict verdict) internal {
        vm.prank(validator);
        jobs.report(id, COMMIT, verdict, RECEIPT);
    }

    /// @dev a job its pod delivered, with what the checks found, waiting for its poster
    function _delivered(PodJobsV4.Verdict verdict) internal returns (uint256 id) {
        id = _lockedJob();
        _report(id, verdict);
    }

    /// @dev the poster says nothing, and a stranger settles the job as the checks found: the same
    ///      money, to the same people, as the second contract moved on the verdict alone
    function _settle(uint256 id, PodJobsV4.Verdict verdict) internal {
        _report(id, verdict);
        vm.warp(jobs.answerBy(id));
        vm.prank(stranger);
        jobs.settleUnanswered(id);
    }

    function _state(uint256 id) internal view returns (PodJobsV4.State state) {
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

    function _approved(uint256 id, PodJobsV4.Role role) internal view returns (bool) {
        return jobs.seatAt(id, role, 0).approved;
    }

    /// @dev What the contract still owes, worked out from what it says about every job it has
    ///      numbered: a job's price until it settles or is refunded, its writing money, every deposit
    ///      it still holds, and what payments could not deliver.
    function _stillOwed() internal view returns (uint256 total) {
        for (uint256 id = FIRST_JOB; id < jobs.nextJobId(); id++) {
            PodJobsV4.State state = _state(id);
            if (state == PodJobsV4.State.Preparing || state == PodJobsV4.State.Open || state == PodJobsV4.State.Working || state == PodJobsV4.State.Delivered) {
                (, uint256 price, , , , , , ) = jobs.jobs(id);
                total += price;
            }
            total += _balance(id) + _reserved(id);
            for (uint8 r; r < ROLES; r++) {
                uint256 count = jobs.seatCount(id, PodJobsV4.Role(r));
                for (uint256 i; i < count; i++) total += jobs.seatAt(id, PodJobsV4.Role(r), i).deposit;
            }
        }
        total += jobs.totalOwed();
    }

    function _assertConserved() internal view {
        assertEq(address(jobs).balance, _stillOwed(), "the contract holds exactly what it still owes");
        // writing money not yet spent belongs to a job still preparing; once it is not, it has gone back
        for (uint256 id = FIRST_JOB; id < jobs.nextJobId(); id++) {
            if (_state(id) != PodJobsV4.State.Preparing) assertEq(_balance(id), 0, "no writing money is left in a job that is not preparing");
        }
    }
}

contract PodJobsV4Test is PodJobsV4Fixture {
    // --- numbering and creating ---

    function test_numberingStartsWhereItIsTold() public {
        assertEq(_post(), FIRST_JOB);
        assertEq(_post(), FIRST_JOB + 1);
        assertEq(jobs.nextJobId(), FIRST_JOB + 2);
    }

    function test_oneJobIsPaidForOnceWithThreeWritings() public {
        uint256 id = _post();
        (address who, uint256 price, bytes32 seal, uint64 endsAt, PodJobsV4.State state, , , uint64 window) = jobs.jobs(id);
        assertEq(who, poster);
        assertEq(price, PRICE);
        assertEq(seal, bytes32(0), "nothing is fixed before the poster approves");
        assertEq(endsAt, 0, "the window has not started");
        assertEq(uint8(state), uint8(PodJobsV4.State.Preparing));
        assertEq(window, WINDOW);
        assertEq(_balance(id), 3 * WRITING);
        _assertConserved();
    }

    function test_aJobThatPaysOnlyForWritingIsRefused() public {
        vm.prank(poster);
        vm.expectRevert(PodJobsV4.WrongAmount.selector);
        jobs.post{ value: 3 * WRITING }(WINDOW, 1);
    }

    function test_aJobWithNoWindowIsRefused() public {
        vm.prank(poster);
        vm.expectRevert(PodJobsV4.NoWindow.selector);
        jobs.post{ value: PRICE + 3 * WRITING }(0, 1);
    }

    function test_tooManyReviewerSeatsIsRefused() public {
        uint8 tooMany = jobs.MAX_REVIEWERS() + 1;
        vm.prank(poster);
        vm.expectRevert(PodJobsV4.TooManyReviewers.selector);
        jobs.post{ value: PRICE + 3 * WRITING }(WINDOW, tooMany);
    }

    // --- preparing, and the poster's approval ---

    function test_noSeatCanBeTakenWhilePreparing() public {
        uint256 id = _post();
        uint256 deposit = jobs.seatDeposit(id, PodJobsV4.Role.Lead);
        vm.prank(leadAgent);
        vm.expectRevert(PodJobsV4.WrongState.selector);
        jobs.takeSeat{ value: deposit }(id, PodJobsV4.Role.Lead, leadOwner);
    }

    function test_approvalFixesTheSealStartsTheWindowAndReturnsWhatWasNotUsed() public {
        uint256 id = _post();
        _write(id);
        vm.warp(block.timestamp + 5 days); // a slow start never eats the pod's time

        uint256 before = poster.balance;
        _open(id);

        (, , bytes32 seal, uint64 endsAt, PodJobsV4.State state, , , ) = jobs.jobs(id);
        assertEq(seal, SEAL);
        assertEq(endsAt, block.timestamp + WINDOW);
        assertEq(uint8(state), uint8(PodJobsV4.State.Open));
        assertEq(poster.balance, before + 2 * WRITING, "two writings were not used");
        assertEq(_balance(id), 0);
        _take(id, PodJobsV4.Role.Lead, leadAgent, leadOwner);
        _assertConserved();
    }

    function test_anApprovalTheWriterDidNotSignIsRefused() public {
        uint256 id = _post();
        (, uint256 somebodyKey) = makeAddrAndKey("somebody else");
        bytes memory forged = _sign(somebodyKey, jobs.checksDigest(id, SEAL));
        vm.prank(poster);
        vm.expectRevert(PodJobsV4.NotWritten.selector);
        jobs.approveChecks(id, SEAL, forged);
    }

    function test_anApprovalSignedForAnotherJobOrSealIsRefused() public {
        uint256 id = _post();
        uint256 other = _post();
        bytes memory forOtherJob = _written(other, SEAL);
        bytes memory forOtherSeal = _written(id, keccak256("different checks"));

        vm.startPrank(poster);
        vm.expectRevert(PodJobsV4.NotWritten.selector);
        jobs.approveChecks(id, SEAL, forOtherJob);
        vm.expectRevert(PodJobsV4.NotWritten.selector);
        jobs.approveChecks(id, SEAL, forOtherSeal);
        vm.stopPrank();
    }

    function test_anApprovalSignedForAnotherContractIsRefused() public {
        PodJobsV4 elsewhere = new PodJobsV4(validator, writer, FIRST_JOB, WRITING, PAYOUT_GAS, ANSWER_TIME);
        uint256 id = _post();
        bytes memory forElsewhere = _sign(writerKey, elsewhere.checksDigest(id, SEAL));
        vm.prank(poster);
        vm.expectRevert(PodJobsV4.NotWritten.selector);
        jobs.approveChecks(id, SEAL, forElsewhere);
    }

    function test_aSignatureInItsOtherFormIsRefused() public {
        uint256 id = _post();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(writerKey, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", jobs.checksDigest(id, SEAL))));
        // the same signature, mirrored onto the upper half of the curve
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes memory mirrored = abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.prank(poster);
        vm.expectRevert(PodJobsV4.NotWritten.selector);
        jobs.approveChecks(id, SEAL, mirrored);
    }

    function test_aSignatureForAnotherChainIsRefused() public {
        uint256 id = _post();
        bytes memory signedHere = _written(id, SEAL);
        vm.chainId(block.chainid + 1);
        vm.prank(poster);
        vm.expectRevert(PodJobsV4.NotWritten.selector);
        jobs.approveChecks(id, SEAL, signedHere);
    }

    function test_aSignatureOverTheSameFactsForAnotherPurposeIsRefused() public {
        uint256 id = _post();
        // everything the approval names, but not what the signature is for
        bytes32 noPurpose = keccak256(abi.encode(address(jobs), block.chainid, id, SEAL));
        bytes memory signed = _sign(writerKey, noPurpose);
        vm.prank(poster);
        vm.expectRevert(PodJobsV4.NotWritten.selector);
        jobs.approveChecks(id, SEAL, signed);
    }

    function test_onlyThePosterApprovesTheChecks_andOnlyOnce() public {
        uint256 id = _post();
        bytes memory signature = _written(id, SEAL);
        vm.prank(stranger);
        vm.expectRevert(PodJobsV4.NotPoster.selector);
        jobs.approveChecks(id, SEAL, signature);

        _open(id);
        bytes memory again = _written(id, keccak256("changed afterwards"));
        vm.prank(poster);
        vm.expectRevert(PodJobsV4.WrongState.selector);
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
        vm.expectRevert(PodJobsV4.NothingToWriteWith.selector);
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
        vm.expectRevert(PodJobsV4.WritingUnderWay.selector);
        jobs.reserveWriting(id);
        vm.stopPrank();
    }

    function test_noWritingStartsOnceTheJobLeftPreparing() public {
        uint256 id = _openJob();
        vm.prank(writer);
        vm.expectRevert(PodJobsV4.WrongState.selector);
        jobs.reserveWriting(id);
    }

    function test_aTopUpIsExactlyOneWriting_fromThePoster_whilePreparing() public {
        uint256 id = _post();
        vm.prank(poster);
        vm.expectRevert(PodJobsV4.WrongAmount.selector);
        jobs.topUp{ value: WRITING + 1 }(id);
        vm.prank(stranger);
        vm.expectRevert(PodJobsV4.NotPoster.selector);
        jobs.topUp{ value: WRITING }(id);

        _open(id);
        vm.prank(poster);
        vm.expectRevert(PodJobsV4.WrongState.selector);
        jobs.topUp{ value: WRITING }(id);
    }

    function test_aTakeBackReturnsThePriceAndWhatWasNotUsed() public {
        uint256 id = _post();
        _write(id);
        uint256 before = poster.balance;
        vm.prank(poster);
        jobs.takeBack(id);
        assertEq(poster.balance, before + PRICE + 2 * WRITING);
        assertEq(uint8(_state(id)), uint8(PodJobsV4.State.Refunded));
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
        vm.expectRevert(PodJobsV4.NotWriter.selector);
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
            vm.expectRevert(PodJobsV4.NotWriter.selector);
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
            vm.expectRevert(PodJobsV4.NotWriter.selector);
            jobs.reserveWriting(id);
        }
        vm.prank(writer);
        jobs.reserveWriting(id);
        for (uint256 i; i < others.length; i++) {
            vm.prank(others[i]);
            vm.expectRevert(PodJobsV4.NotWriter.selector);
            jobs.keepWriting(id);
            vm.prank(others[i]);
            vm.expectRevert(PodJobsV4.NotWriter.selector);
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
        _take(id, PodJobsV4.Role.Builder, builderAgent, builderOwner);
        vm.prank(poster);
        vm.expectRevert(PodJobsV4.WrongState.selector);
        jobs.takeBack(id);
    }

    function test_onlyThePosterTakesTheMoneyBack() public {
        uint256 id = _post();
        vm.prank(stranger);
        vm.expectRevert(PodJobsV4.NotPoster.selector);
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
        vm.prank(reviewerAgent); jobs.approve(id, PodJobsV4.Role.Reviewer, COMMIT, ACCOUNT);
        vm.warp(block.timestamp + 10 minutes);

        bytes32 later = keccak256("pushed again, answering a refusal");
        _putForward(id, later);
        assertEq(_commit(id), later);
        assertFalse(_approved(id, PodJobsV4.Role.Reviewer), "what was said of the old commit is not said of the new one");
        assertEq(jobs.accounts(id, uint8(PodJobsV4.Role.Reviewer), 0), bytes32(0), "nor is the account that was bound to it");
        assertTrue(_approved(id, PodJobsV4.Role.Builder), "the builder stands behind what it put forward");
        assertEq(jobs.reviewBy(id), block.timestamp + REVIEW_TIME, "and the seats have the whole time again to review it");
        // the old commit is nobody's to approve any more, nor the lead's to conclude
        vm.prank(reviewerAgent);
        vm.expectRevert(PodJobsV4.CommitMismatch.selector);
        jobs.approve(id, PodJobsV4.Role.Reviewer, COMMIT, ACCOUNT);
        vm.prank(leadAgent);
        vm.expectRevert(PodJobsV4.CommitMismatch.selector);
        jobs.conclude(id, COMMIT, 0, REASONS);
    }

    function test_onceLockedNothingElseIsPutForwardOrApproved() public {
        uint256 id = _lockedJob();
        assertTrue(jobs.locked(id));
        vm.prank(builderAgent);
        vm.expectRevert(PodJobsV4.Locked.selector);
        jobs.putForward(id, keccak256("swapped while being graded"));
        vm.prank(reviewerAgent);
        vm.expectRevert(PodJobsV4.CommitMismatch.selector);
        jobs.approve(id, PodJobsV4.Role.Reviewer, keccak256("swapped while being graded"), ACCOUNT);
        // the lead has concluded, so the review is over: nobody signs on again, or changes the account it bound
        vm.prank(reviewerAgent);
        vm.expectRevert(PodJobsV4.Locked.selector);
        jobs.approve(id, PodJobsV4.Role.Reviewer, COMMIT, keccak256("an account written after the conclusion"));
        assertEq(jobs.accounts(id, uint8(PodJobsV4.Role.Reviewer), 0), ACCOUNT);
        assertEq(_commit(id), COMMIT);
    }

    function test_withNoLeadTheCommitThatIsLockedIsStillFineToStandBehind_forAsLongAsItsReviewRuns() public {
        uint256 id = _openJob();
        _take(id, PodJobsV4.Role.Builder, builderAgent, builderOwner);
        _take(id, PodJobsV4.Role.Reviewer, reviewerAgent, reviewerOwner);
        _putForward(id, COMMIT);
        vm.prank(reviewerAgent); jobs.approve(id, PodJobsV4.Role.Reviewer, COMMIT, ACCOUNT);
        assertTrue(jobs.locked(id), "no lead sits here, so the whole pod behind it is graded at once, as on the third contract");
        vm.prank(builderAgent);
        vm.expectRevert(PodJobsV4.Locked.selector);
        jobs.putForward(id, keccak256("swapped while being graded"));
        // as there: said again with the same account, a yes changes nothing
        vm.prank(reviewerAgent);
        jobs.approve(id, PodJobsV4.Role.Reviewer, COMMIT, ACCOUNT);
        assertEq(jobs.accounts(id, uint8(PodJobsV4.Role.Reviewer), 0), ACCOUNT);
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

        uint256 deposit = jobs.seatDeposit(id, PodJobsV4.Role.Reviewer);
        vm.deal(stranger, deposit);
        vm.prank(stranger);
        vm.expectRevert(PodJobsV4.Locked.selector);
        jobs.takeSeat{ value: deposit }(id, PodJobsV4.Role.Reviewer, stranger);

        vm.prank(validator);
        jobs.releaseLock(id);
        vm.prank(stranger);
        jobs.takeSeat{ value: deposit }(id, PodJobsV4.Role.Reviewer, stranger);
        assertEq(jobs.seatCount(id, PodJobsV4.Role.Reviewer), 2);
        _assertConserved();
    }

    function test_theLockEndsWithTheSettlement() public {
        uint256 id = _lockedJob();
        _settle(id, PodJobsV4.Verdict.Passed);
        vm.prank(reviewerAgent);
        vm.expectRevert(PodJobsV4.WrongState.selector);
        jobs.approve(id, PodJobsV4.Role.Reviewer, keccak256("after the fact"), ACCOUNT);
    }

    function test_theLockEndsWithTheWindow() public {
        uint256 id = _lockedJob();
        vm.warp(block.timestamp + WINDOW);
        vm.prank(reviewerAgent);
        vm.expectRevert(PodJobsV4.TooLate.selector);
        jobs.approve(id, PodJobsV4.Role.Reviewer, COMMIT, ACCOUNT);
        vm.prank(builderAgent);
        vm.expectRevert(PodJobsV4.TooLate.selector);
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
        for (uint8 r; r < ROLES; r++) assertTrue(_approved(id, PodJobsV4.Role(r)));

        // a different commit is new work: nothing said of the old one is said of it
        bytes32 fixedUp = keccak256("fixed after the hold");
        _putForward(id, fixedUp);
        assertEq(jobs.released(id), bytes32(0));
        assertTrue(_approved(id, PodJobsV4.Role.Builder));
        assertFalse(_approved(id, PodJobsV4.Role.Lead));
        assertFalse(jobs.concluded(id), "the lead concluded the review of other work");
        assertEq(jobs.earned(id), 0);
        assertFalse(jobs.locked(id));
        _approveAll(id, fixedUp);
        assertTrue(jobs.policyMet(id, fixedUp));
    }

    function test_onlyTheValidatorReleases_andOnlyALockedJob() public {
        uint256 id = _openJob();
        _fillEverySeat(id);
        vm.prank(validator);
        vm.expectRevert(PodJobsV4.NotLocked.selector);
        jobs.releaseLock(id);

        _approveAll(id, COMMIT);
        address[3] memory others = [poster, writer, leadAgent];
        for (uint256 i; i < others.length; i++) {
            vm.prank(others[i]);
            vm.expectRevert(PodJobsV4.NotValidator.selector);
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
        vm.expectRevert(PodJobsV4.CommitMismatch.selector);
        jobs.report(id, COMMIT, PodJobsV4.Verdict.Passed, RECEIPT);
        vm.expectRevert(PodJobsV4.CommitMismatch.selector);
        jobs.report(id, COMMIT, PodJobsV4.Verdict.VisibleFailed, RECEIPT);
        jobs.report(id, fixedUp, PodJobsV4.Verdict.Passed, RECEIPT);
        vm.stopPrank();
    }

    function test_nothingIsReportedBeforeItIsLocked() public {
        uint256 id = _openJob();
        _fillEverySeat(id);
        // nothing put forward at all
        vm.prank(validator);
        vm.expectRevert(PodJobsV4.CommitMismatch.selector);
        jobs.report(id, COMMIT, PodJobsV4.Verdict.Passed, RECEIPT);

        _putForward(id, COMMIT);
        vm.prank(reviewerAgent); jobs.approve(id, PodJobsV4.Role.Reviewer, COMMIT, ACCOUNT);
        vm.startPrank(validator);
        vm.expectRevert(PodJobsV4.NotLocked.selector);
        jobs.report(id, COMMIT, PodJobsV4.Verdict.Passed, RECEIPT);
        vm.expectRevert(PodJobsV4.NotLocked.selector);
        jobs.report(id, COMMIT, PodJobsV4.Verdict.VisibleFailed, RECEIPT);
        vm.expectRevert(PodJobsV4.NoVerdict.selector);
        jobs.report(id, COMMIT, PodJobsV4.Verdict.None, RECEIPT);
        vm.stopPrank();
    }

    function test_onlyTheValidatorReportsAVerdict() public {
        uint256 id = _lockedJob();
        address[3] memory others = [poster, writer, leadAgent];
        for (uint256 i; i < others.length; i++) {
            vm.prank(others[i]);
            vm.expectRevert(PodJobsV4.NotValidator.selector);
            jobs.report(id, COMMIT, PodJobsV4.Verdict.Passed, RECEIPT);
        }
    }

    function test_nothingIsReportedAfterTheWindow() public {
        uint256 id = _lockedJob();
        vm.warp(block.timestamp + WINDOW);
        vm.prank(validator);
        vm.expectRevert(PodJobsV4.TooLate.selector);
        jobs.report(id, COMMIT, PodJobsV4.Verdict.Passed, RECEIPT);
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
        uint256 builderDue = jobs.seatPay(id, PodJobsV4.Role.Builder) + jobs.seatDeposit(id, PodJobsV4.Role.Builder);
        uint256 paid;
        for (uint8 r; r < ROLES; r++) paid += jobs.seatPay(id, PodJobsV4.Role(r));

        _settle(id, PodJobsV4.Verdict.Passed);
        assertEq(builderAgent.balance, builderBefore + builderDue);
        assertEq(poster.balance, posterBefore + price - paid);
        assertGt(price - paid, jobs.seatPay(id, PodJobsV4.Role.Reviewer), "the untaken reviewer's share went back");
        assertEq(address(jobs).balance, 0, "every last wei went somewhere");
        _assertConserved();
    }

    function test_aVerdictIsRecordedWithItsReceipt() public {
        uint256 id = _lockedJob();
        _settle(id, PodJobsV4.Verdict.VisibleFailed);
        (PodJobsV4.Verdict verdict, bytes32 receiptHash) = jobs.reports(id);
        assertEq(uint8(verdict), uint8(PodJobsV4.Verdict.VisibleFailed));
        assertEq(receiptHash, RECEIPT);
    }

    // --- item 14: an approval that costs something ---

    function test_aCheckThePodCouldSeeFailing_costsEverySeatBehindTheWorkItsDeposit_theBuilderToo() public {
        uint256 id = _lockedJob();
        uint256 forfeited = jobs.seatDeposit(id, PodJobsV4.Role.Lead) + jobs.seatDeposit(id, PodJobsV4.Role.Builder)
            + jobs.seatDeposit(id, PodJobsV4.Role.Reviewer) + jobs.seatDeposit(id, PodJobsV4.Role.QA) + jobs.seatDeposit(id, PodJobsV4.Role.Security);

        uint256 posterBefore = poster.balance;
        uint256 leadBefore = leadAgent.balance;
        uint256 builderBefore = builderAgent.balance;
        _settle(id, PodJobsV4.Verdict.VisibleFailed);

        assertEq(leadAgent.balance, leadBefore, "the lead stood behind it, and loses its deposit");
        assertEq(builderAgent.balance, builderBefore, "the builder put it forward, and loses its deposit");
        assertEq(poster.balance, posterBefore + PRICE + forfeited, "the poster gets the price and the forfeits");
        assertEq(address(jobs).balance, 0);
        _assertConserved();
    }

    function test_onlyAHiddenCheckFailing_sendsEveryDepositHome() public {
        uint256 id = _lockedJob();
        uint256 leadDeposit = jobs.seatDeposit(id, PodJobsV4.Role.Lead);
        uint256 posterBefore = poster.balance;
        uint256 leadBefore = leadAgent.balance;
        _settle(id, PodJobsV4.Verdict.HiddenFailed);

        assertEq(leadAgent.balance, leadBefore + leadDeposit);
        assertEq(poster.balance, posterBefore + PRICE, "a poster cannot profit from an exam made to fail");
        assertEq(address(jobs).balance, 0);
        _assertConserved();
    }

    function test_theWindowClosingSendsEveryDepositHome() public {
        uint256 id = _lockedJob();
        uint256 leadDeposit = jobs.seatDeposit(id, PodJobsV4.Role.Lead);
        uint256 leadBefore = leadAgent.balance;
        uint256 posterBefore = poster.balance;
        vm.warp(block.timestamp + WINDOW);
        vm.prank(stranger);
        jobs.close(id);

        assertEq(leadAgent.balance, leadBefore + leadDeposit);
        assertEq(poster.balance, posterBefore + PRICE);
        assertEq(uint8(_state(id)), uint8(PodJobsV4.State.Refunded));
        _assertConserved();
    }

    // --- closing ---

    function test_anybodyMayCloseAfterTheWindow_nobodyBefore() public {
        uint256 id = _openJob();
        _take(id, PodJobsV4.Role.Builder, builderAgent, builderOwner);
        vm.warp(block.timestamp + WINDOW - 1);
        vm.prank(stranger);
        vm.expectRevert(PodJobsV4.TooEarly.selector);
        jobs.close(id);

        vm.warp(block.timestamp + 1);
        vm.prank(stranger);
        jobs.close(id);
        vm.prank(stranger);
        vm.expectRevert(PodJobsV4.WrongState.selector);
        jobs.close(id);
        _assertConserved();
    }

    function test_aNumberNobodyWasGivenCannotBeClosed() public {
        vm.prank(stranger);
        vm.expectRevert(PodJobsV4.NoSuchJob.selector);
        jobs.close(FIRST_JOB - 1);
        uint256 next = jobs.nextJobId();
        vm.prank(stranger);
        vm.expectRevert(PodJobsV4.NoSuchJob.selector);
        jobs.close(next);
    }

    function test_aJobStillPreparingHasNoWindowToClose() public {
        uint256 id = _post();
        vm.warp(block.timestamp + 30 days);
        vm.prank(stranger);
        vm.expectRevert(PodJobsV4.WrongState.selector);
        jobs.close(id);
    }

    // --- payments that do not arrive ---

    function _seatAPayee(address payee) internal returns (uint256 id) {
        id = _openJob();
        vm.deal(payee, 10 ether);
        _take(id, PodJobsV4.Role.Lead, leadAgent, leadOwner);
        _take(id, PodJobsV4.Role.Builder, payee, builderOwner);
        _take(id, PodJobsV4.Role.Reviewer, reviewerAgent, reviewerOwner);
        _take(id, PodJobsV4.Role.QA, qaAgent, qaOwner);
        _take(id, PodJobsV4.Role.Security, securityAgent, securityOwner);
        _approveAll(id, COMMIT);
    }

    function _assertEverybodyElsePaid(uint256 id, address payee) internal {
        uint256 leadBefore = leadAgent.balance;
        uint256 securityBefore = securityAgent.balance;
        uint256 payeeBefore = payee.balance;
        uint256 payeeDue = jobs.seatPay(id, PodJobsV4.Role.Builder) + jobs.seatDeposit(id, PodJobsV4.Role.Builder);
        _settle(id, PodJobsV4.Verdict.Passed);

        assertEq(uint8(_state(id)), uint8(PodJobsV4.State.Settled));
        assertEq(leadAgent.balance, leadBefore + jobs.seatPay(id, PodJobsV4.Role.Lead) + jobs.seatDeposit(id, PodJobsV4.Role.Lead));
        assertEq(securityAgent.balance, securityBefore + jobs.seatPay(id, PodJobsV4.Role.Security) + jobs.seatDeposit(id, PodJobsV4.Role.Security));
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
        _settle(_seatAPayee(address(new Quiet())), PodJobsV4.Verdict.Passed);
        uint256 quietJob = _seatAPayee(address(new Quiet()));
        uint256 floodJob = _seatAPayee(address(new Flood()));
        _report(quietJob, PodJobsV4.Verdict.Passed);
        _report(floodJob, PodJobsV4.Verdict.Passed);
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
        vm.expectRevert(PodJobsV4.PaymentFailed.selector);
        jobs.withdraw(address(refuser));

        vm.prank(address(refuser));
        jobs.withdraw(stranger);
        assertEq(jobs.owed(address(refuser)), 0);
        _assertConserved();
    }

    function test_nothingOwedIsNothingToWithdraw() public {
        vm.prank(stranger);
        vm.expectRevert(PodJobsV4.NothingOwed.selector);
        jobs.withdraw(stranger);
    }

    // --- seats, as before ---

    function test_theSharesAddUpToThePrice() public {
        uint256 id = _openJob();
        uint256 total;
        for (uint8 r; r < ROLES; r++) total += jobs.seatPay(id, PodJobsV4.Role(r));
        assertEq(total, PRICE);
    }

    function test_oneOwnerCannotHoldTwoSeats() public {
        uint256 id = _openJob();
        _take(id, PodJobsV4.Role.Lead, leadAgent, leadOwner);
        uint256 deposit = jobs.seatDeposit(id, PodJobsV4.Role.Builder);
        vm.prank(builderAgent);
        vm.expectRevert(PodJobsV4.OwnerAlreadySeated.selector);
        jobs.takeSeat{ value: deposit }(id, PodJobsV4.Role.Builder, leadOwner);
    }

    // a seat reads the pod's work before it is paid for, and stands in judgement of it: never the job's own poster
    function test_aPosterTakesNoSeatOnTheirOwnJob_asTheAgent() public {
        uint256 id = _openJob();
        uint256 deposit = jobs.seatDeposit(id, PodJobsV4.Role.Security);
        vm.prank(poster);
        vm.expectRevert(PodJobsV4.PosterTakesNoSeat.selector);
        jobs.takeSeat{ value: deposit }(id, PodJobsV4.Role.Security, securityOwner);
    }

    function test_aPosterTakesNoSeatOnTheirOwnJob_asTheOwnerOfAnAgent() public {
        uint256 id = _openJob();
        uint256 deposit = jobs.seatDeposit(id, PodJobsV4.Role.Security);
        vm.prank(securityAgent);
        vm.expectRevert(PodJobsV4.PosterTakesNoSeat.selector);
        jobs.takeSeat{ value: deposit }(id, PodJobsV4.Role.Security, poster);
    }

    function test_aPosterMaySitOnSomebodyElsesJob_andAStrangerOnTheirs() public {
        uint256 theirs = _openJob();
        // a stranger takes the seat the poster was refused
        _take(theirs, PodJobsV4.Role.Security, securityAgent, securityOwner);
        assertEq(jobs.seatCount(theirs, PodJobsV4.Role.Security), 1);

        // and the same person sits on a job somebody else posted, like anybody
        vm.prank(stranger);
        uint256 id = jobs.post{ value: PRICE + 3 * WRITING }(WINDOW, 1);
        _write(id);
        bytes memory signature = _written(id, SEAL);
        vm.prank(stranger);
        jobs.approveChecks(id, SEAL, signature);
        uint256 deposit = jobs.seatDeposit(id, PodJobsV4.Role.QA);
        vm.prank(poster);
        jobs.takeSeat{ value: deposit }(id, PodJobsV4.Role.QA, poster);
        assertEq(jobs.seatCount(id, PodJobsV4.Role.QA), 1);
    }

    function test_aSeatIsFirstComeFirstServed() public {
        uint256 id = _openJob();
        _take(id, PodJobsV4.Role.Lead, leadAgent, leadOwner);
        uint256 deposit = jobs.seatDeposit(id, PodJobsV4.Role.Lead);
        vm.prank(builderAgent);
        vm.expectRevert(PodJobsV4.SeatFilled.selector);
        jobs.takeSeat{ value: deposit }(id, PodJobsV4.Role.Lead, builderOwner);
    }

    function test_theDepositMustBeExact() public {
        uint256 id = _openJob();
        vm.prank(leadAgent);
        vm.expectRevert(PodJobsV4.WrongAmount.selector);
        jobs.takeSeat{ value: 1 }(id, PodJobsV4.Role.Lead, leadOwner);
    }

    function test_noSeatAfterTheWindow() public {
        uint256 id = _openJob();
        vm.warp(block.timestamp + WINDOW);
        uint256 deposit = jobs.seatDeposit(id, PodJobsV4.Role.Lead);
        vm.prank(leadAgent);
        vm.expectRevert(PodJobsV4.TooLate.selector);
        jobs.takeSeat{ value: deposit }(id, PodJobsV4.Role.Lead, leadOwner);
    }

    function test_withoutTheLeadsWordThePodHasNotAgreed_soItIsNotGradedAtOnce() public {
        uint256 id = _openJob();
        _fillEverySeat(id);
        _putForward(id, COMMIT);
        vm.prank(reviewerAgent); jobs.approve(id, PodJobsV4.Role.Reviewer, COMMIT, ACCOUNT);
        vm.prank(qaAgent); jobs.approve(id, PodJobsV4.Role.QA, COMMIT, ACCOUNT);
        vm.prank(securityAgent); jobs.approve(id, PodJobsV4.Role.Security, COMMIT, ACCOUNT);
        assertFalse(jobs.policyMet(id, COMMIT), "the lead, who speaks last, has not concluded");
        assertFalse(jobs.locked(id));
        _conclude(id, COMMIT, _behind(id));
        assertTrue(jobs.policyMet(id, COMMIT));
        assertTrue(jobs.locked(id), "the lead concluded: graded at once");
    }

    function test_withNoLeadAndNotEverySeatBehindItThePodHasNotAgreed_soItIsNotGradedAtOnce() public {
        uint256 id = _openJob();
        _take(id, PodJobsV4.Role.Builder, builderAgent, builderOwner);
        _take(id, PodJobsV4.Role.Reviewer, reviewerAgent, reviewerOwner);
        _take(id, PodJobsV4.Role.QA, qaAgent, qaOwner);
        _take(id, PodJobsV4.Role.Security, securityAgent, securityOwner);
        _putForward(id, COMMIT);
        vm.prank(reviewerAgent); jobs.approve(id, PodJobsV4.Role.Reviewer, COMMIT, ACCOUNT);
        vm.prank(qaAgent); jobs.approve(id, PodJobsV4.Role.QA, COMMIT, ACCOUNT);
        assertFalse(jobs.policyMet(id, COMMIT), "security has not said it stands behind it");
        assertFalse(jobs.locked(id));
        vm.prank(securityAgent); jobs.approve(id, PodJobsV4.Role.Security, COMMIT, ACCOUNT);
        assertTrue(jobs.policyMet(id, COMMIT));
        assertTrue(jobs.locked(id), "the whole pod behind it, and no lead to wait for: graded at once");
    }

    function test_theBuilderStandsBehindItsWorkByPuttingItForward_andByNothingElse() public {
        uint256 id = _openJob();
        _fillEverySeat(id);
        assertFalse(_approved(id, PodJobsV4.Role.Builder));
        _putForward(id, COMMIT);
        assertTrue(_approved(id, PodJobsV4.Role.Builder), "putting it forward is standing behind it");
        vm.prank(builderAgent);
        vm.expectRevert(PodJobsV4.BuildersDoNotApprove.selector);
        jobs.approve(id, PodJobsV4.Role.Builder, COMMIT, ACCOUNT);
        // the same commit again changes nothing, and is refused rather than clearing what the pod said
        vm.prank(reviewerAgent); jobs.approve(id, PodJobsV4.Role.Reviewer, COMMIT, ACCOUNT);
        vm.prank(builderAgent);
        vm.expectRevert(PodJobsV4.CommitMismatch.selector);
        jobs.putForward(id, COMMIT);
        assertTrue(_approved(id, PodJobsV4.Role.Reviewer));

        // only a hidden check fails: nobody could have seen it, and the builder's deposit comes home with the others
        _approveAll(id, COMMIT);
        uint256 before = builderAgent.balance;
        _settle(id, PodJobsV4.Verdict.HiddenFailed);
        assertEq(builderAgent.balance, before + jobs.seatDeposit(id, PodJobsV4.Role.Builder));
    }

    function test_onlyASeatHolderApproves_andOnlyTheBuilderPutsWorkForward() public {
        uint256 id = _openJob();
        _fillEverySeat(id);
        // the lead, a judge and a stranger each try to name what is graded
        address[3] memory notTheBuilder = [leadAgent, securityAgent, stranger];
        for (uint256 i; i < notTheBuilder.length; i++) {
            vm.prank(notTheBuilder[i]);
            vm.expectRevert(PodJobsV4.NotTheSeat.selector);
            jobs.putForward(id, COMMIT);
        }
        assertEq(_commit(id), bytes32(0));
        // and nothing is approved, or concluded, that the builder has not put forward
        vm.prank(reviewerAgent);
        vm.expectRevert(PodJobsV4.CommitMismatch.selector);
        jobs.approve(id, PodJobsV4.Role.Reviewer, COMMIT, ACCOUNT);
        vm.prank(leadAgent);
        vm.expectRevert(PodJobsV4.CommitMismatch.selector);
        jobs.conclude(id, COMMIT, 0, REASONS);

        _putForward(id, COMMIT);
        vm.prank(stranger);
        vm.expectRevert(PodJobsV4.NotTheSeat.selector);
        jobs.approve(id, PodJobsV4.Role.Reviewer, COMMIT, ACCOUNT);
        // a seat approves as the seat it holds, not as another
        vm.prank(qaAgent);
        vm.expectRevert(PodJobsV4.NotTheSeat.selector);
        jobs.approve(id, PodJobsV4.Role.Security, COMMIT, ACCOUNT);
    }
}

/// @dev a poster that, on being paid anything, tries to answer its delivered job again
contract TwiceAnsweringPoster {
    PodJobsV4 immutable jobs;
    uint256 public jobId;
    uint256 public triedAgain;

    constructor(PodJobsV4 jobs_) { jobs = jobs_; }

    function post(uint64 window) external payable { jobId = jobs.post{ value: msg.value }(window, 1); }

    function approveChecks(bytes32 seal, bytes calldata signature) external { jobs.approveChecks(jobId, seal, signature); }

    function refuse() external { jobs.refuse(jobId); }

    receive() external payable {
        triedAgain++;
        try jobs.refuse(jobId) {} catch {}
        try jobs.accept(jobId) {} catch {}
    }
}

/// @notice What the third contract added and the fourth keeps: the validator reports and moves nothing, the poster has the
///         last word, silence follows the checks, and the contract keeps count of how jobs ended.
/// @dev An agent in the lead's seat that, each time it is paid, tries every door of the contract
///      from inside the payment: settling, closing, answering, seating, approving, concluding and
///      withdrawing.
contract GreedyAgent {
    PodJobsV4 immutable jobs;
    uint256 id;
    uint256 public paid;
    uint256 public landed;

    constructor(PodJobsV4 jobs_) {
        jobs = jobs_;
    }

    function sit(uint256 id_) external {
        id = id_;
        jobs.takeSeat{ value: jobs.seatDeposit(id_, PodJobsV4.Role.Lead) }(id_, PodJobsV4.Role.Lead, address(this));
    }

    function conclude(bytes32 commit, uint256 named) external {
        jobs.conclude(id, commit, named, keccak256("its reasons"));
    }

    receive() external payable {
        paid++;
        try jobs.settleUnanswered(id) { landed++; } catch {}
        try jobs.close(id) { landed++; } catch {}
        try jobs.accept(id) { landed++; } catch {}
        try jobs.refuse(id) { landed++; } catch {}
        try jobs.takeSeat(id, PodJobsV4.Role.Reviewer, address(uint160(paid + 1000))) { landed++; } catch {}
        try jobs.conclude(id, keccak256("another commit"), 0, keccak256("its reasons")) { landed++; } catch {}
        try jobs.approve(id, PodJobsV4.Role.Reviewer, keccak256("another commit"), keccak256("an account")) { landed++; } catch {}
        try jobs.withdraw(address(this)) { landed++; } catch {}
    }
}

contract PodJobsV4LastWordTest is PodJobsV4Fixture {
    PodJobsV4.Verdict constant PASSED = PodJobsV4.Verdict.Passed;
    PodJobsV4.Verdict constant HIDDEN_FAILED = PodJobsV4.Verdict.HiddenFailed;
    PodJobsV4.Verdict constant VISIBLE_FAILED = PodJobsV4.Verdict.VisibleFailed;

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
        assertEq(uint8(_state(id)), uint8(PodJobsV4.State.Delivered));
        assertEq(jobs.answerBy(id), block.timestamp + ANSWER_TIME);
        (PodJobsV4.Verdict verdict, bytes32 receiptHash) = jobs.reports(id);
        assertEq(uint8(verdict), uint8(PASSED));
        assertEq(receiptHash, RECEIPT);
        _assertConserved();
    }

    function test_theValidatorCanMoveNoJobsMoney() public {
        uint256 id = _delivered(PASSED);
        vm.startPrank(validator);
        vm.expectRevert(PodJobsV4.NotPoster.selector);
        jobs.accept(id);
        vm.expectRevert(PodJobsV4.NotPoster.selector);
        jobs.refuse(id);
        vm.expectRevert(PodJobsV4.TooEarly.selector);
        jobs.settleUnanswered(id);
        // the second contract's way of settling on the verdict alone is not here to be called
        (bool isThere, ) = address(jobs).call(abi.encodeWithSignature("settle(uint256,bytes32,uint8,bytes32)", id, COMMIT, uint8(1), RECEIPT));
        assertFalse(isThere);
        vm.stopPrank();
        assertEq(uint8(_state(id)), uint8(PodJobsV4.State.Delivered));
    }

    function test_nothingElseHappensToADeliveredJob() public {
        uint256 id = _delivered(PASSED);
        address late = makeAddr("a late agent");
        vm.deal(late, 1 ether);

        vm.prank(late);
        vm.expectRevert(PodJobsV4.WrongState.selector);
        jobs.takeSeat{ value: 0 }(id, PodJobsV4.Role.Reviewer, late);
        vm.prank(reviewerAgent);
        vm.expectRevert(PodJobsV4.WrongState.selector);
        jobs.approve(id, PodJobsV4.Role.Reviewer, keccak256("another commit"), ACCOUNT);
        vm.prank(poster);
        vm.expectRevert(PodJobsV4.WrongState.selector);
        jobs.takeBack(id);
        vm.startPrank(validator);
        vm.expectRevert(PodJobsV4.WrongState.selector);
        jobs.releaseLock(id);
        vm.expectRevert(PodJobsV4.WrongState.selector);
        jobs.report(id, COMMIT, HIDDEN_FAILED, RECEIPT);
        vm.stopPrank();
    }

    function test_aDeliveredJobIsNotClosed_notEvenAfterItsWindow() public {
        uint256 id = _delivered(PASSED);
        vm.warp(block.timestamp + WINDOW + 1);
        vm.prank(stranger);
        vm.expectRevert(PodJobsV4.WrongState.selector);
        jobs.close(id);
    }

    // --- accepting ---

    function _assertAcceptedPays(PodJobsV4.Verdict verdict) internal {
        uint256 id = _delivered(verdict);
        uint256[6] memory before = _balances();
        address[5] memory holders = _seatHolders();

        vm.prank(poster);
        jobs.accept(id);

        uint256 paid;
        for (uint8 r; r < ROLES; r++) {
            uint256 pay = jobs.seatPay(id, PodJobsV4.Role(r));
            assertEq(holders[r].balance, before[r] + pay + jobs.seatDeposit(id, PodJobsV4.Role(r)), "every seat is paid, with its deposit home");
            paid += pay;
        }
        assertEq(poster.balance, before[5] + PRICE - paid);
        assertEq(uint8(_state(id)), uint8(PodJobsV4.State.Settled));
        _assertConserved();
    }

    function test_acceptingPaysThePod_whenTheChecksPassed() public { _assertAcceptedPays(PASSED); }

    function test_acceptingPaysThePod_thoughAHiddenCheckFailed() public { _assertAcceptedPays(HIDDEN_FAILED); }

    function test_acceptingPaysThePod_thoughACheckThePodCouldSeeFailed_andNoDepositIsLost() public { _assertAcceptedPays(VISIBLE_FAILED); }

    function test_onlyThePosterAccepts_andOnlyADeliveredJob_andOnlyOnce() public {
        uint256 id = _lockedJob();
        vm.prank(poster);
        vm.expectRevert(PodJobsV4.WrongState.selector);
        jobs.accept(id);

        _report(id, PASSED);
        address[3] memory others = [stranger, validator, leadAgent];
        for (uint256 i; i < others.length; i++) {
            vm.prank(others[i]);
            vm.expectRevert(PodJobsV4.NotPoster.selector);
            jobs.accept(id);
        }

        vm.startPrank(poster);
        jobs.accept(id);
        vm.expectRevert(PodJobsV4.WrongState.selector);
        jobs.accept(id);
        vm.expectRevert(PodJobsV4.WrongState.selector);
        jobs.refuse(id);
        vm.stopPrank();
    }

    function test_aLateYesStillPaysThePod_untilSomebodySettles() public {
        uint256 id = _delivered(HIDDEN_FAILED);
        vm.warp(jobs.answerBy(id) + 1 days);
        uint256 leadBefore = leadAgent.balance;
        vm.prank(poster);
        jobs.accept(id);
        assertEq(leadAgent.balance, leadBefore + jobs.seatPay(id, PodJobsV4.Role.Lead) + jobs.seatDeposit(id, PodJobsV4.Role.Lead));
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
            uint256 share = (jobs.seatPay(id, PodJobsV4.Role(r)) * REFUSAL_SHARE) / 100;
            assertEq(holders[r].balance, before[r] + share + jobs.seatDeposit(id, PodJobsV4.Role(r)), "each seat keeps a quarter of its pay, and its deposit comes home");
            kept += share;
        }
        // the shares add to the whole price here, so a quarter of each is a quarter of it
        assertEq(kept, (PRICE * REFUSAL_SHARE) / 100);
        assertEq(poster.balance, before[5] + PRICE - kept);
        assertEq(uint8(_state(id)), uint8(PodJobsV4.State.Refunded));
        _assertConserved();
    }

    function test_refusingAfterOnlyAHiddenCheckFailed_returnsEverything() public {
        uint256 id = _delivered(HIDDEN_FAILED);
        uint256[6] memory before = _balances();
        address[5] memory holders = _seatHolders();

        vm.prank(poster);
        jobs.refuse(id);

        for (uint8 r; r < ROLES; r++) assertEq(holders[r].balance, before[r] + jobs.seatDeposit(id, PodJobsV4.Role(r)), "a seat gets its deposit home and nothing more");
        assertEq(poster.balance, before[5] + PRICE);
        _assertConserved();
    }

    function test_refusingAfterACheckThePodCouldSeeFailed_costsEverySeatBehindItItsDeposit_asSilenceWould() public {
        uint256 id = _delivered(VISIBLE_FAILED);
        uint256[6] memory before = _balances();
        address[5] memory holders = _seatHolders();
        uint256 forfeited;
        for (uint8 r; r < ROLES; r++) forfeited += jobs.seatDeposit(id, PodJobsV4.Role(r));

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
        vm.expectRevert(PodJobsV4.WrongState.selector);
        jobs.refuse(id);

        _report(id, PASSED);
        address[3] memory others = [stranger, validator, leadAgent];
        for (uint256 i; i < others.length; i++) {
            vm.prank(others[i]);
            vm.expectRevert(PodJobsV4.NotPoster.selector);
            jobs.refuse(id);
        }
    }

    function test_aRefusalIsOnlyInTime_afterThatTheChecksDecide() public {
        uint256 id = _delivered(PASSED);
        vm.warp(jobs.answerBy(id) - 1);
        vm.prank(stranger);
        vm.expectRevert(PodJobsV4.TooEarly.selector);
        jobs.settleUnanswered(id);

        vm.warp(jobs.answerBy(id));
        vm.prank(poster);
        vm.expectRevert(PodJobsV4.TooLate.selector);
        jobs.refuse(id);

        uint256 leadBefore = leadAgent.balance;
        vm.prank(stranger);
        jobs.settleUnanswered(id);
        assertEq(leadAgent.balance, leadBefore + jobs.seatPay(id, PodJobsV4.Role.Lead) + jobs.seatDeposit(id, PodJobsV4.Role.Lead), "a pass the poster never answered pays the pod in full");
        assertEq(uint8(_state(id)), uint8(PodJobsV4.State.Settled));

        vm.prank(stranger);
        vm.expectRevert(PodJobsV4.WrongState.selector);
        jobs.settleUnanswered(id);
    }

    function test_aRefusalOnTheLastSecondStillCounts() public {
        uint256 id = _delivered(PASSED);
        vm.warp(jobs.answerBy(id) - 1);
        vm.prank(poster);
        jobs.refuse(id);
        assertEq(uint8(_state(id)), uint8(PodJobsV4.State.Refunded));
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
        assertEq(leadAgent.balance, leadBefore + (jobs.seatPay(id, PodJobsV4.Role.Lead) * REFUSAL_SHARE) / 100 + jobs.seatDeposit(id, PodJobsV4.Role.Lead), "and the pod was paid its quarter once");
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

        PodJobsV4.PosterRecord memory record = _poster();
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
            PodJobsV4.AgentRecord memory record = _agent(holders[i]);
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
        assertEq(uint8(jobs.answers(waiting)), uint8(PodJobsV4.Answer.None), "delivered, and not answered yet");
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

        assertEq(uint8(jobs.answers(accepted)), uint8(PodJobsV4.Answer.Accepted));
        assertEq(uint8(jobs.answers(refused)), uint8(PodJobsV4.Answer.Refused));
        assertEq(uint8(jobs.answers(refusedAfterFailing)), uint8(PodJobsV4.Answer.Refused));
        assertEq(uint8(jobs.answers(unanswered)), uint8(PodJobsV4.Answer.Unanswered));
        assertEq(uint8(jobs.answers(neverDelivered)), uint8(PodJobsV4.Answer.None));
    }

    function test_aJobTakenBackOrNeverTakenCountsAgainstNobody() public {
        uint256 id = _openJob();
        vm.prank(poster);
        jobs.takeBack(id);
        PodJobsV4.PosterRecord memory record = _poster();
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
        _take(id, PodJobsV4.Role.Lead, solo, address(madeUp++));
        _take(id, PodJobsV4.Role.Builder, solo, address(madeUp++));
        for (uint256 i; i < 5; i++) _take(id, PodJobsV4.Role.Reviewer, solo, address(madeUp++));
        _take(id, PodJobsV4.Role.QA, solo, address(madeUp++));
        _take(id, PodJobsV4.Role.Security, solo, address(madeUp++));
    }

    function _approveAsEverySeat(uint256 id, address solo) internal {
        vm.startPrank(solo);
        jobs.putForward(id, COMMIT);
        jobs.approve(id, PodJobsV4.Role.Reviewer, COMMIT, ACCOUNT);
        jobs.approve(id, PodJobsV4.Role.QA, COMMIT, ACCOUNT);
        jobs.approve(id, PodJobsV4.Role.Security, COMMIT, ACCOUNT);
        vm.stopPrank();
        // as the lead it names every seat it sits in, the five reviewers' among them
        _conclude(id, COMMIT, _behind(id));
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

        PodJobsV4.AgentRecord memory record = _agent(solo);
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
        _take(id, PodJobsV4.Role.Lead, leadAgent, leadOwner);
        _take(id, PodJobsV4.Role.Builder, builderAgent, builderOwner);
        _take(id, PodJobsV4.Role.Reviewer, reviewerAgent, reviewerOwner);
        _take(id, PodJobsV4.Role.QA, leadAgent, qaOwner);
        _take(id, PodJobsV4.Role.Security, securityAgent, securityOwner);
        _putForward(id, COMMIT);
        vm.prank(leadAgent); jobs.approve(id, PodJobsV4.Role.QA, COMMIT, ACCOUNT);
        vm.prank(reviewerAgent); jobs.approve(id, PodJobsV4.Role.Reviewer, COMMIT, ACCOUNT);
        vm.prank(securityAgent); jobs.approve(id, PodJobsV4.Role.Security, COMMIT, ACCOUNT);
        _conclude(id, COMMIT, _behind(id));
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

    function test_aPodIsOnlySaidToHaveAgreedOnceItsLeadHasConcluded() public {
        uint256 id = _openJob();
        _fillEverySeat(id);
        assertFalse(jobs.wasLocked(id));
        _putForward(id, COMMIT);
        vm.prank(reviewerAgent); jobs.approve(id, PodJobsV4.Role.Reviewer, COMMIT, ACCOUNT);
        vm.prank(qaAgent); jobs.approve(id, PodJobsV4.Role.QA, COMMIT, ACCOUNT);
        vm.prank(securityAgent); jobs.approve(id, PodJobsV4.Role.Security, COMMIT, ACCOUNT);
        assertFalse(jobs.wasLocked(id), "every yes is in, and the lead's word is not: not agreed");
        _conclude(id, COMMIT, _behind(id));
        assertTrue(jobs.wasLocked(id));
    }

    function test_withNoLeadAPodIsOnlySaidToHaveAgreedOnceEveryApprovalIsIn() public {
        uint256 id = _openJob();
        _take(id, PodJobsV4.Role.Builder, builderAgent, builderOwner);
        _take(id, PodJobsV4.Role.Reviewer, reviewerAgent, reviewerOwner);
        _take(id, PodJobsV4.Role.QA, qaAgent, qaOwner);
        _take(id, PodJobsV4.Role.Security, securityAgent, securityOwner);
        assertFalse(jobs.wasLocked(id));
        _putForward(id, COMMIT);
        vm.prank(reviewerAgent); jobs.approve(id, PodJobsV4.Role.Reviewer, COMMIT, ACCOUNT);
        vm.prank(qaAgent); jobs.approve(id, PodJobsV4.Role.QA, COMMIT, ACCOUNT);
        assertFalse(jobs.wasLocked(id), "one approval short is not agreed");
        vm.prank(securityAgent); jobs.approve(id, PodJobsV4.Role.Security, COMMIT, ACCOUNT);
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
        new PodJobsV4(validator, writer, FIRST_JOB, WRITING, PAYOUT_GAS, 259_200_000);
        vm.expectRevert("a poster answers within an hour to thirty days");
        new PodJobsV4(validator, writer, FIRST_JOB, WRITING, PAYOUT_GAS, 1 hours - 1);
        vm.expectRevert("a poster answers within an hour to thirty days");
        new PodJobsV4(validator, writer, FIRST_JOB, WRITING, PAYOUT_GAS, 0);
        // gas that ten payments in one call could not carry
        vm.expectRevert("too much gas for a payment");
        new PodJobsV4(validator, writer, FIRST_JOB, WRITING, 500_001, ANSWER_TIME);
        vm.expectRevert("bad setting");
        new PodJobsV4(validator, writer, FIRST_JOB, WRITING, 0, ANSWER_TIME);
        vm.expectRevert("bad setting");
        new PodJobsV4(validator, writer, FIRST_JOB, 0, PAYOUT_GAS, ANSWER_TIME);
        vm.expectRevert("bad address");
        new PodJobsV4(address(0), writer, FIRST_JOB, WRITING, PAYOUT_GAS, ANSWER_TIME);
        vm.expectRevert("jobs are numbered from 1");
        new PodJobsV4(validator, writer, 0, WRITING, PAYOUT_GAS, ANSWER_TIME);

        // the edges themselves are allowed
        assertEq(new PodJobsV4(validator, writer, FIRST_JOB, WRITING, 500_000, 1 hours).answerTime(), 1 hours);
        assertEq(new PodJobsV4(validator, writer, FIRST_JOB, WRITING, PAYOUT_GAS, 30 days).answerTime(), 30 days);
    }

    /// @dev An agent that, on being paid, tries every door of the contract from inside its payment.
    function test_anAgentPaidFirstCanDoNothingFromInsideItsPayment_inAnyEnding() public {
        // enough gas for the attempt to be a real one
        jobs = new PodJobsV4(validator, writer, FIRST_JOB, WRITING, 500_000, ANSWER_TIME);
        for (uint8 ending; ending < 5; ending++) {
            uint256 id = _openJob();
            GreedyAgent greedy = new GreedyAgent(jobs);
            vm.deal(address(greedy), 10 ether);
            greedy.sit(id);
            _take(id, PodJobsV4.Role.Builder, builderAgent, builderOwner);
            _take(id, PodJobsV4.Role.Reviewer, reviewerAgent, reviewerOwner);
            _take(id, PodJobsV4.Role.QA, qaAgent, qaOwner);
            _take(id, PodJobsV4.Role.Security, securityAgent, securityOwner);
            _putForward(id, COMMIT);
            vm.prank(reviewerAgent); jobs.approve(id, PodJobsV4.Role.Reviewer, COMMIT, ACCOUNT);
            vm.prank(qaAgent); jobs.approve(id, PodJobsV4.Role.QA, COMMIT, ACCOUNT);
            vm.prank(securityAgent); jobs.approve(id, PodJobsV4.Role.Security, COMMIT, ACCOUNT);
            greedy.conclude(COMMIT, _behind(id));

            uint256 before = address(greedy).balance;
            uint256 pay = jobs.seatPay(id, PodJobsV4.Role.Lead);
            uint256 deposit = jobs.seatDeposit(id, PodJobsV4.Role.Lead);
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

/// @notice No seat can stop a delivery, the lead included. The builder puts its work forward; the
///         other seats stand behind it or do not; and it is graded when the lead concludes, when
///         with no lead the whole pod agrees, or when the time for reviewing runs out, whichever
///         comes first. Risk and record follow who stood behind it.
contract PodJobsV4NoSeatStopsADeliveryTest is PodJobsV4Fixture {
    PodJobsV4.Verdict constant PASSED = PodJobsV4.Verdict.Passed;
    PodJobsV4.Verdict constant HIDDEN_FAILED = PodJobsV4.Verdict.HiddenFailed;
    PodJobsV4.Verdict constant VISIBLE_FAILED = PodJobsV4.Verdict.VisibleFailed;

    function _pay(uint256 id, PodJobsV4.Role role) internal view returns (uint256) {
        return jobs.seatPay(id, role);
    }

    function _deposit(uint256 id, PodJobsV4.Role role) internal view returns (uint256) {
        return jobs.seatDeposit(id, role);
    }

    /// @dev a full pod seated, the builder's work put forward, the reviewer and QA behind it, and
    ///      security saying nothing: the seat a poster's own wallet would sit in to hold the work
    ///      back. The lead has not concluded
    function _putForwardWithSecuritySilent() internal returns (uint256 id) {
        id = _openJob();
        _fillEverySeat(id);
        _putForward(id, COMMIT);
        vm.prank(reviewerAgent); jobs.approve(id, PodJobsV4.Role.Reviewer, COMMIT, ACCOUNT);
        vm.prank(qaAgent); jobs.approve(id, PodJobsV4.Role.QA, COMMIT, ACCOUNT);
    }

    /// @dev the same, and the lead, having left security half the review to speak in, concludes
    ///      without it, naming the reviewer and QA
    function _concludedWithSecuritySilent() internal returns (uint256 id) {
        id = _putForwardWithSecuritySilent();
        vm.warp(_halfTheReview(id));
        _conclude(id, COMMIT, _behind(id));
    }

    // --- nobody can hold the work back ---

    function test_aSeatThatSaysNothingHoldsNothingBack_theLeadNoMoreThanAnother_theWorkIsGradedOnceItsReviewHasRunOut() public {
        // security says nothing, and neither does the lead, whose word would have sent it to grading
        uint256 id = _putForwardWithSecuritySilent();
        assertFalse(jobs.locked(id), "not concluded, and its review still runs");
        vm.prank(validator);
        vm.expectRevert(PodJobsV4.NotLocked.selector);
        jobs.report(id, COMMIT, PASSED, RECEIPT);

        vm.warp(jobs.reviewBy(id));
        assertTrue(jobs.locked(id), "the time for reviewing has run out: it is graded, whoever is behind it");
        assertFalse(jobs.concluded(id));
        _report(id, PASSED);
        assertEq(uint8(_state(id)), uint8(PodJobsV4.State.Delivered));
    }

    function test_aSeatThatSaysNothingKeepsTheLeadWaitingOnlyHalfTheReview() public {
        uint256 id = _putForwardWithSecuritySilent();
        vm.warp(_halfTheReview(id));
        _conclude(id, COMMIT, _behind(id));
        assertTrue(jobs.locked(id), "graded with half its review still to run");
        assertLt(block.timestamp, jobs.reviewBy(id));
        _report(id, PASSED);
        assertEq(uint8(_state(id)), uint8(PodJobsV4.State.Delivered));
    }

    function test_theSilentSeatIsPaidNothing_andItsShareGoesBackToThePoster() public {
        uint256 id = _concludedWithSecuritySilent();
        vm.warp(jobs.reviewBy(id));
        _report(id, PASSED);
        uint256 securityBefore = securityAgent.balance;
        uint256 builderBefore = builderAgent.balance;
        uint256 leadBefore = leadAgent.balance;
        uint256 posterBefore = poster.balance;

        vm.prank(poster);
        jobs.accept(id);

        assertEq(securityAgent.balance, securityBefore + _deposit(id, PodJobsV4.Role.Security), "its deposit home, and no pay for work it did not stand behind");
        assertEq(builderAgent.balance, builderBefore + _pay(id, PodJobsV4.Role.Builder) + _deposit(id, PodJobsV4.Role.Builder));
        assertEq(leadAgent.balance, leadBefore + _pay(id, PodJobsV4.Role.Lead) + _deposit(id, PodJobsV4.Role.Lead));
        assertEq(poster.balance, posterBefore + _pay(id, PodJobsV4.Role.Security), "the share nobody earned goes back to who paid it");
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
        _take(id, PodJobsV4.Role.Builder, builderAgent, builderOwner);
        address[4] memory silent = [makeAddr("the poster's second wallet"), makeAddr("their third"), makeAddr("their fourth"), makeAddr("their fifth")];
        PodJobsV4.Role[4] memory roles = [PodJobsV4.Role.Lead, PodJobsV4.Role.Reviewer, PodJobsV4.Role.QA, PodJobsV4.Role.Security];
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
        uint256 quarter = (_pay(id, PodJobsV4.Role.Builder) * REFUSAL_SHARE) / 100;
        vm.prank(poster);
        jobs.refuse(id);
        assertEq(builderAgent.balance, builderBefore + quarter + _deposit(id, PodJobsV4.Role.Builder));
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
        _take(id, PodJobsV4.Role.Builder, builderAgent, builderOwner);
        _putForward(id, COMMIT);
        assertTrue(jobs.locked(id), "nobody waits for a seat nobody took");
        assertTrue(jobs.wasLocked(id));
        // and nobody sits down now to be paid for work they were not there to review
        uint256 deposit = _deposit(id, PodJobsV4.Role.QA);
        vm.prank(qaAgent);
        vm.expectRevert(PodJobsV4.Locked.selector);
        jobs.takeSeat{ value: deposit }(id, PodJobsV4.Role.QA, qaOwner);
        _report(id, PASSED);

        uint256 builderBefore = builderAgent.balance;
        uint256 posterBefore = poster.balance;
        vm.prank(poster);
        jobs.accept(id);
        uint256 pay = _pay(id, PodJobsV4.Role.Builder);
        assertEq(builderAgent.balance, builderBefore + pay + _deposit(id, PodJobsV4.Role.Builder));
        assertEq(poster.balance, posterBefore + PRICE - pay, "the shares of seats nobody took go back");
        assertEq(_agent(builderAgent).accepted, 1);
        assertEq(address(jobs).balance, 0);
    }

    function test_everySeatThatIsTakenBehindItSendsItToGradingAtOnce_howeverFewAreTaken() public {
        uint256 id = _openJob();
        _take(id, PodJobsV4.Role.Builder, builderAgent, builderOwner);
        _take(id, PodJobsV4.Role.QA, qaAgent, qaOwner);
        _putForward(id, COMMIT);
        assertFalse(jobs.locked(id), "QA holds a seat and has not answered");
        vm.prank(qaAgent);
        jobs.approve(id, PodJobsV4.Role.QA, COMMIT, ACCOUNT);
        assertTrue(jobs.policyMet(id, COMMIT));
        assertTrue(jobs.locked(id), "the lead's, the reviewer's and security's seats are empty, and nobody waits for them");
        assertLt(block.timestamp, jobs.reviewBy(id));
        _report(id, PASSED);

        uint256 qaBefore = qaAgent.balance;
        uint256 posterBefore = poster.balance;
        vm.prank(poster);
        jobs.accept(id);
        assertEq(qaAgent.balance, qaBefore + _pay(id, PodJobsV4.Role.QA) + _deposit(id, PodJobsV4.Role.QA));
        assertEq(poster.balance, posterBefore + PRICE - _pay(id, PodJobsV4.Role.Builder) - _pay(id, PodJobsV4.Role.QA));
        _assertConserved();
    }

    function test_aSilentPosterAndAPassPayTheBuilderAndTheSeatsBehindIt_andNobodyElse() public {
        uint256 id = _concludedWithSecuritySilent();
        vm.warp(jobs.reviewBy(id));
        uint256 securityBefore = securityAgent.balance;
        uint256 qaBefore = qaAgent.balance;
        _settle(id, PASSED);
        assertEq(qaAgent.balance, qaBefore + _pay(id, PodJobsV4.Role.QA) + _deposit(id, PodJobsV4.Role.QA));
        assertEq(securityAgent.balance, securityBefore + _deposit(id, PodJobsV4.Role.Security));
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

    function test_theReviewEndsOnTheSecond_andNobodySignsOnOrConcludesAfterIt() public {
        uint256 id = _putForwardWithSecuritySilent();
        uint64 until = jobs.reviewBy(id);
        assertEq(until, block.timestamp + REVIEW_TIME);

        // one second before: still open to a voice and to the lead's word, and not yet graded
        vm.warp(until - 1);
        assertFalse(jobs.locked(id));
        uint256 snapshot = vm.snapshotState();
        vm.prank(securityAgent);
        jobs.approve(id, PodJobsV4.Role.Security, COMMIT, ACCOUNT);
        assertTrue(_approved(id, PodJobsV4.Role.Security));
        _conclude(id, COMMIT, _behind(id));
        assertTrue(jobs.concluded(id));
        vm.revertToState(snapshot);

        // on the second: graded, and closed to anybody who would rather see the verdict first
        vm.warp(until);
        assertTrue(jobs.locked(id));
        vm.prank(securityAgent);
        vm.expectRevert(PodJobsV4.TooLate.selector);
        jobs.approve(id, PodJobsV4.Role.Security, COMMIT, ACCOUNT);
        // the lead too: it does not get to say who is paid once it could know what the checks found
        uint256 named = _behind(id);
        vm.prank(leadAgent);
        vm.expectRevert(PodJobsV4.TooLate.selector);
        jobs.conclude(id, COMMIT, named, REASONS);

        // nor once it is reported: the job is delivered, and nothing is added to it
        _report(id, PASSED);
        vm.prank(securityAgent);
        vm.expectRevert(PodJobsV4.WrongState.selector);
        jobs.approve(id, PodJobsV4.Role.Security, COMMIT, ACCOUNT);
        vm.prank(leadAgent);
        vm.expectRevert(PodJobsV4.WrongState.selector);
        jobs.conclude(id, COMMIT, named, REASONS);
    }

    function test_aSeatedReviewerStillReadingIsNotLockedOut_theLeadWaitsForEveryReviewerSeated() public {
        vm.prank(poster);
        uint256 id = jobs.post{ value: PRICE + 3 * WRITING }(WINDOW, 2);
        _write(id);
        _open(id);
        _fillEverySeat(id);
        address second = makeAddr("a second reviewer");
        vm.deal(second, 10 ether);
        _take(id, PodJobsV4.Role.Reviewer, second, second);

        _putForward(id, COMMIT);
        vm.prank(reviewerAgent); jobs.approve(id, PodJobsV4.Role.Reviewer, COMMIT, ACCOUNT);
        vm.prank(qaAgent); jobs.approve(id, PodJobsV4.Role.QA, COMMIT, ACCOUNT);
        vm.prank(securityAgent); jobs.approve(id, PodJobsV4.Role.Security, COMMIT, ACCOUNT);
        // one reviewer seated has not spoken, and half the review is its own: the lead cannot close it yet
        uint256 soFar = _behind(id);
        vm.prank(leadAgent);
        vm.expectRevert(PodJobsV4.TooEarly.selector);
        jobs.conclude(id, COMMIT, soFar, REASONS);
        assertFalse(jobs.policyMet(id, COMMIT));
        assertFalse(jobs.locked(id));
        vm.prank(second);
        jobs.approve(id, PodJobsV4.Role.Reviewer, COMMIT, ACCOUNT);
        assertFalse(jobs.locked(id), "every seat is behind it, and the lead has still to speak");
        _conclude(id, COMMIT, _behind(id));
        assertTrue(jobs.locked(id));

        // and both are paid: half the reviewers' share each
        _report(id, PASSED);
        uint256 before = second.balance;
        vm.prank(poster);
        jobs.accept(id);
        assertEq(second.balance, before + _pay(id, PodJobsV4.Role.Reviewer) + _deposit(id, PodJobsV4.Role.Reviewer));
        assertEq(_pay(id, PodJobsV4.Role.Reviewer) * 2, (PRICE * 15) / 100);
    }

    function test_aSeatCanBeTakenWhileTheReviewRuns_andNotOnceItIsLocked() public {
        uint256 id = _openJob();
        _take(id, PodJobsV4.Role.Builder, builderAgent, builderOwner);
        _take(id, PodJobsV4.Role.Lead, leadAgent, leadOwner);
        _putForward(id, COMMIT);
        // the lead has not answered, so the review runs: a judge arrives, reads the work, and stands behind it
        _take(id, PodJobsV4.Role.QA, qaAgent, qaOwner);
        vm.prank(qaAgent);
        jobs.approve(id, PodJobsV4.Role.QA, COMMIT, ACCOUNT);
        assertFalse(jobs.locked(id));

        vm.warp(jobs.reviewBy(id));
        uint256 deposit = _deposit(id, PodJobsV4.Role.Security);
        vm.prank(securityAgent);
        vm.expectRevert(PodJobsV4.Locked.selector);
        jobs.takeSeat{ value: deposit }(id, PodJobsV4.Role.Security, securityOwner);
    }

    function test_onceTheReviewHasRunOutTheBuilderCannotSwapTheWork() public {
        uint256 id = _putForwardWithSecuritySilent();
        vm.warp(jobs.reviewBy(id));
        vm.prank(builderAgent);
        vm.expectRevert(PodJobsV4.Locked.selector);
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
        vm.expectRevert(PodJobsV4.CommitMismatch.selector);
        jobs.report(id, COMMIT, PASSED, RECEIPT);
        // nothing is put forward, so there is nothing to stand behind, for a seat that had not or one that had
        vm.prank(securityAgent);
        vm.expectRevert(PodJobsV4.CommitMismatch.selector);
        jobs.approve(id, PodJobsV4.Role.Security, COMMIT, ACCOUNT);
    }

    /// @dev What an outsider's reading of this contract found, and how it was closed. The validator
    ///      lets go of work late in the window; were the same commit given a whole review again,
    ///      there would be no time for it, and the seats that say nothing would have run the window
    ///      out after all.
    function test_aReleaseLateInTheWindowHandsNothingToTheSeatsThatSayNothing() public {
        uint256 id = _openJob();
        _take(id, PodJobsV4.Role.Builder, builderAgent, builderOwner);
        address[4] memory silent = [makeAddr("the poster's second wallet"), makeAddr("their third"), makeAddr("their fourth"), makeAddr("their fifth")];
        PodJobsV4.Role[4] memory roles = [PodJobsV4.Role.Lead, PodJobsV4.Role.Reviewer, PodJobsV4.Role.QA, PodJobsV4.Role.Security];
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
        uint256 quarter = (_pay(id, PodJobsV4.Role.Builder) * REFUSAL_SHARE) / 100;
        vm.prank(poster);
        jobs.refuse(id);
        assertEq(builderAgent.balance, builderBefore + quarter + _deposit(id, PodJobsV4.Role.Builder), "its quarter, though the poster held every other seat and said nothing from any");
        _assertConserved();
    }

    function test_theCommitLetGoOfPutForwardAgainKeepsTheSeatsBehindIt_andTakesNoOthers() public {
        uint256 id = _concludedWithSecuritySilent();
        vm.warp(jobs.reviewBy(id));
        vm.prank(validator);
        jobs.releaseLock(id);
        // what the three said of it stands while nothing is put forward, the lead's conclusion with it
        assertTrue(_approved(id, PodJobsV4.Role.Lead));
        assertTrue(_approved(id, PodJobsV4.Role.QA));
        assertFalse(_approved(id, PodJobsV4.Role.Security));
        assertTrue(jobs.concluded(id));
        assertEq(jobs.earned(id), _bit(PodJobsV4.Role.Reviewer) | _bit(PodJobsV4.Role.QA));

        vm.warp(block.timestamp + 5 minutes);
        _putForward(id, COMMIT);
        assertTrue(jobs.locked(id), "back to grading at once");
        assertTrue(_approved(id, PodJobsV4.Role.Lead), "with the same seats behind it");
        // security had its time to stand behind this commit, and did not: it has no second one
        vm.prank(securityAgent);
        vm.expectRevert(PodJobsV4.TooLate.selector);
        jobs.approve(id, PodJobsV4.Role.Security, COMMIT, ACCOUNT);

        _report(id, PASSED);
        uint256 leadBefore = leadAgent.balance;
        uint256 securityBefore = securityAgent.balance;
        vm.prank(poster);
        jobs.accept(id);
        assertEq(leadAgent.balance, leadBefore + _pay(id, PodJobsV4.Role.Lead) + _deposit(id, PodJobsV4.Role.Lead));
        assertEq(securityAgent.balance, securityBefore + _deposit(id, PodJobsV4.Role.Security));
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
        assertFalse(_approved(id, PodJobsV4.Role.Lead));
        assertFalse(jobs.concluded(id), "nor does the lead's conclusion of it come back");
        assertFalse(jobs.locked(id));
    }

    function test_nothingIsLetGoOfOnceTheWindowHasClosed_soWorkPutForwardTooLateIsNeverSaidToHaveReachedGrading() public {
        uint256 id = _openJob();
        _take(id, PodJobsV4.Role.Builder, builderAgent, builderOwner);
        _take(id, PodJobsV4.Role.Lead, leadAgent, leadOwner);
        (, , , uint64 endsAt, , , , ) = jobs.jobs(id);
        // five minutes before the end, beside a seat that never answers: its review would end long after the window does
        vm.warp(endsAt - 5 minutes);
        _putForward(id, COMMIT);
        vm.warp(jobs.reviewBy(id));
        // it reads as locked, since its review has run out, and still nothing can be done with it
        vm.prank(validator);
        vm.expectRevert(PodJobsV4.TooLate.selector);
        jobs.report(id, COMMIT, PASSED, RECEIPT);
        vm.prank(validator);
        vm.expectRevert(PodJobsV4.TooLate.selector);
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
        vm.prank(reviewerAgent); jobs.approve(id, PodJobsV4.Role.Reviewer, COMMIT, ACCOUNT);
        vm.prank(qaAgent); jobs.approve(id, PodJobsV4.Role.QA, COMMIT, ACCOUNT);
        // in front of the last approval, somebody takes the reviewer seat still free, and says nothing
        address late = makeAddr("the poster's second wallet");
        vm.deal(late, 10 ether);
        _take(id, PodJobsV4.Role.Reviewer, late, late);
        vm.prank(securityAgent); jobs.approve(id, PodJobsV4.Role.Security, COMMIT, ACCOUNT);
        // the lead would have concluded now, and has to leave the newcomer its half of the review
        uint256 named = _behind(id);
        vm.prank(leadAgent);
        vm.expectRevert(PodJobsV4.TooEarly.selector);
        jobs.conclude(id, COMMIT, named, REASONS);
        assertFalse(jobs.locked(id), "the whole pod is one voice short now");

        // half the review, and no longer: the lead concludes without it
        vm.warp(_halfTheReview(id));
        _conclude(id, COMMIT, named);
        assertTrue(jobs.locked(id));
        _report(id, PASSED);
        uint256 securityBefore = securityAgent.balance;
        uint256 lateBefore = late.balance;
        vm.prank(poster);
        jobs.accept(id);
        assertEq(securityAgent.balance, securityBefore + _pay(id, PodJobsV4.Role.Security) + _deposit(id, PodJobsV4.Role.Security));
        assertEq(late.balance, lateBefore + _deposit(id, PodJobsV4.Role.Reviewer), "the seat that came to say nothing leaves with what it put down");
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
        vm.expectRevert(PodJobsV4.Locked.selector);
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
        vm.prank(reviewerAgent);
        vm.expectRevert(PodJobsV4.TooLate.selector);
        jobs.approve(id, PodJobsV4.Role.Reviewer, COMMIT, ACCOUNT);
        vm.prank(leadAgent);
        vm.expectRevert(PodJobsV4.TooLate.selector);
        jobs.conclude(id, COMMIT, 0, REASONS);
    }

    function test_aBuilderCannotTakeBackWhatItPutForward_onlyReplaceIt() public {
        uint256 id = _openJob();
        _fillEverySeat(id);
        _putForward(id, COMMIT);
        vm.prank(builderAgent);
        vm.expectRevert(PodJobsV4.CommitMismatch.selector);
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
        uint256 id = _concludedWithSecuritySilent();
        vm.warp(jobs.reviewBy(id));
        uint256 securityBefore = securityAgent.balance;
        uint256 builderBefore = builderAgent.balance;
        uint256 qaBefore = qaAgent.balance;
        uint256 posterBefore = poster.balance;
        uint256 forfeited = _deposit(id, PodJobsV4.Role.Lead) + _deposit(id, PodJobsV4.Role.Builder)
            + _deposit(id, PodJobsV4.Role.Reviewer) + _deposit(id, PodJobsV4.Role.QA);

        _settle(id, VISIBLE_FAILED);

        assertEq(builderAgent.balance, builderBefore, "it put forward work that failed a check it could see");
        assertEq(qaAgent.balance, qaBefore, "it said yes to it");
        assertEq(securityAgent.balance, securityBefore + _deposit(id, PodJobsV4.Role.Security), "it did not, and answers for nothing");
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
        assertEq(leadAgent.balance, leadBefore + _deposit(id, PodJobsV4.Role.Lead), "a seat that did not sign on loses nothing");
        assertEq(poster.balance, posterBefore + PRICE + _deposit(id, PodJobsV4.Role.Builder));
        assertEq(_agent(builderAgent).failed, 1);
        assertEq(_counted(leadAgent), 0);
        _assertConserved();
    }

    function test_aHiddenFailureCostsNobodyADeposit_andIsCountedOnlyForWhoStoodBehindIt() public {
        uint256 id = _concludedWithSecuritySilent();
        vm.warp(jobs.reviewBy(id));
        uint256 builderBefore = builderAgent.balance;
        _settle(id, HIDDEN_FAILED);
        assertEq(builderAgent.balance, builderBefore + _deposit(id, PodJobsV4.Role.Builder));
        assertEq(_agent(builderAgent).failed, 1);
        assertEq(_agent(leadAgent).failed, 1);
        assertEq(_counted(securityAgent), 0);
        _assertConserved();
    }

    function test_refusingWhatPassedLeavesAQuarterToWhoStoodBehindIt_andOnlyThem() public {
        uint256 id = _concludedWithSecuritySilent();
        vm.warp(jobs.reviewBy(id));
        _report(id, PASSED);
        uint256 securityBefore = securityAgent.balance;
        uint256 reviewerBefore = reviewerAgent.balance;
        uint256 posterBefore = poster.balance;

        vm.prank(poster);
        jobs.refuse(id);

        uint256 kept;
        PodJobsV4.Role[4] memory behind = [PodJobsV4.Role.Lead, PodJobsV4.Role.Builder, PodJobsV4.Role.Reviewer, PodJobsV4.Role.QA];
        for (uint256 i; i < behind.length; i++) kept += (_pay(id, behind[i]) * REFUSAL_SHARE) / 100;
        assertEq(reviewerAgent.balance, reviewerBefore + (_pay(id, PodJobsV4.Role.Reviewer) * REFUSAL_SHARE) / 100 + _deposit(id, PodJobsV4.Role.Reviewer));
        assertEq(securityAgent.balance, securityBefore + _deposit(id, PodJobsV4.Role.Security));
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
        vm.prank(reviewerAgent); jobs.approve(id, PodJobsV4.Role.Reviewer, COMMIT, ACCOUNT);
        assertGt(jobs.reviewBy(id), block.timestamp + 5 minutes, "its review would end after the window does");
        // nor can the lead send it to grading over the heads of seats that have had no time to look
        uint256 named = _behind(id);
        vm.prank(leadAgent);
        vm.expectRevert(PodJobsV4.TooEarly.selector);
        jobs.conclude(id, COMMIT, named, REASONS);
        assertFalse(jobs.locked(id));
        vm.warp(block.timestamp + 5 minutes);
        vm.prank(stranger);
        jobs.close(id);
        assertEq(_agent(builderAgent).undelivered, 1, "leaving time for the review is the builder's to do");
        assertEq(_counted(reviewerAgent), 0);
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
        _take(late, PodJobsV4.Role.Builder, builderAgent, builderOwner);
        _take(late, PodJobsV4.Role.Lead, leadAgent, leadOwner);
        (, , , uint64 endsAt, , , , ) = jobs.jobs(late);
        vm.warp(endsAt - REVIEW_TIME);
        _putForward(late, COMMIT);
        assertEq(jobs.reviewBy(late), endsAt);
        vm.warp(endsAt);
        jobs.close(late);
        assertEq(_agent(builderAgent).undelivered, 1);

        // one second sooner, and there was a second in which it could have been
        uint256 inTime = _openJob();
        _take(inTime, PodJobsV4.Role.Builder, builderAgent, builderOwner);
        _take(inTime, PodJobsV4.Role.Lead, leadAgent, leadOwner);
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
        _take(id, PodJobsV4.Role.Lead, leadAgent, leadOwner);
        _take(id, PodJobsV4.Role.Builder, builderAgent, builderOwner);
        _take(id, PodJobsV4.Role.QA, leadAgent, qaOwner);
        _putForward(id, COMMIT);
        vm.prank(leadAgent);
        jobs.approve(id, PodJobsV4.Role.QA, COMMIT, ACCOUNT);
        vm.warp(jobs.reviewBy(id));
        _report(id, PASSED);

        uint256 before = leadAgent.balance;
        vm.prank(poster);
        jobs.accept(id);
        assertEq(_agent(leadAgent).accepted, 1, "behind it from one seat is behind it");
        assertEq(leadAgent.balance, before + _pay(id, PodJobsV4.Role.QA) + _deposit(id, PodJobsV4.Role.QA) + _deposit(id, PodJobsV4.Role.Lead), "paid as QA, and only its deposit back as lead");
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
            _take(id, PodJobsV4.Role.Builder, builderAgent, builderOwner);
            _take(id, PodJobsV4.Role.Lead, leadAgent, leadOwner);
            _putForward(id, COMMIT);
            assertEq(jobs.reviewBy(id), block.timestamp + reviews[i]);
            assertFalse(jobs.locked(id));
            vm.warp(block.timestamp + reviews[i]);
            assertTrue(jobs.locked(id));
        }
    }
}

/// @notice What the fourth contract adds: a yes carries the account its seat wrote, the lead speaks
///         last and names which seats earned their pay, and what is kept from a seat goes back to
///         the poster, never to the lead or to another seat.
contract PodJobsV4TheLeadNamesWhoIsPaidTest is PodJobsV4Fixture {
    PodJobsV4.Verdict constant PASSED = PodJobsV4.Verdict.Passed;
    PodJobsV4.Verdict constant HIDDEN_FAILED = PodJobsV4.Verdict.HiddenFailed;
    PodJobsV4.Verdict constant VISIBLE_FAILED = PodJobsV4.Verdict.VisibleFailed;
    PodJobsV4.Role constant LEAD = PodJobsV4.Role.Lead;
    PodJobsV4.Role constant BUILDER = PodJobsV4.Role.Builder;
    PodJobsV4.Role constant REVIEWER = PodJobsV4.Role.Reviewer;
    PodJobsV4.Role constant QA = PodJobsV4.Role.QA;
    PodJobsV4.Role constant SECURITY = PodJobsV4.Role.Security;

    function _pay(uint256 id, PodJobsV4.Role role) internal view returns (uint256) {
        return jobs.seatPay(id, role);
    }

    function _deposit(uint256 id, PodJobsV4.Role role) internal view returns (uint256) {
        return jobs.seatDeposit(id, role);
    }

    function _quarter(uint256 id, PodJobsV4.Role role) internal view returns (uint256) {
        return (jobs.seatPay(id, role) * REFUSAL_SHARE) / 100;
    }

    function _withheld(address agent) internal view returns (uint32 withheld) {
        (withheld, ) = jobs.cuts(agent);
    }

    function _withholdings(address agent) internal view returns (uint32 withholdings) {
        (, withholdings) = jobs.cuts(agent);
    }

    function _account(uint256 id, PodJobsV4.Role role, uint256 index) internal view returns (bytes32) {
        return jobs.accounts(id, uint8(role), index);
    }

    function _seatHolders() internal view returns (address[5] memory) {
        return [leadAgent, builderAgent, reviewerAgent, qaAgent, securityAgent];
    }

    function _balances() internal view returns (uint256[6] memory held) {
        address[5] memory holders = _seatHolders();
        for (uint256 i; i < holders.length; i++) held[i] = holders[i].balance;
        held[5] = poster.balance;
    }

    /// @dev a full pod, the work put forward, the reviewer and QA behind it, security still silent,
    ///      and the lead still to conclude
    function _reviewedButForSecurity() internal returns (uint256 id) {
        id = _openJob();
        _fillEverySeat(id);
        _putForward(id, COMMIT);
        vm.prank(reviewerAgent); jobs.approve(id, REVIEWER, COMMIT, ACCOUNT);
        vm.prank(qaAgent); jobs.approve(id, QA, COMMIT, ACCOUNT);
    }

    /// @dev a full pod, the work put forward, every other seat behind it, and the lead still to conclude
    function _reviewed() internal returns (uint256 id) {
        id = _reviewedButForSecurity();
        vm.prank(securityAgent); jobs.approve(id, SECURITY, COMMIT, ACCOUNT);
    }

    /// @dev every other seat stands behind the work, and the lead names the reviewer and QA and not security
    function _securityKeptFromPay() internal returns (uint256 id) {
        id = _reviewed();
        _conclude(id, COMMIT, _bit(REVIEWER) | _bit(QA));
    }

    /// @dev every other seat stands behind the work, and the lead names none of them
    function _nobodyNamed() internal returns (uint256 id) {
        id = _reviewed();
        _conclude(id, COMMIT, 0);
    }

    // --- a yes carries its account ---

    function test_aYesWithNothingToShowForItIsRefused() public {
        uint256 id = _openJob();
        _fillEverySeat(id);
        _putForward(id, COMMIT);
        vm.prank(reviewerAgent);
        vm.expectRevert(PodJobsV4.NoAccount.selector);
        jobs.approve(id, REVIEWER, COMMIT, bytes32(0));
        assertFalse(_approved(id, REVIEWER));
        // with one, the same yes lands
        vm.prank(reviewerAgent);
        jobs.approve(id, REVIEWER, COMMIT, ACCOUNT);
        assertTrue(_approved(id, REVIEWER));
    }

    function test_theAccountBoundToAYesCanBeReadBack_andCannotBeSwappedWhileThatWorkIsTheCandidate() public {
        uint256 id = _openJob();
        _fillEverySeat(id);
        assertEq(_account(id, REVIEWER, 0), bytes32(0));
        _putForward(id, COMMIT);
        bytes32 first = keccak256("what the reviewer wrote first");
        bytes32 better = keccak256("what it wrote once it had read the rest");
        vm.prank(reviewerAgent); jobs.approve(id, REVIEWER, COMMIT, first);
        assertEq(_account(id, REVIEWER, 0), first);
        // what the reviewer and the lead have read is what stays: a seat does not swap its account under them
        vm.prank(reviewerAgent);
        vm.expectRevert(PodJobsV4.AccountBound.selector);
        jobs.approve(id, REVIEWER, COMMIT, better);
        assertEq(_account(id, REVIEWER, 0), first);
        // the same yes said again is no swap, and lands
        vm.prank(reviewerAgent); jobs.approve(id, REVIEWER, COMMIT, first);
        assertEq(_account(id, REVIEWER, 0), first);
        assertEq(_account(id, QA, 0), bytes32(0), "a seat that has said nothing has bound nothing");

        vm.prank(qaAgent); jobs.approve(id, QA, COMMIT, ACCOUNT);
        vm.prank(securityAgent); jobs.approve(id, SECURITY, COMMIT, ACCOUNT);
        _conclude(id, COMMIT, _behind(id));
        assertEq(_account(id, LEAD, 0), REASONS, "the lead's reasons are bound the same way");
        assertEq(_account(id, BUILDER, 0), bytes32(0), "the builder's account is in the commit it put forward");
    }

    function test_onAJobSoSmallASeatsPayIsNothing_beingKeptFromItIsCountedAllTheSame() public {
        // 5 wei: the security seat's tenth of it rounds to nothing, and so does its deposit
        vm.prank(poster);
        uint256 id = jobs.post{ value: 5 + 3 * WRITING }(WINDOW, 1);
        _write(id);
        _open(id);
        assertEq(jobs.seatPay(id, SECURITY), 0);
        _fillEverySeat(id);
        _putForward(id, COMMIT);
        vm.prank(securityAgent); jobs.approve(id, SECURITY, COMMIT, ACCOUNT);
        vm.warp(jobs.reviewBy(id) - jobs.reviewTimeOf(id) / 2);
        _conclude(id, COMMIT, 0);
        _report(id, PodJobsV4.Verdict.Passed);
        vm.prank(poster);
        jobs.accept(id);
        // counted by the seat, not by the money: nothing was there to keep, and it was kept from the pay all the same
        (uint32 withheld, ) = jobs.cuts(securityAgent);
        (, uint32 withholdings) = jobs.cuts(leadAgent);
        assertEq(withheld, 1);
        assertEq(withholdings, 1);
    }

    function test_differentWorkPutForwardFreesASeatToBindANewAccount() public {
        uint256 id = _openJob();
        _fillEverySeat(id);
        _putForward(id, COMMIT);
        bytes32 first = keccak256("what the reviewer wrote of the first work");
        bytes32 second = keccak256("what it wrote of the second");
        vm.prank(reviewerAgent); jobs.approve(id, REVIEWER, COMMIT, first);
        bytes32 better = keccak256("better work");
        _putForward(id, better);
        assertEq(_account(id, REVIEWER, 0), bytes32(0), "an account was of the work it was bound to, and goes with it");
        vm.prank(reviewerAgent); jobs.approve(id, REVIEWER, better, second);
        assertEq(_account(id, REVIEWER, 0), second);
    }

    function test_anAgentInTwoReviewerSeatsBindsItsAccountToBoth() public {
        vm.prank(poster);
        uint256 id = jobs.post{ value: PRICE + 3 * WRITING }(WINDOW, 2);
        _write(id);
        _open(id);
        _take(id, BUILDER, builderAgent, builderOwner);
        _take(id, REVIEWER, reviewerAgent, reviewerOwner);
        _take(id, REVIEWER, reviewerAgent, makeAddr("an owner it made up"));
        _putForward(id, COMMIT);
        vm.prank(reviewerAgent); jobs.approve(id, REVIEWER, COMMIT, ACCOUNT);
        assertEq(_account(id, REVIEWER, 0), ACCOUNT);
        assertEq(_account(id, REVIEWER, 1), ACCOUNT);
    }

    // --- the lead concludes, and does not approve ---

    function test_theLeadDoesNotApprove_itConcludes() public {
        uint256 id = _reviewed();
        vm.prank(leadAgent);
        vm.expectRevert(PodJobsV4.LeadsConclude.selector);
        jobs.approve(id, LEAD, COMMIT, ACCOUNT);
        assertFalse(_approved(id, LEAD));
        // nor does anybody else say yes as the lead
        vm.prank(stranger);
        vm.expectRevert(PodJobsV4.LeadsConclude.selector);
        jobs.approve(id, LEAD, COMMIT, ACCOUNT);
    }

    function test_onlyTheLeadConcludes() public {
        uint256 id = _reviewed();
        address[6] memory notTheLead = [stranger, builderAgent, reviewerAgent, securityAgent, poster, validator];
        for (uint256 i; i < notTheLead.length; i++) {
            vm.prank(notTheLead[i]);
            vm.expectRevert(PodJobsV4.NotTheSeat.selector);
            jobs.conclude(id, COMMIT, 0, REASONS);
        }
        assertFalse(jobs.concluded(id));
        assertFalse(jobs.locked(id));
    }

    function test_aJobNoLeadSitsOnHasNobodyToConcludeIt() public {
        uint256 id = _openJob();
        _take(id, BUILDER, builderAgent, builderOwner);
        _take(id, REVIEWER, reviewerAgent, reviewerOwner);
        _take(id, QA, qaAgent, qaOwner);
        _putForward(id, COMMIT);
        vm.prank(reviewerAgent); jobs.approve(id, REVIEWER, COMMIT, ACCOUNT);
        vm.warp(_halfTheReview(id));
        address[3] memory anybody = [leadAgent, reviewerAgent, builderAgent];
        for (uint256 i; i < anybody.length; i++) {
            vm.prank(anybody[i]);
            vm.expectRevert(PodJobsV4.NotTheSeat.selector);
            jobs.conclude(id, COMMIT, 0, REASONS);
        }
    }

    function test_aConclusionWithNoReasonsIsRefused() public {
        uint256 id = _reviewed();
        uint256 named = _behind(id);
        vm.prank(leadAgent);
        vm.expectRevert(PodJobsV4.NoAccount.selector);
        jobs.conclude(id, COMMIT, named, bytes32(0));
        assertFalse(jobs.concluded(id));
    }

    // --- the lead speaks last ---

    function test_theLeadCannotConcludeOverASeatStillSilent_untilHalfTheReviewHasGone_toTheSecond() public {
        uint256 id = _reviewedButForSecurity();
        uint256 named = _behind(id);
        uint256 half = block.timestamp + REVIEW_TIME / 2;
        assertEq(_halfTheReview(id), half, "half the time for reviewing, counted from when the work was put forward");

        vm.prank(leadAgent);
        vm.expectRevert(PodJobsV4.TooEarly.selector);
        jobs.conclude(id, COMMIT, named, REASONS);

        vm.warp(half - 1);
        vm.prank(leadAgent);
        vm.expectRevert(PodJobsV4.TooEarly.selector);
        jobs.conclude(id, COMMIT, named, REASONS);
        assertFalse(jobs.locked(id));

        vm.warp(half);
        vm.prank(leadAgent);
        jobs.conclude(id, COMMIT, named, REASONS);
        assertTrue(jobs.concluded(id));
        assertTrue(jobs.locked(id));
        assertFalse(_approved(id, SECURITY), "the seat that had not said yes by then is not behind the work");
    }

    function test_theLeadConcludesAtOnceOnceEveryOtherSeatHasSpoken() public {
        uint256 id = _openJob();
        _fillEverySeat(id);
        _putForward(id, COMMIT);
        uint256 putForwardAt = block.timestamp;
        vm.prank(reviewerAgent); jobs.approve(id, REVIEWER, COMMIT, ACCOUNT);
        vm.prank(qaAgent); jobs.approve(id, QA, COMMIT, ACCOUNT);
        vm.prank(securityAgent); jobs.approve(id, SECURITY, COMMIT, ACCOUNT);
        _conclude(id, COMMIT, _behind(id));
        assertEq(block.timestamp, putForwardAt, "not a second of the review was waited out");
        assertTrue(jobs.locked(id));
        _report(id, PASSED);
    }

    function test_aLeadAloneWithItsBuilderHasNobodyToWaitFor() public {
        uint256 id = _openJob();
        _take(id, BUILDER, builderAgent, builderOwner);
        _take(id, LEAD, leadAgent, leadOwner);
        _putForward(id, COMMIT);
        assertFalse(jobs.locked(id), "a lead sits here, and its word is still to come");
        _conclude(id, COMMIT, 0);
        assertTrue(jobs.locked(id));
        _report(id, PASSED);

        uint256 leadBefore = leadAgent.balance;
        uint256 builderBefore = builderAgent.balance;
        uint256 posterBefore = poster.balance;
        vm.prank(poster);
        jobs.accept(id);
        assertEq(leadAgent.balance, leadBefore + _pay(id, LEAD) + _deposit(id, LEAD));
        assertEq(builderAgent.balance, builderBefore + _pay(id, BUILDER) + _deposit(id, BUILDER));
        assertEq(poster.balance, posterBefore + PRICE - _pay(id, LEAD) - _pay(id, BUILDER));
        assertEq(_withholdings(leadAgent), 0, "it kept nothing from anybody");
        _assertConserved();
    }

    function test_theLeadsWordCanStillBeGivenOnTheLastSecondOfTheReview_andNotOnTheNext() public {
        uint256 id = _reviewedButForSecurity();
        uint256 named = _behind(id);
        uint256 snapshot = vm.snapshotState();
        vm.warp(jobs.reviewBy(id) - 1);
        vm.prank(leadAgent);
        jobs.conclude(id, COMMIT, named, REASONS);
        assertTrue(jobs.concluded(id));
        vm.revertToState(snapshot);

        vm.warp(jobs.reviewBy(id));
        vm.prank(leadAgent);
        vm.expectRevert(PodJobsV4.TooLate.selector);
        jobs.conclude(id, COMMIT, named, REASONS);
        assertFalse(jobs.concluded(id));
        assertTrue(jobs.locked(id), "graded all the same, with whoever stands behind it");
    }

    function test_theLeadConcludesOnce_andNobodySignsOnOrChangesTheirAccountAfter() public {
        uint256 id = _reviewedButForSecurity();
        vm.warp(_halfTheReview(id));
        uint256 named = _behind(id);
        _conclude(id, COMMIT, named);

        // not again, to name somebody else once it has seen who complained
        vm.prank(leadAgent);
        vm.expectRevert(PodJobsV4.Locked.selector);
        jobs.conclude(id, COMMIT, 0, REASONS);
        assertEq(jobs.earned(id), named);
        // the seat that had not spoken has no yes left to give, though the review's time still runs
        assertLt(block.timestamp, jobs.reviewBy(id));
        vm.prank(securityAgent);
        vm.expectRevert(PodJobsV4.Locked.selector);
        jobs.approve(id, SECURITY, COMMIT, ACCOUNT);
        assertFalse(_approved(id, SECURITY));
        // and a seat already behind it cannot swap the account it was judged on
        vm.prank(reviewerAgent);
        vm.expectRevert(PodJobsV4.Locked.selector);
        jobs.approve(id, REVIEWER, COMMIT, keccak256("a better account, written afterwards"));
        assertEq(_account(id, REVIEWER, 0), ACCOUNT);
    }

    function test_aConclusionSendsTheWorkToGrading_andNothingElseIsTakenWhileItIsThere() public {
        // a spare reviewer seat, so that there is a seat somebody could still try to take
        vm.prank(poster);
        uint256 id = jobs.post{ value: PRICE + 3 * WRITING }(WINDOW, 2);
        _write(id);
        _open(id);
        _fillEverySeat(id);
        _putForward(id, COMMIT);
        vm.prank(reviewerAgent); jobs.approve(id, REVIEWER, COMMIT, ACCOUNT);
        vm.prank(qaAgent); jobs.approve(id, QA, COMMIT, ACCOUNT);
        vm.prank(securityAgent); jobs.approve(id, SECURITY, COMMIT, ACCOUNT);
        assertFalse(jobs.locked(id));
        assertFalse(jobs.policyMet(id, COMMIT));
        assertFalse(jobs.wasLocked(id));

        _conclude(id, COMMIT, _behind(id));
        assertTrue(jobs.concluded(id));
        assertTrue(jobs.locked(id));
        assertTrue(jobs.policyMet(id, COMMIT));
        assertFalse(jobs.policyMet(id, keccak256("some other commit")));
        assertTrue(jobs.wasLocked(id));
        assertTrue(_approved(id, LEAD), "concluding is how the lead stands behind the work");

        uint256 deposit = _deposit(id, REVIEWER);
        vm.deal(stranger, deposit);
        vm.prank(stranger);
        vm.expectRevert(PodJobsV4.Locked.selector);
        jobs.takeSeat{ value: deposit }(id, REVIEWER, stranger);
        vm.prank(builderAgent);
        vm.expectRevert(PodJobsV4.Locked.selector);
        jobs.putForward(id, keccak256("swapped while being graded"));
        _report(id, PASSED);
        assertEq(uint8(_state(id)), uint8(PodJobsV4.State.Delivered));
    }

    // --- nobody is named who is not behind the work ---

    function test_nobodyIsNamedWhoIsNotBehindTheWork() public {
        uint256 id = _reviewedButForSecurity();
        vm.warp(_halfTheReview(id));
        uint256 behind = _behind(id);
        assertEq(behind, _bit(REVIEWER) | _bit(QA));
        uint256[6] memory notBehind = [
            _bit(SECURITY),              // seated, and silent
            _bit(BUILDER),               // its pay follows the work, and is not the lead's to name
            _bit(LEAD),                  // nor is the lead's own
            jobs.seatBit(REVIEWER, 1),   // a reviewer seat this job does not have
            uint256(1) << 200,           // no seat at all
            uint256(1) << 255
        ];
        for (uint256 i; i < notBehind.length; i++) {
            vm.prank(leadAgent);
            vm.expectRevert(PodJobsV4.NotBehind.selector);
            jobs.conclude(id, COMMIT, notBehind[i], REASONS);
            // nor slipped in beside seats that are
            vm.prank(leadAgent);
            vm.expectRevert(PodJobsV4.NotBehind.selector);
            jobs.conclude(id, COMMIT, behind | notBehind[i], REASONS);
        }
        assertFalse(jobs.concluded(id));
        // any part of who is behind it may be named: all, some, or none
        _conclude(id, COMMIT, _bit(QA));
        assertEq(jobs.earned(id), _bit(QA));
    }

    function test_theBitsALeadNamesSeatsByAreEightToARole() public view {
        assertEq(jobs.seatBit(LEAD, 0), 1);
        assertEq(jobs.seatBit(BUILDER, 0), 1 << 8);
        assertEq(jobs.seatBit(REVIEWER, 0), 1 << 16);
        assertEq(jobs.seatBit(REVIEWER, 1), 1 << 17, "the second reviewer seat");
        assertEq(jobs.seatBit(REVIEWER, 4), 1 << 20, "the last a job can have");
        assertEq(jobs.seatBit(QA, 0), 1 << 24);
        assertEq(jobs.seatBit(SECURITY, 0), 1 << 32);
    }

    // --- who is paid ---

    /// @dev the reviewer and QA are named and security is not, though all three said yes: how the
    ///      money falls when the pod is paid in full
    function _assertOnlyTheNamedArePaid(bool isAccepted) internal {
        uint256 id = _securityKeptFromPay();
        _report(id, PASSED);
        if (!isAccepted) vm.warp(jobs.answerBy(id));
        uint256[6] memory before = _balances();
        address[5] memory holders = _seatHolders();

        if (isAccepted) { vm.prank(poster); jobs.accept(id); }
        else { vm.prank(stranger); jobs.settleUnanswered(id); }

        PodJobsV4.Role[4] memory paid = [LEAD, BUILDER, REVIEWER, QA];
        for (uint256 i; i < paid.length; i++) {
            uint8 r = uint8(paid[i]);
            assertEq(holders[r].balance, before[r] + _pay(id, paid[i]) + _deposit(id, paid[i]), "its own pay, and its deposit home");
        }
        assertEq(securityAgent.balance, before[4] + _deposit(id, SECURITY), "its deposit home, and nothing for a yes the lead did not find earned");
        // the shares add to the whole price here, so what the poster gets back is exactly what was kept
        assertEq(poster.balance, before[5] + _pay(id, SECURITY), "what is kept goes back to who paid it, to the wei");
        assertEq(address(jobs).balance, 0, "and none of it stays behind, or goes to the lead or another seat");
        assertEq(uint8(_state(id)), uint8(PodJobsV4.State.Settled));
        _assertConserved();
    }

    function test_acceptingPaysTheBuilderTheLeadAndTheSeatsNamed_andWhatIsKeptGoesBackToThePoster() public {
        _assertOnlyTheNamedArePaid(true);
    }

    function test_silenceAfterAPassPaysTheBuilderTheLeadAndTheSeatsNamed_andWhatIsKeptGoesBackToThePoster() public {
        _assertOnlyTheNamedArePaid(false);
    }

    function test_refusingWhatPassedLeavesAQuarterOnlyToTheBuilderTheLeadAndTheSeatsNamed() public {
        uint256 id = _securityKeptFromPay();
        _report(id, PASSED);
        uint256[6] memory before = _balances();
        address[5] memory holders = _seatHolders();

        vm.prank(poster);
        jobs.refuse(id);

        uint256 kept;
        PodJobsV4.Role[4] memory paid = [LEAD, BUILDER, REVIEWER, QA];
        for (uint256 i; i < paid.length; i++) {
            uint8 r = uint8(paid[i]);
            assertEq(holders[r].balance, before[r] + _quarter(id, paid[i]) + _deposit(id, paid[i]), "a quarter of its own pay, and its deposit home");
            kept += _quarter(id, paid[i]);
        }
        assertEq(securityAgent.balance, before[4] + _deposit(id, SECURITY), "no quarter for the seat the lead did not name");
        assertEq(poster.balance, before[5] + PRICE - kept);
        assertEq(kept, ((PRICE - _pay(id, SECURITY)) * REFUSAL_SHARE) / 100);
        assertEq(address(jobs).balance, 0);
        _assertConserved();
    }

    function test_theBuilderIsNeverTheLeadsToCut_whateverItNames() public {
        // paid in full
        uint256 id = _nobodyNamed();
        _report(id, PASSED);
        uint256 before = builderAgent.balance;
        vm.prank(poster);
        jobs.accept(id);
        assertEq(builderAgent.balance, before + _pay(id, BUILDER) + _deposit(id, BUILDER));
        assertEq(_withheld(builderAgent), 0);

        // and its quarter when what passed is refused
        id = _nobodyNamed();
        _report(id, PASSED);
        before = builderAgent.balance;
        vm.prank(poster);
        jobs.refuse(id);
        assertEq(builderAgent.balance, before + _quarter(id, BUILDER) + _deposit(id, BUILDER));
        _assertConserved();
    }

    function test_whenTheLeadNamesNobody_itIsPaidItsOwnShareAndNotOneWeiOfTheirs() public {
        uint256 id = _nobodyNamed();
        _report(id, PASSED);
        uint256[6] memory before = _balances();

        vm.prank(poster);
        jobs.accept(id);

        assertEq(leadAgent.balance, before[0] + _pay(id, LEAD) + _deposit(id, LEAD), "nobody in the pod is paid for cutting somebody else");
        assertEq(builderAgent.balance, before[1] + _pay(id, BUILDER) + _deposit(id, BUILDER));
        assertEq(reviewerAgent.balance, before[2] + _deposit(id, REVIEWER));
        assertEq(qaAgent.balance, before[3] + _deposit(id, QA));
        assertEq(securityAgent.balance, before[4] + _deposit(id, SECURITY));
        assertEq(poster.balance, before[5] + _pay(id, REVIEWER) + _pay(id, QA) + _pay(id, SECURITY));
        assertEq(address(jobs).balance, 0);
        _assertConserved();
    }

    function test_eachReviewerSeatIsNamedOnItsOwn() public {
        vm.prank(poster);
        uint256 id = jobs.post{ value: PRICE + 3 * WRITING }(WINDOW, 3);
        _write(id);
        _open(id);
        _fillEverySeat(id);
        address second = makeAddr("a second reviewer");
        address third = makeAddr("a third reviewer");
        vm.deal(second, 10 ether);
        vm.deal(third, 10 ether);
        _take(id, REVIEWER, second, second);
        _take(id, REVIEWER, third, third);
        _putForward(id, COMMIT);
        vm.prank(reviewerAgent); jobs.approve(id, REVIEWER, COMMIT, ACCOUNT);
        vm.prank(second); jobs.approve(id, REVIEWER, COMMIT, ACCOUNT);
        vm.prank(third); jobs.approve(id, REVIEWER, COMMIT, ACCOUNT);
        vm.prank(qaAgent); jobs.approve(id, QA, COMMIT, ACCOUNT);
        vm.prank(securityAgent); jobs.approve(id, SECURITY, COMMIT, ACCOUNT);
        // of the three reviewers, only the second
        _conclude(id, COMMIT, jobs.seatBit(REVIEWER, 1) | _bit(QA) | _bit(SECURITY));
        assertFalse(jobs.earns(id, REVIEWER, 0));
        assertTrue(jobs.earns(id, REVIEWER, 1));
        assertFalse(jobs.earns(id, REVIEWER, 2));
        assertFalse(jobs.earns(id, REVIEWER, 3), "a seat the job does not have earns nothing");
        _report(id, PASSED);

        uint256 firstBefore = reviewerAgent.balance;
        uint256 secondBefore = second.balance;
        uint256 thirdBefore = third.balance;
        uint256 posterBefore = poster.balance;
        vm.prank(poster);
        jobs.accept(id);
        // a reviewer's pay is a third of the reviewers' share, with three of them seated
        uint256 pay = _pay(id, REVIEWER);
        assertEq(pay * 3, (PRICE * 15) / 100);
        assertEq(reviewerAgent.balance, firstBefore + _deposit(id, REVIEWER));
        assertEq(second.balance, secondBefore + pay + _deposit(id, REVIEWER));
        assertEq(third.balance, thirdBefore + _deposit(id, REVIEWER));
        assertEq(poster.balance, posterBefore + 2 * pay);
        assertEq(_withheld(reviewerAgent), 1);
        assertEq(_withheld(second), 0);
        assertEq(_withheld(third), 1);
        assertEq(_withholdings(leadAgent), 1, "two seats kept from pay, on one job");
        _assertConserved();
    }

    // --- a seat kept from pay still answers for its yes ---

    function test_aCheckThePodCouldSeeFailingCostsASeatKeptFromPayItsDeposit_asItDoesASeatThatWasNamed() public {
        uint256 id = _securityKeptFromPay();
        uint256[6] memory before = _balances();
        uint256 forfeited;
        for (uint8 r; r < ROLES; r++) forfeited += _deposit(id, PodJobsV4.Role(r));

        _settle(id, VISIBLE_FAILED);

        address[5] memory holders = _seatHolders();
        for (uint256 i; i < holders.length; i++) assertEq(holders[i].balance, before[i], "every seat that said yes loses its deposit, named by the lead or not");
        assertEq(poster.balance, before[5] + PRICE + forfeited);
        assertEq(_agent(securityAgent).failed, 1, "and the failure is on its record");
        assertEq(_withheld(securityAgent), 0, "nobody was paid, so no pay was kept from it");
        assertEq(_withholdings(leadAgent), 0);
        _assertConserved();
    }

    function test_onlyAHiddenCheckFailingSendsASeatKeptFromPayItsDepositHome() public {
        uint256 id = _securityKeptFromPay();
        uint256 before = securityAgent.balance;
        _settle(id, HIDDEN_FAILED);
        assertEq(securityAgent.balance, before + _deposit(id, SECURITY));
        assertEq(_agent(securityAgent).failed, 1);
        assertEq(_withheld(securityAgent), 0);
        _assertConserved();
    }

    function test_theJobIsCountedForASeatKeptFromPay_howeverItEnds() public {
        uint256 id = _securityKeptFromPay();
        _report(id, PASSED);
        vm.prank(poster); jobs.accept(id);
        id = _securityKeptFromPay();
        _settle(id, PASSED);
        id = _securityKeptFromPay();
        _report(id, PASSED);
        vm.prank(poster); jobs.refuse(id);
        id = _securityKeptFromPay();
        _report(id, HIDDEN_FAILED);
        vm.prank(poster); jobs.refuse(id);

        // exactly as it is for the reviewer, whom the lead named each time
        PodJobsV4.AgentRecord memory kept = _agent(securityAgent);
        PodJobsV4.AgentRecord memory named = _agent(reviewerAgent);
        assertEq(kept.accepted, 1);
        assertEq(kept.paidUnanswered, 1);
        assertEq(kept.refusedPassed, 1);
        assertEq(kept.failed, 1);
        assertEq(keccak256(abi.encode(kept)), keccak256(abi.encode(named)), "it stood behind the work, and the work's ending is its own");
    }

    // --- every cut is on record ---

    function test_payKeptIsCountedOnceForEachSeatAndOnceAJobForTheLead_andOnlyWhereThePodWasPaidSomething() public {
        vm.deal(poster, 1_000 ether);
        address[3] memory cut = [reviewerAgent, qaAgent, securityAgent];

        // accepted: the pod is paid, and three seats are kept from it, on one job
        uint256 id = _nobodyNamed();
        _report(id, PASSED);
        vm.prank(poster); jobs.accept(id);
        for (uint256 i; i < cut.length; i++) assertEq(_withheld(cut[i]), 1);
        assertEq(_withholdings(leadAgent), 1, "once for the job, however many seats");

        // everybody named: nothing is kept, and nothing counted
        id = _lockedJob();
        _report(id, PASSED);
        vm.prank(poster); jobs.accept(id);
        for (uint256 i; i < cut.length; i++) assertEq(_withheld(cut[i]), 1);
        assertEq(_withholdings(leadAgent), 1);

        // refused though it passed: a quarter was paid, and theirs was kept
        id = _nobodyNamed();
        _report(id, PASSED);
        vm.prank(poster); jobs.refuse(id);
        for (uint256 i; i < cut.length; i++) assertEq(_withheld(cut[i]), 2);
        assertEq(_withholdings(leadAgent), 2);

        // unanswered after a pass: paid, and kept
        id = _nobodyNamed();
        _settle(id, PASSED);
        for (uint256 i; i < cut.length; i++) assertEq(_withheld(cut[i]), 3);
        assertEq(_withholdings(leadAgent), 3);

        // accepted though a check the pod could see failed: paid all the same, and kept
        id = _nobodyNamed();
        _report(id, VISIBLE_FAILED);
        vm.prank(poster); jobs.accept(id);
        for (uint256 i; i < cut.length; i++) assertEq(_withheld(cut[i]), 4);
        assertEq(_withholdings(leadAgent), 4);

        // every ending in which nobody is paid: refused after a failure of either kind, unanswered
        // after one, and closed without a verdict. No pay moved, so none was kept
        id = _nobodyNamed();
        _report(id, HIDDEN_FAILED);
        vm.prank(poster); jobs.refuse(id);
        id = _nobodyNamed();
        _report(id, VISIBLE_FAILED);
        vm.prank(poster); jobs.refuse(id);
        _settle(_nobodyNamed(), HIDDEN_FAILED);
        _settle(_nobodyNamed(), VISIBLE_FAILED);
        id = _nobodyNamed();
        vm.warp(block.timestamp + WINDOW);
        jobs.close(id);
        for (uint256 i; i < cut.length; i++) assertEq(_withheld(cut[i]), 4);
        assertEq(_withholdings(leadAgent), 4);

        // the lead and the builder are never kept from their own pay, and only a lead keeps anybody's
        assertEq(_withheld(leadAgent), 0);
        assertEq(_withheld(builderAgent), 0);
        for (uint256 i; i < cut.length; i++) assertEq(_withholdings(cut[i]), 0);
        assertEq(_withholdings(builderAgent), 0);
        _assertConserved();
    }

    // --- a lead that says nothing ---

    function test_aLeadThatSaysNothingHoldsNothingBack_everySeatBehindTheWorkIsPaid_andTheLeadIsNot() public {
        uint256 id = _reviewed();
        assertFalse(jobs.locked(id), "the whole pod but its lead is behind it, and the lead's word is waited for");
        vm.warp(jobs.reviewBy(id));
        assertTrue(jobs.locked(id), "for the time of the review, and no longer");
        assertFalse(jobs.concluded(id));
        _report(id, PASSED);
        uint256[6] memory before = _balances();

        vm.prank(poster);
        jobs.accept(id);

        assertEq(leadAgent.balance, before[0] + _deposit(id, LEAD), "it stood behind nothing: its deposit, and no pay");
        PodJobsV4.Role[4] memory paid = [BUILDER, REVIEWER, QA, SECURITY];
        address[5] memory holders = _seatHolders();
        for (uint256 i; i < paid.length; i++) {
            uint8 r = uint8(paid[i]);
            assertEq(holders[r].balance, before[r] + _pay(id, paid[i]) + _deposit(id, paid[i]), "paid in full, as on the third contract");
            assertEq(_withheld(holders[r]), 0);
        }
        assertEq(poster.balance, before[5] + _pay(id, LEAD), "the lead's share goes back, and nobody else's");
        assertEq(_withholdings(leadAgent), 0, "a lead that said nothing kept nothing from anybody");
        assertEq(_counted(leadAgent), 0, "and the job is not on its record");
        assertEq(_agent(securityAgent).accepted, 1);
        _assertConserved();
    }

    function test_aLeadThatSaysNothing_andARefusalOfWhatPassed_leavesEverySeatBehindItItsQuarter() public {
        uint256 id = _reviewed();
        vm.warp(jobs.reviewBy(id));
        _report(id, PASSED);
        uint256[6] memory before = _balances();

        vm.prank(poster);
        jobs.refuse(id);

        uint256 kept;
        PodJobsV4.Role[4] memory paid = [BUILDER, REVIEWER, QA, SECURITY];
        address[5] memory holders = _seatHolders();
        for (uint256 i; i < paid.length; i++) {
            uint8 r = uint8(paid[i]);
            assertEq(holders[r].balance, before[r] + _quarter(id, paid[i]) + _deposit(id, paid[i]));
            kept += _quarter(id, paid[i]);
        }
        assertEq(leadAgent.balance, before[0] + _deposit(id, LEAD));
        assertEq(poster.balance, before[5] + PRICE - kept);
        _assertConserved();
    }

    // --- no lead at all ---

    function test_aJobNoLeadSitsOnRunsAsItDoesOnTheThirdContract() public {
        uint256 id = _openJob();
        _take(id, BUILDER, builderAgent, builderOwner);
        _take(id, REVIEWER, reviewerAgent, reviewerOwner);
        _take(id, QA, qaAgent, qaOwner);
        _take(id, SECURITY, securityAgent, securityOwner);
        _putForward(id, COMMIT);
        vm.prank(reviewerAgent); jobs.approve(id, REVIEWER, COMMIT, ACCOUNT);
        vm.prank(qaAgent); jobs.approve(id, QA, COMMIT, ACCOUNT);
        assertFalse(jobs.locked(id));
        vm.prank(securityAgent); jobs.approve(id, SECURITY, COMMIT, ACCOUNT);
        assertTrue(jobs.locked(id), "every seat that is taken behind it: graded at once, with nobody's word to wait for");
        assertLt(block.timestamp, jobs.reviewBy(id));
        assertFalse(jobs.concluded(id));
        _report(id, PASSED);
        uint256[6] memory before = _balances();

        vm.prank(poster);
        jobs.accept(id);

        PodJobsV4.Role[4] memory paid = [BUILDER, REVIEWER, QA, SECURITY];
        address[5] memory holders = _seatHolders();
        for (uint256 i; i < paid.length; i++) {
            uint8 r = uint8(paid[i]);
            assertEq(holders[r].balance, before[r] + _pay(id, paid[i]) + _deposit(id, paid[i]));
            assertEq(_withheld(holders[r]), 0);
        }
        assertEq(poster.balance, before[5] + _pay(id, LEAD), "the share of the seat nobody took goes back");
        assertEq(address(jobs).balance, 0);
        _assertConserved();
    }

    // --- different work, and the same work again ---

    function test_differentWorkPutForwardClearsTheAccountsTheConclusionAndTheNames() public {
        uint256 id = _securityKeptFromPay();
        assertEq(_account(id, SECURITY, 0), ACCOUNT);
        vm.prank(validator);
        jobs.releaseLock(id);
        // let go of, and not yet replaced: all of it stands
        assertTrue(jobs.concluded(id));
        assertEq(jobs.earned(id), _bit(REVIEWER) | _bit(QA));
        assertEq(_account(id, LEAD, 0), REASONS);

        bytes32 fixedUp = keccak256("fixed after the hold");
        _putForward(id, fixedUp);
        assertFalse(jobs.concluded(id), "the lead concluded the review of other work");
        assertEq(jobs.earned(id), 0, "and named who earned their pay for other work");
        for (uint8 r; r < ROLES; r++) {
            assertEq(_account(id, PodJobsV4.Role(r), 0), bytes32(0), "an account was of the work it was bound to");
            assertEq(_approved(id, PodJobsV4.Role(r)), PodJobsV4.Role(r) == BUILDER);
        }
        assertFalse(jobs.locked(id));

        // nothing said of the old work pays or keeps anybody for the new: security alone stands behind
        // this one, the lead says nothing, and security, which it had kept from pay, is paid in full
        vm.prank(securityAgent); jobs.approve(id, SECURITY, fixedUp, ACCOUNT);
        vm.warp(jobs.reviewBy(id));
        vm.prank(validator);
        jobs.report(id, fixedUp, PASSED, RECEIPT);
        uint256[6] memory before = _balances();
        vm.prank(poster);
        jobs.accept(id);
        assertEq(securityAgent.balance, before[4] + _pay(id, SECURITY) + _deposit(id, SECURITY));
        assertEq(reviewerAgent.balance, before[2] + _deposit(id, REVIEWER), "named for the old work, and not behind the new");
        assertEq(leadAgent.balance, before[0] + _deposit(id, LEAD));
        assertEq(_withheld(securityAgent), 0);
        _assertConserved();
    }

    function test_theCommitLetGoOfPutForwardAgainKeepsTheLeadsConclusionAndItsNames() public {
        uint256 id = _securityKeptFromPay();
        vm.prank(validator);
        jobs.releaseLock(id);
        vm.warp(block.timestamp + 5 minutes);
        _putForward(id, COMMIT);

        assertTrue(jobs.locked(id), "back to grading at once");
        assertTrue(jobs.concluded(id), "with the lead's word as it was given");
        assertEq(jobs.earned(id), _bit(REVIEWER) | _bit(QA));
        assertEq(_account(id, LEAD, 0), REASONS);
        assertEq(_account(id, SECURITY, 0), ACCOUNT);
        assertTrue(jobs.policyMet(id, COMMIT));
        // the lead does not get a second go at who is paid, now that it may know what the grader found
        uint256 everybody = _behind(id);
        vm.prank(leadAgent);
        vm.expectRevert(PodJobsV4.TooLate.selector);
        jobs.conclude(id, COMMIT, everybody, REASONS);

        _report(id, PASSED);
        uint256[6] memory before = _balances();
        vm.prank(poster);
        jobs.accept(id);
        assertEq(reviewerAgent.balance, before[2] + _pay(id, REVIEWER) + _deposit(id, REVIEWER));
        assertEq(securityAgent.balance, before[4] + _deposit(id, SECURITY), "still kept from pay");
        assertEq(poster.balance, before[5] + _pay(id, SECURITY));
        assertEq(_withheld(securityAgent), 1);
        assertEq(_withholdings(leadAgent), 1);
        _assertConserved();
    }

    // --- what anybody can read ---

    function test_whoEarnsIsWhoIsPaid_atEveryStepOfAJob() public {
        uint256 id = _openJob();
        _fillEverySeat(id);
        for (uint8 r; r < ROLES; r++) assertFalse(jobs.earns(id, PodJobsV4.Role(r), 0), "nothing is put forward, so nobody stands behind anything");

        _putForward(id, COMMIT);
        assertTrue(jobs.earns(id, BUILDER, 0), "the builder stands behind what it put forward");
        assertFalse(jobs.earns(id, REVIEWER, 0));

        vm.prank(reviewerAgent); jobs.approve(id, REVIEWER, COMMIT, ACCOUNT);
        vm.prank(qaAgent); jobs.approve(id, QA, COMMIT, ACCOUNT);
        vm.prank(securityAgent); jobs.approve(id, SECURITY, COMMIT, ACCOUNT);
        // were the review to run out now, with the lead silent, every seat behind it would be paid
        assertTrue(jobs.earns(id, REVIEWER, 0));
        assertTrue(jobs.earns(id, SECURITY, 0));
        assertFalse(jobs.earns(id, LEAD, 0), "the lead has not stood behind it");

        _conclude(id, COMMIT, _bit(REVIEWER) | _bit(QA));
        bool[5] memory earns;
        for (uint8 r; r < ROLES; r++) earns[r] = jobs.earns(id, PodJobsV4.Role(r), 0);
        assertTrue(earns[0] && earns[1] && earns[2] && earns[3]);
        assertFalse(earns[4], "behind the work, and not named");

        _report(id, PASSED);
        uint256[6] memory before = _balances();
        address[5] memory holders = _seatHolders();
        vm.prank(poster);
        jobs.accept(id);
        for (uint8 r; r < ROLES; r++) {
            uint256 pay = earns[r] ? _pay(id, PodJobsV4.Role(r)) : 0;
            assertEq(holders[r].balance, before[r] + pay + _deposit(id, PodJobsV4.Role(r)), "paid exactly when it was said to earn");
        }
    }

    function test_aYesAConclusionAndPayKeptAreEachAnnounced() public {
        uint256 id = _openJob();
        _fillEverySeat(id);
        _putForward(id, COMMIT);

        vm.expectEmit(true, true, false, true, address(jobs));
        emit PodJobsV4.Approved(id, REVIEWER, reviewerAgent, COMMIT);
        vm.expectEmit(true, true, false, true, address(jobs));
        emit PodJobsV4.Accounted(id, REVIEWER, reviewerAgent, COMMIT, ACCOUNT);
        vm.prank(reviewerAgent);
        jobs.approve(id, REVIEWER, COMMIT, ACCOUNT);

        vm.prank(qaAgent); jobs.approve(id, QA, COMMIT, ACCOUNT);
        vm.prank(securityAgent); jobs.approve(id, SECURITY, COMMIT, ACCOUNT);
        uint256 named = _bit(REVIEWER) | _bit(QA);
        // the lead stands behind the work by concluding, and is said to, as any seat that says yes is
        vm.expectEmit(true, true, false, true, address(jobs));
        emit PodJobsV4.Approved(id, LEAD, leadAgent, COMMIT);
        vm.expectEmit(true, true, false, true, address(jobs));
        emit PodJobsV4.Concluded(id, leadAgent, COMMIT, named, REASONS);
        vm.prank(leadAgent);
        jobs.conclude(id, COMMIT, named, REASONS);

        _report(id, PASSED);
        vm.expectEmit(true, true, false, true, address(jobs));
        emit PodJobsV4.PayKept(id, SECURITY, securityAgent, _pay(id, SECURITY));
        vm.prank(poster);
        jobs.accept(id);
    }

    function test_whatIsKeptOnARefusalOfWhatPassedIsAnnouncedAsTheQuarterItWas() public {
        uint256 id = _securityKeptFromPay();
        _report(id, PASSED);
        vm.expectEmit(true, true, false, true, address(jobs));
        emit PodJobsV4.PayKept(id, SECURITY, securityAgent, _quarter(id, SECURITY));
        vm.prank(poster);
        jobs.refuse(id);
    }

    // --- what no contract can close, and what limits it ---

    /// @dev A lead that sits down after the work is put forward would be judging work it never watched
    ///      being made, and could cut every seat behind it: a poster's second wallet could do it, and
    ///      nothing on a chain can tell that it is theirs. So the lead's seat is not to be had once
    ///      work has been put forward. The job is not held up by that: its review runs out by itself,
    ///      and every seat behind the work is paid in full, as it would be on the contract before.
    function test_theLeadsSeatCannotBeTakenOnceWorkIsPutForward_andTheJobIsStillPaidWhenItsReviewRunsOut() public {
        uint256 id = _openJob();
        _take(id, BUILDER, builderAgent, builderOwner);
        _take(id, QA, qaAgent, qaOwner);
        _take(id, SECURITY, securityAgent, securityOwner);
        _putForward(id, COMMIT);
        vm.prank(qaAgent); jobs.approve(id, QA, COMMIT, ACCOUNT);
        // security is slow, so the work is not yet graded, and half the review goes by
        vm.warp(_halfTheReview(id));

        address late = makeAddr("the poster's second wallet");
        vm.deal(late, 10 ether);
        uint256 deposit = jobs.seatDeposit(id, LEAD);
        vm.prank(late);
        vm.expectRevert(PodJobsV4.LeadComesFirst.selector);
        jobs.takeSeat{ value: deposit }(id, LEAD, late);
        // and no other seat is shut out by work being put forward: only the lead's is
        _take(id, REVIEWER, reviewerAgent, reviewerOwner);
        vm.prank(reviewerAgent); jobs.approve(id, REVIEWER, COMMIT, ACCOUNT);

        // nobody concludes, so the review runs out and the work is graded with whoever is behind it
        vm.warp(jobs.reviewBy(id));
        assertTrue(jobs.locked(id), "a review that ran out is graded, lead or no lead");
        assertFalse(jobs.concluded(id));
        _report(id, PASSED);

        uint256[6] memory before = _balances();
        vm.prank(poster);
        jobs.accept(id);
        assertEq(builderAgent.balance, before[1] + _pay(id, BUILDER) + _deposit(id, BUILDER));
        assertEq(reviewerAgent.balance, before[2] + _pay(id, REVIEWER) + _deposit(id, REVIEWER), "behind the work, and nobody was there to cut it");
        assertEq(qaAgent.balance, before[3] + _pay(id, QA) + _deposit(id, QA));
        assertEq(securityAgent.balance, before[4] + _deposit(id, SECURITY), "it never said yes, so it is paid nothing for the work");
        assertEq(_withholdings(late), 0, "nothing was kept from anybody");
        assertEq(_withheld(reviewerAgent), 0);
        _assertConserved();
    }

    function test_aLeadThatAlsoSitsInAnotherSeatIsPaidForThatSeatOnlyIfItNamesIt_andCountedAsAnySeatIs() public {
        uint256 id = _openJob();
        _take(id, LEAD, leadAgent, leadOwner);
        _take(id, BUILDER, builderAgent, builderOwner);
        _take(id, QA, leadAgent, qaOwner);
        _putForward(id, COMMIT);
        vm.prank(leadAgent); jobs.approve(id, QA, COMMIT, ACCOUNT);
        _conclude(id, COMMIT, 0);
        _report(id, PASSED);

        uint256 before = leadAgent.balance;
        vm.prank(poster);
        jobs.accept(id);
        assertEq(leadAgent.balance, before + _pay(id, LEAD) + _deposit(id, LEAD) + _deposit(id, QA), "paid as the lead, and only its deposit back as the QA it did not name");
        assertEq(_withheld(leadAgent), 1);
        assertEq(_withholdings(leadAgent), 1);
        assertEq(_agent(leadAgent).accepted, 1, "two seats, one job");
        _assertConserved();
    }

    /// @dev A chain refuses a contract whose code is longer than this (EIP-170). The fourth contract
    ///      is the third with more in it, so the room it has left is held here too.
    function test_theContractIsStillSmallEnoughToBeDeployedOnAnyChain() public view {
        assertLe(address(jobs).code.length, 24_576 - 2_000, "within 2,000 bytes of the most a chain allows");
    }
}
