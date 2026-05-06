// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";
import "./IdentityRegistry.sol";
import "./RepNetFeeRouter.sol";
import "./EscrowVault.sol";

/**
 * @title RepNetEscrow
 * @notice Tier C escrow for RepNet jobs with structured agreements, per-spec
 *         review/contest flow, timeline enforcement, and automated dispute
 *         resolution (3-judge LLM panel, off-chain).
 *
 * @dev SECURITY: Owner should be a multisig wallet (e.g., Gnosis Safe) in
 *      production. On testnet, a single EOA is used for development speed.
 *
 *      ARCHITECTURE:
 *      This contract handles the on-chain mechanics. The off-chain dispute
 *      resolver service watches for ContestFiled events, orchestrates 3 LLM
 *      judge evaluations, then calls submitVerdict() to record the result.
 *
 *      UPGRADE: Uses UUPS proxy pattern (EIP-1822). Only owner can upgrade.
 *
 *      FLOW:
 *      1. Contractor creates escrow with agreement hash + spec weights + deadlines
 *      2. Worker accepts job (on-chain signature = agreement to terms)
 *      3. Worker delivers (URI) before delivery deadline
 *      4. Contractor reviews each spec: Pass/Fail within review period
 *      5. Worker responds to Failed specs: Accept / ExtraWork / Contest
 *      6. Agreed portions settle IMMEDIATELY
 *      7. Contested specs: both submit evidence → 3 LLM judges → verdict → final
 *      8. If contractor doesn't review in time → auto-approve (all specs Pass)
 *      9. If worker doesn't deliver in time → contractor claims refund
 *
 *      DISPUTE FEE: 15% of contested amount (adjustable, 5-30% bounds). Winner gets remainder. Protocol gets fee.
 *      NO APPEALS: Three judges, one round, final.
 *
 * @dev This contract assumes USDC (6 decimals, no fee-on-transfer, no rebasing). Do not use with other ERC20 tokens.
 *
 * v6 changes (full rebuild):
 *   - Agreement Protocol: hash on-chain, mandatory specs with weights
 *   - Per-spec review/contest flow (Pass/Fail → Accept/ExtraWork/Contest)
 *   - Timeline enforcement (delivery deadline, review period, auto-approve)
 *   - Evidence submission for contested specs
 *   - Configurable dispute fee on contested amount (default 15%, adjustable 5-30%)
 *   - Authorized resolver (off-chain service submits verdicts)
 *   - Immediate settlement of agreed portions
 *   - Per-job EscrowVault isolation (EIP-1167 clones)
 *
 * v7 changes:
 *   - UUPS proxy pattern for upgradeability
 */
