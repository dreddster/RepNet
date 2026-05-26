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
 *      Owner controls: treasury updates and pause/unpause.
 *      See deploy script for owner configuration.
 *         Direct payment fee: max($0.01, 1%) per side, capped at $5 per side.
 *         No minimum job value — micro-jobs welcome.
 */
contract RepNetFeeRouter is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    /// @notice RepNet contract suite release identifier.
    string public constant REPNET_VERSION = "release";

    IERC20 public immutable usdc;
    address public treasury;

    /// @notice Direct payment fee basis points (100 = 1%). Configurable within bounds.
    uint256 public feeBps = 100;

    /// @notice Minimum fee per side in USDC (6 decimals). Configurable.
    uint256 public minFee = 10_000; // $0.01

    /// @notice Maximum fee per side in USDC (6 decimals). Configurable.
    uint256 public maxFee = 5_000_000; // $5

    // --- Fee parameter bounds (adjustable by owner) ---
    uint256 public minFeeBps = 10;          // 0.1% floor
    uint256 public maxFeeBps = 500;         // 5% ceiling
    uint256 public absoluteMinFee = 1_000;  // $0.001 floor
    uint256 public absoluteMaxFee = 100_000_000; // $100 ceiling

    /// @notice Total jobs routed
    uint256 public totalJobs;

    /// @notice Total fees collected
    uint256 public totalFeesCollected;

    /// @notice Monotonic direct-payment fee config version. Immediate routes use current config.
    uint64 public currentConfigVersion = 1;

    event JobRouted(
        uint256 indexed jobId,
        address indexed contractor,
        address indexed worker,
        uint256 jobAmount,
        uint256 contractorFee,
        uint256 workerFee
    );

    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);

    constructor(address _usdc, address _treasury) Ownable(msg.sender) {
        if (_usdc == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();
        usdc = IERC20(_usdc);
        treasury = _treasury;
    }

    event FeesUpdated(uint256 feeBps, uint256 minFee, uint256 maxFee);
    event FeeBoundsUpdated(uint256 minFeeBps, uint256 maxFeeBps, uint256 absoluteMinFee, uint256 absoluteMaxFee);
    event FeeConfigVersionUpdated(uint64 indexed configVersion, uint256 feeBps, uint256 minFee, uint256 maxFee);

    // ──────────────────────────────────────────
    //  CUSTOM ERRORS
    // ──────────────────────────────────────────
    error ZeroAddress();
    error SelfPayment();
    error ZeroAmount();
    error FeeExceedsAmount();
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

        unchecked {
            currentConfigVersion += 1;
        }

        emit FeesUpdated(newFeeBps, newMinFee, newMaxFee);
        emit FeeConfigVersionUpdated(currentConfigVersion, newFeeBps, newMinFee, newMaxFee);
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

        // G15: Clamp feeBps if outside new bounds
        if (feeBps < _minFeeBps) {
            feeBps = _minFeeBps;
        } else if (feeBps > _maxFeeBps) {
            feeBps = _maxFeeBps;
        }
        // G15: Clamp minFee/maxFee if outside new absolute bounds
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

        unchecked {
            currentConfigVersion += 1;
        }

        emit FeeBoundsUpdated(_minFeeBps, _maxFeeBps, _absoluteMinFee, _absoluteMaxFee);
        emit FeeConfigVersionUpdated(currentConfigVersion, feeBps, minFee, maxFee);
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }
}
