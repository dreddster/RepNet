// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title RepNetDKGAnchors
 * @notice Minimal sidecar for publishing RepNet → OriginTrail DKG anchor events.
 *
 * @dev This contract intentionally does not store anchor state. RepNet core
 *      settlement contracts stay the source of truth; this sidecar emits a
 *      normalized event that indexers, publishers, dashboards, and agents can
 *      consume without bloating RepNetEscrow, which is already near EIP-170.
 *
 *      Use recordAnchor() for public/safe locators. Use recordAnchorHashOnly()
 *      for private or sensitive payloads where the locator itself should not be
 *      emitted publicly. Private content must never be written into event data.
 */
contract RepNetDKGAnchors is Ownable {
    /// @notice RepNet contract suite release identifier.
    string public constant REPNET_VERSION = "v10";

    enum AnchorType {
        AgentProfile,
        Agreement,
        Delivery,
        Evidence,
        Feedback,
        DisputeReasoning
    }

    enum DKGStatus {
        None,
        Tentative,
        Confirmed,
        Failed
    }

    mapping(address => bool) public authorizedPublishers;

    event PublisherUpdated(address indexed publisher, bool authorized);

    event DKGAnchorRecorded(
        AnchorType indexed anchorType,
        uint256 indexed subjectId,
        bytes32 indexed locatorHash,
        bytes32 contentHash,
        bytes32 publicRoot,
        bytes32 privateRoot,
        DKGStatus status,
        string locator
    );

    error ZeroAddress();
    error NotAuthorizedPublisher();
    error EmptyLocator();
    error InvalidDKGStatus();
    error EmptyLocatorHash();

    constructor(address initialOwner) Ownable(initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
    }

    modifier onlyPublisher() {
        if (!authorizedPublishers[msg.sender]) revert NotAuthorizedPublisher();
        _;
    }

    /**
     * @notice Authorize or revoke a DKG publisher/gateway address.
     */
    function setPublisher(address publisher, bool authorized) external onlyOwner {
        if (publisher == address(0)) revert ZeroAddress();
        authorizedPublishers[publisher] = authorized;
        emit PublisherUpdated(publisher, authorized);
    }

    /**
     * @notice Record a public DKG anchor with an emitted locator.
     * @dev Use only for locators that are safe to expose in public event logs.
     */
    function recordAnchor(
        AnchorType anchorType,
        uint256 subjectId,
        string calldata locator,
        bytes32 contentHash,
        bytes32 publicRoot,
        bytes32 privateRoot,
        DKGStatus status
    ) external onlyPublisher {
        if (bytes(locator).length == 0) revert EmptyLocator();
        _validateStatus(status);

        emit DKGAnchorRecorded(
            anchorType,
            subjectId,
            keccak256(bytes(locator)),
            contentHash,
            publicRoot,
            privateRoot,
            status,
            locator
        );
    }

    /**
     * @notice Record a DKG anchor commitment without emitting the locator.
     * @dev Intended for private/sensitive artifacts such as dispute evidence.
     */
    function recordAnchorHashOnly(
        AnchorType anchorType,
        uint256 subjectId,
        bytes32 locatorHash,
        bytes32 contentHash,
        bytes32 publicRoot,
        bytes32 privateRoot,
        DKGStatus status
    ) external onlyPublisher {
        if (locatorHash == bytes32(0)) revert EmptyLocatorHash();
        _validateStatus(status);

        emit DKGAnchorRecorded(
            anchorType,
            subjectId,
            locatorHash,
            contentHash,
            publicRoot,
            privateRoot,
            status,
            ""
        );
    }

    function _validateStatus(DKGStatus status) internal pure {
        if (status == DKGStatus.None) revert InvalidDKGStatus();
    }
}
