// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";
import {Owned} from "./utils/Owned.sol";

/// @title MockAUSD
/// @notice Testnet stand-in for Agora AUSD: a 6-decimal dollar stablecoin used by Paraclr as
///         the sole quote asset and margin collateral. Anyone can call the public faucet
///         `mint(to, amount)` up to `MAX_MINT_PER_CALL` per call; the owner can mint without a cap
///         (used by the deploy script to seed lane insurance funds).
contract MockAUSD is IERC20, Owned {
    string public constant name = "Agora USD (Paraclr Testnet Mock)";
    string public constant symbol = "AUSD";
    uint8 public constant decimals = 6;

    /// @notice Faucet cap per call: 10,000 AUSD.
    uint256 public constant MAX_MINT_PER_CALL = 10_000e6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    error MintCapExceeded(uint256 requested, uint256 cap);
    error InsufficientBalance();
    error InsufficientAllowance();

    constructor(address initialOwner) Owned(initialOwner) {}

    /// @notice Public faucet. Anyone may mint up to MAX_MINT_PER_CALL per call (testnet only).
    function mint(address to, uint256 amount) external {
        if (amount > MAX_MINT_PER_CALL) revert MintCapExceeded(amount, MAX_MINT_PER_CALL);
        _mint(to, amount);
    }

    /// @notice Uncapped owner mint (deploy/seed use only).
    function ownerMint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < amount) revert InsufficientAllowance();
            unchecked {
                allowance[from][msg.sender] = allowed - amount;
            }
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        if (to == address(0)) revert ZeroAddress();
        uint256 bal = balanceOf[from];
        if (bal < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = bal - amount;
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);
    }

    function _mint(address to, uint256 amount) internal {
        if (to == address(0)) revert ZeroAddress();
        totalSupply += amount;
        unchecked {
            balanceOf[to] += amount;
        }
        emit Transfer(address(0), to, amount);
    }
}
