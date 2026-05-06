// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title EscrowVault
 * @notice Minimal per-job vault. Holds USDC for exactly ONE escrow job.
 *         Only the parent RepNetEscrow contract can release funds.
 *         Deployed as EIP-1167 minimal proxy (cheap clones).
 *
 * @dev This contract is intentionally simple. No admin, no upgrades,
 *      no complex logic. It does one thing: hold funds and release
 *      them when the parent contract says so.
 *
 *      A bug in job #2's settlement CANNOT drain job #1's vault.
 *      Each vault is a separate contract with its own balance.
 *
 *      SECURITY INVARIANT: Funds can ONLY flow to contractor, worker,
 *      or treasury. There is no arbitrary withdrawal function. Even a
 *      compromised resolver can only decide which of the two parties
 *      receives the disputed amount — funds cannot leave to unknown wallets.
 */
contract EscrowVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice RepNet contract suite release identifier.
    string public constant REPNET_VERSION = "v10";
    address public parentEscrow;
    uint256 public jobId;
    uint256 public totalDeposited;    // Set once — the hard ceiling
    uint256 public totalReleased;     // Cumulative outflow — can never exceed deposit
    bool public initialized;

    event FundsReleased(address indexed to, uint256 amount);

    // ──────────────────────────────────────────
    //  CUSTOM ERRORS
    // ──────────────────────────────────────────
    error AlreadyInitialized();
    error ZeroParent();
    error ZeroDeposit();
    error OnlyParent();
    error ZeroRecipient();
    error ZeroAmount();
    error ExceedsDeposited();

    /**
     * @notice Lock down the implementation contract.
     * @dev EscrowVault is deployed as an EIP-1167 minimal proxy clone.
     *      This constructor runs ONLY on the implementation contract (not clones),
     *      setting initialized = true so nobody can call initialize() on it.
     *      Prevents the "uninitialized implementation" takeover attack.
     */
    constructor() {
        initialized = true;
    }

    /**
     * @notice Initialize the vault. Called once after clone creation.
     * @param _parentEscrow The RepNetEscrow contract that controls this vault
     * @param _jobId The escrow job ID this vault belongs to
     * @param _totalDeposited The exact amount deposited — vault will NEVER release more
     */
    function initialize(address _parentEscrow, uint256 _jobId, uint256 _totalDeposited) external {
        if (initialized) revert AlreadyInitialized();
        if (_parentEscrow == address(0)) revert ZeroParent();
        if (_totalDeposited == 0) revert ZeroDeposit();

        parentEscrow = _parentEscrow;
        jobId = _jobId;
        totalDeposited = _totalDeposited;
        initialized = true;
    }

    /**
     * @notice Release funds to a recipient. Only callable by parent escrow.
     *         Self-protecting: refuses to release more than was deposited,
     *         even if the parent contract has a bug.
     * @param token The ERC20 token to transfer
     * @param to Recipient address
     * @param amount Amount to transfer
     */
    function release(IERC20 token, address to, uint256 amount) external nonReentrant {
        if (msg.sender != parentEscrow) revert OnlyParent();
        if (to == address(0)) revert ZeroRecipient();
        if (amount == 0) revert ZeroAmount();
        if (totalReleased + amount > totalDeposited) revert ExceedsDeposited();

        totalReleased += amount;
        token.safeTransfer(to, amount);
        emit FundsReleased(to, amount);
    }

    /**
     * @notice Add additional deposit to the vault (e.g., worker collateral).
     *         Only callable by parent escrow. Updates the ceiling so subsequent
     *         releases can cover the new total.
     * @param amount Amount of additional deposit
     */
    function addDeposit(uint256 amount) external nonReentrant {
        if (msg.sender != parentEscrow) revert OnlyParent();
        if (amount == 0) revert ZeroAmount();
        totalDeposited += amount;
    }

    /**
     * @notice Check vault balance for a token.
     */
    function balance(IERC20 token) external view returns (uint256) {
        return token.balanceOf(address(this));
    }
}
