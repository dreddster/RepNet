// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./IdentityRegistry.sol";

/**
 * @title ReputationRegistry
 * @notice ERC-8004 compatible bidirectional feedback registry.
 *         Both contractors and workers leave feedback after each job.
 *         Feedback is on-chain, composable, and filterable by tags.
 *         No scoring or ratings — stores raw interaction data.
 *         Consuming agents query receipts and form their own assessments.
 *
 * @dev Anti-gaming is handled at the publisher layer (off-chain), not on-chain.
 *      The publisher decides what gets published to DKG based on pair frequency,
 *      burst detection, diversity decay, and graph analysis. The contract is a
 *      permissionless event log — anyone can write, publisher curates what matters.
 *
 * v5 changes:
 *   - Removed on-chain rate limiting (publisher handles anti-gaming)
 *   - Added jobId to giveFeedback() for escrow job linking
 *
 * v3 changes (no-ratings alignment):
 *   - value field is binary satisfaction (1=satisfied, 0=not)
 *   - feedbackSum replaced with satisfiedCount (factual, not averaged)
 *   - No computed scores — raw data only
 *
 * v2 changes:
 *   - Running totals instead of unbounded getSummary() loop
 *   - Sender must be a registered agent (prevents spam)
 *   - Self-feedback prevention
 */
