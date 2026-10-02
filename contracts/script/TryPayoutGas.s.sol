// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script } from "forge-std/Script.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @notice A wallet as smart wallets are built: its code behind a proxy, so taking a payment costs the
///         proxy's reads of where its code is and the call into it, which Monad prices on its own scale.
contract WalletCode {
    event Received(address indexed from, uint256 amount);

    receive() external payable {
        emit Received(msg.sender, msg.value);
    }
}

/// @notice Pays the way PodJobsV2 pays (its _pay): a call carrying a fixed amount of gas, whose answer is
///         never copied. Here, whether it arrived is only said, not kept for a withdrawal.
contract Payer {
    event Paid(address indexed to, uint256 amount, uint256 gasForPayment, bool delivered);

    function pay(address to, uint256 gasForPayment) external payable {
        bool delivered;
        assembly { delivered := call(gasForPayment, to, callvalue(), 0, 0, 0, 0) }
        emit Paid(to, msg.value, gasForPayment, delivered);
        if (!delivered) payable(msg.sender).transfer(msg.value);
    }
}

/// @notice V4: whether a payment carrying POD_PAYOUT_GAS reaches a proxy wallet on Monad, tried on Monad
///         itself before the contract that prepares jobs is deployed with it. A payment carrying 2,300, a
///         plain transfer's allowance, is tried beside it, and is expected not to arrive.
/// @dev     What the chain did is read from its Paid events after the broadcast: the run before it
///          simulates with Ethereum's prices, not Monad's. Forge sets each transaction's gas from that
///          estimate, which on Monad left a payment less than it was to carry, so broadcast with
///          `--gas-estimate-multiplier 1000`, or send the payments again with `cast send --gas-limit`.
///          Tried on Monad testnet on 1 Oct 2026, through a wallet behind an ERC-1967 proxy: carrying
///          100,000 it arrived, and 25,000 too; carrying 2,300 it did not.
contract TryPayoutGas is Script {
    uint256 public constant TRANSFER_ALLOWANCE = 2_300;

    function run() external {
        uint256 payoutGas = vm.envUint("POD_PAYOUT_GAS");
        vm.startBroadcast(vm.envUint("POD_DEPLOYER_KEY"));
        WalletCode code = new WalletCode();
        ERC1967Proxy wallet = new ERC1967Proxy(address(code), "");
        Payer payer = new Payer();
        payer.pay{ value: 1 }(address(wallet), payoutGas);
        payer.pay{ value: 1 }(address(wallet), TRANSFER_ALLOWANCE);
        vm.stopBroadcast();
    }
}
