import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("RepNetDKGAnchors", function () {
  let owner: SignerWithAddress;
  let publisher: SignerWithAddress;
  let stranger: SignerWithAddress;
  let anchors: any;

  const AnchorType = {
    AgentProfile: 0,
    Agreement: 1,
    Delivery: 2,
    Evidence: 3,
    Feedback: 4,
    DisputeReasoning: 5,
  } as const;

  const DKGStatus = {
    None: 0,
    Tentative: 1,
    Confirmed: 2,
    Failed: 3,
  } as const;

  const subjectId = 42n;
  const locator = "did:dkg:base:84532/0xabc/repnet-dev/ka/42";
  const locatorHash = ethers.keccak256(ethers.toUtf8Bytes(locator));
  const contentHash = ethers.keccak256(ethers.toUtf8Bytes("public receipt payload"));
  const publicRoot = ethers.keccak256(ethers.toUtf8Bytes("public merkle root"));
  const privateRoot = ethers.keccak256(ethers.toUtf8Bytes("private merkle root"));

  beforeEach(async function () {
    [owner, publisher, stranger] = await ethers.getSigners();
    const RepNetDKGAnchors = await ethers.getContractFactory("RepNetDKGAnchors");
    anchors = await RepNetDKGAnchors.deploy(owner.address);
  });

  it("exposes the v10 suite marker", async function () {
    expect(await anchors.REPNET_VERSION()).to.equal("v10");
  });

  it("lets the owner authorize and revoke DKG publishers", async function () {
    await expect(anchors.connect(owner).setPublisher(publisher.address, true))
      .to.emit(anchors, "PublisherUpdated")
      .withArgs(publisher.address, true);

    expect(await anchors.authorizedPublishers(publisher.address)).to.equal(true);

    await expect(anchors.connect(owner).setPublisher(publisher.address, false))
      .to.emit(anchors, "PublisherUpdated")
      .withArgs(publisher.address, false);

    expect(await anchors.authorizedPublishers(publisher.address)).to.equal(false);
  });

  it("rejects publisher authorization from non-owners", async function () {
    await expect(
      anchors.connect(stranger).setPublisher(stranger.address, true)
    ).to.be.revertedWithCustomError(anchors, "OwnableUnauthorizedAccount");
  });

  it("lets authorized publishers emit public anchors with full locator", async function () {
    await anchors.connect(owner).setPublisher(publisher.address, true);

    await expect(
      anchors.connect(publisher).recordAnchor(
        AnchorType.Feedback,
        subjectId,
        locator,
        contentHash,
        publicRoot,
        privateRoot,
        DKGStatus.Confirmed
      )
    ).to.emit(anchors, "DKGAnchorRecorded")
      .withArgs(
        AnchorType.Feedback,
        subjectId,
        locatorHash,
        contentHash,
        publicRoot,
        privateRoot,
        DKGStatus.Confirmed,
        locator
      );
  });

  it("rejects anchor recording from unauthorized callers", async function () {
    await expect(
      anchors.connect(stranger).recordAnchor(
        AnchorType.Agreement,
        subjectId,
        locator,
        contentHash,
        publicRoot,
        privateRoot,
        DKGStatus.Tentative
      )
    ).to.be.revertedWithCustomError(anchors, "NotAuthorizedPublisher");
  });

  it("rejects public anchor records with empty locators", async function () {
    await anchors.connect(owner).setPublisher(publisher.address, true);

    await expect(
      anchors.connect(publisher).recordAnchor(
        AnchorType.Agreement,
        subjectId,
        "",
        contentHash,
        publicRoot,
        privateRoot,
        DKGStatus.Tentative
      )
    ).to.be.revertedWithCustomError(anchors, "EmptyLocator");
  });

  it("supports hash-only anchors for private/sensitive payloads without leaking a locator", async function () {
    await anchors.connect(owner).setPublisher(publisher.address, true);

    await expect(
      anchors.connect(publisher).recordAnchorHashOnly(
        AnchorType.Evidence,
        subjectId,
        locatorHash,
        contentHash,
        publicRoot,
        privateRoot,
        DKGStatus.Tentative
      )
    ).to.emit(anchors, "DKGAnchorRecorded")
      .withArgs(
        AnchorType.Evidence,
        subjectId,
        locatorHash,
        contentHash,
        publicRoot,
        privateRoot,
        DKGStatus.Tentative,
        ""
      );
  });

  it("rejects invalid DKG status values", async function () {
    await anchors.connect(owner).setPublisher(publisher.address, true);

    await expect(
      anchors.connect(publisher).recordAnchor(
        AnchorType.Delivery,
        subjectId,
        locator,
        contentHash,
        publicRoot,
        privateRoot,
        99
      )
    ).to.be.reverted;
  });
});
