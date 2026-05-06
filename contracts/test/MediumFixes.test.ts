import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { MockUSDC, IdentityRegistry, ReputationRegistry, RepNetFeeRouter, RepNetEscrow } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("Medium Audit Fixes (C1-C4, E1)", function () {
  let usdc: MockUSDC;
  let identity: IdentityRegistry;
  let reputation: ReputationRegistry;
  let feeRouter: RepNetFeeRouter;
  let escrow: RepNetEscrow;

  let owner: SignerWithAddress;
  let treasury: SignerWithAddress;
  let contractor: SignerWithAddress;
  let worker: SignerWithAddress;
  let platform: SignerWithAddress;
  let stranger: SignerWithAddress;
  let judge1: SignerWithAddress;
  let judge2: SignerWithAddress;
  let judge3: SignerWithAddress;

  const USDC_DECIMALS = 6;
  const toUSDC = (amount: number) => ethers.parseUnits(amount.toString(), USDC_DECIMALS);
  const DAY = 86400;
  const WEEK = 7 * DAY;
  const HOUR = 3600;

  const agreementHash = ethers.keccak256(ethers.toUtf8Bytes("Test agreement for audit fixes"));

  // Helper: create, accept, deliver, review-fail, and contest a job
  // Returns jobId with spec 0 in Contested state
  async function createContestedJob(amount: bigint = toUSDC(1000)) {
    const deadline = (await time.latest()) + WEEK;
    await usdc.connect(contractor).approve(await escrow.getAddress(), amount);
    const tx = await escrow.connect(contractor).createEscrow(
      worker.address,
      amount,
      agreementHash,
      [5000n, 5000n],  // two equal specs
      deadline,
      3 * DAY,
      0,
      0
    );
    const jobId = await escrow.nextJobId() - 1n;

    // Accept
    await escrow.connect(worker).acceptJob(jobId);

    // Deliver
    await escrow.connect(worker).deliverWork(jobId, "ipfs://delivery");

    // Review: fail spec 0, pass spec 1
    await escrow.connect(contractor).reviewSpecs(jobId, [false, true]);

    // Contest spec 0
    await escrow.connect(worker).contestSpec(jobId, 0, "ipfs://evidence-worker");

    return jobId;
  }

  beforeEach(async function () {
    [owner, treasury, contractor, worker, platform, stranger, judge1, judge2, judge3] = await ethers.getSigners();

    // Deploy MockUSDC
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();

    // Deploy IdentityRegistry
    const IdentityRegistry = await ethers.getContractFactory("IdentityRegistry");
    identity = await IdentityRegistry.deploy();

    // Deploy ReputationRegistry
    const ReputationRegistry = await ethers.getContractFactory("ReputationRegistry");
    reputation = await ReputationRegistry.deploy(await identity.getAddress());

    // Configure IdentityRegistry for paid registration
    await identity.configureRegistrationFee(await usdc.getAddress(), treasury.address);

    // Deploy RepNetFeeRouter
    const RepNetFeeRouter = await ethers.getContractFactory("RepNetFeeRouter");
    feeRouter = await RepNetFeeRouter.deploy(
      await usdc.getAddress(),
      treasury.address
    );

    // Deploy EscrowVault implementation
    const EscrowVault = await ethers.getContractFactory("EscrowVault");
    const vaultImpl = await EscrowVault.deploy();

    // Deploy RepNetEscrow via UUPS proxy
    const RepNetEscrow = await ethers.getContractFactory("RepNetEscrow");
    escrow = await upgrades.deployProxy(
      RepNetEscrow,
      [
        await usdc.getAddress(),
        await identity.getAddress(),
        await feeRouter.getAddress(),
        await vaultImpl.getAddress(),
        1500,  // disputeFeeBps (15%)
        500,   // minDisputeFeeBps (5%)
        3000,  // maxDisputeFeeBps (30%)
        2      // requiredVotes
      ],
      { kind: 'uups' }
    ) as unknown as RepNetEscrow;
    await escrow.waitForDeployment();

    // Post-deploy config
    await feeRouter.setAuthorizedEscrow(await escrow.getAddress(), true);
    await escrow.connect(owner).setJudge(judge1.address, true);
    await escrow.connect(owner).setJudge(judge2.address, true);
    await escrow.connect(owner).setJudge(judge3.address, true);

    // Register identities
    await identity.connect(contractor).register("contractor-card");
    await identity.connect(worker).register("worker-card");

    // Mint USDC
    await usdc.mint(contractor.address, toUSDC(100000));
    await usdc.mint(worker.address, toUSDC(10000));
  });

  // ═══════════════════════════════════════════════════════════════
  //  C1: Snapshot disputeFeeBps at Contest Time
  // ═══════════════════════════════════════════════════════════════

  describe("C1: Snapshot disputeFeeBps at contest time", function () {
    it("should use snapshotted fee at verdict, not changed global fee", async function () {
      // Default disputeFeeBps is 1500 (15%)
      const amount = toUSDC(1000);
      const jobId = await createContestedJob(amount);

      // Verify snapshotted fee on spec
      const spec = await escrow.getSpec(jobId, 0);
      expect(spec.disputeFeeBps).to.equal(1500n);

      // Change global fee to 2500 (25%) — no active dispute guard since we use setDisputeFeeBps
      // Need to resolve dispute first or use timelock. Let's use proposeDisputeFeeBps instead.
      // Actually, setDisputeFeeBps requires activeDisputeCount == 0, so use timelock:
      await escrow.connect(owner).proposeDisputeFeeBps(2500);
      await time.increase(48 * HOUR);
      await escrow.connect(owner).executeDisputeFeeBps();
      expect(await escrow.disputeFeeBps()).to.equal(2500n);

      // Spec 0 amount = 1000 * 5000/10000 = 500 USDC
      // Snapshotted fee = 15% of 500 = 75 USDC
      // If it used global (25%), fee would be 125 USDC

      // Judge votes: SpecMet (worker wins)
      await escrow.connect(judge1).castVote(jobId, 0, 1); // SpecMet
      await escrow.connect(judge2).castVote(jobId, 0, 1); // SpecMet — majority

      // Check verdict event for dispute fee = 75 USDC (15% of 500), not 125 (25%)
      const specAmount = toUSDC(500);
      const expectedFee = (specAmount * 1500n) / 10000n; // 75 USDC
      expect(expectedFee).to.equal(toUSDC(75));

      // Verify the job's disputeFeesCollected matches snapshotted rate
      const job = await escrow.getJob(jobId);
      expect(job.disputeFeesCollected).to.equal(expectedFee);
    });

    it("should snapshot disputeFeeBps=0 initially and set at contest time", async function () {
      const amount = toUSDC(1000);
      const deadline = (await time.latest()) + WEEK;
      await usdc.connect(contractor).approve(await escrow.getAddress(), amount);
      await escrow.connect(contractor).createEscrow(
        worker.address, amount, agreementHash, [10000n], deadline, 3 * DAY, 0, 0
      );
      const jobId = await escrow.nextJobId() - 1n;

      // Check initial spec has disputeFeeBps = 0
      const spec = await escrow.getSpec(jobId, 0);
      expect(spec.disputeFeeBps).to.equal(0n);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  C2: Guard requiredVotes During Active Disputes
  // ═══════════════════════════════════════════════════════════════

  describe("C2: Guard requiredVotes during active disputes", function () {
    it("should revert setRequiredVotes when disputes are active", async function () {
      await createContestedJob();

      // activeDisputeCount should be 1
      expect(await escrow.activeDisputeCount()).to.equal(1n);

      await expect(
        escrow.connect(owner).setRequiredVotes(3)
      ).to.be.revertedWithCustomError(escrow, "ActiveDisputes");
    });

    it("should allow setRequiredVotes when no disputes are active", async function () {
      expect(await escrow.activeDisputeCount()).to.equal(0n);
      await escrow.connect(owner).setRequiredVotes(3);
      expect(await escrow.requiredVotes()).to.equal(3n);
    });

    it("should allow setRequiredVotes after dispute is resolved", async function () {
      const jobId = await createContestedJob();
      expect(await escrow.activeDisputeCount()).to.equal(1n);

      // Resolve the dispute
      await escrow.connect(judge1).castVote(jobId, 0, 1); // SpecMet
      await escrow.connect(judge2).castVote(jobId, 0, 1); // SpecMet — majority

      expect(await escrow.activeDisputeCount()).to.equal(0n);

      // Now setRequiredVotes should work
      await escrow.connect(owner).setRequiredVotes(3);
      expect(await escrow.requiredVotes()).to.equal(3n);
    });

    it("should track multiple active disputes correctly", async function () {
      // Create a job with 3 specs, contest 2
      const amount = toUSDC(1000);
      const deadline = (await time.latest()) + WEEK;
      await usdc.connect(contractor).approve(await escrow.getAddress(), amount);
      await escrow.connect(contractor).createEscrow(
        worker.address, amount, agreementHash,
        [3334n, 3333n, 3333n], deadline, 3 * DAY, 0, 0
      );
      const jobId = await escrow.nextJobId() - 1n;
      await escrow.connect(worker).acceptJob(jobId);
      await escrow.connect(worker).deliverWork(jobId, "ipfs://delivery");
      await escrow.connect(contractor).reviewSpecs(jobId, [false, false, true]);

      await escrow.connect(worker).contestSpec(jobId, 0, "ipfs://ev1");
      expect(await escrow.activeDisputeCount()).to.equal(1n);

      await escrow.connect(worker).contestSpec(jobId, 1, "ipfs://ev2");
      expect(await escrow.activeDisputeCount()).to.equal(2n);

      // Resolve one
      await escrow.connect(judge1).castVote(jobId, 0, 1);
      await escrow.connect(judge2).castVote(jobId, 0, 1);
      expect(await escrow.activeDisputeCount()).to.equal(1n);

      // Still can't change
      await expect(
        escrow.connect(owner).setRequiredVotes(3)
      ).to.be.revertedWithCustomError(escrow, "ActiveDisputes");

      // Resolve second
      await escrow.connect(judge1).castVote(jobId, 1, 2);
      await escrow.connect(judge2).castVote(jobId, 1, 2);
      expect(await escrow.activeDisputeCount()).to.equal(0n);

      // Now should work
      await escrow.connect(owner).setRequiredVotes(3);
      expect(await escrow.requiredVotes()).to.equal(3n);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  C3: Timelocked Fee Governance
  // ═══════════════════════════════════════════════════════════════

  describe("C3: Timelocked fee governance", function () {
    describe("proposeDisputeFeeBps / executeDisputeFeeBps", function () {
      it("should revert execution before timelock expires", async function () {
        await escrow.connect(owner).proposeDisputeFeeBps(2000);

        await expect(
          escrow.connect(owner).executeDisputeFeeBps()
        ).to.be.revertedWithCustomError(escrow, "TimelockNotExpired");
      });

      it("should succeed after 48h timelock", async function () {
        await escrow.connect(owner).proposeDisputeFeeBps(2000);

        // Advance 48 hours
        await time.increase(48 * HOUR);

        await escrow.connect(owner).executeDisputeFeeBps();
        expect(await escrow.disputeFeeBps()).to.equal(2000n);
      });

      it("should emit DisputeFeeProposed event", async function () {
        const tx = escrow.connect(owner).proposeDisputeFeeBps(2000);
        await expect(tx).to.emit(escrow, "DisputeFeeProposed");
      });

      it("should revert proposal if fee below minimum", async function () {
        await expect(
          escrow.connect(owner).proposeDisputeFeeBps(100)
        ).to.be.revertedWithCustomError(escrow, "FeeBelowMinimum");
      });

      it("should revert proposal if fee above maximum", async function () {
        await expect(
          escrow.connect(owner).proposeDisputeFeeBps(5000)
        ).to.be.revertedWithCustomError(escrow, "FeeAboveMaximum");
      });

      it("should allow cancellation of pending proposal", async function () {
        await escrow.connect(owner).proposeDisputeFeeBps(2000);
        await escrow.connect(owner).cancelDisputeFeeProposal();

        expect(await escrow.pendingDisputeFeeBps()).to.equal(0n);
        expect(await escrow.pendingDisputeFeeTimestamp()).to.equal(0n);
      });

      it("should revert execute when no pending proposal", async function () {
        await expect(
          escrow.connect(owner).executeDisputeFeeBps()
        ).to.be.revertedWithCustomError(escrow, "NoPendingProposal");
      });

      it("should only allow owner", async function () {
        await expect(
          escrow.connect(stranger).proposeDisputeFeeBps(2000)
        ).to.be.reverted;
      });
    });

    describe("proposeDisputeFeeBounds / executeDisputeFeeBounds", function () {
      it("should revert execution before timelock expires", async function () {
        await escrow.connect(owner).proposeDisputeFeeBounds(300, 4000);

        await expect(
          escrow.connect(owner).executeDisputeFeeBounds()
        ).to.be.revertedWithCustomError(escrow, "TimelockNotExpired");
      });

      it("should succeed after 48h timelock", async function () {
        await escrow.connect(owner).proposeDisputeFeeBounds(300, 4000);

        await time.increase(48 * HOUR);

        await escrow.connect(owner).executeDisputeFeeBounds();
        expect(await escrow.minDisputeFeeBps()).to.equal(300n);
        expect(await escrow.maxDisputeFeeBps()).to.equal(4000n);
      });

      it("should clamp current dispute fee when timelocked bounds move below it", async function () {
        expect(await escrow.disputeFeeBps()).to.equal(1500n);

        await escrow.connect(owner).proposeDisputeFeeBounds(300, 1000);
        await time.increase(48 * HOUR);
        await escrow.connect(owner).executeDisputeFeeBounds();

        expect(await escrow.minDisputeFeeBps()).to.equal(300n);
        expect(await escrow.maxDisputeFeeBps()).to.equal(1000n);
        expect(await escrow.disputeFeeBps()).to.equal(1000n);
      });

      it("should clamp current dispute fee when timelocked bounds move above it", async function () {
        await escrow.connect(owner).setDisputeFeeBps(500);
        expect(await escrow.disputeFeeBps()).to.equal(500n);

        await escrow.connect(owner).proposeDisputeFeeBounds(800, 3000);
        await time.increase(48 * HOUR);
        await escrow.connect(owner).executeDisputeFeeBounds();

        expect(await escrow.minDisputeFeeBps()).to.equal(800n);
        expect(await escrow.maxDisputeFeeBps()).to.equal(3000n);
        expect(await escrow.disputeFeeBps()).to.equal(800n);
      });

      it("should allow cancellation of bounds proposal", async function () {
        await escrow.connect(owner).proposeDisputeFeeBounds(300, 4000);
        await escrow.connect(owner).cancelDisputeFeeBoundsProposal();

        expect(await escrow.pendingMinDisputeFeeBps()).to.equal(0n);
        expect(await escrow.pendingMaxDisputeFeeBps()).to.equal(0n);
        expect(await escrow.pendingDisputeFeeBoundsTimestamp()).to.equal(0n);
      });

      it("should revert execute when no pending bounds proposal", async function () {
        await expect(
          escrow.connect(owner).executeDisputeFeeBounds()
        ).to.be.revertedWithCustomError(escrow, "NoPendingProposal");
      });
    });

    describe("setDisputeFeeBps guard during active disputes", function () {
      it("should revert setDisputeFeeBps during active disputes", async function () {
        await createContestedJob();

        await expect(
          escrow.connect(owner).setDisputeFeeBps(2000)
        ).to.be.revertedWithCustomError(escrow, "ActiveDisputes");
      });

      it("should allow setDisputeFeeBps when no active disputes", async function () {
        await escrow.connect(owner).setDisputeFeeBps(2000);
        expect(await escrow.disputeFeeBps()).to.equal(2000n);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  C4: Cap Dispute Fee Bounds at 50%
  // ═══════════════════════════════════════════════════════════════

  describe("C4: Cap dispute fee bounds at 50%", function () {
    it("should revert setDisputeFeeBounds with max > 50%", async function () {
      await expect(
        escrow.connect(owner).setDisputeFeeBounds(500, 5001)
      ).to.be.revertedWithCustomError(escrow, "MaxExceeds50Percent");
    });

    it("should allow setDisputeFeeBounds with max = 50%", async function () {
      await escrow.connect(owner).setDisputeFeeBounds(500, 5000);
      expect(await escrow.maxDisputeFeeBps()).to.equal(5000n);
    });

    it("should revert setDisputeFeeBounds with max at 100%", async function () {
      await expect(
        escrow.connect(owner).setDisputeFeeBounds(500, 10000)
      ).to.be.revertedWithCustomError(escrow, "MaxExceeds50Percent");
    });

    it("should revert proposeDisputeFeeBounds with max > 50%", async function () {
      await expect(
        escrow.connect(owner).proposeDisputeFeeBounds(500, 5001)
      ).to.be.revertedWithCustomError(escrow, "MaxExceeds50Percent");
    });

    it("should allow proposeDisputeFeeBounds with max = 50%", async function () {
      await escrow.connect(owner).proposeDisputeFeeBounds(500, 5000);
      expect(await escrow.pendingMaxDisputeFeeBps()).to.equal(5000n);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  E1: Lock Evidence After First Judge Vote
  // ═══════════════════════════════════════════════════════════════

  describe("E1: Lock evidence after first judge vote", function () {
    it("should allow evidence submission before any votes", async function () {
      const jobId = await createContestedJob();

      // Contractor submits counter-evidence before any votes
      await expect(
        escrow.connect(contractor).submitEvidence(jobId, 0, "ipfs://contractor-evidence")
      ).to.not.be.reverted;
    });

    it("should revert evidence submission after judge votes", async function () {
      const jobId = await createContestedJob();

      // Judge 1 votes
      await escrow.connect(judge1).castVote(jobId, 0, 1); // SpecMet

      // Now evidence submission should be locked
      await expect(
        escrow.connect(contractor).submitEvidence(jobId, 0, "ipfs://late-evidence")
      ).to.be.revertedWithCustomError(escrow, "EvidenceLocked");

      // Worker also can't submit
      await expect(
        escrow.connect(worker).submitEvidence(jobId, 0, "ipfs://late-worker-evidence")
      ).to.be.revertedWithCustomError(escrow, "EvidenceLocked");
    });

    it("should allow evidence before votes but lock after first vote", async function () {
      const jobId = await createContestedJob();

      // Both parties submit evidence before votes — OK
      await escrow.connect(contractor).submitEvidence(jobId, 0, "ipfs://c-evidence");
      await escrow.connect(worker).submitEvidence(jobId, 0, "ipfs://w-evidence-v2");

      // First vote
      await escrow.connect(judge1).castVote(jobId, 0, 2); // SpecNotMet

      // Now locked
      await expect(
        escrow.connect(contractor).submitEvidence(jobId, 0, "ipfs://c-update")
      ).to.be.revertedWithCustomError(escrow, "EvidenceLocked");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  D1: Configurable Collateral Penalty on Delivery Timeout
  // ═══════════════════════════════════════════════════════════════

  describe("D1: Configurable collateral penalty on delivery timeout", function () {
    const JOB = toUSDC(10000);
    const COL_BPS = 1500n; // 15%
    const COL_AMOUNT = toUSDC(1500); // 15% of 10000

    async function createJobWithPenalty(penaltyBps: bigint) {
      const deadline = (await time.latest()) + DAY;
      const totalDeposit = JOB + COL_AMOUNT;
      await usdc.connect(contractor).approve(await escrow.getAddress(), totalDeposit);
      await escrow.connect(contractor).createEscrow(
        worker.address, JOB, agreementHash,
        [10000n], deadline, 3 * DAY, COL_BPS, penaltyBps
      );
      const jobId = await escrow.nextJobId() - 1n;

      // Worker accepts (deposits matching collateral)
      await usdc.connect(worker).approve(await escrow.getAddress(), COL_AMOUNT);
      await escrow.connect(worker).acceptJob(jobId);

      // Fast-forward past deadline — worker ghosts
      await time.increase(2 * DAY);

      return jobId;
    }

    it("should forfeit 50% of worker collateral with penaltyBps=5000", async function () {
      const jobId = await createJobWithPenalty(5000n);

      const contractorBefore = await usdc.balanceOf(contractor.address);
      const workerBefore = await usdc.balanceOf(worker.address);

      await escrow.claimRefund(jobId);

      const contractorAfter = await usdc.balanceOf(contractor.address);
      const workerAfter = await usdc.balanceOf(worker.address);

      const penalty = COL_AMOUNT * 5000n / 10000n; // 50% of 1500 = 750
      const remainder = COL_AMOUNT - penalty;

      // Contractor gets: job amount + own collateral + 50% of worker collateral
      expect(contractorAfter - contractorBefore).to.equal(JOB + COL_AMOUNT + penalty);
      // Worker gets: 50% of own collateral back
      expect(workerAfter - workerBefore).to.equal(remainder);
    });

    it("should forfeit 100% of worker collateral with penaltyBps=10000", async function () {
      const jobId = await createJobWithPenalty(10000n);

      const contractorBefore = await usdc.balanceOf(contractor.address);
      const workerBefore = await usdc.balanceOf(worker.address);

      await escrow.claimRefund(jobId);

      const contractorAfter = await usdc.balanceOf(contractor.address);
      const workerAfter = await usdc.balanceOf(worker.address);

      // Contractor gets: job amount + own collateral + ALL worker collateral
      expect(contractorAfter - contractorBefore).to.equal(JOB + COL_AMOUNT + COL_AMOUNT);
      // Worker gets nothing back
      expect(workerAfter - workerBefore).to.equal(0n);
    });

    it("should return all worker collateral with penaltyBps=0 (no penalty)", async function () {
      const jobId = await createJobWithPenalty(0n);

      const contractorBefore = await usdc.balanceOf(contractor.address);
      const workerBefore = await usdc.balanceOf(worker.address);

      await escrow.claimRefund(jobId);

      const contractorAfter = await usdc.balanceOf(contractor.address);
      const workerAfter = await usdc.balanceOf(worker.address);

      // Contractor gets: job amount + own collateral only
      expect(contractorAfter - contractorBefore).to.equal(JOB + COL_AMOUNT);
      // Worker gets all collateral back
      expect(workerAfter - workerBefore).to.equal(COL_AMOUNT);
    });

    it("should emit CollateralForfeited for penalty and CollateralReturned for remainder", async function () {
      const jobId = await createJobWithPenalty(5000n);

      const penalty = COL_AMOUNT * 5000n / 10000n;
      const remainder = COL_AMOUNT - penalty;

      const tx = escrow.claimRefund(jobId);
      await expect(tx).to.emit(escrow, "CollateralForfeited")
        .withArgs(jobId, worker.address, contractor.address, penalty);
      await expect(tx).to.emit(escrow, "CollateralReturned")
        .withArgs(jobId, worker.address, remainder);
    });

    it("should reject collateralPenaltyBps > 10000", async function () {
      const deadline = (await time.latest()) + DAY;
      const totalDeposit = JOB + COL_AMOUNT;
      await usdc.connect(contractor).approve(await escrow.getAddress(), totalDeposit);
      await expect(
        escrow.connect(contractor).createEscrow(
          worker.address, JOB, agreementHash,
          [10000n], deadline, 3 * DAY, COL_BPS, 10001n
        )
      ).to.be.revertedWithCustomError(escrow, "PenaltyExceeds100");
    });

    it("should not affect _settleAgreedCollateral (normal completion)", async function () {
      // Create job with high penalty but complete normally
      const deadline = (await time.latest()) + WEEK;
      const totalDeposit = JOB + COL_AMOUNT;
      await usdc.connect(contractor).approve(await escrow.getAddress(), totalDeposit);
      await escrow.connect(contractor).createEscrow(
        worker.address, JOB, agreementHash,
        [10000n], deadline, 3 * DAY, COL_BPS, 10000n // 100% penalty
      );
      const jobId = await escrow.nextJobId() - 1n;

      await usdc.connect(worker).approve(await escrow.getAddress(), COL_AMOUNT);
      await escrow.connect(worker).acceptJob(jobId);

      // Deliver and get approved — normal path
      await escrow.connect(worker).deliverWork(jobId, "ipfs://delivery");
      await escrow.connect(contractor).reviewSpecs(jobId, [true]);

      // Both should get collateral back (penalty only applies on timeout)
      const workerAfter = await usdc.balanceOf(worker.address);
      // Worker should have gotten collateral back via _settleAgreedCollateral
      const job = await escrow.getJob(jobId);
      expect(job.collateralSettled).to.equal(COL_AMOUNT * 2n);
    });
  });
});
