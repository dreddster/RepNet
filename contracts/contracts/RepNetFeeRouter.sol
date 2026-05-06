// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title RepNetFeeRouter
 * @notice Routes x402 payments with RepNet fee collection.
 *
 * @dev SECURITY: Owner should be a multisig wallet (e.g., Gnosis Safe) in
 *      production. On testnet, a single EOA is used for development speed.
 *      Owner controls: treasury updates, escrow authorization, pause/unpause.
 *      See deploy script for owner configuration.
 *         Direct payment fee: max($0.01, 1%) per side, capped at $5 per side.
 *         Escrow fee: max($0.01, 2%) per side, capped at $5 per side.
 *         No minimum job value — micro-jobs welcome.
 *
 * v4 changes:
 *   - Escrow settlement now only charges worker-side fee (contractor pays 2% upfront via SDK)
 *   - settleEscrow() totalFee = feePerSide (not feePerSide * 2)
 *   - Contractor refund = totalPot - workerPortion (no fee deducted at settlement)
 *
 * v3 changes:
 *   - Separate escrow fee tier (escrowFeeBps, default 2% vs 1% direct)
 *   - calculateEscrowFee() + setEscrowFees() + previewEscrow()
 *
 * v2 changes:
 *   - ReentrancyGuard on all external payment functions
 *   - settleEscrow() — single entry point for escrow settlements
 *   - Worker minimum receive check (fee cannot exceed job amount)
 *   - Authorized escrow mapping (only approved escrow contracts can call settleEscrow)
 */
