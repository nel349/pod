// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { PodJobsV3 } from "../src/PodJobsV3.sol";
import { PodJobsV3Fixture, Refuser, GasBurner } from "./PodJobsV3.t.sol";

/// @dev Everybody who can touch the contract, doing anything they are allowed to in any order. Some
///      of them refuse payment or burn the gas they are sent. A step that is not allowed at that
///      moment is refused by the contract and changes nothing, which is itself part of what is tested.
/// @dev how many roles a job has seats for
uint8 constant ROLES = 5;

contract PodJobsV3Handler is Test {
    PodJobsV3 immutable jobs;
    address immutable validator;
    address immutable writer;
    uint256 immutable writerKey;

    address[] public posters;
    address[] public agents;
    uint256[] public ids;
    address public sink;

    /// @notice how often each ending was reached, so the run can show it went everywhere
    mapping(bytes32 => uint256) public reached;

    constructor(PodJobsV3 jobs_, address validator_, address writer_, uint256 writerKey_) {
        jobs = jobs_;
        validator = validator_;
        writer = writer_;
        writerKey = writerKey_;
        sink = makeAddr("sink");
        posters.push(makeAddr("poster one"));
        posters.push(makeAddr("poster two"));
        posters.push(address(new Refuser()));
        for (uint256 i; i < 4; i++) agents.push(makeAddr(string.concat("agent ", vm.toString(i))));
        agents.push(address(new Refuser()));
        agents.push(address(new GasBurner()));
        agents.push(makeAddr("agent 6"));
        for (uint256 i; i < posters.length; i++) vm.deal(posters[i], 1_000_000 ether);
        for (uint256 i; i < agents.length; i++) vm.deal(agents[i], 1_000_000 ether);
    }

    function payees() external view returns (address[] memory everyone) {
        everyone = new address[](posters.length + agents.length + 1);
        for (uint256 i; i < posters.length; i++) everyone[i] = posters[i];
        for (uint256 i; i < agents.length; i++) everyone[posters.length + i] = agents[i];
        everyone[everyone.length - 1] = validator;
    }

    function _job(uint256 seed) internal view returns (uint256) {
        return ids.length == 0 ? 0 : ids[seed % ids.length];
    }

    /// @dev a delivered job, looking from the seed onwards, since an answer only lands on one
    function _deliveredJob(uint256 seed) internal view returns (uint256) {
        for (uint256 i; i < ids.length; i++) {
            uint256 id = ids[(seed + i) % ids.length];
            if (_stateOf(id) == PodJobsV3.State.Delivered) return id;
        }
        return _job(seed);
    }

    /// @dev a locked job still in its window, looking from the seed onwards, since a report only
    ///      lands on one
    function _lockedJob(uint256 seed) internal view returns (uint256) {
        for (uint256 i; i < ids.length; i++) {
            uint256 id = ids[(seed + i) % ids.length];
            (, , , uint64 endsAt, PodJobsV3.State state, , , ) = jobs.jobs(id);
            if (state == PodJobsV3.State.Working && block.timestamp < endsAt && jobs.locked(id)) return id;
        }
        return _job(seed);
    }

    function _posterOf(uint256 id) internal view returns (address poster) {
        (poster, , , , , , , ) = jobs.jobs(id);
    }

    function _stateOf(uint256 id) internal view returns (PodJobsV3.State state) {
        (, , , , state, , , ) = jobs.jobs(id);
    }

    function _commitOf(uint256 id) internal view returns (bytes32 commit) {
        (, , , , , commit, , ) = jobs.jobs(id);
    }

    function _note(bool ok, bytes32 what) internal {
        if (ok) reached[what]++;
    }

    // --- preparing ---

    function post(uint256 posterSeed, uint256 price, uint8 reviewers, uint64 window) external {
        address poster = posters[posterSeed % posters.length];
        price = bound(price, 1, 50 ether);
        reviewers = uint8(bound(reviewers, 0, jobs.MAX_REVIEWERS()));
        window = uint64(bound(window, 1 minutes, 10 days));
        // read before the prank: a view call after it would spend it, and the post would come from here
        uint256 paid = price + 3 * jobs.writingPrice();
        vm.prank(poster);
        ids.push(jobs.post{ value: paid }(window, reviewers));
    }

    function topUp(uint256 seed) external {
        uint256 id = _job(seed);
        uint256 amount = jobs.writingPrice();
        vm.prank(_posterOf(id));
        try jobs.topUp{ value: amount }(id) { reached["top up"]++; } catch {}
    }

    function reserveWriting(uint256 seed) external {
        vm.prank(writer);
        try jobs.reserveWriting(_job(seed)) { reached["reserve"]++; } catch {}
    }

    function keepWriting(uint256 seed) external {
        vm.prank(writer);
        try jobs.keepWriting(_job(seed)) { reached["keep"]++; } catch {}
    }

    function releaseWriting(uint256 seed, bool byThePoster) external {
        uint256 id = _job(seed);
        vm.prank(byThePoster ? _posterOf(id) : writer);
        try jobs.releaseWriting(id) { reached["release writing"]++; } catch {}
    }

    function approveChecks(uint256 seed, bytes32 seal) external {
        uint256 id = _job(seed);
        if (seal == bytes32(0)) seal = keccak256("a seal");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(writerKey, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", jobs.checksDigest(id, seal))));
        vm.prank(_posterOf(id));
        try jobs.approveChecks(id, seal, abi.encodePacked(r, s, v)) { reached["open"]++; } catch {}
    }

    function takeBack(uint256 seed) external {
        uint256 id = _job(seed);
        vm.prank(_posterOf(id));
        try jobs.takeBack(id) { reached["take back"]++; } catch {}
    }

    // --- open and working ---

    /// @dev One time in three the seat names an owner the agent made up, which is how one agent comes
    ///      to hold several seats on a job: the one-owner rule goes by the owner a seat names.
    function takeSeat(uint256 seed, uint8 roleSeed, uint256 agentSeed, uint256 ownerSeed) external {
        uint256 id = _job(seed);
        PodJobsV3.Role role = PodJobsV3.Role(roleSeed % 5);
        address agent = agents[agentSeed % agents.length];
        address owner = ownerSeed % 3 == 0 ? address(uint160(uint256(keccak256(abi.encode("a made-up owner", ownerSeed))))) : agent;
        uint256 deposit = jobs.seatDeposit(id, role);
        vm.prank(agent);
        try jobs.takeSeat{ value: deposit }(id, role, owner) {
            reached["seat"]++;
            if (owner != agent) reached["seat under a made-up owner"]++;
        } catch {}
    }

    /// @dev the builder names a commit, which is the only way one comes to be reviewed and graded
    function putForward(uint256 seed, uint8 commitSeed) external {
        uint256 id = _job(seed);
        if (jobs.seatCount(id, PodJobsV3.Role.Builder) == 0) return;
        address builder = jobs.seatAt(id, PodJobsV3.Role.Builder, 0).agent;
        vm.prank(builder);
        try jobs.putForward(id, keccak256(abi.encode(commitSeed % 3))) { reached["put forward"]++; } catch {}
    }

    /// @dev somebody who is not the job's builder tries to name what is graded, which never works
    function putForwardAsSomebodyElse(uint256 seed, uint256 agentSeed, uint8 commitSeed) external {
        uint256 id = _job(seed);
        address agent = agents[agentSeed % agents.length];
        if (jobs.seatCount(id, PodJobsV3.Role.Builder) != 0 && jobs.seatAt(id, PodJobsV3.Role.Builder, 0).agent == agent) agent = sink;
        vm.prank(agent);
        try jobs.putForward(id, keccak256(abi.encode(commitSeed % 3))) { reached["another seat named the work"]++; } catch {}
    }

    /// @dev Some of the other seats stand behind what is put forward and some say nothing, chosen by
    ///      the bits of a mask, so that every mix of voices and silences comes up.
    function approveSomeSeats(uint256 seed, uint16 mask) external {
        uint256 id = _job(seed);
        bytes32 commit = _commitOf(id);
        uint256 nth;
        for (uint8 r; r < ROLES; r++) {
            uint256 count = jobs.seatCount(id, PodJobsV3.Role(r));
            for (uint256 i; i < count; i++) {
                if ((mask >> (nth++ % 16)) & 1 == 0) continue;
                vm.prank(jobs.seatAt(id, PodJobsV3.Role(r), i).agent);
                try jobs.approve(id, PodJobsV3.Role(r), commit) { reached["approved"]++; } catch {}
            }
        }
    }

    /// @dev the builder puts a commit forward and every other seat stands behind it, which is how a
    ///      full pod is locked and graded at once
    function approveEverySeat(uint256 seed, uint8 commitSeed) external {
        uint256 id = _job(seed);
        this.putForward(seed, commitSeed);
        this.approveSomeSeats(seed, type(uint16).max);
        _note(jobs.locked(id), "locked");
    }

    /// @dev a job walked from open to locked in one step, so the fuzzer reaches the verdicts often
    function fillAndLock(uint256 seed) external {
        uint256 id = _job(seed);
        PodJobsV3.State state = _stateOf(id);
        if (state != PodJobsV3.State.Open && state != PodJobsV3.State.Working) return;
        for (uint8 r; r < ROLES; r++) {
            PodJobsV3.Role role = PodJobsV3.Role(r);
            for (uint256 a; a < agents.length && jobs.seatCount(id, role) == 0; a++) {
                if (jobs.holdsSeat(id, agents[a])) continue;
                uint256 deposit = jobs.seatDeposit(id, role);
                vm.prank(agents[a]);
                try jobs.takeSeat{ value: deposit }(id, role, agents[a]) {} catch {}
            }
        }
        this.approveEverySeat(seed, 0);
    }

    function report(uint256 seed, uint8 verdictSeed, bytes32 receipt) external {
        uint256 id = _lockedJob(seed);
        PodJobsV3.Verdict verdict = PodJobsV3.Verdict(1 + (verdictSeed % 3));
        bytes32 commit = _commitOf(id); // read before the prank, which the read would spend
        bool isBehindItAsOne = jobs.policyMet(id, commit); // read before the prank, as the commit is
        vm.prank(validator);
        try jobs.report(id, commit, verdict, receipt) {
            if (!isBehindItAsOne) reached["reported with a seat silent"]++;
            reached[verdict == PodJobsV3.Verdict.Passed ? bytes32("passed") : verdict == PodJobsV3.Verdict.VisibleFailed ? bytes32("visible failed") : bytes32("hidden failed")]++;
        } catch {}
    }

    function accept(uint256 seed) external {
        uint256 id = _deliveredJob(seed);
        vm.prank(_posterOf(id));
        try jobs.accept(id) { reached["accepted"]++; } catch {}
    }

    function refuse(uint256 seed) external {
        uint256 id = _deliveredJob(seed);
        vm.prank(_posterOf(id));
        try jobs.refuse(id) { reached["refused"]++; } catch {}
    }

    function settleUnanswered(uint256 seed) external {
        uint256 id = _deliveredJob(seed);
        vm.prank(sink);
        try jobs.settleUnanswered(id) { reached["settled unanswered"]++; } catch {}
    }

    /// @dev somebody who is not the poster tries to answer for them, which never works
    function answerAsAStranger(uint256 seed, bool isYes) external {
        uint256 id = _deliveredJob(seed);
        vm.prank(sink);
        if (isYes) { try jobs.accept(id) { reached["a stranger answered"]++; } catch {} }
        else { try jobs.refuse(id) { reached["a stranger answered"]++; } catch {} }
    }

    function releaseLock(uint256 seed) external {
        uint256 id = _lockedJob(seed); // looked up before the prank, which its reads would spend
        vm.prank(validator);
        try jobs.releaseLock(id) { reached["release lock"]++; } catch {}
    }

    function close(uint256 seed) external {
        vm.prank(sink);
        try jobs.close(_job(seed)) { reached["close"]++; } catch {}
    }

    function passTime(uint256 seconds_) external {
        vm.warp(block.timestamp + bound(seconds_, 1 minutes, 2 days));
    }

    function withdraw(uint256 payeeSeed) external {
        address[] memory everyone = this.payees();
        address payee = everyone[payeeSeed % everyone.length];
        vm.prank(payee);
        try jobs.withdraw(sink) { reached["withdraw"]++; } catch {}
    }
}

contract PodJobsV3InvariantTest is PodJobsV3Fixture {
    PodJobsV3Handler handler;

    function setUp() public override {
        super.setUp();
        handler = new PodJobsV3Handler(jobs, validator, writer, writerKey);
        targetContract(address(handler));
        // only what somebody can do, not the handler's own bookkeeping
        bytes4[] memory actions = new bytes4[](31);
        actions[0] = PodJobsV3Handler.post.selector;
        actions[1] = PodJobsV3Handler.topUp.selector;
        actions[2] = PodJobsV3Handler.reserveWriting.selector;
        actions[3] = PodJobsV3Handler.keepWriting.selector;
        actions[4] = PodJobsV3Handler.releaseWriting.selector;
        actions[5] = PodJobsV3Handler.approveChecks.selector;
        actions[6] = PodJobsV3Handler.takeBack.selector;
        actions[7] = PodJobsV3Handler.takeSeat.selector;
        actions[8] = PodJobsV3Handler.approveEverySeat.selector;
        actions[9] = PodJobsV3Handler.fillAndLock.selector;
        actions[10] = PodJobsV3Handler.fillAndLock.selector;
        actions[11] = PodJobsV3Handler.report.selector;
        actions[12] = PodJobsV3Handler.report.selector;
        actions[13] = PodJobsV3Handler.releaseLock.selector;
        actions[14] = PodJobsV3Handler.close.selector;
        actions[15] = PodJobsV3Handler.passTime.selector;
        actions[16] = PodJobsV3Handler.withdraw.selector;
        actions[17] = PodJobsV3Handler.accept.selector;
        actions[18] = PodJobsV3Handler.refuse.selector;
        actions[19] = PodJobsV3Handler.refuse.selector;
        actions[20] = PodJobsV3Handler.settleUnanswered.selector;
        actions[21] = PodJobsV3Handler.settleUnanswered.selector;
        actions[22] = PodJobsV3Handler.answerAsAStranger.selector;
        actions[23] = PodJobsV3Handler.takeSeat.selector;
        actions[24] = PodJobsV3Handler.takeSeat.selector;
        actions[25] = PodJobsV3Handler.putForward.selector;
        actions[26] = PodJobsV3Handler.putForward.selector;
        actions[27] = PodJobsV3Handler.approveSomeSeats.selector;
        actions[28] = PodJobsV3Handler.approveSomeSeats.selector;
        actions[29] = PodJobsV3Handler.putForwardAsSomebodyElse.selector;
        actions[30] = PodJobsV3Handler.report.selector;
        targetSelector(FuzzSelector({ addr: address(handler), selectors: actions }));
    }

    /// @notice the steps the random runs take do land: walked once in order, each ending is reached,
    ///         so a run that reached nothing could not pass for one that tried everything
    function test_theStepsLand_eachEndingIsReached() public {
        for (uint256 i; i < 4; i++) {
            handler.post(0, 5 ether, 1, 1 days);
            handler.reserveWriting(i);
            handler.keepWriting(i);
            handler.approveChecks(i, bytes32(0));
            handler.fillAndLock(i);
        }
        handler.report(0, 0, keccak256("a receipt"));
        handler.accept(0);
        handler.report(1, 0, keccak256("a receipt"));
        handler.refuse(1);
        handler.report(2, 1, keccak256("a receipt"));
        handler.answerAsAStranger(2, true);
        handler.answerAsAStranger(2, false);
        // time passes two days at most in one step, and a poster has three to answer
        handler.passTime(2 days);
        handler.passTime(2 days);
        handler.settleUnanswered(2);
        handler.close(3);

        assertEq(handler.reached("open"), 4);
        assertEq(handler.reached("locked"), 4);
        assertEq(handler.reached("passed"), 2);
        assertEq(handler.reached("hidden failed"), 1);
        assertEq(handler.reached("accepted"), 1);
        assertEq(handler.reached("refused"), 1);
        assertEq(handler.reached("settled unanswered"), 1);
        assertEq(handler.reached("close"), 1);
        assertEq(handler.reached("a stranger answered"), 0);
        _assertConserved();

        // one agent in two seats of a job, the second under an owner it made up
        handler.post(0, 5 ether, 1, 1 days);
        handler.reserveWriting(4);
        handler.keepWriting(4);
        handler.approveChecks(4, bytes32(0));
        handler.takeSeat(4, 0, 6, 1);
        handler.takeSeat(4, 3, 6, 3);
        assertEq(handler.reached("seat under a made-up owner"), 1);

        // on that job a builder puts work forward, only the lead stands behind it, and it is graded
        // all the same once its review has run out
        handler.takeSeat(4, 1, 0, 1);
        handler.putForwardAsSomebodyElse(4, 6, 0);
        handler.putForward(4, 0);
        handler.approveSomeSeats(4, 1);
        handler.report(4, 0, keccak256("a receipt"));
        assertEq(handler.reached("reported with a seat silent"), 0, "not while its review runs");
        // a quarter of its day is its review
        handler.passTime(7 hours);
        handler.report(4, 0, keccak256("a receipt"));
        handler.accept(4);
        assertEq(handler.reached("put forward"), 5);
        assertEq(handler.reached("another seat named the work"), 0);
        assertEq(handler.reached("reported with a seat silent"), 1);
        assertEq(handler.reached("accepted"), 2);
        _assertConserved();
    }

    /// @notice after any sequence of anything anybody may do, the contract holds exactly what it owes
    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 300
    function invariant_theContractHoldsExactlyWhatItStillOwes() public view {
        _assertConserved();
    }

    /// @notice what payments could not deliver adds up to what the contract says is owed
    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 300
    function invariant_whatIsOwedAddsUp() public view {
        address[] memory everyone = handler.payees();
        uint256 sum;
        for (uint256 i; i < everyone.length; i++) sum += jobs.owed(everyone[i]);
        assertEq(sum, jobs.totalOwed());
    }

    /// @notice nobody but a job's poster ever answers for it, and no poster's jobs end more often than they posted
    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 300
    function invariant_onlyPostersAnswer_andNoMoreOftenThanTheyPosted() public view {
        assertEq(handler.reached("a stranger answered"), 0);
        for (uint256 i; i < 3; i++) {
            (uint32 posted, uint32 accepted, uint32 refusedPassed, uint32 refusedFailed, uint32 unanswered) = jobs.posters(handler.posters(i));
            assertLe(uint256(accepted) + refusedPassed + refusedFailed + unanswered, posted);
        }
    }

    /// @dev whether an agent stood behind a job's work from any seat: put it forward, or said yes to it
    function _stoodBehind(uint256 id, address agent) internal view returns (bool) {
        for (uint8 r; r < ROLES; r++) {
            uint256 count = jobs.seatCount(id, PodJobsV3.Role(r));
            for (uint256 i; i < count; i++) {
                PodJobsV3.Seat memory seat = jobs.seatAt(id, PodJobsV3.Role(r), i);
                if (seat.agent == agent && seat.approved) return true;
            }
        }
        return false;
    }

    /// @dev whether a closed job's work ever reached grading inside its window, from what anybody can read
    function _reachedGrading(uint256 id) internal view returns (bool) {
        (, , , uint64 endsAt, , bytes32 commit, , ) = jobs.jobs(id);
        if (jobs.wasLocked(id)) return true;
        return commit != bytes32(0) && (jobs.reviewBy(id) < endsAt || jobs.policyMet(id, commit));
    }

    /// @notice an agent's record is exactly the jobs it stood behind that ended, one for each however
    ///         many seats it stood behind them from, and one for each job it was the builder of that
    ///         closed with no work of its ever reaching grading. A seat that said nothing is never counted
    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 300
    function invariant_anAgentsRecordIsExactlyTheJobsItStoodBehindThatEnded() public view {
        for (uint256 a; a < 7; a++) {
            address agent = handler.agents(a);
            (uint32 accepted, uint32 paidUnanswered, uint32 refusedPassed, uint32 failed, uint32 undelivered) = jobs.agents(agent);
            uint256 answered;
            uint256 neverPutForward;
            for (uint256 id = FIRST_JOB; id < jobs.nextJobId(); id++) {
                if (jobs.answers(id) != PodJobsV3.Answer.None) {
                    if (_stoodBehind(id, agent)) answered++;
                    continue;
                }
                bool isItsBuilder = jobs.seatCount(id, PodJobsV3.Role.Builder) != 0 && jobs.seatAt(id, PodJobsV3.Role.Builder, 0).agent == agent;
                if (isItsBuilder && _state(id) == PodJobsV3.State.Refunded && !_reachedGrading(id)) neverPutForward++;
            }
            assertEq(uint256(accepted) + paidUnanswered + refusedPassed + failed, answered, "once for each answered job it stood behind");
            assertEq(undelivered, neverPutForward, "once for each job it was to build that closed with nothing graded");
        }
    }

    /// @notice while a job is worked on, what is put forward and who stands behind it always fit: a
    ///         review is set exactly when a commit is put forward, whose builder then stands behind
    ///         it; and a seat stands behind something only while a commit is put forward, or one the
    ///         validator let go of is still waiting to be put forward again. And nobody but a builder
    ///         ever named a commit
    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 300
    function invariant_whatIsPutForwardIsItsBuildersAndNobodyStandsBehindNothing() public view {
        assertEq(handler.reached("another seat named the work"), 0);
        for (uint256 id = FIRST_JOB; id < jobs.nextJobId(); id++) {
            if (_state(id) != PodJobsV3.State.Working) continue;
            (, , , , , bytes32 commit, , ) = jobs.jobs(id);
            bool isPutForward = commit != bytes32(0);
            bool isLetGoOf = jobs.released(id) != bytes32(0);
            assertEq(jobs.reviewBy(id) != 0, isPutForward);
            assertFalse(isPutForward && isLetGoOf, "what was let go of is forgotten once anything is put forward");
            for (uint8 r; r < ROLES; r++) {
                uint256 count = jobs.seatCount(id, PodJobsV3.Role(r));
                for (uint256 i; i < count; i++) {
                    bool isBehind = jobs.seatAt(id, PodJobsV3.Role(r), i).approved;
                    if (PodJobsV3.Role(r) == PodJobsV3.Role.Builder) assertEq(isBehind, isPutForward || isLetGoOf);
                    else if (isBehind) assertTrue(isPutForward || isLetGoOf);
                }
            }
        }
    }

    /// @notice a poster's record is exactly the jobs of theirs that were delivered and have ended
    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 300
    function invariant_aPostersRecordIsExactlyTheirJobsThatWereAnswered() public view {
        for (uint256 p; p < 3; p++) {
            address poster_ = handler.posters(p);
            (uint32 posted, uint32 accepted, uint32 refusedPassed, uint32 refusedFailed, uint32 unanswered) = jobs.posters(poster_);
            uint256 theirs;
            uint256 answered;
            for (uint256 id = FIRST_JOB; id < jobs.nextJobId(); id++) {
                (address by, , , , , , , ) = jobs.jobs(id);
                if (by != poster_) continue;
                theirs++;
                if (jobs.answers(id) != PodJobsV3.Answer.None) answered++;
            }
            assertEq(posted, theirs);
            assertEq(uint256(accepted) + refusedPassed + refusedFailed + unanswered, answered);
        }
    }

    /// @notice a delivered job has a time to answer, and no other job has one
    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 300
    function invariant_onlyADeliveredJobHasBeenGivenATimeToAnswer() public view {
        for (uint256 id = FIRST_JOB; id < jobs.nextJobId(); id++) {
            PodJobsV3.State state = _state(id);
            if (state == PodJobsV3.State.Preparing || state == PodJobsV3.State.Open || state == PodJobsV3.State.Working) assertEq(jobs.answerBy(id), 0);
            if (state == PodJobsV3.State.Delivered) assertGt(jobs.answerBy(id), 0);
        }
    }
}
