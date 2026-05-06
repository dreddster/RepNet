// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

interface IIdentityRegistryForReentrancyTest {
    function register(string calldata agentURI) external returns (uint256);
    function registerWithFee(string calldata agentURI) external returns (uint256);
    function burn(uint256 agentId) external;
    function updateAgentURI(uint256 agentId, string calldata newURI) external;
}

contract MockIdentityReentrantReceiver is IERC721Receiver {
    enum AttackMode {
        Register,
        RegisterWithFee,
        Burn,
        UpdateURI
    }

    IIdentityRegistryForReentrancyTest public immutable identity;
    bool public attackEnabled;
    AttackMode public attackMode;
    uint256 public reentryCount;

    constructor(address identity_) {
        identity = IIdentityRegistryForReentrancyTest(identity_);
    }

    function attackRegister() external {
        attackEnabled = true;
        attackMode = AttackMode.Register;
        identity.register("outer-uri");
        attackEnabled = false;
    }

    function attackRegisterWithFee() external {
        attackEnabled = true;
        attackMode = AttackMode.RegisterWithFee;
        identity.registerWithFee("outer-fee-uri");
        attackEnabled = false;
    }

    function setHookBurnAttack() external {
        attackEnabled = true;
        attackMode = AttackMode.Burn;
    }

    function setHookUpdateURIAttack() external {
        attackEnabled = true;
        attackMode = AttackMode.UpdateURI;
    }

    function onERC721Received(address, address, uint256 tokenId, bytes calldata) external returns (bytes4) {
        if (attackEnabled && reentryCount == 0) {
            reentryCount = 1;
            if (attackMode == AttackMode.RegisterWithFee) {
                identity.registerWithFee("inner-fee-uri");
            } else if (attackMode == AttackMode.Burn) {
                identity.burn(tokenId);
            } else if (attackMode == AttackMode.UpdateURI) {
                identity.updateAgentURI(tokenId, "hook-mutated-uri");
            } else {
                identity.register("inner-uri");
            }
        }
        return IERC721Receiver.onERC721Received.selector;
    }
}
