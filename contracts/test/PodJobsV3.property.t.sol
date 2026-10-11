// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { PodJobsV3 } from "../src/PodJobsV3.sol";
import { PodJobsV3Fixture, Refuser, GasBurner } from "./PodJobsV3.t.sol";

/// @notice What PodJobsV3 promises, stated as properties and tried against whatever a run makes up,
///         rather than as examples. Both were first written by an outsider reading the contract to
///         break it (10 Oct), and are kept so that the next change is held to the same.
contract PodJobsV3PropertyTest is PodJobsV3Fixture {
    PodJobsV3.Verdict constant PASSED = PodJobsV3.Verdict.Passed;
    PodJobsV3.Verdict constant VISIBLE_FAILED = PodJobsV3.Verdict.VisibleFailed;

    function _endsAt(uint256 id) internal view returns (uint64 endsAt) {
        (, , , endsAt, , , , ) = jobs.jobs(id);
    }

    function _openWith(uint64 window, uint8 reviewers) internal returns (uint256 id) {
        vm.prank(poster);
        id = jobs.post{ value: PRICE + 3 * WRITING }(window, reviewers);
        _write(id);
        _open(id);
    }


    struct Run { uint256 id; uint64 endsAt; bytes32 commit; address[6] foes; }

    function _foeStep(Run memory run, uint256 seed) internal {
        uint256 kind = seed % 12;
        address foe = run.foes[(seed >> 8) % 6];
        PodJobsV3.Role role = PodJobsV3.Role((seed >> 16) % 5);
        if (kind <= 2) {
            address owner = (seed >> 24) % 2 == 0 ? foe : address(uint160(uint256(keccak256(abi.encode(seed)))));
            if ((seed >> 32) % 7 == 0) owner = builderOwner;
            uint256 deposit = jobs.seatDeposit(run.id, role);
            vm.prank(foe);
            try jobs.takeSeat{ value: deposit }(run.id, role, owner) {} catch {}
        } else if (kind <= 5) {
            bytes32 commit = (seed >> 24) % 5 == 0 ? keccak256(abi.encode(seed)) : _commit(run.id);
            // mostly whoever really holds a seat of that role, so that yeses land and the pod can agree
            uint256 count = jobs.seatCount(run.id, role);
            if (count != 0 && (seed >> 40) % 8 != 0) foe = jobs.seatAt(run.id, role, (seed >> 48) % count).agent;
            if (foe == builderAgent) return;
            vm.prank(foe);
            try jobs.approve(run.id, role, commit) {} catch {}
        } else if (kind == 6) {
            vm.prank(foe);
            try jobs.putForward(run.id, keccak256(abi.encode(seed))) { revert("a foe named the work"); } catch {}
        } else if (kind == 7) {
            vm.prank(foe);
            try jobs.close(run.id) { revert("closed inside the window"); } catch {}
            vm.prank(poster);
            try jobs.takeBack(run.id) { revert("taken back while worked on"); } catch {}
        } else if (kind == 8) {
            vm.prank(foe);
            try jobs.releaseLock(run.id) { revert("a foe released"); } catch {}
            vm.prank(poster);
            try jobs.report(run.id, _commit(run.id), VISIBLE_FAILED, RECEIPT) { revert("a foe reported"); } catch {}
        } else if (kind == 9) {
            vm.prank(poster);
            try jobs.accept(run.id) { revert("answered before delivery"); } catch {}
            vm.prank(poster);
            try jobs.refuse(run.id) { revert("answered before delivery"); } catch {}
            try jobs.settleUnanswered(run.id) { revert("settled before delivery"); } catch {}
        } else {
            // time passes, never past the moment the validator will report
            uint256 step = bound(seed >> 24, 1, 6 minutes);
            uint256 latest = uint256(jobs.reviewBy(run.id));
            if (latest == 0) latest = run.endsAt - REVIEW_TIME - 5 minutes;
            if (block.timestamp + step > latest) vm.warp(latest); else vm.warp(block.timestamp + step);
        }
    }

    /// @notice The property this contract's rule exists for, held against anything the other parties
    ///         can do. An honest builder puts real work forward leaving the time for reviewing and
    ///         five minutes; the poster and every other seat, in any number and under any owner, do
    ///         whatever they like before, during and after; the validator reports within those
    ///         minutes, and may first have to let go of the work once. Whatever happens, the work is
    ///         reported on, it is the builder's own commit, and the builder ends with its deposit and
    ///         its pay, or at the very least a quarter of it.
    /// forge-config: default.fuzz.runs = 600
    function testFuzz_whateverThePosterAndTheOtherSeatsDo_workLeftItsReviewIsReportedOn_andItsBuilderIsPaid(
        uint256[24] memory before, uint256[24] memory during, uint8 reviewers, uint8 ending, uint64 slack, bool foesAreContracts, bool isLetGoOnce
    ) public {
        Run memory run;
        run.commit = COMMIT;
        run.id = _openWith(WINDOW, uint8(bound(reviewers, 0, 5)));
        run.endsAt = _endsAt(run.id);
        for (uint256 i; i < 6; i++) {
            run.foes[i] = makeAddr(string.concat("foe", vm.toString(i)));
            vm.deal(run.foes[i], 1000 ether);
        }
        if (foesAreContracts) {
            run.foes[4] = address(new Refuser());
            run.foes[5] = address(new GasBurner());
            vm.deal(run.foes[4], 1000 ether);
            vm.deal(run.foes[5], 1000 ether);
        }
        // the honest builder is seated first, under an owner nobody else can have claimed yet
        _take(run.id, PodJobsV3.Role.Builder, builderAgent, builderOwner);
        uint256 builderStart = builderAgent.balance;
        uint256 deposit = jobs.seatDeposit(run.id, PodJobsV3.Role.Builder);
        uint256 pay = jobs.seatPay(run.id, PodJobsV3.Role.Builder);

        for (uint256 i; i < before.length; i++) _foeStep(run, before[i]);
        assertLe(block.timestamp, run.endsAt - REVIEW_TIME - 5 minutes);
        // it puts its work forward leaving the review time and at least five minutes
        slack = uint64(bound(slack, 0, run.endsAt - REVIEW_TIME - 5 minutes - block.timestamp));
        vm.warp(run.endsAt - REVIEW_TIME - 5 minutes - slack);
        vm.prank(builderAgent);
        jobs.putForward(run.id, run.commit);
        uint64 reviewBy = jobs.reviewBy(run.id);

        for (uint256 i; i < during.length; i++) {
            _foeStep(run, during[i]);
            assertEq(_commit(run.id), run.commit, "nothing else is ever what is graded");
            assertTrue(jobs.seatAt(run.id, PodJobsV3.Role.Builder, 0).approved);
            assertEq(jobs.reviewBy(run.id), reviewBy);
        }
        // the honest validator reports once it is locked, within a few minutes of the review's end
        if (!jobs.locked(run.id)) vm.warp(reviewBy);
        assertTrue(jobs.locked(run.id));
        vm.warp(block.timestamp + bound(slack, 0, 2 minutes));
        if (isLetGoOnce) {
            // the validator could not grade it this time, and lets go of it. The builder puts the same
            // commit forward again, and the foes get a go in between: it has had its review, so it is
            // graded again at once, however little of the window is left
            vm.prank(validator);
            jobs.releaseLock(run.id);
            _foeStep(run, during[1] | 3);
            vm.prank(builderAgent);
            jobs.putForward(run.id, run.commit);
            assertTrue(jobs.locked(run.id), "no second review for a seat that says nothing to run out");
            vm.warp(block.timestamp + bound(slack, 0, 2 minutes));
        }
        // the foes get one more go in front of the report
        _foeStep(run, during[0] | 3);
        vm.prank(validator);
        jobs.report(run.id, run.commit, PASSED, RECEIPT);

        // the poster ends it whichever way is cheapest for them, or says nothing
        uint256 least = deposit + pay;
        if (ending % 3 == 0) { vm.prank(poster); jobs.accept(run.id); }
        else if (ending % 3 == 1) { vm.prank(poster); jobs.refuse(run.id); least = deposit + (pay * 25) / 100; }
        else {
            vm.warp(jobs.answerBy(run.id));
            vm.prank(poster);
            vm.expectRevert(PodJobsV3.TooLate.selector);
            jobs.refuse(run.id);
            jobs.settleUnanswered(run.id);
        }
        assertEq(builderAgent.balance + jobs.owed(builderAgent), builderStart + least, "its deposit home and its pay, or its quarter");
        PodJobsV3.AgentRecord memory record = _agent(builderAgent);
        assertEq(record.failed, 0);
        assertEq(record.undelivered, 0);
        assertEq(_counted(builderAgent), 1);
        _assertConserved();
        // every foe has back exactly what it put in, or more only by pay it earned by saying yes
        assertEq(jobs.totalOwed(), jobs.owed(run.foes[4]) + jobs.owed(run.foes[5]) + jobs.owed(builderAgent) + jobs.owed(poster));
    }

    struct Mix {
        uint256 id;
        address[8] who;
        PodJobsV3.Role[8] roles;
        bool[8] isSeated;
        bool[8] isBehind;
        uint256[8] start;
        uint256 builderBefore;
        uint256 posterBefore;
        uint256 toPoster;
        bool isPaid;
        bool isQuarter;
        bool isForfeit;
    }

    function _after(Mix memory mix, PodJobsV3.Role role, bool isBehind, uint256 start) internal view returns (uint256 expected) {
        uint256 deposit = jobs.seatDeposit(mix.id, role);
        uint256 pay = jobs.seatPay(mix.id, role);
        expected = start;
        if (!isBehind) return expected + deposit;
        if (mix.isPaid) { mix.toPoster -= pay; return expected + deposit + pay; }
        if (mix.isQuarter) { mix.toPoster -= (pay * 25) / 100; return expected + deposit + (pay * 25) / 100; }
        if (mix.isForfeit) { mix.toPoster += deposit; return expected; }
        return expected + deposit;
    }

    /// @notice The money, for every mix of seats taken and seats behind the work, with one to five
    ///         reviewer seats, each verdict and each ending, with and without an earlier commit that
    ///         was replaced or let go of: only a seat behind the work is paid, keeps a quarter, loses
    ///         a deposit or is counted, to the wei, and nothing is left in the contract.
    /// forge-config: default.fuzz.runs = 600
    function testFuzz_onlySeatsBehindTheWorkArePaidKeepAQuarterOrLoseADeposit_inEveryEnding(uint8 reviewers, uint16 seated, uint16 behind, uint8 verdictSeed, uint8 ending, bool agreeFirst) public {
        reviewers = uint8(bound(reviewers, 1, 5));
        Mix memory mix;
        mix.id = _openWith(WINDOW, reviewers);
        _take(mix.id, PodJobsV3.Role.Builder, builderAgent, builderOwner);
        // seats 0..7: lead, 5 reviewers, qa, security
        mix.roles = [PodJobsV3.Role.Lead, PodJobsV3.Role.Reviewer, PodJobsV3.Role.Reviewer, PodJobsV3.Role.Reviewer, PodJobsV3.Role.Reviewer, PodJobsV3.Role.Reviewer, PodJobsV3.Role.QA, PodJobsV3.Role.Security];
        for (uint256 i; i < 8; i++) {
            mix.who[i] = makeAddr(string.concat("seat", vm.toString(i)));
            vm.deal(mix.who[i], 10 ether);
            if ((seated >> i) & 1 == 0) continue;
            if (i >= 1 && i <= 5 && i > reviewers) continue;
            _take(mix.id, mix.roles[i], mix.who[i], mix.who[i]);
            mix.isSeated[i] = true;
        }
        if (agreeFirst) {
            // an earlier commit some stood behind, then replaced or let go: none of that may carry over
            _putForward(mix.id, keccak256("earlier"));
            for (uint256 i; i < 8; i++) if (mix.isSeated[i]) { vm.prank(mix.who[i]); jobs.approve(mix.id, mix.roles[i], keccak256("earlier")); }
            if (jobs.locked(mix.id)) { vm.prank(validator); jobs.releaseLock(mix.id); }
        }
        _putForward(mix.id, COMMIT);
        for (uint256 i; i < 8; i++) {
            if (!mix.isSeated[i] || (behind >> i) & 1 == 0) continue;
            vm.prank(mix.who[i]);
            jobs.approve(mix.id, mix.roles[i], COMMIT);
            mix.isBehind[i] = true;
        }
        if (!jobs.locked(mix.id)) vm.warp(jobs.reviewBy(mix.id));
        PodJobsV3.Verdict verdict = PodJobsV3.Verdict(1 + verdictSeed % 3);
        vm.prank(validator);
        jobs.report(mix.id, COMMIT, verdict, RECEIPT);

        for (uint256 i; i < 8; i++) mix.start[i] = mix.who[i].balance;
        mix.builderBefore = builderAgent.balance;
        mix.posterBefore = poster.balance;
        // 0 accept, 1 refuse, 2 unanswered
        uint8 how = ending % 3;
        if (how == 0) { vm.prank(poster); jobs.accept(mix.id); }
        else if (how == 1) { vm.prank(poster); jobs.refuse(mix.id); }
        else { vm.warp(jobs.answerBy(mix.id)); jobs.settleUnanswered(mix.id); }

        mix.isPaid = how == 0 || (how == 2 && verdict == PASSED);
        mix.isQuarter = how == 1 && verdict == PASSED;
        mix.isForfeit = !mix.isPaid && !mix.isQuarter && verdict == VISIBLE_FAILED;
        mix.toPoster = PRICE;
        for (uint256 i; i < 8; i++) {
            uint256 expected = mix.isSeated[i] ? _after(mix, mix.roles[i], mix.isBehind[i], mix.start[i]) : mix.start[i];
            assertEq(mix.who[i].balance, expected);
            assertEq(_counted(mix.who[i]), mix.isSeated[i] && mix.isBehind[i] ? 1 : 0);
        }
        assertEq(builderAgent.balance, _after(mix, PodJobsV3.Role.Builder, true, mix.builderBefore));
        assertEq(_counted(builderAgent), 1);
        assertEq(poster.balance, mix.posterBefore + mix.toPoster);
        assertEq(address(jobs).balance, 0);
    }
}
