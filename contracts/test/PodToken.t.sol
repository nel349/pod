// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { PodToken, IERC721Receiver } from "../src/PodToken.sol";

/// A wallet that refuses tokens, which is the case a safe transfer exists to catch.
contract Deaf { }

/// A wallet that takes them.
contract Listening is IERC721Receiver {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}

contract PodTokenTest is Test {
    PodToken internal token;

    address internal validator = makeAddr("validator");
    address internal paid = makeAddr("the person who paid");
    address internal buyer = makeAddr("a buyer");
    address internal lead = makeAddr("the lead agent");
    address internal builder = makeAddr("the builder agent");

    bytes32 internal constant SEAL = bytes32(uint256(0xABAB));
    bytes32 internal constant COMMIT = bytes32(uint256(0xC0FFEE));
    bytes32 internal constant RECEIPT = bytes32(uint256(0x4EC317));

    function setUp() public {
        token = new PodToken(validator);
    }

    function _crew() internal view returns (PodToken.Seat[] memory seats) {
        seats = new PodToken.Seat[](2);
        seats[0] = PodToken.Seat({ agent: lead, role: 0 });
        seats[1] = PodToken.Seat({ agent: builder, role: 1 });
    }

    function _mint(uint256 jobId) internal returns (uint256) {
        vm.prank(validator);
        return token.mint(paid, jobId, SEAL, COMMIT, RECEIPT, _crew(), "https://pod.example/job/one");
    }

    function test_theTitleGoesToThePersonWhoPaid() public {
        uint256 id = _mint(1);
        assertEq(token.ownerOf(id), paid);
        assertEq(token.balanceOf(paid), 1);
    }

    function test_itHoldsTheFactsTheVerdictRestedOn() public {
        uint256 id = _mint(1);
        PodToken.Pod memory held = token.pod(id);
        assertEq(held.seal, SEAL);
        assertEq(held.commitHash, COMMIT);
        assertEq(held.receiptHash, RECEIPT);
        assertEq(token.tokenURI(id), "https://pod.example/job/one");
    }

    function test_itNamesTheCrewAndTheSeatEachOneHeld() public {
        uint256 id = _mint(1);
        PodToken.Seat[] memory seats = token.crew(id);
        assertEq(seats.length, 2);
        assertEq(seats[0].agent, lead);
        assertEq(seats[1].role, 1);
    }

    function test_onlyTheValidatorCanMint() public {
        PodToken.Seat[] memory seats = _crew();
        vm.prank(paid);
        vm.expectRevert(PodToken.NotMinter.selector);
        token.mint(paid, 1, SEAL, COMMIT, RECEIPT, seats, "https://pod.example/job/one");
    }

    function test_oneJobMintsOneTitle() public {
        _mint(1);
        PodToken.Seat[] memory seats = _crew();
        vm.prank(validator);
        vm.expectRevert(PodToken.AlreadyMinted.selector);
        token.mint(paid, 1, SEAL, COMMIT, RECEIPT, seats, "https://pod.example/job/one");
    }

    function test_theRepositoryFollowsTheTitle() public {
        uint256 id = _mint(1);
        vm.prank(paid);
        token.transferFrom(paid, buyer, id);
        assertEq(token.ownerOf(id), buyer);
        assertEq(token.balanceOf(paid), 0);
        assertEq(token.balanceOf(buyer), 1);
        // the facts travel with it, unchanged
        assertEq(token.pod(id).commitHash, COMMIT);
    }

    function test_aStrangerCannotMoveSomebodyElsesTitle() public {
        uint256 id = _mint(1);
        vm.prank(buyer);
        vm.expectRevert(PodToken.NotOwnerOrApproved.selector);
        token.transferFrom(paid, buyer, id);
    }

    function test_anApprovedAddressCanMoveIt() public {
        uint256 id = _mint(1);
        vm.prank(paid);
        token.approve(buyer, id);
        vm.prank(buyer);
        token.transferFrom(paid, buyer, id);
        assertEq(token.ownerOf(id), buyer);
    }

    function test_aSafeTransferRefusesAContractThatCannotHoldIt() public {
        uint256 id = _mint(1);
        Deaf deaf = new Deaf();
        vm.prank(paid);
        vm.expectRevert();
        token.safeTransferFrom(paid, address(deaf), id);

        Listening listening = new Listening();
        vm.prank(paid);
        token.safeTransferFrom(paid, address(listening), id);
        assertEq(token.ownerOf(id), address(listening));
    }

    function test_aTokenNobodyMintedHasNothingToSay() public {
        vm.expectRevert(PodToken.NoSuchToken.selector);
        token.pod(99);
        vm.expectRevert(PodToken.NoSuchToken.selector);
        token.ownerOf(99);
    }

    function test_itAnswersTheInterfacesAWalletAsksAbout() public view {
        assertTrue(token.supportsInterface(0x01ffc9a7)); // ERC-165
        assertTrue(token.supportsInterface(0x80ac58cd)); // ERC-721
        assertTrue(token.supportsInterface(0x5b5e139f)); // metadata
        assertFalse(token.supportsInterface(0xdeadbeef));
    }
}
