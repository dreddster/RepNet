// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title IdentityRegistry
 * @notice ERC-8004 compatible agent identity registry.
 *         Each agent gets an ERC-721 NFT with a URI pointing to their
 *         A2A Agent Card. The agentWallet is the address authorized
 *         to sign on behalf of the agent (EIP-712 verified).
 *
 *         Also handles paid registration (formerly in RepNetRegistration):
 *         - registerWithFee(): Individual registration with USDC payment
 *         - registerBulkForPlatform(): Approved platform bulk registration
 *         - Fee configuration (setRegistrationFee, setFeeEnabled, setRegistrationTreasury)
 *         - Platform approval (approvePlatform, revokePlatform)
 *
 * @dev SECURITY: Owner should be a multisig wallet (e.g., Gnosis Safe) in
 *      production. On testnet, a single EOA is used for development speed.
 *      Owner controls: registrar management, pause/unpause, fee config, platform approval.
 *      See deploy script for owner configuration.
 *
 * v2 changes:
 *   - Ownable instead of custom admin (transferable, standard)
 *   - burn() for key compromise / unregistration
 *   - _update() override to sync walletToAgent on NFT transfers
 *
 * v3 changes:
 *   - Merged RepNetRegistration logic (paid registration, platform bulk, fee config)
 */
