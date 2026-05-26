import { expect } from "chai";
import { ethers } from "hardhat";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { MockUSDC, RepNetJobBoard } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("RepNetJobBoard", function () {
  let usdc: MockUSDC;
  let jobs: RepNetJobBoard;
  let contractor: SignerWithAddress;
  let worker: SignerWithAddress;
  let treasury: SignerWithAddress;
  let opinionPublisher: SignerWithAddress;
  let emergencyAuthority: SignerWithAddress;
  let stranger: SignerWithAddress;

  const toUSDC = (amount: number) => ethers.parseUnits(amount.toString(), 6);
  const contractorFee = (amount: bigint) => amount / BigInt(100);
  const feeAtBps = (amount: bigint, bps: bigint) => (amount * bps) / BigInt(10_000);
  const agreementHash = ethers.keccak256(ethers.toUtf8Bytes("current agreement"));
  const publicSpecHash = ethers.keccak256(ethers.toUtf8Bytes("public spec"));
  const privateSpecHash = ethers.keccak256(ethers.toUtf8Bytes("private spec"));
  const opinionHash = ethers.keccak256(ethers.toUtf8Bytes("official opinion"));

  async function currentDeadlineTerms() {
    const now = await time.latest();
    return {
      deliveryDeadline: BigInt(now + 3 * 24 * 60 * 60),
      reviewDeadline: BigInt(now + 6 * 24 * 60 * 60),
    };
  }

  async function createJob(amount = toUSDC(100)) {
    const { deliveryDeadline, reviewDeadline } = await currentDeadlineTerms();
    await usdc.connect(contractor).approve(await jobs.getAddress(), amount + contractorFee(amount));
    await jobs.connect(contractor).createJob(worker.address, amount, agreementHash, publicSpecHash, privateSpecHash, deliveryDeadline, reviewDeadline);
    return jobs.nextJobId();
  }

  async function createAndAccept(amount = toUSDC(100)) {
    const jobId = await createJob(amount);
    await jobs.connect(worker).acceptJob(jobId);
    return jobId;
  }

  async function createSubmitAndPublishOpinion(amount = toUSDC(100)) {
    const jobId = await createAndAccept(amount);
    await jobs.connect(worker).submitDelivery(jobId, "delivery-handle-1");
    await jobs.connect(opinionPublisher).publishOpinionReport(jobId, opinionHash, "opinion-schema-v1");
    return jobId;
  }

  async function additionalWorkDeadline(hoursFromNow = 48) {
    return BigInt((await time.latest()) + hoursFromNow * 60 * 60);
  }

  async function createAdditionalWorkRequested(amount = toUSDC(100)) {
    const jobId = await createSubmitAndPublishOpinion(amount);
    await jobs.connect(contractor).requestAdditionalWork(jobId, "tighten the delivery", await additionalWorkDeadline());
    return jobId;
  }

  beforeEach(async function () {
    [, contractor, worker, treasury, opinionPublisher, emergencyAuthority, stranger] = await ethers.getSigners();
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();

    const RepNetJobBoard = await ethers.getContractFactory("RepNetJobBoard");
    jobs = await RepNetJobBoard.deploy(await usdc.getAddress(), treasury.address, opinionPublisher.address, emergencyAuthority.address, false);

    await usdc.mint(contractor.address, toUSDC(1000));
  });

  it("pays upfront jobs directly with two-sided fee, both feedback rights, and no held balance", async function () {
    const amount = toUSDC(100);
    await usdc.connect(contractor).approve(await jobs.getAddress(), amount + contractorFee(amount));

    const { deliveryDeadline, reviewDeadline } = await currentDeadlineTerms();
    await expect(jobs.connect(contractor).createUpfrontJob(worker.address, amount, agreementHash, publicSpecHash, privateSpecHash, deliveryDeadline, reviewDeadline))
      .to.emit(jobs, "JobReceiptRecorded")
      .withArgs(1, "upfront_paid", amount, toUSDC(99), 0, toUSDC(2))
      .and.to.emit(jobs, "FeedbackRightsRecorded")
      .withArgs(1, true, true);

    expect(await usdc.balanceOf(contractor.address)).to.equal(toUSDC(899));
    expect(await usdc.balanceOf(worker.address)).to.equal(toUSDC(99));
    expect(await usdc.balanceOf(treasury.address)).to.equal(toUSDC(2));
    expect(await usdc.balanceOf(await jobs.getAddress())).to.equal(0);

    const job = await jobs.jobs(1);
    expect(job.paymentMode).to.equal(0);
  });

  it("keeps createJob as review-gated hold funding without paying W before terminal action", async function () {
    const jobId = await createJob();

    expect(await usdc.balanceOf(contractor.address)).to.equal(toUSDC(899));
    expect(await usdc.balanceOf(worker.address)).to.equal(0);
    expect(await usdc.balanceOf(treasury.address)).to.equal(0);
    expect(await usdc.balanceOf(await jobs.getAddress())).to.equal(toUSDC(101));

    const job = await jobs.jobs(jobId);
    expect(job.paymentMode).to.equal(1);
  });

  it("pauses only new escrow funding while existing jobs can still move through delivery and release", async function () {
    const jobId = await createAndAccept();

    await expect(jobs.connect(emergencyAuthority).pauseNewEscrows())
      .to.emit(jobs, "NewEscrowsPauseUpdated")
      .withArgs(true);
    expect(await jobs.newEscrowsPaused()).to.equal(true);

    const { deliveryDeadline, reviewDeadline } = await currentDeadlineTerms();
    const amount = toUSDC(50);
    await usdc.connect(contractor).approve(await jobs.getAddress(), amount + contractorFee(amount));
    await expect(
      jobs.connect(contractor).createJob(worker.address, amount, agreementHash, publicSpecHash, privateSpecHash, deliveryDeadline, reviewDeadline)
    ).to.be.revertedWithCustomError(jobs, "NewEscrowsPaused");
    await expect(
      jobs.connect(contractor).createUpfrontJob(worker.address, amount, agreementHash, publicSpecHash, privateSpecHash, deliveryDeadline, reviewDeadline)
    ).to.be.revertedWithCustomError(jobs, "NewEscrowsPaused");

    await expect(jobs.connect(worker).submitDelivery(jobId, "delivery-while-new-escrows-paused"))
      .to.emit(jobs, "DeliverySubmitted")
      .withArgs(jobId, "delivery-while-new-escrows-paused");
    await expect(jobs.connect(contractor).releaseJob(jobId))
      .to.emit(jobs, "JobReceiptRecorded")
      .withArgs(jobId, "released", toUSDC(100), toUSDC(99), 0, toUSDC(2));

    await expect(jobs.connect(emergencyAuthority).unpauseNewEscrows())
      .to.emit(jobs, "NewEscrowsPauseUpdated")
      .withArgs(false);
  });

  it("snapshots fee config per job so future fee changes do not strand funded escrows", async function () {
    const oldFeeJobId = await createAndAccept();
    const oldFeeJob = await jobs.jobs(oldFeeJobId);
    expect(oldFeeJob.configVersion).to.equal(1);
    expect(oldFeeJob.reputationFeeBps).to.equal(100);
    expect(oldFeeJob.paymentToken).to.equal(await usdc.getAddress());

    await expect(jobs.connect(emergencyAuthority).setReputationFeeBps(200))
      .to.emit(jobs, "JobConfigVersionUpdated")
      .withArgs(2, 200, await usdc.getAddress());
    expect(await jobs.currentConfigVersion()).to.equal(2);

    await jobs.connect(worker).submitDelivery(oldFeeJobId, "old-fee-delivery");
    await expect(jobs.connect(contractor).releaseJob(oldFeeJobId))
      .to.emit(jobs, "JobReceiptRecorded")
      .withArgs(oldFeeJobId, "released", toUSDC(100), toUSDC(99), 0, toUSDC(2));

    const newAmount = toUSDC(100);
    const { deliveryDeadline, reviewDeadline } = await currentDeadlineTerms();
    await usdc.connect(contractor).approve(await jobs.getAddress(), newAmount + feeAtBps(newAmount, BigInt(200)));
    await expect(jobs.connect(contractor).createJob(worker.address, newAmount, agreementHash, publicSpecHash, privateSpecHash, deliveryDeadline, reviewDeadline))
      .to.emit(jobs, "JobConfigSnapshotted")
      .withArgs(2, 2, 200, await usdc.getAddress());

    const newFeeJob = await jobs.jobs(2);
    expect(newFeeJob.configVersion).to.equal(2);
    expect(newFeeJob.reputationFeeBps).to.equal(200);
    expect(await usdc.balanceOf(await jobs.getAddress())).to.equal(toUSDC(102));
  });

  it("refunds the full contractor deposit when W declines before accepting, with no fee or feedback rights", async function () {
    const jobId = await createJob();

    await expect(jobs.connect(worker).declineJobBeforeAccept(jobId))
      .to.emit(jobs, "JobReceiptRecorded")
      .withArgs(jobId, "declined", toUSDC(100), 0, toUSDC(101), 0)
      .and.to.emit(jobs, "FeedbackRightsRecorded")
      .withArgs(jobId, false, false);

    expect(await usdc.balanceOf(contractor.address)).to.equal(toUSDC(1000));
    expect(await usdc.balanceOf(worker.address)).to.equal(0);
    expect(await usdc.balanceOf(treasury.address)).to.equal(0);
    expect(await usdc.balanceOf(await jobs.getAddress())).to.equal(0);
  });

  it("records the review-hold worker acceptance deadline as 24 hours after funding", async function () {
    const amount = toUSDC(100);
    await usdc.connect(contractor).approve(await jobs.getAddress(), amount + contractorFee(amount));
    const { deliveryDeadline, reviewDeadline } = await currentDeadlineTerms();
    const tx = await jobs.connect(contractor).createJob(worker.address, amount, agreementHash, publicSpecHash, privateSpecHash, deliveryDeadline, reviewDeadline);
    const receipt = await tx.wait();
    const createdBlock = await ethers.provider.getBlock(receipt!.blockNumber);
    const job = await jobs.jobs(1);

    expect(job.acceptanceDeadline).to.equal(BigInt(createdBlock!.timestamp + 24 * 60 * 60));
  });

  it("records private spec hash and delivery/review deadlines for review-hold jobs", async function () {
    const amount = toUSDC(100);
    const { deliveryDeadline, reviewDeadline } = await currentDeadlineTerms();
    await usdc.connect(contractor).approve(await jobs.getAddress(), amount + contractorFee(amount));

    await expect(
      (jobs.connect(contractor) as any).createJob(
        worker.address,
        amount,
        agreementHash,
        publicSpecHash,
        privateSpecHash,
        deliveryDeadline,
        reviewDeadline
      )
    )
      .to.emit(jobs, "JobAgreementCreated")
      .withArgs(1, contractor.address, worker.address, amount, agreementHash, publicSpecHash, privateSpecHash, deliveryDeadline, reviewDeadline);

    const job = await jobs.jobs(1);
    expect(job.privateSpecHash).to.equal(privateSpecHash);
    expect(job.deliveryDeadline).to.equal(deliveryDeadline);
    expect(job.reviewDeadline).to.equal(reviewDeadline);
  });

  it("rejects review-hold jobs with invalid private spec/deadline terms", async function () {
    const amount = toUSDC(100);
    const { deliveryDeadline, reviewDeadline } = await currentDeadlineTerms();
    await usdc.connect(contractor).approve(await jobs.getAddress(), amount + contractorFee(amount) * BigInt(3));

    await expect(
      (jobs.connect(contractor) as any).createJob(worker.address, amount, agreementHash, publicSpecHash, ethers.ZeroHash, deliveryDeadline, reviewDeadline)
    ).to.be.revertedWithCustomError(jobs, "EmptyHash");

    await expect(
      (jobs.connect(contractor) as any).createJob(worker.address, amount, agreementHash, publicSpecHash, privateSpecHash, 0, reviewDeadline)
    ).to.be.revertedWithCustomError(jobs, "InvalidDeadline");

    await expect(
      (jobs.connect(contractor) as any).createJob(worker.address, amount, agreementHash, publicSpecHash, privateSpecHash, reviewDeadline, deliveryDeadline)
    ).to.be.revertedWithCustomError(jobs, "InvalidDeadline");
  });

  it("blocks C from reclaiming the full deposit before the worker acceptance deadline", async function () {
    const jobId = await createJob();

    await expect(jobs.connect(contractor).refundBeforeAccept(jobId))
      .to.be.revertedWithCustomError(jobs, "AcceptanceDeadlineNotReached");

    expect(await usdc.balanceOf(contractor.address)).to.equal(toUSDC(899));
    expect(await usdc.balanceOf(await jobs.getAddress())).to.equal(toUSDC(101));
  });

  it("lets C reclaim the full deposit after worker acceptance deadline with no fee or feedback rights", async function () {
    const jobId = await createJob();
    await time.increase(24 * 60 * 60);

    await expect(jobs.connect(contractor).refundBeforeAccept(jobId))
      .to.emit(jobs, "JobReceiptRecorded")
      .withArgs(jobId, "expired", toUSDC(100), 0, toUSDC(101), 0)
      .and.to.emit(jobs, "FeedbackRightsRecorded")
      .withArgs(jobId, false, false);

    expect(await usdc.balanceOf(contractor.address)).to.equal(toUSDC(1000));
    expect(await usdc.balanceOf(worker.address)).to.equal(0);
    expect(await usdc.balanceOf(treasury.address)).to.equal(0);
    expect(await usdc.balanceOf(await jobs.getAddress())).to.equal(0);
  });

  it("blocks W acceptance after the worker acceptance deadline", async function () {
    const jobId = await createJob();
    await time.increase(24 * 60 * 60);

    await expect(jobs.connect(worker).acceptJob(jobId))
      .to.be.revertedWithCustomError(jobs, "AcceptanceDeadlineExpired");
  });

  it("lets C cancel after W accepts but before delivery with reason, two-sided fee, and both feedback rights", async function () {
    const jobId = await createAndAccept();

    await expect(jobs.connect(contractor).cancelBeforeDelivery(jobId, "Changed requirements before delivery"))
      .to.emit(jobs, "JobReceiptRecorded")
      .withArgs(jobId, "cancelled_before_delivery", toUSDC(100), 0, toUSDC(99), toUSDC(2))
      .and.to.emit(jobs, "FeedbackRightsRecorded")
      .withArgs(jobId, true, true);

    expect(await usdc.balanceOf(contractor.address)).to.equal(toUSDC(998));
    expect(await usdc.balanceOf(worker.address)).to.equal(0);
    expect(await usdc.balanceOf(treasury.address)).to.equal(toUSDC(2));
    expect(await usdc.balanceOf(await jobs.getAddress())).to.equal(0);
  });

  it("blocks W delivery submission after the delivery deadline without moving funds or state", async function () {
    const jobId = await createAndAccept();
    const jobBeforeDeadline = await jobs.jobs(jobId);

    await time.increaseTo(jobBeforeDeadline.deliveryDeadline);

    await expect(jobs.connect(worker).submitDelivery(jobId, "late-delivery-handle"))
      .to.be.revertedWithCustomError(jobs, "DeliveryDeadlineExpired");

    const jobAfterLateAttempt = await jobs.jobs(jobId);
    expect(jobAfterLateAttempt.status).to.equal(1);
    expect(jobAfterLateAttempt.deliveryHandle).to.equal("");
    expect(await usdc.balanceOf(await jobs.getAddress())).to.equal(toUSDC(101));
  });

  it("requires W delivery submission before review cancellation", async function () {
    const jobId = await createAndAccept();

    await expect(jobs.connect(contractor).cancelAfterReview(jobId, "AI opinion failed acceptance criteria"))
      .to.be.revertedWithCustomError(jobs, "WrongState");

    await expect(jobs.connect(worker).submitDelivery(jobId, "delivery-handle-1"))
      .to.emit(jobs, "DeliverySubmitted")
      .withArgs(jobId, "delivery-handle-1");

    await expect(jobs.connect(opinionPublisher).publishOpinionReport(jobId, opinionHash, "opinion-schema-v1"))
      .to.emit(jobs, "OpinionReportPublished")
      .withArgs(jobId, opinionHash, "opinion-schema-v1");

    await expect(jobs.connect(contractor).cancelAfterReview(jobId, "AI opinion failed acceptance criteria"))
      .to.emit(jobs, "JobReceiptRecorded")
      .withArgs(jobId, "cancelled", toUSDC(100), 0, toUSDC(99), toUSDC(2));

    expect(await usdc.balanceOf(await jobs.getAddress())).to.equal(0);
  });

  it("lets C act on submitted delivery without publishing an opinion", async function () {
    const releaseJobId = await createAndAccept();
    await jobs.connect(worker).submitDelivery(releaseJobId, "delivery-handle-release");

    await expect(jobs.connect(contractor).releaseJob(releaseJobId))
      .to.emit(jobs, "JobReceiptRecorded")
      .withArgs(releaseJobId, "released", toUSDC(100), toUSDC(99), 0, toUSDC(2));

    const cancelJobId = await createAndAccept();
    await jobs.connect(worker).submitDelivery(cancelJobId, "delivery-handle-cancel");

    await expect(jobs.connect(contractor).cancelAfterReview(cancelJobId, "delivery report missed acceptance criteria"))
      .to.emit(jobs, "JobReceiptRecorded")
      .withArgs(cancelJobId, "cancelled", toUSDC(100), 0, toUSDC(99), toUSDC(2));

    const moreWorkJobId = await createAndAccept();
    await jobs.connect(worker).submitDelivery(moreWorkJobId, "delivery-handle-more-work");
    const deadline = await additionalWorkDeadline();

    await expect(jobs.connect(contractor).requestAdditionalWork(moreWorkJobId, "tighten the delivery", deadline))
      .to.emit(jobs, "AdditionalWorkRequested")
      .withArgs(moreWorkJobId, "tighten the delivery", deadline, 1);
  });

  it("lets W release as accepted after the review deadline when C does not respond to submitted delivery", async function () {
    const jobId = await createAndAccept();
    await jobs.connect(worker).submitDelivery(jobId, "delivery-handle-1");
    const jobAfterDelivery = await jobs.jobs(jobId);

    await expect(jobs.connect(worker).releaseJob(jobId))
      .to.be.revertedWithCustomError(jobs, "ReviewDeadlineNotReached");

    await time.increaseTo(jobAfterDelivery.reviewDeadline);

    await expect(jobs.connect(worker).releaseJob(jobId))
      .to.emit(jobs, "JobReceiptRecorded")
      .withArgs(jobId, "released", toUSDC(100), toUSDC(99), 0, toUSDC(2))
      .and.to.emit(jobs, "FeedbackRightsRecorded")
      .withArgs(jobId, true, true);

    const finalized = await jobs.jobs(jobId);
    expect(finalized.status).to.equal(8);
    expect(await usdc.balanceOf(worker.address)).to.equal(toUSDC(99));
    expect(await usdc.balanceOf(treasury.address)).to.equal(toUSDC(2));
    expect(await usdc.balanceOf(await jobs.getAddress())).to.equal(0);
  });

  it("lets W release as accepted after the review deadline when C does not act on an official opinion", async function () {
    const jobId = await createSubmitAndPublishOpinion();
    const jobAfterOpinion = await jobs.jobs(jobId);

    await expect(jobs.connect(worker).releaseJob(jobId))
      .to.be.revertedWithCustomError(jobs, "ReviewDeadlineNotReached");

    await time.increaseTo(jobAfterOpinion.reviewDeadline);

    await expect(jobs.connect(worker).releaseJob(jobId))
      .to.emit(jobs, "JobReceiptRecorded")
      .withArgs(jobId, "released", toUSDC(100), toUSDC(99), 0, toUSDC(2));

    expect(await usdc.balanceOf(await jobs.getAddress())).to.equal(0);
  });

  it("rejects unofficial AI opinion publication", async function () {
    const jobId = await createAndAccept();
    await jobs.connect(worker).submitDelivery(jobId, "delivery-handle-1");

    await expect(jobs.connect(worker).publishOpinionReport(jobId, opinionHash, "opinion-schema-v1"))
      .to.be.revertedWithCustomError(jobs, "NotOpinionPublisher");
  });

  it("supports one additional-work request with C-chosen minimum 24h deadline, explicit W agreement, and W resubmission before the latest report", async function () {
    const jobId = await createAndAccept();
    await jobs.connect(worker).submitDelivery(jobId, "delivery-handle-1");
    const deadline = await additionalWorkDeadline();

    await expect(jobs.connect(contractor).requestAdditionalWork(jobId, "tighten the delivery", deadline))
      .to.emit(jobs, "AdditionalWorkRequested")
      .withArgs(jobId, "tighten the delivery", deadline, 1);

    const jobAfterRequest = await jobs.jobs(jobId);
    expect(jobAfterRequest.additionalWorkDeadline).to.equal(deadline);

    await expect(jobs.connect(worker).resubmitDelivery(jobId, "delivery-handle-2"))
      .to.be.revertedWithCustomError(jobs, "WrongState");

    await expect(jobs.connect(worker).acceptAdditionalWork(jobId))
      .to.emit(jobs, "AdditionalWorkAccepted")
      .withArgs(jobId, worker.address);

    const jobAfterAgreement = await jobs.jobs(jobId);
    expect(jobAfterAgreement.status).to.equal(5);

    await expect(jobs.connect(worker).resubmitDelivery(jobId, "delivery-handle-2"))
      .to.emit(jobs, "DeliveryResubmitted")
      .withArgs(jobId, "delivery-handle-2", 2);

    await expect(jobs.connect(contractor).releaseJob(jobId))
      .to.emit(jobs, "JobReceiptRecorded")
      .withArgs(jobId, "released", toUSDC(100), toUSDC(99), 0, toUSDC(2));
  });

  it("rejects additional-work deadlines shorter than 24 hours", async function () {
    const jobId = await createSubmitAndPublishOpinion();
    const tooSoon = await additionalWorkDeadline(23);

    await expect(jobs.connect(contractor).requestAdditionalWork(jobId, "same day squeeze", tooSoon))
      .to.be.revertedWithCustomError(jobs, "AdditionalWorkDeadlineTooSoon");

    const jobAfterRejectedRequest = await jobs.jobs(jobId);
    expect(jobAfterRejectedRequest.status).to.equal(3);
    expect(jobAfterRejectedRequest.additionalWorkRequestsUsed).to.equal(0);
    expect(jobAfterRejectedRequest.additionalWorkDeadline).to.equal(0);
  });

  it("allows only one additional-work request", async function () {
    const jobId = await createAdditionalWorkRequested();
    await jobs.connect(worker).acceptAdditionalWork(jobId);
    await jobs.connect(worker).resubmitDelivery(jobId, "delivery-handle-2");
    const secondOpinionHash = ethers.keccak256(ethers.toUtf8Bytes("official opinion round 2"));
    await jobs.connect(opinionPublisher).publishOpinionReport(jobId, secondOpinionHash, "opinion-schema-v1");

    await expect(jobs.connect(contractor).requestAdditionalWork(jobId, "one more round", await additionalWorkDeadline()))
      .to.be.revertedWithCustomError(jobs, "AdditionalWorkLimitReached");
  });

  it("lets C finalize or cancel when W explicitly refuses more work", async function () {
    const jobId = await createAdditionalWorkRequested();

    await expect(jobs.connect(worker).refuseAdditionalWork(jobId, "deadline is not workable"))
      .to.emit(jobs, "AdditionalWorkRefused")
      .withArgs(jobId, worker.address, "deadline is not workable");

    const jobAfterRefusal = await jobs.jobs(jobId);
    expect(jobAfterRefusal.status).to.equal(6);
    expect(jobAfterRefusal.additionalWorkRefusalReason).to.equal("deadline is not workable");

    await expect(jobs.connect(contractor).cancelAfterReview(jobId, "W refused more work"))
      .to.emit(jobs, "JobReceiptRecorded")
      .withArgs(jobId, "cancelled", toUSDC(100), 0, toUSDC(99), toUSDC(2));

    expect(await usdc.balanceOf(await jobs.getAddress())).to.equal(0);
  });

  it("blocks C final action while an additional-work response deadline is still open", async function () {
    const jobId = await createAdditionalWorkRequested();

    await expect(jobs.connect(contractor).releaseJob(jobId))
      .to.be.revertedWithCustomError(jobs, "AdditionalWorkDeadlineNotReached");
    await expect(jobs.connect(contractor).cancelAfterReview(jobId, "too soon"))
      .to.be.revertedWithCustomError(jobs, "AdditionalWorkDeadlineNotReached");

    expect(await usdc.balanceOf(await jobs.getAddress())).to.equal(toUSDC(101));
  });

  it("blocks W acceptance and resubmission after the additional-work deadline without moving funds", async function () {
    const jobId = await createAdditionalWorkRequested();
    const jobAfterRequest = await jobs.jobs(jobId);

    await time.increaseTo(jobAfterRequest.additionalWorkDeadline);

    await expect(jobs.connect(worker).acceptAdditionalWork(jobId))
      .to.be.revertedWithCustomError(jobs, "AdditionalWorkDeadlineExpired");

    const unchangedAfterExpiredAccept = await jobs.jobs(jobId);
    expect(unchangedAfterExpiredAccept.status).to.equal(4);
    expect(await usdc.balanceOf(await jobs.getAddress())).to.equal(toUSDC(101));

    await expect(jobs.connect(contractor).cancelAfterReview(jobId, "W missed more-work response deadline"))
      .to.emit(jobs, "JobReceiptRecorded")
      .withArgs(jobId, "cancelled", toUSDC(100), 0, toUSDC(99), toUSDC(2));

    expect(await usdc.balanceOf(await jobs.getAddress())).to.equal(0);
  });

  it("blocks W resubmission after accepting more work when the additional-work deadline expires", async function () {
    const jobId = await createAdditionalWorkRequested();
    await jobs.connect(worker).acceptAdditionalWork(jobId);
    const jobAfterAccept = await jobs.jobs(jobId);

    await time.increaseTo(jobAfterAccept.additionalWorkDeadline);

    await expect(jobs.connect(worker).resubmitDelivery(jobId, "late-delivery-handle-2"))
      .to.be.revertedWithCustomError(jobs, "AdditionalWorkDeadlineExpired");

    const unchangedAfterLateResubmit = await jobs.jobs(jobId);
    expect(unchangedAfterLateResubmit.status).to.equal(5);
    expect(unchangedAfterLateResubmit.deliveryHandle).to.equal("delivery-handle-1");
    expect(await usdc.balanceOf(await jobs.getAddress())).to.equal(toUSDC(101));
  });

  it("releases a finalized job with worker payment, protocol fee, and both feedback rights", async function () {
    const jobId = await createSubmitAndPublishOpinion();

    await expect(jobs.connect(contractor).releaseJob(jobId))
      .to.emit(jobs, "JobReceiptRecorded")
      .withArgs(jobId, "released", toUSDC(100), toUSDC(99), 0, toUSDC(2))
      .and.to.emit(jobs, "FeedbackRightsRecorded")
      .withArgs(jobId, true, true);

    expect(await usdc.balanceOf(worker.address)).to.equal(toUSDC(99));
    expect(await usdc.balanceOf(treasury.address)).to.equal(toUSDC(2));
    expect(await usdc.balanceOf(await jobs.getAddress())).to.equal(0);
  });

  it("cancels after review with mandatory reason, contractor refund, protocol fee, and both feedback rights", async function () {
    const jobId = await createSubmitAndPublishOpinion();

    await expect(jobs.connect(contractor).cancelAfterReview(jobId, "AI opinion failed acceptance criteria"))
      .to.emit(jobs, "JobReceiptRecorded")
      .withArgs(jobId, "cancelled", toUSDC(100), 0, toUSDC(99), toUSDC(2))
      .and.to.emit(jobs, "FeedbackRightsRecorded")
      .withArgs(jobId, true, true);

    expect(await usdc.balanceOf(contractor.address)).to.equal(toUSDC(998));
    expect(await usdc.balanceOf(worker.address)).to.equal(0);
    expect(await usdc.balanceOf(treasury.address)).to.equal(toUSDC(2));
    expect(await usdc.balanceOf(await jobs.getAddress())).to.equal(0);
  });


  it("rejects mainnet-grade emergency authority configuration when the authority is an EOA", async function () {
    const RepNetJobBoard = await ethers.getContractFactory("RepNetJobBoard");

    await expect(
      RepNetJobBoard.deploy(await usdc.getAddress(), treasury.address, opinionPublisher.address, emergencyAuthority.address, true)
    ).to.be.revertedWithCustomError(jobs, "EmergencyAuthorityMustBeContract");
  });

  it("prevents emergency rescue before a provable stuck additional-work terminal condition", async function () {
    const reasonHash = ethers.keccak256(ethers.toUtf8Bytes("stuck additional work accepted after deadline"));
    const jobId = await createAdditionalWorkRequested();

    await expect(jobs.connect(stranger).emergencyRescueStuckJob(jobId, reasonHash))
      .to.be.revertedWithCustomError(jobs, "NotEmergencyAuthority");

    await expect(jobs.connect(emergencyAuthority).emergencyRescueStuckJob(jobId, ethers.ZeroHash))
      .to.be.revertedWithCustomError(jobs, "EmptyRescueReason");

    await expect(jobs.connect(emergencyAuthority).emergencyRescueStuckJob(jobId, reasonHash))
      .to.be.revertedWithCustomError(jobs, "JobNotEmergencyRescuable");

    await jobs.connect(worker).acceptAdditionalWork(jobId);

    await expect(jobs.connect(emergencyAuthority).emergencyRescueStuckJob(jobId, reasonHash))
      .to.be.revertedWithCustomError(jobs, "JobNotEmergencyRescuable");
  });

  it("rescues only the fixed contractor/treasury split after additional-work acceptance becomes stuck", async function () {
    const reasonHash = ethers.keccak256(ethers.toUtf8Bytes("W accepted additional work but missed the terminal deadline"));
    const jobId = await createAdditionalWorkRequested();
    await jobs.connect(worker).acceptAdditionalWork(jobId);
    const jobAfterAccept = await jobs.jobs(jobId);
    await time.increaseTo(jobAfterAccept.additionalWorkDeadline);

    await expect(jobs.connect(emergencyAuthority).emergencyRescueStuckJob(jobId, reasonHash))
      .to.emit(jobs, "EmergencyJobRescue")
      .withArgs(jobId, reasonHash, contractor.address, toUSDC(99), emergencyAuthority.address, anyValue)
      .and.to.emit(jobs, "EmergencyJobRescue")
      .withArgs(jobId, reasonHash, treasury.address, toUSDC(2), emergencyAuthority.address, anyValue)
      .and.to.emit(jobs, "JobReceiptRecorded")
      .withArgs(jobId, "emergency_rescue", toUSDC(100), 0, toUSDC(99), toUSDC(2))
      .and.to.emit(jobs, "FeedbackRightsRecorded")
      .withArgs(jobId, true, true);

    const finalized = await jobs.jobs(jobId);
    expect(finalized.status).to.equal(10);
    expect(await usdc.balanceOf(contractor.address)).to.equal(toUSDC(998));
    expect(await usdc.balanceOf(worker.address)).to.equal(0);
    expect(await usdc.balanceOf(treasury.address)).to.equal(toUSDC(2));
    expect(await usdc.balanceOf(await jobs.getAddress())).to.equal(0);

    await expect(jobs.connect(emergencyAuthority).emergencyRescueStuckJob(jobId, reasonHash))
      .to.be.revertedWithCustomError(jobs, "JobNotEmergencyRescuable");
  });

  it("handles W post-accept withdrawal as paid reputation event with only C feedback right", async function () {
    const jobId = await createAndAccept();

    await expect(jobs.connect(worker).workerWithdrawAfterAccept(jobId))
      .to.emit(jobs, "JobReceiptRecorded")
      .withArgs(jobId, "withdrawn", toUSDC(100), 0, toUSDC(100), toUSDC(1))
      .and.to.emit(jobs, "FeedbackRightsRecorded")
      .withArgs(jobId, true, false);

    expect(await usdc.balanceOf(contractor.address)).to.equal(toUSDC(999));
    expect(await usdc.balanceOf(worker.address)).to.equal(0);
    expect(await usdc.balanceOf(treasury.address)).to.equal(toUSDC(1));
    expect(await usdc.balanceOf(await jobs.getAddress())).to.equal(0);
  });
});
