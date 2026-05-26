// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title RepNetJobBoard
 * @notice Narrow RepNet job-board/review-hold lifecycle without v1 dispute settlement.
 * @dev This is the default-path contract spine. It deliberately avoids per-spec disputes,
 *      LLM judge settlement, appeals, and private delivery custody.
 */
contract RepNetJobBoard is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private constant BPS_BASE = 10_000;
    uint256 public constant REPUTATION_FEE_BPS = 100;
    uint256 public constant MAX_REPUTATION_FEE_BPS = 1_000;
    uint48 public constant WORKER_ACCEPTANCE_PERIOD = 24 hours;
    uint48 public constant MIN_ADDITIONAL_WORK_PERIOD = 24 hours;
    uint8 public constant MAX_ADDITIONAL_WORK_REQUESTS = 1;

    enum PaymentMode {
        UPFRONT,
        REVIEW_GATED_DELIVERY_HOLD
    }

    enum JobStatus {
        Created,
        Accepted,
        SubmittedForReview,
        OpinionPublished,
        AdditionalWorkRequested,
        AdditionalWorkAccepted,
        AdditionalWorkRefused,
        ResubmittedForReview,
        Released,
        CancelledBeforeDelivery,
        CancelledAfterReview,
        WorkerWithdrawn,
        DeclinedBeforeAccept,
        ExpiredBeforeAccept,
        UpfrontPaid
    }

    struct Job {
        address contractor;
        address worker;
        uint256 amount;
        bytes32 agreementHash;
        bytes32 publicSpecHash;
        bytes32 privateSpecHash;
        uint48 deliveryDeadline;
        uint48 reviewDeadline;
        PaymentMode paymentMode;
        JobStatus status;
        uint48 createdAt;
        uint48 acceptanceDeadline;
        uint48 acceptedAt;
        uint48 finalizedAt;
        string cancellationReason;
        string deliveryHandle;
        bytes32 opinionHash;
        string opinionSchemaVersion;
        uint48 additionalWorkDeadline;
        string additionalWorkRefusalReason;
        uint8 additionalWorkRequestsUsed;
        uint8 contractorReviewsUsed;
        uint64 configVersion;
        uint16 reputationFeeBps;
        address paymentToken;
    }

    struct JobConfig {
        uint16 reputationFeeBps;
        address paymentToken;
    }

    IERC20 public immutable usdc;
    address public immutable treasury;
    address public immutable opinionPublisher;
    /// @notice Multisig/timelock address allowed to execute emergency stuck-job rescues.
    address public immutable emergencyAuthority;
    /// @notice True on mainnet-grade deployments: emergency authority must be contract code, not an EOA.
    bool public immutable emergencyAuthorityMustBeContract;
    uint256 public nextJobId;
    uint64 public currentConfigVersion = 1;
    uint16 public reputationFeeBps = uint16(REPUTATION_FEE_BPS);
    bool public newEscrowsPaused;
    mapping(uint256 => Job) public jobs;
    mapping(uint64 => JobConfig) public configByVersion;

    event JobAgreementCreated(
        uint256 indexed jobId,
        address indexed contractor,
        address indexed worker,
        uint256 amount,
        bytes32 agreementHash,
        bytes32 publicSpecHash,
        bytes32 privateSpecHash,
        uint48 deliveryDeadline,
        uint48 reviewDeadline
    );
    event JobAccepted(uint256 indexed jobId, address indexed worker);
    event DeliverySubmitted(uint256 indexed jobId, string deliveryHandle);
    event DeliveryResubmitted(uint256 indexed jobId, string deliveryHandle, uint8 contractorReviewsUsed);
    event OpinionReportPublished(uint256 indexed jobId, bytes32 opinionHash, string opinionSchemaVersion);
    event AdditionalWorkRequested(uint256 indexed jobId, string request, uint48 deadline, uint8 additionalWorkRequestsUsed);
    event AdditionalWorkAccepted(uint256 indexed jobId, address indexed worker);
    event AdditionalWorkRefused(uint256 indexed jobId, address indexed worker, string reason);
    event JobReceiptRecorded(
        uint256 indexed jobId,
        string terminalPath,
        uint256 amount,
        uint256 workerReceived,
        uint256 contractorRefunded,
        uint256 protocolFee
    );
    event FeedbackRightsRecorded(
        uint256 indexed jobId,
        bool contractorFeedbackRight,
        bool workerFeedbackRight
    );
    event EmergencyJobRescue(
        uint256 indexed jobId,
        bytes32 indexed reasonHash,
        address indexed recipient,
        uint256 amount,
        address caller,
        uint256 timestamp
    );
    event NewEscrowsPauseUpdated(bool paused);
    event JobConfigVersionUpdated(uint64 indexed configVersion, uint16 reputationFeeBps, address indexed paymentToken);
    event JobConfigSnapshotted(uint256 indexed jobId, uint64 indexed configVersion, uint16 reputationFeeBps, address indexed paymentToken);

    error ZeroAddress();
    error ZeroAmount();
    error SelfJob();
    error EmptyHash();
    error EmptyCancellationReason();
    error EmptyDeliveryHandle();
    error EmptyOpinionSchemaVersion();
    error NotContractor();
    error NotWorker();
    error NotOpinionPublisher();
    error EmptyAdditionalWorkRequest();
    error AdditionalWorkLimitReached();
    error AdditionalWorkDeadlineTooSoon();
    error AdditionalWorkDeadlineNotReached();
    error AdditionalWorkDeadlineExpired();
    error AcceptanceDeadlineNotReached();
    error AcceptanceDeadlineExpired();
    error DeliveryDeadlineExpired();
    error ReviewDeadlineNotReached();
    error InvalidDeadline();
    error WrongState();
    error NotEmergencyAuthority();
    error EmergencyAuthorityMustBeContract();
    error EmptyRescueReason();
    error JobNotEmergencyRescuable();
    error NewEscrowsPaused();
    error FeeBpsOutOfBounds();

    constructor(
        address _usdc,
        address _treasury,
        address _opinionPublisher,
        address _emergencyAuthority,
        bool _emergencyAuthorityMustBeContract
    ) {
        if (
            _usdc == address(0) || _treasury == address(0) || _opinionPublisher == address(0)
                || _emergencyAuthority == address(0)
        ) revert ZeroAddress();
        if (_emergencyAuthorityMustBeContract && _emergencyAuthority.code.length == 0) {
            revert EmergencyAuthorityMustBeContract();
        }
        usdc = IERC20(_usdc);
        treasury = _treasury;
        opinionPublisher = _opinionPublisher;
        emergencyAuthority = _emergencyAuthority;
        emergencyAuthorityMustBeContract = _emergencyAuthorityMustBeContract;
        configByVersion[currentConfigVersion] = JobConfig({
            reputationFeeBps: reputationFeeBps,
            paymentToken: _usdc
        });
    }

    function pauseNewEscrows() external {
        if (msg.sender != emergencyAuthority) revert NotEmergencyAuthority();
        newEscrowsPaused = true;
        emit NewEscrowsPauseUpdated(true);
    }

    function unpauseNewEscrows() external {
        if (msg.sender != emergencyAuthority) revert NotEmergencyAuthority();
        newEscrowsPaused = false;
        emit NewEscrowsPauseUpdated(false);
    }

    function setReputationFeeBps(uint16 newReputationFeeBps) external {
        if (msg.sender != emergencyAuthority) revert NotEmergencyAuthority();
        if (newReputationFeeBps > MAX_REPUTATION_FEE_BPS) revert FeeBpsOutOfBounds();
        reputationFeeBps = newReputationFeeBps;
        unchecked {
            currentConfigVersion += 1;
        }
        configByVersion[currentConfigVersion] = JobConfig({
            reputationFeeBps: newReputationFeeBps,
            paymentToken: address(usdc)
        });
        emit JobConfigVersionUpdated(currentConfigVersion, newReputationFeeBps, address(usdc));
    }

    function createJob(
        address worker,
        uint256 amount,
        bytes32 agreementHash,
        bytes32 publicSpecHash,
        bytes32 privateSpecHash,
        uint48 deliveryDeadline,
        uint48 reviewDeadline
    )
        external
        nonReentrant
        returns (uint256 jobId)
    {
        if (newEscrowsPaused) revert NewEscrowsPaused();
        if (worker == address(0)) revert ZeroAddress();
        if (worker == msg.sender) revert SelfJob();
        if (amount == 0) revert ZeroAmount();
        if (agreementHash == bytes32(0) || publicSpecHash == bytes32(0) || privateSpecHash == bytes32(0)) revert EmptyHash();

        jobId = ++nextJobId;
        uint48 createdAt = uint48(block.timestamp);
        if (deliveryDeadline <= createdAt || reviewDeadline <= deliveryDeadline) revert InvalidDeadline();
        JobConfig memory snapshot = _currentConfig();
        jobs[jobId] = Job({
            contractor: msg.sender,
            worker: worker,
            amount: amount,
            agreementHash: agreementHash,
            publicSpecHash: publicSpecHash,
            privateSpecHash: privateSpecHash,
            deliveryDeadline: deliveryDeadline,
            reviewDeadline: reviewDeadline,
            paymentMode: PaymentMode.REVIEW_GATED_DELIVERY_HOLD,
            status: JobStatus.Created,
            createdAt: createdAt,
            acceptanceDeadline: createdAt + WORKER_ACCEPTANCE_PERIOD,
            acceptedAt: 0,
            finalizedAt: 0,
            cancellationReason: "",
            deliveryHandle: "",
            opinionHash: bytes32(0),
            opinionSchemaVersion: "",
            additionalWorkDeadline: 0,
            additionalWorkRefusalReason: "",
            additionalWorkRequestsUsed: 0,
            contractorReviewsUsed: 0,
            configVersion: currentConfigVersion,
            reputationFeeBps: snapshot.reputationFeeBps,
            paymentToken: snapshot.paymentToken
        });

        usdc.safeTransferFrom(msg.sender, address(this), amount + _fee(amount, snapshot.reputationFeeBps));
        emit JobAgreementCreated(
            jobId,
            msg.sender,
            worker,
            amount,
            agreementHash,
            publicSpecHash,
            privateSpecHash,
            deliveryDeadline,
            reviewDeadline
        );
        emit JobConfigSnapshotted(jobId, currentConfigVersion, snapshot.reputationFeeBps, snapshot.paymentToken);
    }

    function createUpfrontJob(
        address worker,
        uint256 amount,
        bytes32 agreementHash,
        bytes32 publicSpecHash,
        bytes32 privateSpecHash,
        uint48 deliveryDeadline,
        uint48 reviewDeadline
    )
        external
        nonReentrant
        returns (uint256 jobId)
    {
        if (newEscrowsPaused) revert NewEscrowsPaused();
        if (worker == address(0)) revert ZeroAddress();
        if (worker == msg.sender) revert SelfJob();
        if (amount == 0) revert ZeroAmount();
        if (agreementHash == bytes32(0) || publicSpecHash == bytes32(0) || privateSpecHash == bytes32(0)) revert EmptyHash();

        uint48 createdAt = uint48(block.timestamp);
        if (deliveryDeadline <= createdAt || reviewDeadline <= deliveryDeadline) revert InvalidDeadline();
        JobConfig memory snapshot = _currentConfig();
        uint256 fee = _fee(amount, snapshot.reputationFeeBps);
        uint256 workerReceived = amount - fee;
        uint256 protocolFee = fee * 2;

        jobId = ++nextJobId;
        jobs[jobId] = Job({
            contractor: msg.sender,
            worker: worker,
            amount: amount,
            agreementHash: agreementHash,
            publicSpecHash: publicSpecHash,
            privateSpecHash: privateSpecHash,
            deliveryDeadline: deliveryDeadline,
            reviewDeadline: reviewDeadline,
            paymentMode: PaymentMode.UPFRONT,
            status: JobStatus.UpfrontPaid,
            createdAt: createdAt,
            acceptanceDeadline: 0,
            acceptedAt: 0,
            finalizedAt: uint48(block.timestamp),
            cancellationReason: "",
            deliveryHandle: "",
            opinionHash: bytes32(0),
            opinionSchemaVersion: "",
            additionalWorkDeadline: 0,
            additionalWorkRefusalReason: "",
            additionalWorkRequestsUsed: 0,
            contractorReviewsUsed: 0,
            configVersion: currentConfigVersion,
            reputationFeeBps: snapshot.reputationFeeBps,
            paymentToken: snapshot.paymentToken
        });

        usdc.safeTransferFrom(msg.sender, address(this), amount + fee);
        usdc.safeTransfer(worker, workerReceived);
        usdc.safeTransfer(treasury, protocolFee);
        emit JobAgreementCreated(
            jobId,
            msg.sender,
            worker,
            amount,
            agreementHash,
            publicSpecHash,
            privateSpecHash,
            deliveryDeadline,
            reviewDeadline
        );
        emit JobConfigSnapshotted(jobId, currentConfigVersion, snapshot.reputationFeeBps, snapshot.paymentToken);
        emit JobReceiptRecorded(jobId, "upfront_paid", amount, workerReceived, 0, protocolFee);
        emit FeedbackRightsRecorded(jobId, true, true);
    }

    function acceptJob(uint256 jobId) external {
        Job storage job = jobs[jobId];
        if (msg.sender != job.worker) revert NotWorker();
        if (job.status != JobStatus.Created) revert WrongState();
        if (block.timestamp >= job.acceptanceDeadline) revert AcceptanceDeadlineExpired();
        job.status = JobStatus.Accepted;
        job.acceptedAt = uint48(block.timestamp);
        emit JobAccepted(jobId, msg.sender);
    }

    function declineJobBeforeAccept(uint256 jobId) external nonReentrant {
        Job storage job = jobs[jobId];
        if (msg.sender != job.worker) revert NotWorker();
        if (job.status != JobStatus.Created) revert WrongState();

        uint256 fullRefund = job.amount + _jobFee(job);
        _finalize(job, JobStatus.DeclinedBeforeAccept);

        usdc.safeTransfer(job.contractor, fullRefund);
        emit JobReceiptRecorded(jobId, "declined", job.amount, 0, fullRefund, 0);
        emit FeedbackRightsRecorded(jobId, false, false);
    }

    function refundBeforeAccept(uint256 jobId) external nonReentrant {
        Job storage job = jobs[jobId];
        if (msg.sender != job.contractor) revert NotContractor();
        if (job.status != JobStatus.Created) revert WrongState();
        if (block.timestamp < job.acceptanceDeadline) revert AcceptanceDeadlineNotReached();

        uint256 fullRefund = job.amount + _jobFee(job);
        _finalize(job, JobStatus.ExpiredBeforeAccept);

        usdc.safeTransfer(job.contractor, fullRefund);
        emit JobReceiptRecorded(jobId, "expired", job.amount, 0, fullRefund, 0);
        emit FeedbackRightsRecorded(jobId, false, false);
    }

    function submitDelivery(uint256 jobId, string calldata deliveryHandle) external {
        if (bytes(deliveryHandle).length == 0) revert EmptyDeliveryHandle();
        Job storage job = jobs[jobId];
        if (msg.sender != job.worker) revert NotWorker();
        if (job.status != JobStatus.Accepted) revert WrongState();
        if (block.timestamp >= job.deliveryDeadline) revert DeliveryDeadlineExpired();

        job.status = JobStatus.SubmittedForReview;
        job.deliveryHandle = deliveryHandle;
        job.contractorReviewsUsed = 1;
        emit DeliverySubmitted(jobId, deliveryHandle);
    }

    function publishOpinionReport(uint256 jobId, bytes32 opinionHash, string calldata opinionSchemaVersion) external {
        if (msg.sender != opinionPublisher) revert NotOpinionPublisher();
        if (opinionHash == bytes32(0)) revert EmptyHash();
        if (bytes(opinionSchemaVersion).length == 0) revert EmptyOpinionSchemaVersion();
        Job storage job = jobs[jobId];
        if (job.status != JobStatus.SubmittedForReview && job.status != JobStatus.ResubmittedForReview) revert WrongState();

        job.status = JobStatus.OpinionPublished;
        job.opinionHash = opinionHash;
        job.opinionSchemaVersion = opinionSchemaVersion;
        emit OpinionReportPublished(jobId, opinionHash, opinionSchemaVersion);
    }

    function requestAdditionalWork(uint256 jobId, string calldata request, uint48 deadline) external {
        if (bytes(request).length == 0) revert EmptyAdditionalWorkRequest();
        Job storage job = jobs[jobId];
        if (msg.sender != job.contractor) revert NotContractor();
        if (
            job.status != JobStatus.SubmittedForReview && job.status != JobStatus.ResubmittedForReview
                && job.status != JobStatus.OpinionPublished
        ) revert WrongState();
        if (job.additionalWorkRequestsUsed >= MAX_ADDITIONAL_WORK_REQUESTS) revert AdditionalWorkLimitReached();
        if (deadline < uint48(block.timestamp) + MIN_ADDITIONAL_WORK_PERIOD) revert AdditionalWorkDeadlineTooSoon();

        job.additionalWorkRequestsUsed += 1;
        job.additionalWorkDeadline = deadline;
        job.additionalWorkRefusalReason = "";
        job.status = JobStatus.AdditionalWorkRequested;
        emit AdditionalWorkRequested(jobId, request, deadline, job.additionalWorkRequestsUsed);
    }

    function resubmitDelivery(uint256 jobId, string calldata deliveryHandle) external {
        if (bytes(deliveryHandle).length == 0) revert EmptyDeliveryHandle();
        Job storage job = jobs[jobId];
        if (msg.sender != job.worker) revert NotWorker();
        if (job.status != JobStatus.AdditionalWorkAccepted) revert WrongState();
        if (block.timestamp >= job.additionalWorkDeadline) revert AdditionalWorkDeadlineExpired();

        job.status = JobStatus.ResubmittedForReview;
        job.deliveryHandle = deliveryHandle;
        job.contractorReviewsUsed += 1;
        emit DeliveryResubmitted(jobId, deliveryHandle, job.contractorReviewsUsed);
    }

    function acceptAdditionalWork(uint256 jobId) external {
        Job storage job = jobs[jobId];
        if (msg.sender != job.worker) revert NotWorker();
        if (job.status != JobStatus.AdditionalWorkRequested) revert WrongState();
        if (block.timestamp >= job.additionalWorkDeadline) revert AdditionalWorkDeadlineExpired();

        job.status = JobStatus.AdditionalWorkAccepted;
        emit AdditionalWorkAccepted(jobId, msg.sender);
    }

    function refuseAdditionalWork(uint256 jobId, string calldata reason) external {
        if (bytes(reason).length == 0) revert EmptyAdditionalWorkRequest();
        Job storage job = jobs[jobId];
        if (msg.sender != job.worker) revert NotWorker();
        if (job.status != JobStatus.AdditionalWorkRequested) revert WrongState();

        job.additionalWorkRefusalReason = reason;
        job.status = JobStatus.AdditionalWorkRefused;
        emit AdditionalWorkRefused(jobId, msg.sender, reason);
    }

    function cancelBeforeDelivery(uint256 jobId, string calldata reason) external nonReentrant {
        if (bytes(reason).length == 0) revert EmptyCancellationReason();
        Job storage job = jobs[jobId];
        if (msg.sender != job.contractor) revert NotContractor();
        if (job.status != JobStatus.Accepted) revert WrongState();

        uint256 fee = _jobFee(job);
        uint256 contractorRefunded = job.amount - fee;
        uint256 protocolFee = fee * 2;
        job.cancellationReason = reason;
        _finalize(job, JobStatus.CancelledBeforeDelivery);

        usdc.safeTransfer(job.contractor, contractorRefunded);
        usdc.safeTransfer(treasury, protocolFee);
        emit JobReceiptRecorded(jobId, "cancelled_before_delivery", job.amount, 0, contractorRefunded, protocolFee);
        emit FeedbackRightsRecorded(jobId, true, true);
    }

    function releaseJob(uint256 jobId) external nonReentrant {
        Job storage job = jobs[jobId];
        if (msg.sender == job.contractor) {
            if (
                job.status != JobStatus.SubmittedForReview && job.status != JobStatus.ResubmittedForReview
                    && job.status != JobStatus.OpinionPublished && job.status != JobStatus.AdditionalWorkRequested
                    && job.status != JobStatus.AdditionalWorkRefused
            ) revert WrongState();
            if (job.status == JobStatus.AdditionalWorkRequested && block.timestamp < job.additionalWorkDeadline) {
                revert AdditionalWorkDeadlineNotReached();
            }
        } else if (msg.sender == job.worker) {
            if (
                job.status != JobStatus.SubmittedForReview && job.status != JobStatus.ResubmittedForReview
                    && job.status != JobStatus.OpinionPublished
            ) revert WrongState();
            if (block.timestamp < job.reviewDeadline) revert ReviewDeadlineNotReached();
        } else {
            revert NotContractor();
        }

        uint256 fee = _jobFee(job);
        uint256 workerReceived = job.amount - fee;
        uint256 protocolFee = fee * 2;
        _finalize(job, JobStatus.Released);

        usdc.safeTransfer(job.worker, workerReceived);
        usdc.safeTransfer(treasury, protocolFee);
        emit JobReceiptRecorded(jobId, "released", job.amount, workerReceived, 0, protocolFee);
        emit FeedbackRightsRecorded(jobId, true, true);
    }

    function cancelAfterReview(uint256 jobId, string calldata reason) external nonReentrant {
        if (bytes(reason).length == 0) revert EmptyCancellationReason();
        Job storage job = jobs[jobId];
        if (msg.sender != job.contractor) revert NotContractor();
        if (
            job.status != JobStatus.SubmittedForReview && job.status != JobStatus.ResubmittedForReview
                && job.status != JobStatus.OpinionPublished && job.status != JobStatus.AdditionalWorkRequested
                && job.status != JobStatus.AdditionalWorkRefused
        ) revert WrongState();
        if (job.status == JobStatus.AdditionalWorkRequested && block.timestamp < job.additionalWorkDeadline) {
            revert AdditionalWorkDeadlineNotReached();
        }

        uint256 fee = _jobFee(job);
        uint256 contractorRefunded = job.amount - fee;
        uint256 protocolFee = fee * 2;
        job.cancellationReason = reason;
        _finalize(job, JobStatus.CancelledAfterReview);

        usdc.safeTransfer(job.contractor, contractorRefunded);
        usdc.safeTransfer(treasury, protocolFee);
        emit JobReceiptRecorded(jobId, "cancelled", job.amount, 0, contractorRefunded, protocolFee);
        emit FeedbackRightsRecorded(jobId, true, true);
    }


    /**
     * @notice Rescue funds for a genuinely stuck review-hold job.
     * @dev This is not a normal settlement path. It is authority-gated and only covers the
     *      current provable stuck terminal condition: W accepted additional work, missed the
     *      additional-work deadline, and C has no normal release/cancel function for that state.
     *      The split is fixed to the existing cancel-after-review economics, so the caller cannot
     *      choose arbitrary vaults, recipients, or amounts. Mainnet deployments must pass a Safe
     *      or timelock as emergencyAuthority with emergencyAuthorityMustBeContract=true.
     */
    function emergencyRescueStuckJob(uint256 jobId, bytes32 reasonHash) external nonReentrant {
        if (msg.sender != emergencyAuthority) revert NotEmergencyAuthority();
        if (emergencyAuthorityMustBeContract && emergencyAuthority.code.length == 0) {
            revert EmergencyAuthorityMustBeContract();
        }
        if (reasonHash == bytes32(0)) revert EmptyRescueReason();

        Job storage job = jobs[jobId];
        if (job.status != JobStatus.AdditionalWorkAccepted || block.timestamp < job.additionalWorkDeadline) {
            revert JobNotEmergencyRescuable();
        }

        uint256 fee = _jobFee(job);
        uint256 contractorRefunded = job.amount - fee;
        uint256 protocolFee = fee * 2;
        _finalize(job, JobStatus.CancelledAfterReview);

        usdc.safeTransfer(job.contractor, contractorRefunded);
        emit EmergencyJobRescue(jobId, reasonHash, job.contractor, contractorRefunded, msg.sender, block.timestamp);
        usdc.safeTransfer(treasury, protocolFee);
        emit EmergencyJobRescue(jobId, reasonHash, treasury, protocolFee, msg.sender, block.timestamp);
        emit JobReceiptRecorded(jobId, "emergency_rescue", job.amount, 0, contractorRefunded, protocolFee);
        emit FeedbackRightsRecorded(jobId, true, true);
    }

    function workerWithdrawAfterAccept(uint256 jobId) external nonReentrant {
        Job storage job = jobs[jobId];
        if (msg.sender != job.worker) revert NotWorker();
        if (job.status != JobStatus.Accepted) revert WrongState();

        uint256 fee = _jobFee(job);
        uint256 contractorRefunded = job.amount;
        _finalize(job, JobStatus.WorkerWithdrawn);

        usdc.safeTransfer(job.contractor, contractorRefunded);
        usdc.safeTransfer(treasury, fee);
        emit JobReceiptRecorded(jobId, "withdrawn", job.amount, 0, contractorRefunded, fee);
        emit FeedbackRightsRecorded(jobId, true, false);
    }

    function _finalize(Job storage job, JobStatus status) private {
        job.status = status;
        job.finalizedAt = uint48(block.timestamp);
    }

    function _currentConfig() private view returns (JobConfig memory) {
        return configByVersion[currentConfigVersion];
    }

    function _jobFee(Job storage job) private view returns (uint256) {
        return _fee(job.amount, job.reputationFeeBps);
    }

    function _fee(uint256 amount, uint16 feeBps) private pure returns (uint256) {
        return (amount * feeBps) / BPS_BASE;
    }
}
