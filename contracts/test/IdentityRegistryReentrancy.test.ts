import { expect } from "chai";
import { ethers } from "hardhat";

describe("IdentityRegistry reentrancy hardening", function () {
  it("prevents ERC721 receiver reentrancy from minting multiple identities", async function () {
    const IdentityRegistry = await ethers.getContractFactory("IdentityRegistry");
    const identity = await IdentityRegistry.deploy();

    const Receiver = await ethers.getContractFactory("MockIdentityReentrantReceiver");
    const receiver = await Receiver.deploy(await identity.getAddress());

    await expect(receiver.attackRegister()).to.be.revertedWithCustomError(identity, "ReentrancyGuardReentrantCall");
    expect(await identity.balanceOf(await receiver.getAddress())).to.equal(0);
    expect(await identity.walletToAgent(await receiver.getAddress())).to.equal(0);
  });

  it("prevents approved external registry ownerOf reentrancy while linking external identity", async function () {
    const [owner, externalAgent] = await ethers.getSigners();

    const IdentityRegistry = await ethers.getContractFactory("IdentityRegistry");
    const identity = await IdentityRegistry.deploy();

    const ExternalRegistry = await ethers.getContractFactory("MockExternalRegistryReentrantOwnerOf");
    const externalRegistry = await ExternalRegistry.deploy(await identity.getAddress());
    await externalRegistry.setTokenOwner(externalAgent.address);
    await externalRegistry.setAttackEnabled(true);

    await identity.connect(owner).approveRegistry(await externalRegistry.getAddress());

    await expect(
      identity.connect(externalAgent).registerExternal(await externalRegistry.getAddress(), 1)
    ).to.be.reverted;

    const userExternal = await identity.externalAgents(externalAgent.address);
    expect(userExternal.registry).to.equal(ethers.ZeroAddress);
    expect(userExternal.agentId).to.equal(0);

    const registryExternal = await identity.externalAgents(await externalRegistry.getAddress());
    expect(registryExternal.registry).to.equal(ethers.ZeroAddress);
    expect(registryExternal.agentId).to.equal(0);
  });

  it("prevents bulk registration receiver hook from burning its just-minted identity", async function () {
    const [owner, platform] = await ethers.getSigners();

    const IdentityRegistry = await ethers.getContractFactory("IdentityRegistry");
    const identity = await IdentityRegistry.deploy();

    const Receiver = await ethers.getContractFactory("MockIdentityReentrantReceiver");
    const receiver = await Receiver.deploy(await identity.getAddress());
    await receiver.setHookBurnAttack();

    await identity.connect(owner).approvePlatform(platform.address);

    await expect(
      identity.connect(platform).registerBulkForPlatform([await receiver.getAddress()], ["bulk-uri"])
    ).to.be.revertedWithCustomError(identity, "ReentrancyGuardReentrantCall");

    expect(await identity.balanceOf(await receiver.getAddress())).to.equal(0);
    expect(await identity.walletToAgent(await receiver.getAddress())).to.equal(0);
  });

  it("prevents bulk registration receiver hook from mutating token URI before registration completes", async function () {
    const [owner, platform] = await ethers.getSigners();

    const IdentityRegistry = await ethers.getContractFactory("IdentityRegistry");
    const identity = await IdentityRegistry.deploy();

    const Receiver = await ethers.getContractFactory("MockIdentityReentrantReceiver");
    const receiver = await Receiver.deploy(await identity.getAddress());
    await receiver.setHookUpdateURIAttack();

    await identity.connect(owner).approvePlatform(platform.address);

    await expect(
      identity.connect(platform).registerBulkForPlatform([await receiver.getAddress()], ["bulk-uri"])
    ).to.be.revertedWithCustomError(identity, "ReentrancyGuardReentrantCall");

    expect(await identity.balanceOf(await receiver.getAddress())).to.equal(0);
    expect(await identity.walletToAgent(await receiver.getAddress())).to.equal(0);
  });
});
