// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { PodJobsV4 } from "../src/PodJobsV4.sol";
import { PodJobsV4Fixture, Refuser, GasBurner } from "./PodJobsV4.t.sol";

/// @dev Everybody who can touch the contract, doing anything they are allowed to in any order. Some
///      of them refuse payment or burn the gas they are sent. A step that is not allowed at that
///      moment is refused by the contract and changes nothing, which is itself part of what is tested.
/// @dev how many roles a job has seats for
uint8 constant ROLES = 5;

contract PodJobsV4Handler is Test {
    PodJobsV4 immutable jobs;
    address immutable validator;
    address immutable writer;
    uint256 immutable writerKey;

    address[] public posters;
    address[] public agents;
    uint256[] public ids;
    address public sink;

    /// @notice how often each ending was reached, so the run can show it went everywhere
    mapping(bytes32 => uint256) public reached;

    constructor(PodJobsV4 jobs_, address validator_, address writer_, uint256 writerKey_) {
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
            if (_stateOf(id) == PodJobsV4.State.Delivered) return id;
        }
        return _job(seed);
    }

    /// @dev a locked job still in its window, looking from the seed onwards, since a report only
    ///      lands on one
    function _lockedJob(uint256 seed) internal view returns (uint256) {
        for (uint256 i; i < ids.length; i++) {
            uint256 id = ids[(seed + i) % ids.length];
            (, , , uint64 endsAt, PodJobsV4.State state, , , ) = jobs.jobs(id);
            if (state == PodJobsV4.State.Working && block.timestamp < endsAt && jobs.locked(id)) return id;
        }
        return _job(seed);
    }

    function _posterOf(uint256 id) internal view returns (address poster) {
        (poster, , , , , , , ) = jobs.jobs(id);
    }

    function _stateOf(uint256 id) internal view returns (PodJobsV4.State state) {
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
        PodJobsV4.Role role = PodJobsV4.Role(roleSeed % 5);
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
        if (jobs.seatCount(id, PodJobsV4.Role.Builder) == 0) return;
        address builder = jobs.seatAt(id, PodJobsV4.Role.Builder, 0).agent;
        vm.prank(builder);
        try jobs.putForward(id, keccak256(abi.encode(commitSeed % 3))) { reached["put forward"]++; } catch {}
    }

    /// @dev somebody who is not the job's builder tries to name what is graded, which never works
    function putForwardAsSomebodyElse(uint256 seed, uint256 agentSeed, uint8 commitSeed) external {
        uint256 id = _job(seed);
        address agent = agents[agentSeed % agents.length];
        if (jobs.seatCount(id, PodJobsV4.Role.Builder) != 0 && jobs.seatAt(id, PodJobsV4.Role.Builder, 0).agent == agent) agent = sink;
        vm.prank(agent);
        try jobs.putForward(id, keccak256(abi.encode(commitSeed % 3))) { reached["another seat named the work"]++; } catch {}
    }

    /// @dev every reviewer, QA and security seat behind the commit put forward, as the bits a lead names them by
    function _behind(uint256 id) internal view returns (uint256 mask) {
        for (uint8 r = uint8(PodJobsV4.Role.Reviewer); r < ROLES; r++) {
            uint256 count = jobs.seatCount(id, PodJobsV4.Role(r));
            for (uint256 i; i < count; i++) {
                if (jobs.seatAt(id, PodJobsV4.Role(r), i).approved) mask |= jobs.seatBit(PodJobsV4.Role(r), i);
            }
        }
    }

    /// @dev Some of the other seats stand behind what is put forward and some say nothing, chosen by
    ///      the bits of a mask, so that every mix of voices and silences comes up. The seats are
    ///      numbered lead first, as they are paid; the lead, when its bit is set, speaks after the
    ///      rest, as it has to, and names the seats behind the work that `named` picks.
    function approveSomeSeats(uint256 seed, uint16 mask, uint256 named) external {
        uint256 id = _job(seed);
        bytes32 commit = _commitOf(id);
        uint256 nth = jobs.seatCount(id, PodJobsV4.Role.Lead);
        for (uint8 r = uint8(PodJobsV4.Role.Builder); r < ROLES; r++) {
            uint256 count = jobs.seatCount(id, PodJobsV4.Role(r));
            for (uint256 i; i < count; i++) {
                if ((mask >> (nth++ % 16)) & 1 == 0) continue;
                vm.prank(jobs.seatAt(id, PodJobsV4.Role(r), i).agent);
                try jobs.approve(id, PodJobsV4.Role(r), commit, keccak256(abi.encode("an account", id, r, i, mask))) { reached["approved"]++; } catch {}
            }
        }
        if (mask & 1 == 1) this.conclude(seed, named, true);
    }

    /// @dev a seat says yes with nothing to show for it, or as the lead's, neither of which ever lands
    function approveWithNoAccountOrAsTheLead(uint256 seed, uint8 roleSeed, uint256 indexSeed, bool isAsTheLead) external {
        uint256 id = _job(seed);
        PodJobsV4.Role role = isAsTheLead ? PodJobsV4.Role.Lead : PodJobsV4.Role(2 + roleSeed % 3);
        uint256 count = jobs.seatCount(id, role);
        if (count == 0) return;
        bytes32 commit = _commitOf(id);
        vm.prank(jobs.seatAt(id, role, indexSeed % count).agent);
        try jobs.approve(id, role, commit, isAsTheLead ? keccak256("an account") : bytes32(0)) { reached["a yes that must not land did"]++; } catch {}
    }

    /// @dev The lead concludes the review, whenever it is let: naming a part of the seats behind the
    ///      work, or, when not asked to be exact, whatever bits the run made up, which lands only
    ///      when they happen to name seats behind it.
    function conclude(uint256 seed, uint256 named, bool isExact) external {
        uint256 id = _job(seed);
        if (jobs.seatCount(id, PodJobsV4.Role.Lead) == 0) return;
        bytes32 commit = _commitOf(id);
        uint256 behind = _behind(id);
        if (isExact) named &= behind;
        address lead = jobs.seatAt(id, PodJobsV4.Role.Lead, 0).agent;
        vm.prank(lead);
        try jobs.conclude(id, commit, named, keccak256(abi.encode("its reasons", id, named))) {
            reached["concluded"]++;
            if (named != behind) reached["concluded naming fewer"]++;
            if (named & ~behind != 0) reached["named a seat not behind the work"]++;
        } catch {}
    }

    /// @dev The lead concludes while keeping one seat from the pay: it names every seat behind the
    ///      work but the first. Its own action because a random mask almost always names them all or
    ///      names nobody, and the money a cut moves is the thing these invariants are here to watch.
    function concludeKeepingPayFromOne(uint256 seed) external {
        uint256 id = _job(seed);
        if (jobs.seatCount(id, PodJobsV4.Role.Lead) == 0) return;
        uint256 behind = _behind(id);
        if (behind == 0) return;
        address lead = jobs.seatAt(id, PodJobsV4.Role.Lead, 0).agent;
        vm.prank(lead);
        // every bit but the lowest: the seat that bit stands for is behind the work and goes unpaid
        try jobs.conclude(id, _commitOf(id), behind & (behind - 1), keccak256(abi.encode("one seat kept", id))) {
            reached["concluded"]++;
            reached["concluded naming fewer"]++;
        } catch {}
    }

    /// @dev somebody who is not the job's lead tries to conclude its review, which never works
    function concludeAsSomebodyElse(uint256 seed, uint256 agentSeed, uint256 named) external {
        uint256 id = _job(seed);
        address agent = agents[agentSeed % agents.length];
        if (jobs.seatCount(id, PodJobsV4.Role.Lead) != 0 && jobs.seatAt(id, PodJobsV4.Role.Lead, 0).agent == agent) agent = sink;
        bytes32 commit = _commitOf(id);
        named &= _behind(id);
        vm.prank(agent);
        try jobs.conclude(id, commit, named, keccak256("its reasons")) { reached["another seat concluded"]++; } catch {}
    }

    /// @dev the builder puts a commit forward, every other seat stands behind it and the lead, where
    ///      one sits, concludes, which is how a full pod is locked and graded at once. Half the time
    ///      the lead names them all, and half the time whichever of them the run picks, so that pay
    ///      kept from a seat reaches every ending as often as pay given does.
    function approveEverySeat(uint256 seed, uint8 commitSeed, uint256 named) external {
        uint256 id = _job(seed);
        this.putForward(seed, commitSeed);
        // every seat but the lead's, which is the first bit: it concludes once they have all spoken
        this.approveSomeSeats(seed, type(uint16).max - 1, 0);
        this.conclude(seed, named % 2 == 0 ? type(uint256).max : named, true);
        _note(jobs.locked(id), "locked");
    }

    /// @dev a job walked from open to locked in one step, so the fuzzer reaches the verdicts often
    function fillAndLock(uint256 seed, uint256 named) external {
        uint256 id = _job(seed);
        PodJobsV4.State state = _stateOf(id);
        if (state != PodJobsV4.State.Open && state != PodJobsV4.State.Working) return;
        for (uint8 r; r < ROLES; r++) {
            PodJobsV4.Role role = PodJobsV4.Role(r);
            for (uint256 a; a < agents.length && jobs.seatCount(id, role) == 0; a++) {
                if (jobs.holdsSeat(id, agents[a])) continue;
                uint256 deposit = jobs.seatDeposit(id, role);
                vm.prank(agents[a]);
                try jobs.takeSeat{ value: deposit }(id, role, agents[a]) {} catch {}
            }
        }
        this.approveEverySeat(seed, 0, named);
    }

    function report(uint256 seed, uint8 verdictSeed, bytes32 receipt) external {
        uint256 id = _lockedJob(seed);
        PodJobsV4.Verdict verdict = PodJobsV4.Verdict(1 + (verdictSeed % 3));
        bytes32 commit = _commitOf(id); // read before the prank, which the read would spend
        bool isBehindItAsOne = jobs.policyMet(id, commit); // read before the prank, as the commit is
        vm.prank(validator);
        try jobs.report(id, commit, verdict, receipt) {
            if (!isBehindItAsOne) reached["reported with a seat silent"]++;
            reached[verdict == PodJobsV4.Verdict.Passed ? bytes32("passed") : verdict == PodJobsV4.Verdict.VisibleFailed ? bytes32("visible failed") : bytes32("hidden failed")]++;
        } catch {}
    }

    /// @dev how a delivered job is about to end, for what each seat is then due
    enum Due { Paid, Quarter, Forfeit, Home }

    /// @dev what everybody holds or is owed, agents first and then the job's poster
    function _held(address poster) internal view returns (uint256[] memory held) {
        held = new uint256[](agents.length + 1);
        for (uint256 a; a < agents.length; a++) held[a] = agents[a].balance + jobs.owed(agents[a]);
        held[agents.length] = poster.balance + jobs.owed(poster);
    }

    function _agentIndex(address agent) internal view returns (uint256) {
        for (uint256 a; a < agents.length; a++) if (agents[a] == agent) return a;
        revert("a seat is held by nobody the handler knows");
    }

    /// @dev What a delivered job's ending owes: to each agent and, last, to its poster; and from which
    ///      agents pay is kept, with the lead that kept it, if any was.
    struct Owing {
        uint256[] due;
        uint256[] keptFrom;
        bool isAnyKept;
        address lead;
    }

    /// @dev What each agent and the poster are due when a delivered job ends this way, worked out from
    ///      what anybody can read of it beforehand, by the rule as it is written and not by the
    ///      contract's own sums: a seat not behind the work gets its deposit; one behind it and not
    ///      named by a lead that concluded gets its deposit where the pod is paid, and loses it where
    ///      a check it could see failed; the builder, the lead and the seats named get their pay or
    ///      their quarter. What nobody is due goes to the poster.
    function _owing(uint256 id, Due how) internal returns (Owing memory owing) {
        owing.due = new uint256[](agents.length + 1);
        owing.keptFrom = new uint256[](agents.length);
        (, uint256 toPoster, , , , , , ) = jobs.jobs(id);
        if (jobs.seatCount(id, PodJobsV4.Role.Lead) != 0) owing.lead = jobs.seatAt(id, PodJobsV4.Role.Lead, 0).agent;
        for (uint8 r; r < ROLES; r++) {
            PodJobsV4.Role role = PodJobsV4.Role(r);
            uint256 count = jobs.seatCount(id, role);
            for (uint256 i; i < count; i++) {
                PodJobsV4.Seat memory seat = jobs.seatAt(id, role, i);
                uint256 a = _agentIndex(seat.agent);
                bool isNamed = _isNamed(id, role, i);
                if (seat.approved && jobs.earns(id, role, i) != isNamed) reached["earns is not what is paid"]++;
                if (!seat.approved) { owing.due[a] += seat.deposit; continue; }
                if (how == Due.Forfeit) { toPoster += seat.deposit; continue; }
                owing.due[a] += seat.deposit;
                if (how == Due.Home) continue;
                if (!isNamed) { owing.isAnyKept = true; owing.keptFrom[a]++; continue; }
                uint256 amount = how == Due.Paid ? jobs.seatPay(id, role) : (jobs.seatPay(id, role) * 25) / 100;
                owing.due[a] += amount;
                toPoster -= amount;
            }
        }
        owing.due[agents.length] = toPoster;
    }

    /// @dev whether a seat is one that is paid when the pod is, by the rule: always the builder and the
    ///      lead, every seat where no lead concluded, and otherwise the seats the lead named
    function _isNamed(uint256 id, PodJobsV4.Role role, uint256 index) internal view returns (bool) {
        if (role == PodJobsV4.Role.Lead || role == PodJobsV4.Role.Builder || !jobs.concluded(id)) return true;
        return jobs.earned(id) & jobs.seatBit(role, index) != 0;
    }

    /// @notice what each agent's record of pay kept should be, counted here as the jobs end
    mapping(address => uint256) public expectedWithheld;
    mapping(address => uint256) public expectedWithholdings;

    /// @dev One ending of a job, held to the wei: everybody ends with exactly what the rule gives
    ///      them, paid or kept for them to withdraw. An ending the contract refuses, as a refusal out
    ///      of time or a settlement before it is, moves nothing and counts nothing.
    /// @param which 0 the poster accepts, 1 the poster refuses, 2 somebody settles it unanswered
    function _end(uint256 id, Due how, uint8 which) internal {
        address poster = _posterOf(id);
        bool isDelivered = _stateOf(id) == PodJobsV4.State.Delivered;
        uint256[] memory before = _held(poster);
        Owing memory owing;
        if (isDelivered) owing = _owing(id, how);
        bool landed;
        vm.prank(which == 2 ? sink : poster);
        if (which == 0) { try jobs.accept(id) { landed = true; } catch {} }
        else if (which == 1) { try jobs.refuse(id) { landed = true; } catch {} }
        else { try jobs.settleUnanswered(id) { landed = true; } catch {} }
        if (!landed) return;
        if (!isDelivered) { reached["ended a job not delivered"]++; return; }

        reached[which == 0 ? bytes32("accepted") : which == 1 ? bytes32("refused") : bytes32("settled unanswered")]++;
        uint256[] memory afterwards = _held(poster);
        for (uint256 a; a < afterwards.length; a++) {
            if (afterwards[a] != before[a] + owing.due[a]) reached["an ending paid a wrong amount"]++;
        }
        for (uint256 a; a < agents.length; a++) expectedWithheld[agents[a]] += owing.keptFrom[a];
        if (owing.isAnyKept) {
            expectedWithholdings[owing.lead]++;
            reached["pay was kept from a seat"]++;
        }
    }

    function _verdictOf(uint256 id) internal view returns (PodJobsV4.Verdict verdict) {
        (verdict, ) = jobs.reports(id);
    }

    function accept(uint256 seed) external {
        _end(_deliveredJob(seed), Due.Paid, 0);
    }

    function refuse(uint256 seed) external {
        uint256 id = _deliveredJob(seed);
        PodJobsV4.Verdict verdict = _verdictOf(id);
        _end(id, verdict == PodJobsV4.Verdict.Passed ? Due.Quarter : verdict == PodJobsV4.Verdict.VisibleFailed ? Due.Forfeit : Due.Home, 1);
    }

    function settleUnanswered(uint256 seed) external {
        uint256 id = _deliveredJob(seed);
        PodJobsV4.Verdict verdict = _verdictOf(id);
        _end(id, verdict == PodJobsV4.Verdict.Passed ? Due.Paid : verdict == PodJobsV4.Verdict.VisibleFailed ? Due.Forfeit : Due.Home, 2);
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

contract PodJobsV4InvariantTest is PodJobsV4Fixture {
    PodJobsV4Handler handler;

    function setUp() public override {
        super.setUp();
        handler = new PodJobsV4Handler(jobs, validator, writer, writerKey);
        targetContract(address(handler));
        // only what somebody can do, not the handler's own bookkeeping
        bytes4[] memory actions = new bytes4[](43);
        actions[41] = PodJobsV4Handler.concludeKeepingPayFromOne.selector;
        actions[42] = PodJobsV4Handler.concludeKeepingPayFromOne.selector;
        actions[37] = PodJobsV4Handler.post.selector;
        actions[38] = PodJobsV4Handler.approveChecks.selector;
        actions[39] = PodJobsV4Handler.fillAndLock.selector;
        actions[40] = PodJobsV4Handler.conclude.selector;
        actions[0] = PodJobsV4Handler.post.selector;
        actions[1] = PodJobsV4Handler.topUp.selector;
        actions[2] = PodJobsV4Handler.reserveWriting.selector;
        actions[3] = PodJobsV4Handler.keepWriting.selector;
        actions[4] = PodJobsV4Handler.releaseWriting.selector;
        actions[5] = PodJobsV4Handler.approveChecks.selector;
        actions[6] = PodJobsV4Handler.takeBack.selector;
        actions[7] = PodJobsV4Handler.takeSeat.selector;
        actions[8] = PodJobsV4Handler.approveEverySeat.selector;
        actions[9] = PodJobsV4Handler.fillAndLock.selector;
        actions[10] = PodJobsV4Handler.fillAndLock.selector;
        actions[11] = PodJobsV4Handler.report.selector;
        actions[12] = PodJobsV4Handler.report.selector;
        actions[13] = PodJobsV4Handler.releaseLock.selector;
        actions[14] = PodJobsV4Handler.close.selector;
        actions[15] = PodJobsV4Handler.passTime.selector;
        actions[16] = PodJobsV4Handler.withdraw.selector;
        actions[17] = PodJobsV4Handler.accept.selector;
        actions[18] = PodJobsV4Handler.refuse.selector;
        actions[19] = PodJobsV4Handler.refuse.selector;
        actions[20] = PodJobsV4Handler.settleUnanswered.selector;
        actions[21] = PodJobsV4Handler.settleUnanswered.selector;
        actions[22] = PodJobsV4Handler.answerAsAStranger.selector;
        actions[23] = PodJobsV4Handler.takeSeat.selector;
        actions[24] = PodJobsV4Handler.takeSeat.selector;
        actions[25] = PodJobsV4Handler.putForward.selector;
        actions[26] = PodJobsV4Handler.putForward.selector;
        actions[27] = PodJobsV4Handler.approveSomeSeats.selector;
        actions[28] = PodJobsV4Handler.approveSomeSeats.selector;
        actions[29] = PodJobsV4Handler.putForwardAsSomebodyElse.selector;
        actions[30] = PodJobsV4Handler.report.selector;
        actions[31] = PodJobsV4Handler.conclude.selector;
        actions[32] = PodJobsV4Handler.conclude.selector;
        actions[33] = PodJobsV4Handler.concludeAsSomebodyElse.selector;
        actions[34] = PodJobsV4Handler.approveSomeSeats.selector;
        actions[35] = PodJobsV4Handler.accept.selector;
        actions[36] = PodJobsV4Handler.approveWithNoAccountOrAsTheLead.selector;
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
            handler.fillAndLock(i, 0);
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

        // on that job a builder puts work forward, and its lead, which also holds the QA seat and says
        // nothing from it, tries to conclude at once: not before half the review has gone
        handler.takeSeat(4, 1, 0, 1);
        handler.putForwardAsSomebodyElse(4, 6, 0);
        handler.putForward(4, 0);
        handler.approveSomeSeats(4, 1, 0);
        handler.concludeAsSomebodyElse(4, 0, 0);
        assertEq(handler.reached("concluded"), 4, "the four pods walked above, and not this one yet");
        handler.report(4, 0, keccak256("a receipt"));
        assertEq(handler.reached("reported with a seat silent"), 0, "not while its review runs");
        // nobody concludes, and it is graded all the same once its review has run out: a quarter of its day
        handler.passTime(7 hours);
        handler.conclude(4, 0, true);
        assertEq(handler.reached("concluded"), 4, "nor once the review is over");
        handler.report(4, 0, keccak256("a receipt"));
        handler.accept(4);
        assertEq(handler.reached("put forward"), 5);
        assertEq(handler.reached("another seat named the work"), 0);
        assertEq(handler.reached("another seat concluded"), 0);
        assertEq(handler.reached("reported with a seat silent"), 1);
        assertEq(handler.reached("accepted"), 2);
        assertEq(handler.reached("pay was kept from a seat"), 0, "every lead so far named every seat behind the work, or said nothing");
        _assertConserved();

        // a full pod whose lead names nobody: its pay is kept from every seat that said yes, twice
        // over, once where the poster accepts and once where they refuse what passed
        for (uint256 i = 5; i < 7; i++) {
            handler.post(1, 5 ether, 1, 1 days);
            handler.reserveWriting(i);
            handler.keepWriting(i);
            handler.approveChecks(i, bytes32(0));
            for (uint8 r; r < ROLES; r++) handler.takeSeat(i, r, r, 1);
            handler.putForward(i, 0);
            // every seat but the lead's, which is the first bit
            handler.approveSomeSeats(i, type(uint16).max - 1, 0);
            handler.approveWithNoAccountOrAsTheLead(i, 0, 0, false);
            handler.approveWithNoAccountOrAsTheLead(i, 0, 0, true);
            handler.conclude(i, 0, true);
            handler.report(i, 0, keccak256("a receipt"));
        }
        handler.accept(5);
        handler.refuse(6);
        assertEq(handler.reached("concluded"), 6);
        assertEq(handler.reached("concluded naming fewer"), 2);
        assertEq(handler.reached("pay was kept from a seat"), 2);
        assertEq(handler.reached("a yes that must not land did"), 0);
        assertEq(handler.reached("an ending paid a wrong amount"), 0);
        for (uint256 a = 2; a < 5; a++) {
            (uint32 withheld, ) = jobs.cuts(handler.agents(a));
            assertEq(withheld, 2, "the reviewer, QA and security, on both jobs");
        }
        (, uint32 withholdings) = jobs.cuts(handler.agents(0));
        assertEq(withholdings, 2, "and the lead that kept it, once a job");
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
            uint256 count = jobs.seatCount(id, PodJobsV4.Role(r));
            for (uint256 i; i < count; i++) {
                PodJobsV4.Seat memory seat = jobs.seatAt(id, PodJobsV4.Role(r), i);
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
                if (jobs.answers(id) != PodJobsV4.Answer.None) {
                    if (_stoodBehind(id, agent)) answered++;
                    continue;
                }
                bool isItsBuilder = jobs.seatCount(id, PodJobsV4.Role.Builder) != 0 && jobs.seatAt(id, PodJobsV4.Role.Builder, 0).agent == agent;
                if (isItsBuilder && _state(id) == PodJobsV4.State.Refunded && !_reachedGrading(id)) neverPutForward++;
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
            if (_state(id) != PodJobsV4.State.Working) continue;
            (, , , , , bytes32 commit, , ) = jobs.jobs(id);
            bool isPutForward = commit != bytes32(0);
            bool isLetGoOf = jobs.released(id) != bytes32(0);
            assertEq(jobs.reviewBy(id) != 0, isPutForward);
            assertFalse(isPutForward && isLetGoOf, "what was let go of is forgotten once anything is put forward");
            for (uint8 r; r < ROLES; r++) {
                uint256 count = jobs.seatCount(id, PodJobsV4.Role(r));
                for (uint256 i; i < count; i++) {
                    bool isBehind = jobs.seatAt(id, PodJobsV4.Role(r), i).approved;
                    if (PodJobsV4.Role(r) == PodJobsV4.Role.Builder) assertEq(isBehind, isPutForward || isLetGoOf);
                    else if (isBehind) assertTrue(isPutForward || isLetGoOf);
                }
            }
        }
    }

    /// @notice Every ending of every delivered job paid everybody exactly what the rule gives them,
    ///         worked out beforehand from what anybody can read: no seat that is not behind the
    ///         work is ever paid more than its deposit; nor is a seat behind it that its lead did
    ///         not name; and the lead is paid its own share and never one wei of what it kept from
    ///         another seat, which goes to the poster. What the contract says a seat earns is what
    ///         it is paid. And nobody but a job's lead ever concluded its review, a yes never landed
    ///         without an account, and no seat was ever named that was not behind the work.
    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 300
    /// @dev These are counters of what went wrong, so they are zero on a campaign that went nowhere
    ///      as surely as on one where everything held. Random sequences reach a conclusion, and an
    ///      ending with pay kept from a seat, in some campaigns and not others, which is why what
    ///      proves those paths are reached is the walk in order below, and not these.
    function invariant_everyEndingPaysExactlyWhoEarnedIt_andWhatIsKeptGoesToThePoster() public view {
        assertEq(handler.reached("an ending paid a wrong amount"), 0);
        assertEq(handler.reached("earns is not what is paid"), 0);
        assertEq(handler.reached("ended a job not delivered"), 0);
        assertEq(handler.reached("another seat concluded"), 0);
        assertEq(handler.reached("a yes that must not land did"), 0);
        assertEq(handler.reached("named a seat not behind the work"), 0);
    }

    /// @notice An agent's record of pay kept is exactly the seats it stood behind work from and was
    ///         kept from the pay of, on jobs where the pod was paid something; and a lead's is
    ///         exactly the jobs on which it kept pay from at least one seat. Read back from what the
    ///         contract still says of every job that has ended, and held against what was counted
    ///         as each one ended.
    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 300
    function invariant_payKeptIsCountedOnceASeatAndOnceAJob_whereThePodWasPaid() public view {
        for (uint256 a; a < 7; a++) {
            address agent = handler.agents(a);
            uint256 withheld;
            uint256 withholdings;
            for (uint256 id = FIRST_JOB; id < jobs.nextJobId(); id++) {
                if (!_wasPaidSomething(id) || !jobs.concluded(id)) continue;
                uint256 keptOnThisJob;
                for (uint8 r = uint8(PodJobsV4.Role.Reviewer); r < ROLES; r++) {
                    uint256 count = jobs.seatCount(id, PodJobsV4.Role(r));
                    for (uint256 i; i < count; i++) {
                        PodJobsV4.Seat memory seat = jobs.seatAt(id, PodJobsV4.Role(r), i);
                        if (!seat.approved || jobs.earned(id) & jobs.seatBit(PodJobsV4.Role(r), i) != 0) continue;
                        keptOnThisJob++;
                        if (seat.agent == agent) withheld++;
                    }
                }
                if (keptOnThisJob != 0 && jobs.seatAt(id, PodJobsV4.Role.Lead, 0).agent == agent) withholdings++;
            }
            (uint32 saidWithheld, uint32 saidWithholdings) = jobs.cuts(agent);
            assertEq(saidWithheld, withheld, "once for each seat it was kept from the pay of");
            assertEq(saidWithholdings, withholdings, "once for each job it kept pay on");
            assertEq(saidWithheld, handler.expectedWithheld(agent));
            assertEq(saidWithholdings, handler.expectedWithholdings(agent));
        }
    }

    /// @dev whether a job ended with its pod paid something: accepted, unanswered after a pass, or
    ///      refused though its checks passed
    function _wasPaidSomething(uint256 id) internal view returns (bool) {
        PodJobsV4.Answer answer = jobs.answers(id);
        if (answer == PodJobsV4.Answer.Accepted) return true;
        (PodJobsV4.Verdict verdict, ) = jobs.reports(id);
        return answer != PodJobsV4.Answer.None && verdict == PodJobsV4.Verdict.Passed;
    }

    /// @notice While a job is worked on, the lead's word and the accounts always fit what stands: a
    ///         review is concluded only by a lead that sits and stands behind the work, which a lead
    ///         does by concluding and by nothing else; only seats behind the work are named, never
    ///         the builder's or the lead's own; every yes still standing has its account bound; and
    ///         a job is agreed to be graded at once exactly when its lead concluded, or, with no
    ///         lead, when every seat taken is behind it.
    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 300
    function invariant_theLeadsWordAndTheAccountsFitWhatStands() public view {
        for (uint256 id = FIRST_JOB; id < jobs.nextJobId(); id++) {
            if (_state(id) != PodJobsV4.State.Working) continue;
            bool hasLead = jobs.seatCount(id, PodJobsV4.Role.Lead) != 0;
            bool isConcluded = jobs.concluded(id);
            if (!hasLead) assertFalse(isConcluded, "nobody concludes a job no lead sits on");
            else assertEq(jobs.seatAt(id, PodJobsV4.Role.Lead, 0).approved, isConcluded, "the lead stands behind work by concluding, and only so");
            if (!isConcluded) assertEq(jobs.earned(id), 0, "nobody is named where nothing is concluded");

            uint256 behind;
            bool isEverySeatBehind = true;
            for (uint8 r; r < ROLES; r++) {
                PodJobsV4.Role role = PodJobsV4.Role(r);
                uint256 count = jobs.seatCount(id, role);
                for (uint256 i; i < count; i++) {
                    bool isBehind = jobs.seatAt(id, role, i).approved;
                    if (!isBehind) isEverySeatBehind = false;
                    bytes32 account = jobs.accounts(id, r, i);
                    if (role == PodJobsV4.Role.Builder) assertEq(account, bytes32(0), "the builder's account is its commit");
                    else assertEq(account != bytes32(0), isBehind, "a yes that stands has its account, and nothing else has one");
                    if (isBehind && r >= uint8(PodJobsV4.Role.Reviewer)) behind |= jobs.seatBit(role, i);
                }
            }
            assertEq(jobs.earned(id) & ~behind, 0, "only seats behind the work are named");

            (, , , , , bytes32 commit, , ) = jobs.jobs(id);
            if (commit != bytes32(0)) assertEq(jobs.policyMet(id, commit), hasLead ? isConcluded : isEverySeatBehind);
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
                if (jobs.answers(id) != PodJobsV4.Answer.None) answered++;
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
            PodJobsV4.State state = _state(id);
            if (state == PodJobsV4.State.Preparing || state == PodJobsV4.State.Open || state == PodJobsV4.State.Working) assertEq(jobs.answerBy(id), 0);
            if (state == PodJobsV4.State.Delivered) assertGt(jobs.answerBy(id), 0);
        }
    }
}