contract RepNetEscrow is Initializable, UUPSUpgradeable, OwnableUpgradeable, ReentrancyGuardTransient, PausableUpgradeable {
    using Clones for address;
    using SafeERC20 for IERC20;

    /// @notice RepNet contract suite release identifier.
    string public constant REPNET_VERSION = "v10";

    uint256 private constant BPS_BASE = 10_000;

    IERC20 public usdc;
    IdentityRegistry public identityRegistry;
    RepNetFeeRouter public feeRouter;

    /// @notice EscrowVault implementation (cloned per job via EIP-1167)
    address public vaultImplementation;

    // ──────────────────────────────────────────
    //  ENUMS
    // ──────────────────────────────────────────

    enum JobStatus {
        Created,        // Contractor created, waiting for worker to accept
        Active,         // Worker accepted, clock started on delivery
        Delivered,      // Worker submitted delivery
        InReview,       // Contractor submitted reviews, waiting for worker response
        Settling,       // Partial settlement in progress (some specs contested)
        Completed,      // All specs settled (paid/refunded)
        Refunded        // Worker missed deadline, full refund to contractor
    }

    enum SpecStatus {
        Pending,            // Not yet reviewed
        Passed,             // Contractor marked Pass → funds to worker
        Failed,             // Contractor marked Fail → waiting for worker response
        Accepted,           // Worker accepted the Fail → funds to contractor
        ExtraWork,          // Worker requested extension → waiting for contractor
        Contested,          // Worker contests → waiting for LLM judges
        Resolved,           // Judges ruled → funds distributed
        ExtensionApproved   // B1: Extension approved, waiting for worker to complete + contractor re-review
    }

    enum Verdict {
        None,           // Not yet resolved
        SpecMet,        // Judges ruled spec was met → worker wins
        SpecNotMet      // Judges ruled spec not met → contractor wins
    }

    // ──────────────────────────────────────────
    //  STRUCTS
    // ──────────────────────────────────────────

    struct EscrowJob {
        // Slot 1: address(20) + uint8(1) + uint8(1) + uint16(2) + uint16(2) + uint32(4) = 30 bytes
        address contractor;               // 20 bytes
        uint8 specCount;                   // 1 byte (max 20)
        JobStatus status;                  // 1 byte (uint8 enum)
        uint16 collateralBps;              // 2 bytes (max 10000)
        uint16 collateralPenaltyBps;       // 2 bytes (max 10000)
        uint32 reviewPeriod;               // 4 bytes (max ~136 years in seconds)

        // Slot 2: address(20) + uint48(6) + uint48(6) = 32 bytes
        address worker;                    // 20 bytes
        uint48 createdAt;                  // 6 bytes (timestamp, good until year 8.9M)
        uint48 completedAt;                // 6 bytes

        // Slot 3: timestamps = uint48(6) + uint48(6) + uint48(6) = 18 bytes
        uint48 deliveryDeadline;           // 6 bytes
        uint48 reviewDeadline;             // 6 bytes
        uint48 workerResponseDeadline;     // 6 bytes

        // Full uint256 fields (one slot each)
        uint256 totalAmount;               // Total USDC deposited (job amount, excl. collateral)
        bytes32 agreementHash;             // keccak256 of full agreement text
        uint256 amountSettled;             // Total USDC settled so far (released + refunded + fees)
        uint256 amountReleased;            // USDC released to worker
        uint256 amountRefunded;            // USDC refunded to contractor
        uint256 disputeFeesCollected;      // 15% dispute fees to protocol
        uint256 escrowFeePaid;             // Tracks FeeRouter escrow fees
        uint256 contractorCollateral;      // Actual USDC deposited as collateral by C
        uint256 workerCollateral;          // Actual USDC deposited as collateral by W
        uint256 collateralSettled;         // Total collateral returned/forfeited so far
        uint256 workerAmountSettled;       // Per-party tracking for incremental settlement
        uint256 contractorAmountSettled;   // Per-party tracking for incremental settlement
    }

    /// @notice Delivery URIs stored separately to avoid stack-too-deep
    mapping(uint256 => string) public deliveryURIs;

    struct SpecItem {
        // Slot 1: uint16(2) + uint8(1) + uint8(1) + uint16(2) + uint48(6) + uint48(6) = 18 bytes
        uint16 weight;                     // 2 bytes (max 10000)
        SpecStatus status;                 // 1 byte (uint8 enum)
        Verdict verdict;                   // 1 byte (uint8 enum)
        uint16 disputeFeeBps;              // 2 bytes (max 5000) — C1: Snapshotted at contest time
        uint48 extensionDeadline;          // 6 bytes — New deadline if ExtraWork approved
        uint48 extraWorkResponseDeadline;  // 6 bytes — B3: Contractor must respond to ExtraWork by this time

        // Dynamic strings (separate slots)
        string contractorEvidenceURI;      // Contractor's evidence for dispute
        string workerEvidenceURI;          // Worker's evidence for dispute
    }

    // ──────────────────────────────────────────
    //  CUSTOM ERRORS
    // ──────────────────────────────────────────
    error ZeroAddress();
    error ZeroAmount();
    error SelfEscrow();
    error EmptyAgreement();
    error NoSpecs();
    error TooManySpecs();
    error ZeroWeight();
    error WeightsMismatch();
    error DeadlineInPast();
    error ZeroReviewPeriod();
    error ReviewPeriodTooLong();
    error NotRegistered();
    error PenaltyExceeds100();
    error EmptyURI();
    error ResultsLengthMismatch();
    error SpecIndexOutOfRange();
    error NotWorker();
    error NotContractor();
    error NotParty();
    error NotAuthorizedJudge();
    error WrongState();
    error WrongSpecState();
    error DeadlinePassed();
    error DeadlineNotPassed();
    error DeadlineNotSet();
    error ReviewPeriodExpired();
    error ReviewPeriodNotExpired();
    error ExtensionDeadlineNotReached();
    error InvalidVote();
    error AlreadyVoted();
    error EvidenceLocked();
    error NoUnrespondedFails();
    error ActiveDisputes();
    error FeeBelowMinimum();
    error FeeAboveMaximum();
    error MinExceedsMax();
    error MaxExceeds50Percent();
    error InvalidVoteCount();
    error NoPendingProposal();
    error TimelockNotExpired();

    // ──────────────────────────────────────────
    //  STATE
    // ──────────────────────────────────────────

    mapping(uint256 => EscrowJob) public jobs;
    mapping(uint256 => mapping(uint256 => SpecItem)) public specs;
    mapping(uint256 => address) public jobVaults;  // jobId → isolated vault address
    uint256 public nextJobId;

    /// @notice Dispute fee in basis points (1500 = 15%). Adjustable by owner.
    uint256 public disputeFeeBps;

    /// @notice Safety rails for dispute fee (adjustable by owner)
    uint256 public minDisputeFeeBps;    // 5% minimum
    uint256 public maxDisputeFeeBps;   // 30% maximum

    /// @notice C2: Number of currently active disputes (contested specs awaiting verdict)
    uint256 public activeDisputeCount;

    /// @notice C3: Timelock state for dispute fee changes
    uint256 public pendingDisputeFeeBps;
    uint256 public pendingDisputeFeeTimestamp;
    uint256 public pendingMinDisputeFeeBps;
    uint256 public pendingMaxDisputeFeeBps;
    uint256 public pendingDisputeFeeBoundsTimestamp;
    uint256 public constant FEE_TIMELOCK = 48 hours;

    event DisputeFeeUpdated(uint256 oldFeeBps, uint256 newFeeBps);
    event DisputeFeeProposed(uint256 newFeeBps, uint256 executeAfter);
    event DisputeFeeProposalCancelled();
    event DisputeFeeBoundsUpdated(uint256 newMin, uint256 newMax);
    event DisputeFeeBoundsProposed(uint256 newMin, uint256 newMax, uint256 executeAfter);
    event DisputeFeeBoundsProposalCancelled();
    event RequiredVotesUpdated(uint256 oldVotes, uint256 newVotes);

    /// @notice Authorized judge wallets (each operated by a separate LLM provider)
    mapping(address => bool) public authorizedJudges;

    /// @notice Required judge votes to reach verdict (default: 2 of 3, adjustable)
    uint256 public requiredVotes;

    /// @notice Judge votes per contested spec: jobId → specIndex → judge → vote
    mapping(uint256 => mapping(uint256 => mapping(address => Verdict))) public judgeVotes;

    /// @notice Vote counts per contested spec
    struct VoteTally {
        uint8 specMetVotes;
        uint8 specNotMetVotes;
        address[] voters;
    }
    mapping(uint256 => mapping(uint256 => VoteTally)) internal voteTallies;

    // ──────────────────────────────────────────
    //  EVENTS
    // ──────────────────────────────────────────

    event EscrowCreated(
        uint256 indexed jobId,
        address indexed contractor,
        address indexed worker,
        uint256 totalAmount,
        bytes32 agreementHash,
        uint256 specCount,
        uint256 deliveryDeadline,
        uint256 reviewPeriod,
        uint256 collateralBps,
        uint256 collateralPenaltyBps
    );

    event JobAccepted(uint256 indexed jobId, address indexed worker);

    event WorkDelivered(uint256 indexed jobId, string deliveryURI);

    event SpecsReviewed(
        uint256 indexed jobId,
        address indexed contractor,
        bool[] results   // true = Pass, false = Fail
    );

    event SpecResponded(
        uint256 indexed jobId,
        uint256 indexed specIndex,
        SpecStatus response   // Accepted, ExtraWork, or Contested
    );

    event AgreedPortionSettled(
        uint256 indexed jobId,
        uint256 workerAmount,
        uint256 contractorRefund
    );

    event ContestFiled(
        uint256 indexed jobId,
        uint256 indexed specIndex,
        address indexed worker,
        string workerEvidenceURI
    );

    event EvidenceSubmitted(
        uint256 indexed jobId,
        uint256 indexed specIndex,
        address indexed party,
        string evidenceURI
    );

    event JudgeVoted(
        uint256 indexed jobId,
        uint256 indexed specIndex,
        address indexed judge,
        Verdict vote
    );

    event VerdictReached(
        uint256 indexed jobId,
        uint256 indexed specIndex,
        Verdict verdict,
        uint256 specMetVotes,
        uint256 specNotMetVotes,
        uint256 disputeFee,
        uint256 winnerAmount
    );

    event ExtensionRequested(
        uint256 indexed jobId,
        uint256 indexed specIndex,
        uint256 newDeadline
    );

    event ExtensionApproved(uint256 indexed jobId, uint256 indexed specIndex);
    event ExtensionDenied(uint256 indexed jobId, uint256 indexed specIndex);

    event EscrowCompleted(
        uint256 indexed jobId,
        uint256 amountReleased,
        uint256 amountRefunded,
        uint256 disputeFees
    );

    event EscrowRefunded(uint256 indexed jobId, uint256 amount);
    event AutoApproved(uint256 indexed jobId);
    event JudgeUpdated(address indexed judge, bool authorized);
    event VaultCreated(uint256 indexed jobId, address indexed vault);

    event CollateralDeposited(uint256 indexed jobId, address indexed party, uint256 amount);
    event CollateralReturned(uint256 indexed jobId, address indexed party, uint256 amount);
    event CollateralForfeited(uint256 indexed jobId, address indexed loser, address indexed winner, uint256 amount);

    // ──────────────────────────────────────────
    //  CONSTRUCTOR & INITIALIZER
    // ──────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the escrow contract (replaces constructor for proxy pattern).
     * @param _usdc USDC token address
     * @param _identityRegistry Identity registry address
     * @param _feeRouter Fee router address
     * @param _vaultImplementation EscrowVault implementation address for EIP-1167 clones
     * @param _disputeFeeBps Initial dispute fee in basis points (e.g. 1500 = 15%)
     * @param _minDisputeFeeBps Minimum dispute fee BPS
     * @param _maxDisputeFeeBps Maximum dispute fee BPS
     * @param _requiredVotes Number of judge votes needed for verdict
     */
    function initialize(
        address _usdc,
        address _identityRegistry,
        address _feeRouter,
        address _vaultImplementation,
        uint256 _disputeFeeBps,
        uint256 _minDisputeFeeBps,
        uint256 _maxDisputeFeeBps,
        uint256 _requiredVotes
    ) external initializer {
        if (_usdc == address(0)) revert ZeroAddress();
        if (_identityRegistry == address(0)) revert ZeroAddress();
        if (_feeRouter == address(0)) revert ZeroAddress();
        if (_vaultImplementation == address(0)) revert ZeroAddress();

        __Ownable_init(msg.sender);
        __Pausable_init();

        usdc = IERC20(_usdc);
        identityRegistry = IdentityRegistry(_identityRegistry);
        feeRouter = RepNetFeeRouter(_feeRouter);
        vaultImplementation = _vaultImplementation;

        nextJobId = 1;
        disputeFeeBps = _disputeFeeBps;
        minDisputeFeeBps = _minDisputeFeeBps;
        maxDisputeFeeBps = _maxDisputeFeeBps;
        requiredVotes = _requiredVotes;
    }

    /**
     * @dev Required by UUPS pattern. Only owner can authorize upgrades.
     */
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // ──────────────────────────────────────────
    //  CREATE ESCROW
    // ──────────────────────────────────────────

    /**
     * @notice Create an escrow job with structured agreement.
     * @param worker Worker's address (must be registered)
     * @param totalAmount Total USDC to deposit (job amount, excl. collateral)
     * @param agreementHash keccak256 of the full agreement text (stored on DKG)
     * @param specWeights Array of weights in basis points (must sum to 10000)
     * @param deliveryDeadline Unix timestamp — worker must deliver by this time
     * @param reviewPeriod Seconds the contractor has to review after delivery
     * @param collateralBps Optional collateral in basis points (0 = none, e.g. 1500 = 15%)
     * @param collateralPenaltyBps D1: Penalty rate on worker collateral for delivery timeout (0-10000 BPS)
     * @return jobId The new escrow job ID
     */
    function createEscrow(
        address worker,
        uint256 totalAmount,
        bytes32 agreementHash,
        uint256[] calldata specWeights,
        uint256 deliveryDeadline,
        uint256 reviewPeriod,
        uint256 collateralBps,
        uint256 collateralPenaltyBps
    ) external nonReentrant whenNotPaused returns (uint256) {
        if (worker == address(0)) revert ZeroAddress();
        if (worker == msg.sender) revert SelfEscrow();
        if (totalAmount == 0) revert ZeroAmount();
        if (agreementHash == bytes32(0)) revert EmptyAgreement();
        if (specWeights.length == 0) revert NoSpecs();
        if (specWeights.length > 20) revert TooManySpecs();
        // slither-disable-next-line timestamp
        if (deliveryDeadline <= block.timestamp) revert DeadlineInPast();
        if (reviewPeriod == 0) revert ZeroReviewPeriod();
        if (reviewPeriod > 30 days) revert ReviewPeriodTooLong();
        if (!identityRegistry.isRegisteredWallet(msg.sender)) revert NotRegistered();
        if (!identityRegistry.isRegisteredWallet(worker)) revert NotRegistered();

        // Validate spec weights sum to 10000 (100%)
        uint256 totalWeight = 0;
        for (uint256 i = 0; i < specWeights.length;) {
            if (specWeights[i] == 0) revert ZeroWeight();
            totalWeight += specWeights[i];
            unchecked { ++i; }
        }
        if (totalWeight != BPS_BASE) revert WeightsMismatch();

        // D1: Validate collateral penalty
        if (collateralPenaltyBps > BPS_BASE) revert PenaltyExceeds100();

        // Calculate collateral
        uint256 collateral = 0;
        if (collateralBps > 0) {
            collateral = (totalAmount * collateralBps) / BPS_BASE;
        }

        // EFFECTS
        uint256 jobId = nextJobId++;
        jobs[jobId] = EscrowJob({
            contractor: msg.sender,
            specCount: uint8(specWeights.length),
            status: JobStatus.Created,
            collateralBps: uint16(collateralBps),
            collateralPenaltyBps: uint16(collateralPenaltyBps),
            reviewPeriod: uint32(reviewPeriod),
            worker: worker,
            createdAt: uint48(block.timestamp),
            completedAt: 0,
            deliveryDeadline: uint48(deliveryDeadline),
            reviewDeadline: 0,             // Set when worker delivers
            workerResponseDeadline: 0,     // B2: Set when contractor reviews with any fails
            totalAmount: totalAmount,
            agreementHash: agreementHash,
            amountSettled: 0,
            amountReleased: 0,
            amountRefunded: 0,
            disputeFeesCollected: 0,
            escrowFeePaid: 0,
            contractorCollateral: collateral,
            workerCollateral: 0,           // Set when worker accepts
            collateralSettled: 0,
            workerAmountSettled: 0,
            contractorAmountSettled: 0
        });

        for (uint256 i = 0; i < specWeights.length;) {
            specs[jobId][i] = SpecItem({
                weight: uint16(specWeights[i]),
                status: SpecStatus.Pending,
                verdict: Verdict.None,
                disputeFeeBps: 0,              // C1: Set at contest time
                extensionDeadline: 0,
                extraWorkResponseDeadline: 0,  // B3: Set when worker requests extra work
                contractorEvidenceURI: "",
                workerEvidenceURI: ""
            });
            unchecked { ++i; }
        }

        // Clone a fresh vault for this job (EIP-1167 minimal proxy)
        address vault = vaultImplementation.clone();
        EscrowVault(vault).initialize(address(this), jobId, totalAmount + collateral);
        jobVaults[jobId] = vault;

        emit VaultCreated(jobId, vault);
        emit EscrowCreated(
            jobId, msg.sender, worker, totalAmount, agreementHash,
            specWeights.length, deliveryDeadline, reviewPeriod, collateralBps,
            collateralPenaltyBps
        );

        if (collateral > 0) {
            emit CollateralDeposited(jobId, msg.sender, collateral);
        }

        // INTERACTIONS: Deposit directly into the isolated vault
        usdc.safeTransferFrom(msg.sender, vault, totalAmount + collateral);

        return jobId;
    }

    // ──────────────────────────────────────────
    //  ACCEPT JOB
    // ──────────────────────────────────────────

    /**
     * @notice Worker accepts the job (agreement to terms).
     *         Clock starts on delivery deadline.
     *         If collateral is enabled, worker must have approved matching
     *         collateral amount for transfer.
     */
    function acceptJob(uint256 jobId) external nonReentrant {
        EscrowJob storage job = jobs[jobId];
        if (msg.sender != job.worker) revert NotWorker();
        if (job.status != JobStatus.Created) revert WrongState();

        job.status = JobStatus.Active;

        // Worker deposits matching collateral
        if (job.collateralBps > 0) {
            uint256 workerCol = job.contractorCollateral; // Match C's collateral
            job.workerCollateral = workerCol;

            // Update vault's deposit tracking
            address vaultAddr = jobVaults[jobId];
            EscrowVault(vaultAddr).addDeposit(workerCol);

            // Transfer collateral from worker to vault
            usdc.safeTransferFrom(msg.sender, vaultAddr, workerCol);

            emit CollateralDeposited(jobId, msg.sender, workerCol);
        }

        emit JobAccepted(jobId, msg.sender);
    }

    // ──────────────────────────────────────────
    //  DELIVER WORK
    // ──────────────────────────────────────────

    /**
     * @notice Worker submits delivery before the deadline.
     * @param jobId The escrow job ID
     * @param _deliveryURI URI pointing to the delivered work
     */
    // slither-disable-next-line timestamp
    function deliverWork(uint256 jobId, string calldata _deliveryURI) external nonReentrant {
        EscrowJob storage job = jobs[jobId];
        if (msg.sender != job.worker) revert NotWorker();
        if (job.status != JobStatus.Active) revert WrongState();
        if (block.timestamp > job.deliveryDeadline) revert DeadlinePassed();
        if (bytes(_deliveryURI).length == 0) revert EmptyURI();

        job.status = JobStatus.Delivered;
        deliveryURIs[jobId] = _deliveryURI;
        job.reviewDeadline = uint48(block.timestamp + job.reviewPeriod);

        emit WorkDelivered(jobId, _deliveryURI);
    }

    // ──────────────────────────────────────────
    //  REVIEW SPECS (Contractor)
    // ──────────────────────────────────────────

    /**
     * @notice Contractor reviews all specs at once: Pass (true) or Fail (false).
     *         Must be called within the review period after delivery.
     * @param jobId The escrow job ID
     * @param results Array of booleans — true=Pass, false=Fail. Length must match specCount.
     */
    // slither-disable-next-line timestamp
    function reviewSpecs(uint256 jobId, bool[] calldata results) external nonReentrant {
        EscrowJob storage job = jobs[jobId];
        if (msg.sender != job.contractor) revert NotContractor();
        if (job.status != JobStatus.Delivered) revert WrongState();
        if (block.timestamp > job.reviewDeadline) revert ReviewPeriodExpired();
        if (results.length != job.specCount) revert ResultsLengthMismatch();

        bool anyFailed = false;
        for (uint256 i = 0; i < results.length;) {
            if (results[i]) {
                specs[jobId][i].status = SpecStatus.Passed;
            } else {
                specs[jobId][i].status = SpecStatus.Failed;
                anyFailed = true;
            }
            unchecked { ++i; }
        }

        if (anyFailed) {
            job.status = JobStatus.InReview;
            // B2: Give worker same time as review period to respond to failed specs
            job.workerResponseDeadline = uint48(block.timestamp + job.reviewPeriod);
        } else {
            // All passed — settle everything to worker
            _settleAllPassed(jobId);
        }

        emit SpecsReviewed(jobId, msg.sender, results);
    }

    // ──────────────────────────────────────────
    //  WORKER RESPONSE TO FAILED SPECS
    // ──────────────────────────────────────────

    /**
     * @notice Worker accepts a Failed spec (agrees it wasn't done).
     *         Funds for this spec go back to contractor.
     */
    function acceptFail(uint256 jobId, uint256 specIndex) external nonReentrant {
        EscrowJob storage job = jobs[jobId];
        if (msg.sender != job.worker) revert NotWorker();
        if (job.status != JobStatus.InReview && job.status != JobStatus.Settling) revert WrongState();
        if (specIndex >= job.specCount) revert SpecIndexOutOfRange();
        if (specs[jobId][specIndex].status != SpecStatus.Failed) revert WrongSpecState();

        specs[jobId][specIndex].status = SpecStatus.Accepted;
        emit SpecResponded(jobId, specIndex, SpecStatus.Accepted);

        _trySettleAgreed(jobId);
    }

    /**
     * @notice Worker requests extra time to fix a Failed spec.
     * @param newDeadline New delivery deadline for this spec
     */
    // slither-disable-next-line timestamp
    function requestExtraWork(
        uint256 jobId,
        uint256 specIndex,
        uint256 newDeadline
    ) external nonReentrant {
        EscrowJob storage job = jobs[jobId];
        if (msg.sender != job.worker) revert NotWorker();
        if (job.status != JobStatus.InReview && job.status != JobStatus.Settling) revert WrongState();
        if (specIndex >= job.specCount) revert SpecIndexOutOfRange();
        if (specs[jobId][specIndex].status != SpecStatus.Failed) revert WrongSpecState();
        if (newDeadline <= block.timestamp) revert DeadlineInPast();

        specs[jobId][specIndex].status = SpecStatus.ExtraWork;
        specs[jobId][specIndex].extensionDeadline = uint48(newDeadline);
        // B3: Give contractor same time as review period to respond to extra work request
        specs[jobId][specIndex].extraWorkResponseDeadline = uint48(block.timestamp + job.reviewPeriod);

        emit ExtensionRequested(jobId, specIndex, newDeadline);

        // A5 FIX: Settle other agreed specs while this one waits for extension decision
        _trySettleAgreed(jobId);
    }

    /**
     * @notice Contractor approves an extension request.
     *         B1 FIX: Spec goes to ExtensionApproved (not Pending), worker gets more time.
     *         Contractor must re-review via reviewExtendedSpec after worker completes.
     */
    function approveExtension(uint256 jobId, uint256 specIndex) external nonReentrant {
        EscrowJob storage job = jobs[jobId];
        if (msg.sender != job.contractor) revert NotContractor();
        if (specIndex >= job.specCount) revert SpecIndexOutOfRange();
        if (specs[jobId][specIndex].status != SpecStatus.ExtraWork) revert WrongSpecState();

        specs[jobId][specIndex].status = SpecStatus.ExtensionApproved;
        specs[jobId][specIndex].extraWorkResponseDeadline = 0;  // B3: Clear response deadline
        emit ExtensionApproved(jobId, specIndex);
    }

    /**
     * @notice Contractor re-reviews a spec after extension was approved and worker completed extra work.
     *         B1 FIX: Provides valid forward path for ExtensionApproved specs.
     * @param jobId The escrow job ID
     * @param specIndex The spec index to re-review
     * @param passed true = Pass (worker completed), false = Fail (still not done)
     */
    function reviewExtendedSpec(uint256 jobId, uint256 specIndex, bool passed) external nonReentrant {
        EscrowJob storage job = jobs[jobId];
        if (msg.sender != job.contractor) revert NotContractor();
        if (specIndex >= job.specCount) revert SpecIndexOutOfRange();
        if (specs[jobId][specIndex].status != SpecStatus.ExtensionApproved) revert WrongSpecState();

        // Check that the extension deadline has passed (worker had time to complete)
        uint256 deadline = specs[jobId][specIndex].extensionDeadline;
        // slither-disable-next-line timestamp
        if (deadline == 0 || block.timestamp < deadline) revert ExtensionDeadlineNotReached();

        if (passed) {
            specs[jobId][specIndex].status = SpecStatus.Passed;
        } else {
            // Back to Failed — worker can Accept, Contest, or request another extension
            specs[jobId][specIndex].status = SpecStatus.Failed;
            specs[jobId][specIndex].extensionDeadline = 0;
            // B2: Reset worker response deadline for new Failed state
            job.workerResponseDeadline = uint48(block.timestamp + job.reviewPeriod);
        }

        _trySettleAgreed(jobId);
    }

    /**
     * @notice Contractor denies an extension request.
     *         Spec goes back to Failed — worker must Accept or Contest.
     */
    function denyExtension(uint256 jobId, uint256 specIndex) external nonReentrant {
        EscrowJob storage job = jobs[jobId];
        if (msg.sender != job.contractor) revert NotContractor();
        if (specIndex >= job.specCount) revert SpecIndexOutOfRange();
        if (specs[jobId][specIndex].status != SpecStatus.ExtraWork) revert WrongSpecState();

        specs[jobId][specIndex].status = SpecStatus.Failed;
        specs[jobId][specIndex].extensionDeadline = 0;
        specs[jobId][specIndex].extraWorkResponseDeadline = 0;  // B3: Clear response deadline
        // NM-001: Reset worker response deadline so worker can respond to the re-Failed spec
        job.workerResponseDeadline = uint48(block.timestamp + job.reviewPeriod);
        emit ExtensionDenied(jobId, specIndex);
    }

    /**
     * @notice Worker contests a Failed spec — takes it to RepNet Court.
     *         Worker must provide evidence URI with their statement.
     * @param jobId The escrow job ID
     * @param specIndex The contested spec index
     * @param evidenceURI URI to worker's evidence + statement
     */
    function contestSpec(
        uint256 jobId,
        uint256 specIndex,
        string calldata evidenceURI
    ) external nonReentrant {
        EscrowJob storage job = jobs[jobId];
        if (msg.sender != job.worker) revert NotWorker();
        if (job.status != JobStatus.InReview && job.status != JobStatus.Settling) revert WrongState();
        if (specIndex >= job.specCount) revert SpecIndexOutOfRange();
        if (specs[jobId][specIndex].status != SpecStatus.Failed) revert WrongSpecState();
        // evidenceURI is optional — evidence can be submitted privately via Gateway API
        specs[jobId][specIndex].status = SpecStatus.Contested;
        specs[jobId][specIndex].disputeFeeBps = uint16(disputeFeeBps);  // C1: Snapshot current fee
        activeDisputeCount++;                                     // C2: Track active disputes
        if (bytes(evidenceURI).length > 0) {
            specs[jobId][specIndex].workerEvidenceURI = evidenceURI;
        }

        emit ContestFiled(jobId, specIndex, msg.sender, evidenceURI);

        _trySettleAgreed(jobId);
    }

    /**
     * @notice Either party submits additional evidence for a contested spec.
     *         Contractor can add their counter-evidence after worker files contest.
     */
    function submitEvidence(
        uint256 jobId,
        uint256 specIndex,
        string calldata evidenceURI
    ) external nonReentrant {
        EscrowJob storage job = jobs[jobId];
        if (msg.sender != job.contractor && msg.sender != job.worker) revert NotParty();
        if (specIndex >= job.specCount) revert SpecIndexOutOfRange();
        if (specs[jobId][specIndex].status != SpecStatus.Contested) revert WrongSpecState();
        if (bytes(evidenceURI).length == 0) revert EmptyURI();
        // E1: Lock evidence after first judge vote
        if (voteTallies[jobId][specIndex].voters.length != 0) revert EvidenceLocked();

        if (msg.sender == job.contractor) {
            specs[jobId][specIndex].contractorEvidenceURI = evidenceURI;
        } else {
            specs[jobId][specIndex].workerEvidenceURI = evidenceURI;
        }

        emit EvidenceSubmitted(jobId, specIndex, msg.sender, evidenceURI);
    }

    // ──────────────────────────────────────────
    //  DISPUTE RESOLUTION (Called by authorized resolver)
    // ──────────────────────────────────────────

    /**
     * @notice Judge casts their vote on a contested spec.
     *         Each judge votes independently. When requiredVotes agree,
     *         the verdict is final and funds move automatically.
     *
     *         SECURITY: Funds can ONLY flow to contractor, worker, or treasury.
     *         No arbitrary withdrawal. Even a compromised judge can only influence
     *         which party wins — funds cannot leave to unknown wallets.
     *         Compromising one judge (1/3) cannot change the outcome.
     *
     * @param jobId The escrow job ID
     * @param specIndex The contested spec index
     * @param _vote SpecMet (worker wins) or SpecNotMet (contractor wins)
     */
    function castVote(
        uint256 jobId,
        uint256 specIndex,
        Verdict _vote
    ) external nonReentrant {
        if (!authorizedJudges[msg.sender]) revert NotAuthorizedJudge();
        if (_vote != Verdict.SpecMet && _vote != Verdict.SpecNotMet) revert InvalidVote();

        EscrowJob storage job = jobs[jobId];
        if (job.status != JobStatus.Settling && job.status != JobStatus.InReview) revert WrongState();
        if (specIndex >= job.specCount) revert SpecIndexOutOfRange();
        if (specs[jobId][specIndex].status != SpecStatus.Contested) revert WrongSpecState();

        // Each judge can only vote once per spec
        if (judgeVotes[jobId][specIndex][msg.sender] != Verdict.None) revert AlreadyVoted();

        // Record vote
        judgeVotes[jobId][specIndex][msg.sender] = _vote;

        VoteTally storage tally = voteTallies[jobId][specIndex];
        tally.voters.push(msg.sender);

        if (_vote == Verdict.SpecMet) {
            tally.specMetVotes++;
        } else {
            tally.specNotMetVotes++;
        }

        emit JudgeVoted(jobId, specIndex, msg.sender, _vote);

        // Check if majority reached
        if (tally.specMetVotes >= requiredVotes) {
            _executeVerdict(jobId, specIndex, Verdict.SpecMet, tally);
        } else if (tally.specNotMetVotes >= requiredVotes) {
            _executeVerdict(jobId, specIndex, Verdict.SpecNotMet, tally);
        }
    }

    /**
     * @dev Execute verdict once majority is reached. Moves funds automatically.
     *      15% dispute fee deducted from the escrow pot. Winner gets pot remainder.
     *      Loser's proportional collateral goes to winner. Winner's collateral returned.
     *      Verdict is FINAL — no appeals.
     */
    function _executeVerdict(
        uint256 jobId,
        uint256 specIndex,
        Verdict _verdict,
        VoteTally storage tally
    ) internal {
        SpecItem storage spec = specs[jobId][specIndex];
        EscrowJob storage job = jobs[jobId];

        spec.status = SpecStatus.Resolved;
        spec.verdict = _verdict;
        activeDisputeCount--;  // C2: Decrement active disputes

        // Calculate amounts for this spec
        uint256 specAmount = (job.totalAmount * spec.weight) / BPS_BASE;
        uint256 disputeFee = (specAmount * spec.disputeFeeBps) / BPS_BASE;  // C1: Use snapshotted fee
        uint256 winnerAmount = specAmount - disputeFee;

        job.disputeFeesCollected += disputeFee;
        job.amountSettled += specAmount;

        // A2 FIX: Update per-party settlement tracking for dispute resolution
        // This ensures _trySettleAgreed won't double-count resolved specs
        if (_verdict == Verdict.SpecMet) {
            job.workerAmountSettled += specAmount;
        } else {
            job.contractorAmountSettled += specAmount;
        }

        EscrowVault vault = EscrowVault(jobVaults[jobId]);

        // Calculate proportional collateral at risk for this spec
        uint256 cPropCol = 0;
        uint256 wPropCol = 0;
        if (job.collateralBps > 0) {
            cPropCol = (job.contractorCollateral * spec.weight) / BPS_BASE;
            wPropCol = (job.workerCollateral * spec.weight) / BPS_BASE;
            job.collateralSettled += cPropCol + wPropCol;
        }

        // Determine winner and loser
        address winner;
        address loser;
        uint256 loserPropCol;
        uint256 winnerPropCol;

        if (_verdict == Verdict.SpecMet) {
            job.amountReleased += winnerAmount;
            winner = job.worker;
            loser = job.contractor;
            loserPropCol = cPropCol;
            winnerPropCol = wPropCol;
        } else {
            job.amountRefunded += winnerAmount;
            winner = job.contractor;
            loser = job.worker;
            loserPropCol = wPropCol;
            winnerPropCol = cPropCol;
        }

        // G1: Emit all events BEFORE external calls (strict CEI)
        emit VerdictReached(
            jobId, specIndex, _verdict,
            tally.specMetVotes, tally.specNotMetVotes,
            disputeFee, winnerAmount
        );

        if (loserPropCol > 0) {
            emit CollateralForfeited(jobId, loser, winner, loserPropCol);
        }
        if (winnerPropCol > 0) {
            emit CollateralReturned(jobId, winner, winnerPropCol);
        }

        // INTERACTIONS: Transfer from vault — ONLY to contractor, worker, or treasury
        // Winner gets: pot remainder + loser's collateral + own collateral returned
        uint256 totalToWinner = winnerAmount + loserPropCol + winnerPropCol;
        if (totalToWinner > 0) {
            vault.release(usdc, winner, totalToWinner);
        }
        if (disputeFee > 0) {
            vault.release(usdc, feeRouter.treasury(), disputeFee);
        }

        _tryComplete(jobId);
    }

    /**
     * @notice Get vote tally for a contested spec.
     */
    function getVoteTally(uint256 jobId, uint256 specIndex) external view returns (
        uint256 specMetVotes,
        uint256 specNotMetVotes,
        address[] memory voters
    ) {
        VoteTally storage tally = voteTallies[jobId][specIndex];
        return (tally.specMetVotes, tally.specNotMetVotes, tally.voters);
    }

    // ──────────────────────────────────────────
    //  TIMELINE ENFORCEMENT
    // ──────────────────────────────────────────

    /**
     * @notice Claim refund if worker never delivered by deadline.
     *         Anyone can call this after delivery deadline passes.
     *         Returns both collaterals (no penalty for timeout).
     */
    // slither-disable-next-line timestamp
    function claimRefund(uint256 jobId) external nonReentrant {
        EscrowJob storage job = jobs[jobId];
        if (job.status != JobStatus.Active && job.status != JobStatus.Created) revert WrongState();
        if (block.timestamp <= job.deliveryDeadline) revert DeadlineNotPassed();

        address cachedContractor = job.contractor;
        address cachedWorker = job.worker;
        uint256 cachedAmount = job.totalAmount;

        job.status = JobStatus.Refunded;
        job.amountRefunded = cachedAmount;
        job.amountSettled = cachedAmount;
        job.completedAt = uint48(block.timestamp);

        emit EscrowRefunded(jobId, cachedAmount);

        EscrowVault vault = EscrowVault(jobVaults[jobId]);
        vault.release(usdc, cachedContractor, cachedAmount);

        // D1: Return collateral with configurable penalty on worker collateral
        if (job.collateralBps > 0) {
            uint256 cCol = job.contractorCollateral;
            uint256 wCol = job.workerCollateral;
            job.collateralSettled = cCol + wCol;

            // Contractor always gets their own collateral back
            if (cCol > 0) {
                vault.release(usdc, cachedContractor, cCol);
                emit CollateralReturned(jobId, cachedContractor, cCol);
            }

            // D1: Apply penalty to worker collateral
            if (wCol > 0) {
                uint256 penalty = (wCol * job.collateralPenaltyBps) / BPS_BASE;
                uint256 remainder = wCol - penalty;

                if (penalty > 0) {
                    vault.release(usdc, cachedContractor, penalty);
                    emit CollateralForfeited(jobId, cachedWorker, cachedContractor, penalty);
                }
                if (remainder > 0) {
                    vault.release(usdc, cachedWorker, remainder);
                    emit CollateralReturned(jobId, cachedWorker, remainder);
                }
            }
        }
    }

    /**
     * @notice Trigger auto-approve if contractor didn't review in time.
     *         All specs marked Pass, full payment to worker via FeeRouter.
     *         Anyone can call this after review deadline passes.
     */
    // slither-disable-next-line timestamp
    function claimAutoApprove(uint256 jobId) external nonReentrant {
        EscrowJob storage job = jobs[jobId];
        if (job.status != JobStatus.Delivered) revert WrongState();
        if (job.reviewDeadline == 0) revert DeadlineNotSet();
        if (block.timestamp <= job.reviewDeadline) revert ReviewPeriodNotExpired();

        // Mark all specs as Passed
        uint256 count = job.specCount;
        for (uint256 i = 0; i < count;) {
            specs[jobId][i].status = SpecStatus.Passed;
            unchecked { ++i; }
        }

        emit AutoApproved(jobId);

        // Settle all to worker via FeeRouter
        _settleAllPassed(jobId);
    }

    /**
     * @notice B2: Claim unresponded Failed specs after worker response deadline.
     *         All Failed specs that worker didn't respond to are treated as
     *         Accepted (contractor wins those portions).
     *         Anyone can call this after workerResponseDeadline passes.
     */
    // slither-disable-next-line timestamp
    function claimUnrespondedFails(uint256 jobId) external nonReentrant {
        EscrowJob storage job = jobs[jobId];
        if (job.status != JobStatus.InReview && job.status != JobStatus.Settling) revert WrongState();
        if (job.workerResponseDeadline == 0) revert DeadlineNotSet();
        if (block.timestamp <= job.workerResponseDeadline) revert DeadlineNotPassed();

        // Mark all unresponded Failed specs as Accepted (contractor wins)
        bool anyChanged = false;
        uint256 count = job.specCount;
        for (uint256 i = 0; i < count;) {
            if (specs[jobId][i].status == SpecStatus.Failed) {
                specs[jobId][i].status = SpecStatus.Accepted;
                anyChanged = true;
            }
            unchecked { ++i; }
        }

        if (!anyChanged) revert NoUnrespondedFails();

        // Settle the newly accepted specs
        _trySettleAgreed(jobId);
    }

    /**
     * @notice B3: Claim timeout on ExtraWork request if contractor didn't respond.
     *         Spec goes back to Failed (auto-deny), worker must Accept or Contest.
     *         Anyone can call this after extraWorkResponseDeadline passes.
     * @param jobId The escrow job ID
     * @param specIndex The spec index with expired ExtraWork
     */
    // slither-disable-next-line timestamp
    function claimExtraWorkTimeout(uint256 jobId, uint256 specIndex) external nonReentrant {
        EscrowJob storage job = jobs[jobId];
        if (job.status != JobStatus.InReview && job.status != JobStatus.Settling) revert WrongState();
        if (specIndex >= job.specCount) revert SpecIndexOutOfRange();

        SpecItem storage spec = specs[jobId][specIndex];
        if (spec.status != SpecStatus.ExtraWork) revert WrongSpecState();
        if (spec.extraWorkResponseDeadline == 0) revert DeadlineNotSet();
        if (block.timestamp <= spec.extraWorkResponseDeadline) revert DeadlineNotPassed();

        // Auto-deny: spec goes back to Failed
        spec.status = SpecStatus.Failed;
        spec.extensionDeadline = 0;
        spec.extraWorkResponseDeadline = 0;
        // NM-001: Reset worker response deadline so worker can respond to the re-Failed spec
        job.workerResponseDeadline = uint48(block.timestamp + job.reviewPeriod);

        emit ExtensionDenied(jobId, specIndex);
    }

    // ──────────────────────────────────────────
    //  INTERNAL: SETTLEMENT
    // ──────────────────────────────────────────

    /**
     * @dev Settle agreed portions immediately. Called after worker responds
     *      to reviews. Settles all Passed and Accepted specs. Moves job to
     *      Settling if any specs are still Contested or in ExtraWork.
     *
     *      A1 FIX: Uses per-party tracking (workerAmountSettled, contractorAmountSettled)
     *      instead of cumulative ratio to correctly handle incremental settlement deltas.
     */
    function _trySettleAgreed(uint256 jobId) internal {
        EscrowJob storage job = jobs[jobId];

        (uint256 workerWeight, uint256 contractorWeight, bool anyPending) = _tallyWeights(jobId);

        // Calculate total owed to each party based on current weights
        uint256 totalWorkerOwed = (job.totalAmount * workerWeight) / BPS_BASE;
        uint256 totalContractorOwed = (job.totalAmount * contractorWeight) / BPS_BASE;

        // Calculate new amounts to settle (delta from what's already settled per-party)
        uint256 newWorkerAmount = totalWorkerOwed > job.workerAmountSettled
            ? totalWorkerOwed - job.workerAmountSettled : 0;
        uint256 newContractorAmount = totalContractorOwed > job.contractorAmountSettled
            ? totalContractorOwed - job.contractorAmountSettled : 0;

        if (newWorkerAmount > 0 || newContractorAmount > 0) {
            job.workerAmountSettled += newWorkerAmount;
            job.contractorAmountSettled += newContractorAmount;
            job.amountSettled += (newWorkerAmount + newContractorAmount);
            _settleAgreedAmounts(jobId, newWorkerAmount, newContractorAmount);
        }

        // Return proportional collateral for agreed (non-disputed) specs
        _settleAgreedCollateral(jobId);

        if (anyPending) {
            job.status = JobStatus.Settling;
        } else {
            _tryComplete(jobId);
        }
    }

    /**
     * @dev Tally spec weights by status category.
     *      A2 FIX: Include Resolved specs based on verdict to avoid race condition
     *      between dispute settlement and agreed settlement tracking.
     */
    function _tallyWeights(uint256 jobId) internal view returns (
        uint256 workerWeight,
        uint256 contractorWeight,
        bool anyPending
    ) {
        uint256 count = jobs[jobId].specCount;
        for (uint256 i = 0; i < count;) {
            SpecItem storage spec = specs[jobId][i];
            SpecStatus s = spec.status;
            if (s == SpecStatus.Passed) {
                workerWeight += spec.weight;
            } else if (s == SpecStatus.Accepted) {
                contractorWeight += spec.weight;
            } else if (s == SpecStatus.Resolved) {
                // A2 FIX: Include resolved specs based on verdict
                if (spec.verdict == Verdict.SpecMet) {
                    workerWeight += spec.weight;
                } else if (spec.verdict == Verdict.SpecNotMet) {
                    contractorWeight += spec.weight;
                }
            } else if (
                s == SpecStatus.Pending ||          // B5: Pending specs not yet reviewed
                s == SpecStatus.Failed ||
                s == SpecStatus.ExtraWork ||
                s == SpecStatus.Contested ||
                s == SpecStatus.ExtensionApproved   // B1: Extension approved but not yet re-reviewed
            ) {
                anyPending = true;
            }
            unchecked { ++i; }
        }
    }

    /**
     * @dev Settle agreed amounts: worker portion via FeeRouter, contractor via direct transfer.
     *      NOTE: amountSettled is updated by caller (_trySettleAgreed), not here.
     */
    function _settleAgreedAmounts(
        uint256 jobId,
        uint256 workerAmount,
        uint256 contractorAmount
    ) internal {
        EscrowJob storage job = jobs[jobId];
        EscrowVault vault = EscrowVault(jobVaults[jobId]);

        // EFFECTS: Update state before external calls (G1: strict CEI)
        if (workerAmount > 0) {
            uint256 fee = feeRouter.calculateEscrowFee(workerAmount);
            if (fee >= workerAmount) fee = workerAmount / 2;
            job.escrowFeePaid += fee;
            job.amountReleased += (workerAmount - fee);
            job.amountRefunded += contractorAmount;
        } else if (contractorAmount > 0) {
            job.amountRefunded += contractorAmount;
        }

        // G1: Emit before external calls
        emit AgreedPortionSettled(jobId, workerAmount, contractorAmount);

        // INTERACTIONS: External calls last
        if (workerAmount > 0) {
            uint256 pot = workerAmount + contractorAmount;
            vault.release(usdc, address(this), pot);
            usdc.forceApprove(address(feeRouter), pot);
            // G7: settleEscrow returns a jobId (uint256) — routing ID, not a success flag; no check needed
            feeRouter.settleEscrow(job.contractor, job.worker, pot, workerAmount);
            usdc.forceApprove(address(feeRouter), 0);
        } else if (contractorAmount > 0) {
            vault.release(usdc, job.contractor, contractorAmount);
        }
    }

    /**
     * @dev Settle all specs to worker (all passed). Used for full signoff
     *      and auto-approve. Routes through FeeRouter for fee collection.
     *      Returns all collateral to both parties (clean completion).
     */
    function _settleAllPassed(uint256 jobId) internal {
        EscrowJob storage job = jobs[jobId];
        EscrowVault vault = EscrowVault(jobVaults[jobId]);

        uint256 cachedAmount = job.totalAmount;
        address cachedContractor = job.contractor;
        address cachedWorker = job.worker;

        // EFFECTS: All state updates before external calls (G1: strict CEI)
        uint256 fee = feeRouter.calculateEscrowFee(cachedAmount);
        if (fee >= cachedAmount) fee = cachedAmount / 2;

        job.escrowFeePaid += fee;
        job.amountReleased = cachedAmount - fee;
        job.amountRefunded = 0;
        job.amountSettled = cachedAmount;

        job.status = JobStatus.Completed;
        job.completedAt = uint48(block.timestamp);

        // Return all collateral to both parties (clean completion)
        if (job.collateralBps > 0) {
            job.collateralSettled = job.contractorCollateral + job.workerCollateral;
        }

        // G1: Emit all events before external calls
        emit EscrowCompleted(jobId, job.amountReleased, 0, 0);

        if (job.collateralBps > 0) {
            uint256 cCol = job.contractorCollateral;
            uint256 wCol = job.workerCollateral;

            if (cCol > 0) {
                emit CollateralReturned(jobId, cachedContractor, cCol);
            }
            if (wCol > 0) {
                emit CollateralReturned(jobId, cachedWorker, wCol);
            }
        }

        // INTERACTIONS: External calls last
        vault.release(usdc, address(this), cachedAmount);
        usdc.forceApprove(address(feeRouter), cachedAmount);
        // G7: settleEscrow returns a jobId (uint256) — routing ID, not a success flag; no check needed
        feeRouter.settleEscrow(cachedContractor, cachedWorker, cachedAmount, cachedAmount);
        usdc.forceApprove(address(feeRouter), 0);

        if (job.collateralBps > 0) {
            uint256 cCol = job.contractorCollateral;
            uint256 wCol = job.workerCollateral;

            if (cCol > 0) {
                vault.release(usdc, cachedContractor, cCol);
            }
            if (wCol > 0) {
                vault.release(usdc, cachedWorker, wCol);
            }
        }
    }

    /**
     * @dev Return proportional collateral to both parties for agreed (non-disputed)
     *      specs that have been settled. Uses a delta approach: compares expected
     *      collateral settled (based on all finalized spec weights) against what
     *      has already been settled (including dispute collateral from _executeVerdict).
     */
    function _settleAgreedCollateral(uint256 jobId) internal {
        EscrowJob storage job = jobs[jobId];
        if (job.collateralBps == 0) return;

        // Calculate total finalized weight (Passed + Accepted + Resolved)
        uint256 finalizedWeight = 0;
        uint256 count = job.specCount;
        for (uint256 i = 0; i < count;) {
            SpecStatus s = specs[jobId][i].status;
            if (s == SpecStatus.Passed || s == SpecStatus.Accepted || s == SpecStatus.Resolved) {
                finalizedWeight += specs[jobId][i].weight;
            }
            unchecked { ++i; }
        }

        // Cache redundant SLOADs
        uint256 cCol = job.contractorCollateral;
        uint256 totalCollateral = cCol + job.workerCollateral;
        uint256 expectedSettled = (totalCollateral * finalizedWeight) / BPS_BASE;

        if (expectedSettled > job.collateralSettled) {
            uint256 delta = expectedSettled - job.collateralSettled;
            // Split proportionally (symmetric: each side gets half of the delta)
            uint256 cReturn = (delta * cCol) / totalCollateral;
            uint256 wReturn = delta - cReturn;

            job.collateralSettled += delta;

            EscrowVault vault = EscrowVault(jobVaults[jobId]);
            if (cReturn > 0) {
                vault.release(usdc, job.contractor, cReturn);
                emit CollateralReturned(jobId, job.contractor, cReturn);
            }
            if (wReturn > 0) {
                vault.release(usdc, job.worker, wReturn);
                emit CollateralReturned(jobId, job.worker, wReturn);
            }
        }
    }

    /**
     * @dev Check if all specs are resolved. If so, mark job as completed.
     */
    function _tryComplete(uint256 jobId) internal {
        EscrowJob storage job = jobs[jobId];

        uint256 count = job.specCount;
        for (uint256 i = 0; i < count;) {
            SpecStatus s = specs[jobId][i].status;
            if (
                s != SpecStatus.Passed &&
                s != SpecStatus.Accepted &&
                s != SpecStatus.Resolved
            ) {
                return; // Still have unresolved specs
            }
            unchecked { ++i; }
        }

        // All specs resolved
        job.status = JobStatus.Completed;
        job.completedAt = uint48(block.timestamp);

        emit EscrowCompleted(
            jobId,
            job.amountReleased,
            job.amountRefunded,
            job.disputeFeesCollected
        );
    }

    // ──────────────────────────────────────────
    //  ADMIN
    // ──────────────────────────────────────────

    function setJudge(address judge, bool authorized) external onlyOwner {
        authorizedJudges[judge] = authorized;
        emit JudgeUpdated(judge, authorized);
    }

    /**
     * @notice Update the dispute fee. Bounded by adjustable min/max.
     *         C3: Requires no active disputes (use timelock during active disputes).
     * @param newFeeBps New fee in basis points.
     */
    function setDisputeFeeBps(uint256 newFeeBps) external onlyOwner {
        if (activeDisputeCount != 0) revert ActiveDisputes();
        if (newFeeBps < minDisputeFeeBps) revert FeeBelowMinimum();
        if (newFeeBps > maxDisputeFeeBps) revert FeeAboveMaximum();
        emit DisputeFeeUpdated(disputeFeeBps, newFeeBps);
        disputeFeeBps = newFeeBps;
    }

    /**
     * @notice Update dispute fee bounds.
     *         C4: Max cannot exceed 50% (5000 bps).
     * @param _min New minimum dispute fee BPS
     * @param _max New maximum dispute fee BPS
     */
    function setDisputeFeeBounds(uint256 _min, uint256 _max) external onlyOwner {
        if (_min > _max) revert MinExceedsMax();
        if (_max > 5_000) revert MaxExceeds50Percent();
        minDisputeFeeBps = _min;
        maxDisputeFeeBps = _max;
        emit DisputeFeeBoundsUpdated(_min, _max);
        _clampDisputeFeeToBounds();
    }

    /**
     * @notice Update required judge votes for verdict.
     *         C2: Cannot change during active disputes.
     * @param _requiredVotes New required votes (minimum 1, maximum 10)
     */
    function setRequiredVotes(uint256 _requiredVotes) external onlyOwner {
        if (activeDisputeCount != 0) revert ActiveDisputes();
        if (_requiredVotes < 1) revert InvalidVoteCount();
        if (_requiredVotes > 10) revert InvalidVoteCount();
        uint256 oldVotes = requiredVotes;
        requiredVotes = _requiredVotes;
        emit RequiredVotesUpdated(oldVotes, _requiredVotes);
    }

    // ──────────────────────────────────────────
    //  C3: TIMELOCKED FEE GOVERNANCE
    // ──────────────────────────────────────────

    /**
     * @notice Propose a new dispute fee (requires 48h timelock before execution).
     * @param newFeeBps New fee in basis points.
     */
    function proposeDisputeFeeBps(uint256 newFeeBps) external onlyOwner {
        if (newFeeBps < minDisputeFeeBps) revert FeeBelowMinimum();
        if (newFeeBps > maxDisputeFeeBps) revert FeeAboveMaximum();
        pendingDisputeFeeBps = newFeeBps;
        pendingDisputeFeeTimestamp = block.timestamp + FEE_TIMELOCK;
        emit DisputeFeeProposed(newFeeBps, pendingDisputeFeeTimestamp);
    }

    /**
     * @notice Execute a previously proposed dispute fee change after timelock.
     */
    function executeDisputeFeeBps() external onlyOwner {
        if (pendingDisputeFeeTimestamp == 0) revert NoPendingProposal();
        if (block.timestamp < pendingDisputeFeeTimestamp) revert TimelockNotExpired();
        uint256 newFeeBps = pendingDisputeFeeBps;
        emit DisputeFeeUpdated(disputeFeeBps, newFeeBps);
        disputeFeeBps = newFeeBps;
        pendingDisputeFeeBps = 0;
        pendingDisputeFeeTimestamp = 0;
    }

    /**
     * @notice Cancel a pending dispute fee proposal.
     */
    function cancelDisputeFeeProposal() external onlyOwner {
        pendingDisputeFeeBps = 0;
        pendingDisputeFeeTimestamp = 0;
        emit DisputeFeeProposalCancelled();
    }

    /**
     * @notice Propose new dispute fee bounds (requires 48h timelock).
     *         C4: Max cannot exceed 50%.
     * @param _min New minimum dispute fee BPS
     * @param _max New maximum dispute fee BPS
     */
    function proposeDisputeFeeBounds(uint256 _min, uint256 _max) external onlyOwner {
        if (_min > _max) revert MinExceedsMax();
        if (_max > 5_000) revert MaxExceeds50Percent();
        pendingMinDisputeFeeBps = _min;
        pendingMaxDisputeFeeBps = _max;
        pendingDisputeFeeBoundsTimestamp = block.timestamp + FEE_TIMELOCK;
        emit DisputeFeeBoundsProposed(_min, _max, pendingDisputeFeeBoundsTimestamp);
    }

    /**
     * @notice Execute a previously proposed dispute fee bounds change after timelock.
     */
    function executeDisputeFeeBounds() external onlyOwner {
        if (pendingDisputeFeeBoundsTimestamp == 0) revert NoPendingProposal();
        if (block.timestamp < pendingDisputeFeeBoundsTimestamp) revert TimelockNotExpired();
        minDisputeFeeBps = pendingMinDisputeFeeBps;
        maxDisputeFeeBps = pendingMaxDisputeFeeBps;
        pendingMinDisputeFeeBps = 0;
        pendingMaxDisputeFeeBps = 0;
        pendingDisputeFeeBoundsTimestamp = 0;
        // NM-002: Emit event for executed bounds change
        emit DisputeFeeBoundsUpdated(minDisputeFeeBps, maxDisputeFeeBps);
        _clampDisputeFeeToBounds();
    }

    function _clampDisputeFeeToBounds() internal {
        if (disputeFeeBps < minDisputeFeeBps) {
            emit DisputeFeeUpdated(disputeFeeBps, minDisputeFeeBps);
            disputeFeeBps = minDisputeFeeBps;
        } else if (disputeFeeBps > maxDisputeFeeBps) {
            emit DisputeFeeUpdated(disputeFeeBps, maxDisputeFeeBps);
            disputeFeeBps = maxDisputeFeeBps;
        }
    }

    /**
     * @notice Cancel a pending dispute fee bounds proposal.
     */
    function cancelDisputeFeeBoundsProposal() external onlyOwner {
        pendingMinDisputeFeeBps = 0;
        pendingMaxDisputeFeeBps = 0;
        pendingDisputeFeeBoundsTimestamp = 0;
        emit DisputeFeeBoundsProposalCancelled();
    }

    /**
     * @notice Emergency pause — blocks new escrow creation.
     *         Existing escrows can still settle (funds never locked).
     */
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ──────────────────────────────────────────
    //  VIEWS
    // ──────────────────────────────────────────

    function getJob(uint256 jobId) external view returns (EscrowJob memory) {
        return jobs[jobId];
    }

    function getSpec(uint256 jobId, uint256 specIndex) external view returns (SpecItem memory) {
        return specs[jobId][specIndex];
    }

    function getAllSpecs(uint256 jobId) external view returns (SpecItem[] memory) {
        uint256 count = jobs[jobId].specCount;
        SpecItem[] memory result = new SpecItem[](count);
        for (uint256 i = 0; i < count;) {
            result[i] = specs[jobId][i];
            unchecked { ++i; }
        }
        return result;
    }

    /**
     * @notice Get the vault address and balance for a job.
     *         Each job has its own isolated vault — funds can never mix.
     */
    function getVaultInfo(uint256 jobId) external view returns (address vault, uint256 vaultBalance) {
        vault = jobVaults[jobId];
        if (vault != address(0)) {
            vaultBalance = usdc.balanceOf(vault);
        }
    }

    /**
     * @notice Get collateral info for a job.
     * @dev Reads from getJob() struct fields: collateralBps, contractorCollateral,
     *      workerCollateral, collateralSettled. This convenience view avoids
     *      decoding the full struct.
     */
    function getCollateralInfo(uint256 jobId) external view returns (
        uint256, uint256, uint256, uint256
    ) {
        EscrowJob storage j = jobs[jobId];
        return (j.collateralBps, j.contractorCollateral, j.workerCollateral, j.collateralSettled);
    }
}