contract IdentityRegistry is ERC721URIStorage, EIP712, Ownable, Pausable, ReentrancyGuard {
    using ECDSA for bytes32;

    /// @notice RepNet contract suite release identifier.
    string public constant REPNET_VERSION = "v10";
    using SafeERC20 for IERC20;

    uint256 private _nextAgentId = 1;

    /// @notice Mapping from agentId to authorized agent wallet
    mapping(uint256 => address) public agentWallet;

    /// @notice Mapping from wallet address to agentId (reverse lookup)
    mapping(address => uint256) public walletToAgent;

    /// @notice EIP-712 typehash for setAgentWallet delegation
    bytes32 public constant SET_WALLET_TYPEHASH =
        keccak256("SetAgentWallet(uint256 agentId,address newWallet,uint256 nonce,uint256 deadline)");

    /// @notice Nonce per agentId for replay protection
    mapping(uint256 => uint256) public walletNonces;

    /// @notice Addresses authorized to call registerFor (e.g., external contracts)
    mapping(address => bool) public authorizedRegistrars;

    /// @notice Approved external ERC-8004 registries
    mapping(address => bool) public approvedRegistries;
    address[] public approvedRegistryList;

    /// @notice External agent identity mapping
    struct ExternalIdentity {
        address registry;
        uint256 agentId;
    }
    mapping(address => ExternalIdentity) public externalAgents;

    /// @notice Universal agent identity struct
    struct AgentIdentity {
        address registry;
        uint256 agentId;
    }

    // ──────────────────────────────────────────
    //  REGISTRATION FEE STATE (merged from RepNetRegistration)
    // ──────────────────────────────────────────

    /// @notice USDC token for registration fees
    IERC20 public usdc;

    /// @notice Treasury address for registration fees
    address public registrationTreasury;

    /// @notice Registration fee in USDC (6 decimals). Default: $10
    uint256 public registrationFee;

    /// @notice Whether registration fee is currently charged. Off at launch to bootstrap.
    bool public feeEnabled;

    /// @notice Approved platforms that can bulk-register agents for free
    mapping(address => bool) public approvedPlatforms;

    /// @notice Maximum agents per bulk registration (adjustable by owner)
    uint256 public maxBulkBatch;

    /// @notice Total paid registrations counter
    uint256 public totalPaidRegistrations;

    /// @notice Safety rails for registration fee (adjustable by owner)
    uint256 public minRegistrationFee;
    uint256 public maxRegistrationFee;

    // ──────────────────────────────────────────
    //  EVENTS
    // ──────────────────────────────────────────

    event AgentRegistered(uint256 indexed agentId, address indexed owner, string agentURI);
    event AgentWalletSet(uint256 indexed agentId, address indexed oldWallet, address indexed newWallet);
    event RegistrarUpdated(address indexed registrar, bool authorized);
    event AgentBurned(uint256 indexed agentId, address indexed owner);
    event ExternalAgentLinked(address indexed wallet, address indexed registry, uint256 agentId);
    event RegistryApproved(address indexed registry);
    event RegistryRevoked(address indexed registry);

    // Registration fee events (from RepNetRegistration)
    event AgentRegisteredViaRepNet(uint256 indexed agentId, address indexed owner, bool feePaid);
    event PlatformApproved(address indexed platform);
    event PlatformRevoked(address indexed platform);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event FeeToggled(bool enabled);
    event RegistrationFeeUpdated(uint256 oldFee, uint256 newFee);

    // ──────────────────────────────────────────
    //  CUSTOM ERRORS
    // ──────────────────────────────────────────
    error EmptyURI();
    error AlreadyRegistered();
    error NotAuthorizedRegistrar();
    error NotApprovedPlatform();
    error ArrayLengthMismatch();
    error BatchTooLarge();
    error NotAgentOwner();
    error RegistryNotApproved();
    error AlreadyRegisteredLocally();
    error AlreadyLinkedExternally();
    error NotExternalOwner();
    error ZeroAddress();
    error WalletAlreadyBound();
    error InvalidWalletSignature();
    error SignatureExpired();
    error USDCNotConfigured();
    error TreasuryNotConfigured();
    error FeeBelowMinimum();
    error FeeAboveMaximum();
    error MinExceedsMax();
    error InvalidBatch();

    constructor()
        ERC721("RepNet Agent Identity", "RepNet-ID")
        EIP712("RepNet Protocol", "1")
        Ownable(msg.sender)
    {
        // Registration fee defaults
        registrationFee = 10 * 1e6;        // $10 USDC
        minRegistrationFee = 1 * 1e6;      // $1 minimum
        maxRegistrationFee = 100 * 1e6;    // $100 maximum
        maxBulkBatch = 50;
        feeEnabled = false;
    }

    // ──────────────────────────────────────────
    //  REGISTRATION (original)
    // ──────────────────────────────────────────

    /**
     * @notice Register a new agent identity.
     * @param agentURI URI pointing to the agent's A2A Agent Card JSON
     * @return agentId The new agent's ID
     */
    function register(string calldata agentURI) external nonReentrant whenNotPaused returns (uint256) {
        if (bytes(agentURI).length == 0) revert EmptyURI();
        if (walletToAgent[msg.sender] != 0) revert AlreadyRegistered();

        uint256 agentId = _nextAgentId++;

        // EFFECTS: reserve wallet binding before _safeMint can call ERC721 receiver hooks.
        // If minting reverts, these writes revert too.
        agentWallet[agentId] = msg.sender;
        walletToAgent[msg.sender] = agentId;

        _safeMint(msg.sender, agentId);
        _setTokenURI(agentId, agentURI);

        emit AgentRegistered(agentId, msg.sender, agentURI);
        return agentId;
    }

    /**
     * @notice Register an agent on behalf of another address.
     *         Only callable by authorized registrars (e.g., external contracts).
     * @param owner_ The address that will own the identity NFT
     * @param agentURI URI pointing to the agent's A2A Agent Card JSON
     * @return agentId The new agent's ID
     */
    function registerFor(address owner_, string calldata agentURI) external nonReentrant whenNotPaused returns (uint256) {
        if (bytes(agentURI).length == 0) revert EmptyURI();
        if (!authorizedRegistrars[msg.sender]) revert NotAuthorizedRegistrar();
        if (walletToAgent[owner_] != 0) revert AlreadyRegistered();

        uint256 agentId = _nextAgentId++;

        // EFFECTS: reserve wallet binding before _safeMint can call ERC721 receiver hooks.
        // If minting reverts, these writes revert too.
        agentWallet[agentId] = owner_;
        walletToAgent[owner_] = agentId;

        _safeMint(owner_, agentId);
        _setTokenURI(agentId, agentURI);

        emit AgentRegistered(agentId, owner_, agentURI);
        return agentId;
    }

    // ──────────────────────────────────────────
    //  PAID REGISTRATION (merged from RepNetRegistration)
    // ──────────────────────────────────────────

    /**
     * @notice Register an individual agent with fee payment.
     *         Pays fee (if enabled) + mints identity NFT in one tx.
     * @param agentURI URI pointing to the agent's A2A Agent Card JSON
     * @return agentId The new agent's ID
     */
    function registerWithFee(string calldata agentURI) external nonReentrant whenNotPaused returns (uint256) {
        if (bytes(agentURI).length == 0) revert EmptyURI();
        if (walletToAgent[msg.sender] != 0) revert AlreadyRegistered();

        // EFFECTS: Update state before external calls (CEI)
        totalPaidRegistrations++;

        // INTERACTIONS: External calls
        if (feeEnabled) {
            if (address(usdc) == address(0)) revert USDCNotConfigured();
            if (registrationTreasury == address(0)) revert TreasuryNotConfigured();
            usdc.safeTransferFrom(msg.sender, registrationTreasury, registrationFee);
        }

        // Mint identity NFT
        uint256 agentId = _nextAgentId++;

        // EFFECTS: reserve wallet binding before _safeMint can call ERC721 receiver hooks.
        // If minting reverts, these writes revert too.
        agentWallet[agentId] = msg.sender;
        walletToAgent[msg.sender] = agentId;

        _safeMint(msg.sender, agentId);
        _setTokenURI(agentId, agentURI);

        emit AgentRegistered(agentId, msg.sender, agentURI);
        emit AgentRegisteredViaRepNet(agentId, msg.sender, feeEnabled);
        return agentId;
    }

    /**
     * @notice Platform bulk-registers agents (no fee).
     *         Only approved platforms can call this.
     * @param agents Array of agent owner addresses
     * @param agentURIs Array of agent URIs
     */
    // slither-disable-next-line calls-loop
    function registerBulkForPlatform(
        address[] calldata agents,
        string[] calldata agentURIs
    ) external nonReentrant whenNotPaused {
        if (!approvedPlatforms[msg.sender]) revert NotApprovedPlatform();
        if (agents.length != agentURIs.length) revert ArrayLengthMismatch();
        if (agents.length > maxBulkBatch) revert BatchTooLarge();

        // EFFECTS: Batch increment before external calls (CEI)
        totalPaidRegistrations += agents.length;

        // INTERACTIONS: Register each agent
        for (uint256 i = 0; i < agents.length;) {
            if (bytes(agentURIs[i]).length == 0) revert EmptyURI();
            if (walletToAgent[agents[i]] != 0) revert AlreadyRegistered();

            uint256 agentId = _nextAgentId++;

            // EFFECTS: reserve wallet binding before _safeMint can call ERC721 receiver hooks.
            // If minting reverts, these writes revert too.
            agentWallet[agentId] = agents[i];
            walletToAgent[agents[i]] = agentId;

            _safeMint(agents[i], agentId);
            _setTokenURI(agentId, agentURIs[i]);

            emit AgentRegistered(agentId, agents[i], agentURIs[i]);
            emit AgentRegisteredViaRepNet(agentId, agents[i], false);
            unchecked { ++i; }
        }
    }

    /**
     * @notice Check if registration is currently free (fee disabled).
     */
    function isFreeTier() external view returns (bool) {
        return !feeEnabled;
    }

    // ──────────────────────────────────────────
    //  IDENTITY MANAGEMENT
    // ──────────────────────────────────────────

    /**
     * @notice Burn an agent identity (unregister).
     *         Clears wallet mapping. Use if key is compromised.
     * @param agentId The agent ID to burn
     */
    function burn(uint256 agentId) external nonReentrant {
        if (ownerOf(agentId) != msg.sender) revert NotAgentOwner();

        address wallet = agentWallet[agentId];
        if (wallet != address(0)) {
            walletToAgent[wallet] = 0;
        }
        agentWallet[agentId] = address(0);

        _burn(agentId);
        emit AgentBurned(agentId, msg.sender);
    }

    /**
     * @notice Emergency pause — blocks new registrations.
     * @dev In production, owner MUST be a multisig (e.g., Gnosis Safe).
     */
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice Authorize or revoke a registrar address.
     * @param registrar The address to authorize/revoke
     * @param authorized Whether to authorize or revoke
     */
    function setRegistrar(address registrar, bool authorized) external onlyOwner {
        authorizedRegistrars[registrar] = authorized;
        emit RegistrarUpdated(registrar, authorized);
    }

    /**
     * @notice Approve an external ERC-8004 registry.
     * @param registry The registry address to approve
     */
    function approveRegistry(address registry) external onlyOwner {
        approvedRegistries[registry] = true;
        approvedRegistryList.push(registry);
        emit RegistryApproved(registry);
    }

    /**
     * @notice Revoke approval of an external registry.
     * @param registry The registry address to revoke
     */
    function revokeRegistry(address registry) external onlyOwner {
        approvedRegistries[registry] = false;
        emit RegistryRevoked(registry);
    }

    /**
     * @notice Register using an external ERC-8004 identity.
     * @param externalRegistry The approved external registry address
     * @param externalAgentId The agent ID in the external registry
     */
    function registerExternal(
        address externalRegistry,
        uint256 externalAgentId
    ) external nonReentrant whenNotPaused {
        if (!approvedRegistries[externalRegistry]) revert RegistryNotApproved();
        if (walletToAgent[msg.sender] != 0) revert AlreadyRegisteredLocally();
        if (externalAgents[msg.sender].registry != address(0)) revert AlreadyLinkedExternally();
        if (IERC721(externalRegistry).ownerOf(externalAgentId) != msg.sender) revert NotExternalOwner();

        externalAgents[msg.sender] = ExternalIdentity(externalRegistry, externalAgentId);
        emit ExternalAgentLinked(msg.sender, externalRegistry, externalAgentId);
    }

    /**
     * @notice Set or change the agent wallet via EIP-712 signature.
     *         Requires signatures from both the NFT owner AND the new wallet
     *         to prevent unauthorized delegation.
     * @param agentId The agent ID
     * @param newWallet The new wallet address to authorize
     * @param newWalletSig EIP-712 signature from the new wallet
     * @param deadline Last timestamp at which the new wallet consent is valid
     */
    function setAgentWallet(
        uint256 agentId,
        address newWallet,
        bytes calldata newWalletSig,
        uint256 deadline
    ) external nonReentrant {
        if (ownerOf(agentId) != msg.sender) revert NotAgentOwner();
        if (newWallet == address(0)) revert ZeroAddress();
        if (walletToAgent[newWallet] != 0) revert WalletAlreadyBound();
        if (block.timestamp > deadline) revert SignatureExpired();

        // Verify the new wallet signed the delegation
        uint256 nonce = walletNonces[agentId]++;
        bytes32 structHash = keccak256(
            abi.encode(SET_WALLET_TYPEHASH, agentId, newWallet, nonce, deadline)
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        address recovered = ECDSA.recover(digest, newWalletSig);
        if (recovered != newWallet) revert InvalidWalletSignature();

        // Clear old mapping
        address oldWallet = agentWallet[agentId];
        if (oldWallet != address(0)) {
            walletToAgent[oldWallet] = 0;
        }

        // Set new wallet
        agentWallet[agentId] = newWallet;
        walletToAgent[newWallet] = agentId;

        emit AgentWalletSet(agentId, oldWallet, newWallet);
    }

    /**
     * @notice Update the agent's URI (A2A Agent Card).
     * @param agentId The agent ID
     * @param newURI New URI pointing to updated Agent Card
     */
    function updateAgentURI(uint256 agentId, string calldata newURI) external nonReentrant {
        if (ownerOf(agentId) != msg.sender) revert NotAgentOwner();
        _setTokenURI(agentId, newURI);
    }

    /**
     * @dev Override ERC-721 _update to sync walletToAgent on transfers.
     *      When an NFT is transferred, the agentWallet stays the same
     *      but we allow the new owner to reassign it via setAgentWallet.
     */
    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal override returns (address) {
        address from = super._update(to, tokenId, auth);

        // On transfer (not mint/burn — those are handled explicitly):
        // Clear the old wallet→agent mapping since the owner changed.
        // The new owner must call setAgentWallet to bind a wallet.
        if (from != address(0) && to != address(0)) {
            address wallet = agentWallet[tokenId];
            if (wallet != address(0)) {
                walletToAgent[wallet] = 0;
                agentWallet[tokenId] = address(0);
            }
        }

        return from;
    }

    // ──────────────────────────────────────────
    //  REGISTRATION FEE ADMIN (merged from RepNetRegistration)
    // ──────────────────────────────────────────

    /**
     * @notice Configure the USDC token and treasury for registration fees.
     *         Must be called before enabling fees.
     * @param _usdc USDC token address
     * @param _treasury Treasury address for fee collection
     */
    function configureRegistrationFee(address _usdc, address _treasury) external onlyOwner {
        if (_usdc == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();
        usdc = IERC20(_usdc);
        registrationTreasury = _treasury;
    }

    function approvePlatform(address platform) external onlyOwner {
        approvedPlatforms[platform] = true;
        emit PlatformApproved(platform);
    }

    function revokePlatform(address platform) external onlyOwner {
        approvedPlatforms[platform] = false;
        emit PlatformRevoked(platform);
    }

    function setFeeEnabled(bool enabled) external onlyOwner {
        feeEnabled = enabled;
        emit FeeToggled(enabled);
    }

    function setRegistrationTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(registrationTreasury, newTreasury);
        registrationTreasury = newTreasury;
    }

    /**
     * @notice Update the registration fee. Bounded by adjustable min/max.
     * @param newFee New fee in USDC (6 decimals).
     */
    function setRegistrationFee(uint256 newFee) external onlyOwner {
        if (newFee < minRegistrationFee) revert FeeBelowMinimum();
        if (newFee > maxRegistrationFee) revert FeeAboveMaximum();
        emit RegistrationFeeUpdated(registrationFee, newFee);
        registrationFee = newFee;
    }

    /**
     * @notice Update registration fee bounds.
     * @param _min New minimum registration fee in USDC (6 decimals)
     * @param _max New maximum registration fee in USDC (6 decimals)
     */
    function setRegistrationFeeBounds(uint256 _min, uint256 _max) external onlyOwner {
        if (_min > _max) revert MinExceedsMax();
        minRegistrationFee = _min;
        maxRegistrationFee = _max;
        if (registrationFee < _min) {
            registrationFee = _min;
        } else if (registrationFee > _max) {
            registrationFee = _max;
        }
    }

    /**
     * @notice Update maximum bulk registration batch size.
     * @param _maxBatch New maximum (minimum 1)
     */
    function setMaxBulkBatch(uint256 _maxBatch) external onlyOwner {
        if (_maxBatch < 1) revert InvalidBatch();
        maxBulkBatch = _maxBatch;
    }

    // ──────────────────────────────────────────
    //  VIEWS
    // ──────────────────────────────────────────

    /**
     * @notice Get the next agent ID (total registered + 1).
     */
    function nextAgentId() external view returns (uint256) {
        return _nextAgentId;
    }

    /**
     * @notice Lookup agentId by wallet address.
     * @param wallet The wallet address to look up
     * @return agentId (0 if not found)
     */
    function getAgentByWallet(address wallet) external view returns (uint256) {
        return walletToAgent[wallet];
    }

    /**
     * @notice Check if an address is a registered agent wallet (local or external).
     */
    function isRegisteredWallet(address wallet) external view returns (bool) {
        if (walletToAgent[wallet] != 0) return true;
        ExternalIdentity memory ext = externalAgents[wallet];
        if (ext.registry != address(0) && approvedRegistries[ext.registry]) {
            try IERC721(ext.registry).ownerOf(ext.agentId) returns (address owner) {
                return owner == wallet;
            } catch {
                return false;
            }
        }
        return false;
    }

    /**
     * @notice Get the full agent identity for a wallet address.
     * @param wallet The wallet address to look up
     * @return The AgentIdentity (registry address + agentId)
     */
    function getAgentIdentity(address wallet) external view returns (AgentIdentity memory) {
        uint256 localId = walletToAgent[wallet];
        if (localId != 0) {
            return AgentIdentity(address(this), localId);
        }
        ExternalIdentity memory ext = externalAgents[wallet];
        if (ext.registry != address(0) && approvedRegistries[ext.registry]) {
            return AgentIdentity(ext.registry, ext.agentId);
        }
        return AgentIdentity(address(0), 0);
    }
}