contract RepNetFeeRouter is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    /// @notice RepNet contract suite release identifier.
    string public constant REPNET_VERSION = "v10";

    IERC20 public immutable usdc;
    address public treasury;

    /// @notice Direct payment fee basis points (100 = 1%). Configurable within bounds.
    uint256 public feeBps = 100;

    /// @notice Minimum fee per side in USDC (6 decimals). Configurable.
    uint256 public minFee = 10_000; // $0.01

    /// @notice Maximum fee per side in USDC (6 decimals). Configurable.
    uint256 public maxFee = 5_000_000; // $5

    /// @notice Escrow fee basis points (200 = 2%). Separate from direct payment fees.
    uint256 public escrowFeeBps = 200;

    /// @notice Escrow minimum fee per side in USDC (6 decimals).
    uint256 public escrowMinFee = 10_000; // $0.01

    /// @notice Escrow maximum fee per side in USDC (6 decimals).
    uint256 public escrowMaxFee = 5_000_000; // $5

    // --- Fee parameter bounds (adjustable by owner) ---
    uint256 public minFeeBps = 10;          // 0.1% floor
    uint256 public maxFeeBps = 500;         // 5% ceiling
    uint256 public absoluteMinFee = 1_000;  // $0.001 floor
    uint256 public absoluteMaxFee = 100_000_000; // $100 ceiling

    /// @notice Total jobs routed
    uint256 public totalJobs;

    /// @notice Total fees collected
    uint256 public totalFeesCollected;

    /// @notice Authorized escrow contracts
    mapping(address => bool) public authorizedEscrows;

    event JobRouted(
        uint256 indexed jobId,
        address indexed contractor,
        address indexed worker,
        uint256 jobAmount,
        uint256 contractorFee,
        uint256 workerFee
    );

    event EscrowSettled(
        uint256 indexed jobId,
        address indexed contractor,
        address indexed worker,
        uint256 workerAmount,
        uint256 contractorRefund,
        uint256 totalFee
    );

    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event EscrowAuthorized(address indexed escrow, bool authorized);

    constructor(address _usdc, address _treasury) Ownable(msg.sender) {
        if (_usdc == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();
        usdc = IERC20(_usdc);
        treasury = _treasury;
    }

    event FeesUpdated(uint256 feeBps, uint256 minFee, uint256 maxFee);
    event EscrowFeesUpdated(uint256 escrowFeeBps, uint256 escrowMinFee, uint256 escrowMaxFee);
    event FeeBoundsUpdated(uint256 minFeeBps, uint256 maxFeeBps, uint256 absoluteMinFee, uint256 absoluteMaxFee);

    // ──────────────────────────────────────────
    //  CUSTOM ERRORS
    // ──────────────────────────────────────────
    error ZeroAddress();
    error SelfPayment();
    error ZeroAmount();
    error FeeExceedsAmount();
    error NotAuthorizedEscrow();
    error WorkerPortionExceedsPot();
    error BPSOutOfBounds();
    error MinFeeOutOfBounds();
    error MaxFeeOutOfBounds();
    error MinFeeExceedsMaxFee();
    error MinBPSExceedsMaxBPS();
    error MaxBPSExceeds100();

    /**
     * @notice Calculate fee for a direct payment.
     * @param amount The payment amount in USDC (6 decimals)
     * @return fee The fee per side
     */
    function calculateFee(uint256 amount) public view returns (uint256) {
        uint256 percentFee = (amount * feeBps) / 10_000;
        uint256 fee = percentFee < minFee ? minFee : percentFee;
        return fee > maxFee ? maxFee : fee;
    }

    /**
     * @notice Calculate fee for an escrow settlement (2% default, vs 1% for direct).
     * @param amount The payment amount in USDC (6 decimals)
     * @return fee The fee per side
     */
    function calculateEscrowFee(uint256 amount) public view returns (uint256) {
        uint256 percentFee = (amount * escrowFeeBps) / 10_000;
        uint256 fee = percentFee < escrowMinFee ? escrowMinFee : percentFee;
        return fee > escrowMaxFee ? escrowMaxFee : fee;
    }

    /**
     * @notice Route a direct job payment with fee collection.
     *         Contractor must approve (jobAmount + contractorFee) to this contract.
     * @param worker The worker's wallet address
     * @param jobAmount The job payment amount (what the worker should receive before their fee)
     * @return jobId The sequential job ID
     */
    function routePayment(
        address worker,
        uint256 jobAmount
    ) external nonReentrant whenNotPaused returns (uint256) {
        if (worker == address(0)) revert ZeroAddress();
        if (worker == msg.sender) revert SelfPayment();
        if (jobAmount == 0) revert ZeroAmount();

        uint256 fee = calculateFee(jobAmount);
        if (fee >= jobAmount) revert FeeExceedsAmount();

        uint256 workerReceives = jobAmount - fee;
        uint256 totalFee = fee * 2;
        uint256 contractorTotal = jobAmount + fee;

        // EFFECTS: Update state before external calls (CEI)
        totalJobs++;
        totalFeesCollected += totalFee;
        uint256 currentJobId = totalJobs;

        emit JobRouted(currentJobId, msg.sender, worker, jobAmount, fee, fee);

        // INTERACTIONS: External calls last
        usdc.safeTransferFrom(msg.sender, address(this), contractorTotal);
        usdc.safeTransfer(worker, workerReceives);
        usdc.safeTransfer(treasury, totalFee);

        return currentJobId;
    }

    /**
     * @notice Settle an escrow job. Called by authorized escrow contracts only.
     *         Escrow sends the full pot; this function splits it:
     *         - Worker gets workerPortion minus worker-side fee
     *         - Contractor gets refund (pot - workerPortion) — no fee deducted (paid upfront via SDK)
     *         - Treasury gets worker-side fee only (contractor fee collected upfront)
     *
     * @dev v4: Only worker-side fee is collected at settlement. Contractor pays their 2%
     *      fee upfront when creating the escrow via the SDK (direct transfer to treasury).
     *      This simplifies the settlement math and provides immediate fee revenue.
     *
     * @param contractor The contractor's address (for refund)
     * @param worker The worker's address (for payment)
     * @param totalPot Total USDC sent by escrow (full job deposit)
     * @param workerPortion The gross amount the worker earned (before fees)
     * @return jobId The sequential job ID
     */
    function settleEscrow(
        address contractor,
        address worker,
        uint256 totalPot,
        uint256 workerPortion
    ) external nonReentrant returns (uint256) {
        if (!authorizedEscrows[msg.sender]) revert NotAuthorizedEscrow();
        if (worker == address(0)) revert ZeroAddress();
        if (contractor == address(0)) revert ZeroAddress();
        if (totalPot == 0) revert ZeroAmount();
        if (workerPortion > totalPot) revert WorkerPortionExceedsPot();

        // CHECKS: Calculate all amounts before state changes
        // v4: Only worker-side fee at settlement (contractor paid upfront)
        uint256 totalFee = 0;
        uint256 workerReceives = 0;
        uint256 contractorRefund = 0;

        if (workerPortion > 0) {
            uint256 feePerSide = calculateEscrowFee(workerPortion);

            // If fee would eat the entire worker portion, take what we can
            if (feePerSide >= workerPortion) {
                feePerSide = workerPortion / 2; // Take at most half
            }

            // v4: Only worker-side fee (not feePerSide * 2)
            totalFee = feePerSide;

            // Cap total fee to not exceed the pot
            if (totalFee > totalPot) {
                totalFee = totalPot;
            }

            workerReceives = workerPortion - totalFee;

            // v4: Contractor refund = pot - workerPortion (no fee deducted from their side)
            contractorRefund = totalPot - workerPortion;
        } else {
            // Full refund (0% to worker)
            contractorRefund = totalPot;
        }

        // EFFECTS: Update state before external calls (CEI)
        totalJobs++;
        totalFeesCollected += totalFee;
        uint256 currentJobId = totalJobs;

        emit EscrowSettled(currentJobId, contractor, worker, workerReceives, contractorRefund, totalFee);

        // INTERACTIONS: External calls last
        usdc.safeTransferFrom(msg.sender, address(this), totalPot);

        if (workerReceives > 0) {
            usdc.safeTransfer(worker, workerReceives);
        }
        if (totalFee > 0) {
            usdc.safeTransfer(treasury, totalFee);
        }
        if (contractorRefund > 0) {
            usdc.safeTransfer(contractor, contractorRefund);
        }

        return currentJobId;
    }

    /**
     * @notice Preview a payment routing (view function).
     * @param jobAmount The job payment amount
     * @return contractorPays Total the contractor needs to approve
     * @return workerReceives Amount the worker gets after fee
     * @return feePerSide Fee charged to each party
     * @return totalFee Combined fee to treasury
     */
    function previewPayment(uint256 jobAmount) external view returns (
        uint256 contractorPays,
        uint256 workerReceives,
        uint256 feePerSide,
        uint256 totalFee
    ) {
        feePerSide = calculateFee(jobAmount);
        contractorPays = jobAmount + feePerSide;
        workerReceives = jobAmount > feePerSide ? jobAmount - feePerSide : 0;
        totalFee = feePerSide * 2;
    }

    // --- Admin ---

    /**
     * @notice Emergency pause — blocks new direct payments.
     *         Existing escrow settlements still process (funds never locked).
     * @dev In production, owner MUST be a multisig (e.g., Gnosis Safe).
     */
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice Update fee parameters. Bounded by hardcoded safety rails.
     * @param newFeeBps New fee in basis points (10-500, i.e., 0.1% to 5%)
     * @param newMinFee New minimum fee in USDC units ($0.001 to $100)
     * @param newMaxFee New maximum fee in USDC units ($0.001 to $100)
     */
    function setFees(uint256 newFeeBps, uint256 newMinFee, uint256 newMaxFee) external onlyOwner {
        if (newFeeBps < minFeeBps || newFeeBps > maxFeeBps) revert BPSOutOfBounds();
        if (newMinFee < absoluteMinFee || newMinFee > absoluteMaxFee) revert MinFeeOutOfBounds();
        if (newMaxFee < absoluteMinFee || newMaxFee > absoluteMaxFee) revert MaxFeeOutOfBounds();
        if (newMinFee > newMaxFee) revert MinFeeExceedsMaxFee();

        feeBps = newFeeBps;
        minFee = newMinFee;
        maxFee = newMaxFee;

        emit FeesUpdated(newFeeBps, newMinFee, newMaxFee);
    }

    /**
     * @notice Update escrow fee parameters. Bounded by same safety rails as direct fees.
     * @param newEscrowFeeBps New escrow fee in basis points (10-500, i.e., 0.1% to 5%)
     * @param newEscrowMinFee New escrow minimum fee in USDC units ($0.001 to $100)
     * @param newEscrowMaxFee New escrow maximum fee in USDC units ($0.001 to $100)
     */
    function setEscrowFees(uint256 newEscrowFeeBps, uint256 newEscrowMinFee, uint256 newEscrowMaxFee) external onlyOwner {
        if (newEscrowFeeBps < minFeeBps || newEscrowFeeBps > maxFeeBps) revert BPSOutOfBounds();
        if (newEscrowMinFee < absoluteMinFee || newEscrowMinFee > absoluteMaxFee) revert MinFeeOutOfBounds();
        if (newEscrowMaxFee < absoluteMinFee || newEscrowMaxFee > absoluteMaxFee) revert MaxFeeOutOfBounds();
        if (newEscrowMinFee > newEscrowMaxFee) revert MinFeeExceedsMaxFee();

        escrowFeeBps = newEscrowFeeBps;
        escrowMinFee = newEscrowMinFee;
        escrowMaxFee = newEscrowMaxFee;

        emit EscrowFeesUpdated(newEscrowFeeBps, newEscrowMinFee, newEscrowMaxFee);
    }

    /**
     * @notice Preview an escrow settlement (view function).
     * @dev v4: Only worker-side fee is collected at settlement.
     *      Contractor fee (2%) is paid upfront via SDK, not included here.
     * @param workerPortion Gross amount the worker earned
     * @param totalPot Total USDC in escrow
     * @return workerReceives Amount the worker gets after escrow fee
     * @return contractorRefund Amount refunded to contractor (no fee deducted)
     * @return feePerSide Escrow fee per side (for reference, only worker pays at settlement)
     * @return totalFee Fee to treasury at settlement (worker-side only)
     */
    function previewEscrow(uint256 workerPortion, uint256 totalPot) external view returns (
        uint256 workerReceives,
        uint256 contractorRefund,
        uint256 feePerSide,
        uint256 totalFee
    ) {
        if (workerPortion > 0) {
            feePerSide = calculateEscrowFee(workerPortion);
            if (feePerSide >= workerPortion) {
                feePerSide = workerPortion / 2;
            }
            // v4: Only worker-side fee at settlement (contractor paid upfront)
            totalFee = feePerSide;
            if (totalFee > totalPot) {
                totalFee = totalPot;
            }
            workerReceives = workerPortion - totalFee;
            // v4: Contractor refund = pot - workerPortion (no fee deducted)
            contractorRefund = totalPot - workerPortion;
        } else {
            contractorRefund = totalPot;
        }
    }

    /**
     * @notice Update fee parameter bounds. All adjustable — no hardcoded limits.
     * @param _minFeeBps Minimum allowed BPS (e.g., 10 = 0.1%)
     * @param _maxFeeBps Maximum allowed BPS (e.g., 500 = 5%)
     * @param _absoluteMinFee Minimum allowed fee floor in USDC (6 decimals)
     * @param _absoluteMaxFee Maximum allowed fee cap in USDC (6 decimals)
     */
    function setFeeBounds(
        uint256 _minFeeBps,
        uint256 _maxFeeBps,
        uint256 _absoluteMinFee,
        uint256 _absoluteMaxFee
    ) external onlyOwner {
        if (_minFeeBps > _maxFeeBps) revert MinBPSExceedsMaxBPS();
        if (_maxFeeBps > 10_000) revert MaxBPSExceeds100();
        if (_absoluteMinFee > _absoluteMaxFee) revert MinFeeExceedsMaxFee();

        minFeeBps = _minFeeBps;
        maxFeeBps = _maxFeeBps;
        absoluteMinFee = _absoluteMinFee;
        absoluteMaxFee = _absoluteMaxFee;

        // G15: Clamp current feeBps if outside new bounds
        if (feeBps < _minFeeBps) {
            feeBps = _minFeeBps;
        } else if (feeBps > _maxFeeBps) {
            feeBps = _maxFeeBps;
        }
        // G15: Clamp current escrowFeeBps if outside new bounds
        if (escrowFeeBps < _minFeeBps) {
            escrowFeeBps = _minFeeBps;
        } else if (escrowFeeBps > _maxFeeBps) {
            escrowFeeBps = _maxFeeBps;
        }
        // G15: Clamp current minFee/maxFee if outside new absolute bounds
        if (minFee < _absoluteMinFee) {
            minFee = _absoluteMinFee;
        } else if (minFee > _absoluteMaxFee) {
            minFee = _absoluteMaxFee;
        }
        if (maxFee < _absoluteMinFee) {
            maxFee = _absoluteMinFee;
        } else if (maxFee > _absoluteMaxFee) {
            maxFee = _absoluteMaxFee;
        }
        if (escrowMinFee < _absoluteMinFee) {
            escrowMinFee = _absoluteMinFee;
        } else if (escrowMinFee > _absoluteMaxFee) {
            escrowMinFee = _absoluteMaxFee;
        }
        if (escrowMaxFee < _absoluteMinFee) {
            escrowMaxFee = _absoluteMinFee;
        } else if (escrowMaxFee > _absoluteMaxFee) {
            escrowMaxFee = _absoluteMaxFee;
        }

        emit FeeBoundsUpdated(_minFeeBps, _maxFeeBps, _absoluteMinFee, _absoluteMaxFee);
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    function setAuthorizedEscrow(address escrow, bool authorized) external onlyOwner {
        authorizedEscrows[escrow] = authorized;
        emit EscrowAuthorized(escrow, authorized);
    }
}