contract ReputationRegistry is ReentrancyGuard, Pausable, Ownable {
    /// @notice RepNet contract suite release identifier.
    string public constant REPNET_VERSION = "v10";

    struct AgentIdentity {
        address registry;
        uint256 agentId;
    }

    struct Feedback {
        address from;             // Wallet that gave feedback
        AgentIdentity fromAgent;  // Full identity of feedback giver
        AgentIdentity targetAgent;// Full identity of target
        int128 value;             // Binary satisfaction (1=satisfied, 0=not satisfied)
        string tag1;              // Primary tag (e.g., "repnet-job", "repnet-contractor", "flag")
        string tag2;              // Secondary tag (e.g., job category)
        string feedbackURI;       // Payment tx, escrow job, or verifiable job proof reference
        uint256 jobId;            // Optional escrow job ID (0 = not linked to a job)
        uint256 timestamp;
    }

    /// @notice All feedback entries
    Feedback[] public feedbacks;

    /// @notice Feedback IDs per target agent (keyed by identity hash)
    mapping(bytes32 => uint256[]) public agentFeedbackIds;

    /// @notice Running totals per agent (keyed by identity hash)
    mapping(bytes32 => uint256) public feedbackCount;
    mapping(bytes32 => uint256) public satisfiedCount;

    /// @notice Reference to identity registry for validation
    IdentityRegistry public immutable identityRegistry;

    event FeedbackGiven(
        uint256 indexed feedbackId,
        address indexed from,
        address targetRegistry,
        uint256 targetAgentId,
        address fromRegistry,
        uint256 fromAgentId,
        int128 value,
        string tag1,
        string tag2,
        uint256 jobId
    );

    // ──────────────────────────────────────────
    //  CUSTOM ERRORS
    // ──────────────────────────────────────────
    error ZeroAddress();
    error SenderNotRegistered();
    error TargetNotRegistered();
    error CannotReviewSelf();
    error InvalidValue();
    error FeedbackNotFound();

    constructor(address _identityRegistry) Ownable(msg.sender) {
        if (_identityRegistry == address(0)) revert ZeroAddress();
        identityRegistry = IdentityRegistry(_identityRegistry);
    }

    /// @notice G11: Emergency pause — blocks new feedback submissions
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice G11: Unpause — re-enables feedback submissions
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice Give feedback to an agent (by wallet address).
     *         Sender must be a registered agent (local or external).
     *         No on-chain rate limiting — anti-gaming is at the publisher layer.
     * @param targetWallet The wallet address of the agent receiving feedback
     * @param value Binary satisfaction (1=satisfied, 0=not satisfied)
     * @param tag1 Primary tag for filtering
     * @param tag2 Secondary tag for filtering
     * @param feedbackURI Payment tx, escrow job, or verifiable job proof reference available at feedback time
     * @param jobId Optional escrow job ID to link feedback to (0 = unlinked)
     */
    function giveFeedback(
        address targetWallet,
        int128 value,
        string calldata tag1,
        string calldata tag2,
        string calldata feedbackURI,
        uint256 jobId
    ) external nonReentrant whenNotPaused returns (uint256) {
        // Sender must be registered (local or external)
        if (!identityRegistry.isRegisteredWallet(msg.sender)) revert SenderNotRegistered();
        IdentityRegistry.AgentIdentity memory fromIdentity = identityRegistry.getAgentIdentity(msg.sender);

        // Target must be registered (local or external)
        if (!identityRegistry.isRegisteredWallet(targetWallet)) revert TargetNotRegistered();
        IdentityRegistry.AgentIdentity memory targetIdentity = identityRegistry.getAgentIdentity(targetWallet);

        // Cannot review yourself
        bytes32 fromKey = keccak256(abi.encode(fromIdentity.registry, fromIdentity.agentId));
        bytes32 targetKey = keccak256(abi.encode(targetIdentity.registry, targetIdentity.agentId));
        if (fromKey == targetKey) revert CannotReviewSelf();

        // Value must be binary
        if (value != 0 && value != 1) revert InvalidValue();

        uint256 feedbackId = feedbacks.length;

        feedbacks.push(Feedback({
            from: msg.sender,
            fromAgent: AgentIdentity(fromIdentity.registry, fromIdentity.agentId),
            targetAgent: AgentIdentity(targetIdentity.registry, targetIdentity.agentId),
            value: value,
            tag1: tag1,
            tag2: tag2,
            feedbackURI: feedbackURI,
            jobId: jobId,
            timestamp: block.timestamp
        }));

        agentFeedbackIds[targetKey].push(feedbackId);

        // Running totals — O(1) instead of O(n) on read
        feedbackCount[targetKey]++;
        if (value == 1) {
            satisfiedCount[targetKey]++;
        }

        _emitFeedbackWithIdentity(feedbackId, fromIdentity, targetIdentity, value, tag1, tag2, jobId);
        return feedbackId;
    }

    /**
     * @dev Split emit into helper to avoid stack-too-deep in giveFeedback.
     */
    function _emitFeedbackWithIdentity(
        uint256 feedbackId,
        IdentityRegistry.AgentIdentity memory fromIdentity,
        IdentityRegistry.AgentIdentity memory targetIdentity,
        int128 value,
        string calldata tag1,
        string calldata tag2,
        uint256 jobId
    ) internal {
        emit FeedbackGiven(
            feedbackId,
            msg.sender,
            targetIdentity.registry,
            targetIdentity.agentId,
            fromIdentity.registry,
            fromIdentity.agentId,
            value,
            tag1,
            tag2,
            jobId
        );
    }

    /**
     * @notice Get feedback IDs for an agent by wallet address.
     * @param wallet The wallet address to query
     * @return Array of feedback IDs
     */
    function getAgentFeedbackIdsByWallet(address wallet) external view returns (uint256[] memory) {
        IdentityRegistry.AgentIdentity memory identity = identityRegistry.getAgentIdentity(wallet);
        bytes32 key = keccak256(abi.encode(identity.registry, identity.agentId));
        return agentFeedbackIds[key];
    }

    /**
     * @notice Get feedback IDs for an agent by local agentId (legacy support, returns all).
     * @dev For large result sets, prefer getAgentFeedbackIdsPaginated() to avoid gas issues.
     * @param agentId The local agent ID to query
     * @return Array of feedback IDs
     */
    function getAgentFeedbackIds(uint256 agentId) external view returns (uint256[] memory) {
        bytes32 key = keccak256(abi.encode(address(identityRegistry), agentId));
        return agentFeedbackIds[key];
    }

    /**
     * @notice Get paginated feedback IDs for an agent by wallet address.
     * @dev Wallet addressing supports both local and externally-linked identities.
     * @param wallet The wallet address to query
     * @param offset Start index in the feedback IDs array
     * @param limit Maximum number of IDs to return
     * @return Array slice of feedback IDs
     */
    function getAgentFeedbackIdsByWalletPaginated(
        address wallet,
        uint256 offset,
        uint256 limit
    ) external view returns (uint256[] memory) {
        IdentityRegistry.AgentIdentity memory identity = identityRegistry.getAgentIdentity(wallet);
        bytes32 key = keccak256(abi.encode(identity.registry, identity.agentId));
        return _feedbackIdsSlice(key, offset, limit);
    }

    /**
     * @notice G12: Get paginated feedback IDs for an agent by local agentId.
     * @param agentId The local agent ID to query
     * @param offset Start index in the feedback IDs array
     * @param limit Maximum number of IDs to return
     * @return Array slice of feedback IDs
     */
    function getAgentFeedbackIdsPaginated(
        uint256 agentId,
        uint256 offset,
        uint256 limit
    ) external view returns (uint256[] memory) {
        bytes32 key = keccak256(abi.encode(address(identityRegistry), agentId));
        return _feedbackIdsSlice(key, offset, limit);
    }

    function _feedbackIdsSlice(
        bytes32 key,
        uint256 offset,
        uint256 limit
    ) internal view returns (uint256[] memory) {
        uint256[] storage ids = agentFeedbackIds[key];
        uint256 total = ids.length;

        if (offset >= total) {
            return new uint256[](0);
        }

        uint256 end = offset + limit;
        if (end > total) {
            end = total;
        }

        uint256 resultLen = end - offset;
        uint256[] memory result = new uint256[](resultLen);
        for (uint256 i = 0; i < resultLen;) {
            result[i] = ids[offset + i];
            unchecked { ++i; }
        }
        return result;
    }

    /**
     * @notice Get a specific feedback entry.
     * @param feedbackId The feedback ID
     */
    function getFeedback(uint256 feedbackId) external view returns (Feedback memory) {
        if (feedbackId >= feedbacks.length) revert FeedbackNotFound();
        return feedbacks[feedbackId];
    }

    /**
     * @notice Get total feedback count across all agents.
     */
    function totalFeedbacks() external view returns (uint256) {
        return feedbacks.length;
    }

    /**
     * @notice Get summary stats for an agent by wallet address.
     * @param wallet The wallet address to query
     * @return count Total feedback count
     * @return satisfied Number of satisfied feedbacks
     */
    function getSummaryByWallet(address wallet) external view returns (uint256 count, uint256 satisfied) {
        IdentityRegistry.AgentIdentity memory identity = identityRegistry.getAgentIdentity(wallet);
        bytes32 key = keccak256(abi.encode(identity.registry, identity.agentId));
        count = feedbackCount[key];
        satisfied = satisfiedCount[key];
    }

    /**
     * @notice Get summary stats for an agent by local agentId (legacy support).
     * @param agentId The local agent ID to query
     * @return count Total feedback count
     * @return satisfied Number of satisfied feedbacks
     */
    function getSummary(uint256 agentId) external view returns (uint256 count, uint256 satisfied) {
        bytes32 key = keccak256(abi.encode(address(identityRegistry), agentId));
        count = feedbackCount[key];
        satisfied = satisfiedCount[key];
    }

    /**
     * @notice Compute identity hash for a given registry and agentId.
     * @param registry The registry address
     * @param agentId The agent ID
     * @return The identity hash key
     */
    function getIdentityKey(address registry, uint256 agentId) external pure returns (bytes32) {
        return keccak256(abi.encode(registry, agentId));
    }
}
