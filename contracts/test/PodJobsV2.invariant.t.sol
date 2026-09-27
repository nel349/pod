// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { PodJobsV2 } from "../src/PodJobsV2.sol";
import { PodJobsV2Fixture, Refuser, GasBurner } from "./PodJobsV2.t.sol";

/// @dev Everybody who can touch the contract, doing anything they are allowed to in any order. Some
///      of them refuse payment or burn the gas they are sent. A step that is not allowed at that
///      moment is refused by the contract and changes nothing, which is itself part of what is tested.
contract PodJobsV2Handler is Test {
    PodJobsV2 immutable jobs;
    address immutable validator;
    address immutable writer;
    uint256 immutable writerKey;

    address[] public posters;
    address[] public agents;
    uint256[] public ids;
    address public sink;

    /// @notice how often each ending was reached, so the run can show it went everywhere
    mapping(bytes32 => uint256) public reached;

    constructor(PodJobsV2 jobs_, address validator_, address writer_, uint256 writerKey_) {
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

    /// @dev a locked job still in its window, looking from the seed onwards, since a verdict only
    ///      lands on one
    function _lockedJob(uint256 seed) internal view returns (uint256) {
        for (uint256 i; i < ids.length; i++) {
            uint256 id = ids[(seed + i) % ids.length];
            (, , , uint64 endsAt, PodJobsV2.State state, , , ) = jobs.jobs(id);
            if (state == PodJobsV2.State.Working && block.timestamp < endsAt && jobs.locked(id)) return id;
        }
        return _job(seed);
    }

    function _posterOf(uint256 id) internal view returns (address poster) {
        (poster, , , , , , , ) = jobs.jobs(id);
    }

    function _stateOf(uint256 id) internal view returns (PodJobsV2.State state) {
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

    function takeSeat(uint256 seed, uint8 roleSeed, uint256 agentSeed) external {
        uint256 id = _job(seed);
        PodJobsV2.Role role = PodJobsV2.Role(roleSeed % 5);
        address agent = agents[agentSeed % agents.length];
        uint256 deposit = jobs.seatDeposit(id, role);
        vm.prank(agent);
        try jobs.takeSeat{ value: deposit }(id, role, agent) { reached["seat"]++; } catch {}
    }

    /// @dev every seat on a job approves one commit, which is how a job gets locked and graded
    function approveEverySeat(uint256 seed, uint8 commitSeed) external {
        uint256 id = _job(seed);
        bytes32 commit = keccak256(abi.encode(commitSeed % 3));
        for (uint8 r; r < 5; r++) {
            uint256 count = jobs.seatCount(id, PodJobsV2.Role(r));
            for (uint256 i; i < count; i++) {
                vm.prank(jobs.seatAt(id, PodJobsV2.Role(r), i).agent);
                try jobs.approve(id, PodJobsV2.Role(r), commit) {} catch {}
            }
        }
        _note(jobs.locked(id), "locked");
    }

    /// @dev a job walked from open to locked in one step, so the fuzzer reaches the verdicts often
    function fillAndLock(uint256 seed) external {
        uint256 id = _job(seed);
        PodJobsV2.State state = _stateOf(id);
        if (state != PodJobsV2.State.Open && state != PodJobsV2.State.Working) return;
        for (uint8 r; r < 5; r++) {
            PodJobsV2.Role role = PodJobsV2.Role(r);
            for (uint256 a; a < agents.length && jobs.seatCount(id, role) == 0; a++) {
                if (jobs.holdsSeat(id, agents[a])) continue;
                uint256 deposit = jobs.seatDeposit(id, role);
                vm.prank(agents[a]);
                try jobs.takeSeat{ value: deposit }(id, role, agents[a]) {} catch {}
            }
        }
        this.approveEverySeat(seed, 0);
    }

    function settle(uint256 seed, uint8 verdictSeed, bytes32 receipt) external {
        uint256 id = _lockedJob(seed);
        PodJobsV2.Verdict verdict = PodJobsV2.Verdict(1 + (verdictSeed % 3));
        bytes32 commit = _commitOf(id); // read before the prank, which the read would spend
        vm.prank(validator);
        try jobs.settle(id, commit, verdict, receipt) {
            reached[verdict == PodJobsV2.Verdict.Passed ? bytes32("passed") : verdict == PodJobsV2.Verdict.VisibleFailed ? bytes32("visible failed") : bytes32("hidden failed")]++;
        } catch {}
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

contract PodJobsV2InvariantTest is PodJobsV2Fixture {
    PodJobsV2Handler handler;

    function setUp() public override {
        super.setUp();
        handler = new PodJobsV2Handler(jobs, validator, writer, writerKey);
        targetContract(address(handler));
        // only what somebody can do, not the handler's own bookkeeping
        bytes4[] memory actions = new bytes4[](17);
        actions[0] = PodJobsV2Handler.post.selector;
        actions[1] = PodJobsV2Handler.topUp.selector;
        actions[2] = PodJobsV2Handler.reserveWriting.selector;
        actions[3] = PodJobsV2Handler.keepWriting.selector;
        actions[4] = PodJobsV2Handler.releaseWriting.selector;
        actions[5] = PodJobsV2Handler.approveChecks.selector;
        actions[6] = PodJobsV2Handler.takeBack.selector;
        actions[7] = PodJobsV2Handler.takeSeat.selector;
        actions[8] = PodJobsV2Handler.approveEverySeat.selector;
        actions[9] = PodJobsV2Handler.fillAndLock.selector;
        actions[10] = PodJobsV2Handler.fillAndLock.selector;
        actions[11] = PodJobsV2Handler.settle.selector;
        actions[12] = PodJobsV2Handler.settle.selector;
        actions[13] = PodJobsV2Handler.releaseLock.selector;
        actions[14] = PodJobsV2Handler.close.selector;
        actions[15] = PodJobsV2Handler.passTime.selector;
        actions[16] = PodJobsV2Handler.withdraw.selector;
        targetSelector(FuzzSelector({ addr: address(handler), selectors: actions }));
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

}
