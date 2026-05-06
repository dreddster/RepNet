// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IIdentityRegistryForExternalReentrancyTest {
    function registerExternal(address externalRegistry, uint256 externalAgentId) external;
}

contract MockExternalRegistryReentrantOwnerOf {
    IIdentityRegistryForExternalReentrancyTest public immutable identity;
    address public tokenOwner;
    bool public attackEnabled;
    uint256 public reentryCount;

    constructor(address identity_) {
        identity = IIdentityRegistryForExternalReentrancyTest(identity_);
    }

    function setTokenOwner(address tokenOwner_) external {
        tokenOwner = tokenOwner_;
    }

    function setAttackEnabled(bool attackEnabled_) external {
        attackEnabled = attackEnabled_;
    }

    function ownerOf(uint256 tokenId) external returns (address) {
        if (attackEnabled && reentryCount == 0) {
            reentryCount = 1;
            identity.registerExternal(address(this), tokenId);
        }
        return tokenOwner;
    }
}
