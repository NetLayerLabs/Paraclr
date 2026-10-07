// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice TEST ONLY: minimal 6-decimal ERC20 with hooks used to attack the clearinghouse:
///         a transfer fee (fee-on-transfer resistance), a re-entry callback (reentrancy), an
///         over-debit on transfer out (balance-delta check), and a blocklist (Agora-style freeze).
contract HookToken {
    string public constant name = "Hook USD";
    string public constant symbol = "HUSD";
    uint8 public decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    uint256 public feeBps; // charged on every transfer, burned
    uint256 public extraDebit; // extra amount taken from the sender on transfer (malicious)
    mapping(address => bool) public frozen;
    address public reenterTarget;
    bytes public reenterPayload;
    bytes public reenterResult;
    bool public reenterOk;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function setFeeBps(uint256 bps) external {
        feeBps = bps;
    }

    function setExtraDebit(uint256 amount) external {
        extraDebit = amount;
    }

    function setFrozen(address who, bool f) external {
        frozen[who] = f;
    }

    function armReentry(address target, bytes calldata payload) external {
        reenterTarget = target;
        reenterPayload = payload;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            require(a >= amount, "allowance");
            allowance[from][msg.sender] = a - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(!frozen[from] && !frozen[to], "frozen");
        uint256 debit = amount + extraDebit;
        require(balanceOf[from] >= debit, "balance");
        balanceOf[from] -= debit;
        uint256 fee = (amount * feeBps) / 10_000;
        balanceOf[to] += amount - fee;
        totalSupply -= fee + extraDebit;
        emit Transfer(from, to, amount - fee);
        if (reenterTarget != address(0)) {
            address t = reenterTarget;
            reenterTarget = address(0);
            (reenterOk, reenterResult) = t.call(reenterPayload);
        }
    }
}
