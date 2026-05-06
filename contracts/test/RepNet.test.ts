import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { MockUSDC, IdentityRegistry, ReputationRegistry, RepNetFeeRouter, RepNetEscrow, EscrowVault } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("RepNet Protocol v10", function () {
  let usdc: MockUSDC;
  let identity: IdentityRegistry;
  let reputation: ReputationRegistry;
  let feeRouter: RepNetFeeRouter;
  let escrow: RepNetEscrow;
  let vaultImpl: EscrowVault;

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
  const fromUSDC = (amount: bigint) => Number(amount) / 1e6;
  const DAY = 86400;
  const WEEK = 7 * DAY;

  // Helper: create a standard agreement hash
  const agreementHash = ethers.keccak256(ethers.toUtf8Bytes("Test agreement: build 4 features"));

  // Helper: equal-weight specs (4 specs at 25% each)
  const fourEqualSpecs = [2500n, 2500n, 2500n, 2500n];

  // Helper: create and accept a standard escrow job
  async function createAndAcceptJob(
    amount: bigint,
    specWeights: bigint[] = fourEqualSpecs.map(w => w),
    deliveryDays: number = 7,
    reviewPeriodSecs: number = 3 * DAY
  ) {
    const deadline = (await time.latest()) + deliveryDays * DAY;
    await usdc.connect(contractor).approve(await escrow.getAddress(), amount);
    const tx = await escrow.connect(contractor).createEscrow(
      worker.address,
      amount,
      agreementHash,
      specWeights,
      deadline,
      reviewPeriodSecs,
      0, // no collateral by default
      0  // no collateral penalty
    );
    const receipt = await tx.wait();
    const jobId = await escrow.nextJobId() - 1n;
    await escrow.connect(worker).acceptJob(jobId);
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

    // Deploy EscrowVault implementation (cloned per job)
    const EscrowVault = await ethers.getContractFactory("EscrowVault");
    vaultImpl = await EscrowVault.deploy();

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

    // --- Post-deploy configuration ---
    await feeRouter.setAuthorizedEscrow(await escrow.getAddress(), true);
    await escrow.connect(owner).setJudge(judge1.address, true);
    await escrow.connect(owner).setJudge(judge2.address, true);
    await escrow.connect(owner).setJudge(judge3.address, true);

    // Mint USDC to test accounts
    await usdc.mint(contractor.address, toUSDC(100000));
    await usdc.mint(worker.address, toUSDC(10000));
  });

  // ═══════════════════════════════════════════════════════════════
  //  Versioning
  // ═══════════════════════════════════════════════════════════════

  describe("RepNet v10 contract markers", function () {
    it("exposes the v10 suite marker on core contracts", async function () {
      expect(await identity.REPNET_VERSION()).to.equal("v10");
      expect(await reputation.REPNET_VERSION()).to.equal("v10");
      expect(await feeRouter.REPNET_VERSION()).to.equal("v10");
      expect(await escrow.REPNET_VERSION()).to.equal("v10");
      expect(await vaultImpl.REPNET_VERSION()).to.equal("v10");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  MockUSDC
  // ═══════════════════════════════════════════════════════════════

  describe("MockUSDC", function () {
    it("should have 6 decimals", async function () {
      expect(await usdc.decimals()).to.equal(6);
    });

    it("should allow minting", async function () {
      expect(await usdc.balanceOf(contractor.address)).to.equal(toUSDC(100000));
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  IdentityRegistry
  // ═══════════════════════════════════════════════════════════════

  describe("IdentityRegistry", function () {
    it("should register an agent and mint NFT", async function () {
      await identity.connect(contractor).register("https://agent.example/.well-known/agent-card.json");

      expect(await identity.ownerOf(1)).to.equal(contractor.address);
      expect(await identity.agentWallet(1)).to.equal(contractor.address);
      expect(await identity.walletToAgent(contractor.address)).to.equal(1);
    });

    it("should increment agent IDs", async function () {
      await identity.connect(contractor).register("uri1");
      await identity.connect(worker).register("uri2");

      expect(await identity.nextAgentId()).to.equal(3);
    });

    it("should reject duplicate registration", async function () {
      await identity.connect(contractor).register("uri1");
      await expect(
        identity.connect(contractor).register("uri2")
      ).to.be.revertedWithCustomError(identity, "AlreadyRegistered");
    });

    it("should allow burn (unregister)", async function () {
      await identity.connect(contractor).register("uri1");
      await identity.connect(contractor).burn(1);

      expect(await identity.walletToAgent(contractor.address)).to.equal(0);
    });

    async function signSetAgentWallet(agentId: bigint, newWallet: string, signer: SignerWithAddress, deadline: bigint) {
      const nonce = await identity.walletNonces(agentId);
      const { chainId } = await ethers.provider.getNetwork();
      return signer.signTypedData(
        {
          name: "RepNet Protocol",
          version: "1",
          chainId,
          verifyingContract: await identity.getAddress(),
        },
        {
          SetAgentWallet: [
            { name: "agentId", type: "uint256" },
            { name: "newWallet", type: "address" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        },
        { agentId, newWallet, nonce, deadline }
      );
    }

    it("should set agent wallet with EIP-712 new-wallet consent", async function () {
      await identity.connect(contractor).register("uri1");
      const deadline = BigInt(await time.latest()) + 1_000n;
      const signature = await signSetAgentWallet(1n, stranger.address, stranger, deadline);

      await identity.connect(contractor).setAgentWallet(1, stranger.address, signature, deadline);

      expect(await identity.agentWallet(1)).to.equal(stranger.address);
      expect(await identity.walletToAgent(stranger.address)).to.equal(1);
      expect(await identity.walletNonces(1)).to.equal(1);
    });

    it("should reject expired agent wallet consent signatures", async function () {
      await identity.connect(contractor).register("uri1");
      const deadline = BigInt(await time.latest()) + 10n;
      const signature = await signSetAgentWallet(1n, stranger.address, stranger, deadline);
      await time.increase(11);

      await expect(
        identity.connect(contractor).setAgentWallet(1, stranger.address, signature, deadline)
      ).to.be.revertedWithCustomError(identity, "SignatureExpired");
    });

    it("should reject replayed agent wallet consent signatures", async function () {
      await identity.connect(contractor).register("uri1");
      const deadline = BigInt(await time.latest()) + 1_000n;
      const signature = await signSetAgentWallet(1n, stranger.address, stranger, deadline);

      await identity.connect(contractor).setAgentWallet(1, stranger.address, signature, deadline);

      await expect(
        identity.connect(contractor).setAgentWallet(1, worker.address, signature, deadline)
      ).to.be.revertedWithCustomError(identity, "InvalidWalletSignature");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  RepNetEscrow v6 — Agreement Protocol + Court System
  // ═══════════════════════════════════════════════════════════════

  describe("RepNetEscrow v6", function () {
    const JOB_AMOUNT = toUSDC(10000); // $10,000

    beforeEach(async function () {
      await identity.connect(contractor).register("contractor-card");
      await identity.connect(worker).register("worker-card");
    });

    // --- CREATION ---

    describe("Escrow creation", function () {
      it("should create escrow with agreement hash and spec weights", async function () {
        const deadline = (await time.latest()) + 7 * DAY;
        await usdc.connect(contractor).approve(await escrow.getAddress(), JOB_AMOUNT);

        await expect(
          escrow.connect(contractor).createEscrow(
            worker.address, JOB_AMOUNT, agreementHash,
            fourEqualSpecs, deadline, 3 * DAY, 0, 0
          )
        ).to.emit(escrow, "EscrowCreated")
          .withArgs(1, contractor.address, worker.address, JOB_AMOUNT, agreementHash, 4, deadline, 3 * DAY, 0, 0);

        const job = await escrow.getJob(1);
        expect(job.status).to.equal(0); // Created
        expect(job.agreementHash).to.equal(agreementHash);
        expect(job.specCount).to.equal(4);
        expect(job.totalAmount).to.equal(JOB_AMOUNT);
      });

      it("should reject specs that don't sum to 10000", async function () {
        const deadline = (await time.latest()) + 7 * DAY;
        await usdc.connect(contractor).approve(await escrow.getAddress(), JOB_AMOUNT);

        await expect(
          escrow.connect(contractor).createEscrow(
            worker.address, JOB_AMOUNT, agreementHash,
            [3000n, 3000n, 3000n], deadline, 3 * DAY, 0, 0
          )
        ).to.be.revertedWithCustomError(escrow, "WeightsMismatch");
      });

      it("should reject zero weight specs", async function () {
        const deadline = (await time.latest()) + 7 * DAY;
        await usdc.connect(contractor).approve(await escrow.getAddress(), JOB_AMOUNT);

        await expect(
          escrow.connect(contractor).createEscrow(
            worker.address, JOB_AMOUNT, agreementHash,
            [5000n, 5000n, 0n], deadline, 3 * DAY, 0, 0
          )
        ).to.be.revertedWithCustomError(escrow, "ZeroWeight");
      });

      it("should reject empty agreement hash", async function () {
        const deadline = (await time.latest()) + 7 * DAY;
        await usdc.connect(contractor).approve(await escrow.getAddress(), JOB_AMOUNT);

        await expect(
          escrow.connect(contractor).createEscrow(
            worker.address, JOB_AMOUNT, ethers.ZeroHash,
            fourEqualSpecs, deadline, 3 * DAY, 0, 0
          )
        ).to.be.revertedWithCustomError(escrow, "EmptyAgreement");
      });

      it("should reject unregistered contractor", async function () {
        const deadline = (await time.latest()) + 7 * DAY;
        await usdc.mint(stranger.address, JOB_AMOUNT);
        await usdc.connect(stranger).approve(await escrow.getAddress(), JOB_AMOUNT);

        await expect(
          escrow.connect(stranger).createEscrow(
            worker.address, JOB_AMOUNT, agreementHash,
            fourEqualSpecs, deadline, 3 * DAY, 0, 0
          )
        ).to.be.revertedWithCustomError(escrow, "NotRegistered");
      });

      it("should reject review period > 30 days", async function () {
        const deadline = (await time.latest()) + 7 * DAY;
        await usdc.connect(contractor).approve(await escrow.getAddress(), JOB_AMOUNT);

        await expect(
          escrow.connect(contractor).createEscrow(
            worker.address, JOB_AMOUNT, agreementHash,
            fourEqualSpecs, deadline, 31 * DAY, 0, 0
          )
        ).to.be.revertedWithCustomError(escrow, "ReviewPeriodTooLong");
      });
    });

    // --- ACCEPT + DELIVER ---

    describe("Accept and deliver", function () {
      it("should allow worker to accept job", async function () {
        const jobId = await createAndAcceptJob(JOB_AMOUNT);

        const job = await escrow.getJob(jobId);
        expect(job.status).to.equal(1); // Active
      });

      it("should reject accept from non-worker", async function () {
        const deadline = (await time.latest()) + 7 * DAY;
        await usdc.connect(contractor).approve(await escrow.getAddress(), JOB_AMOUNT);
        await escrow.connect(contractor).createEscrow(
          worker.address, JOB_AMOUNT, agreementHash,
          fourEqualSpecs, deadline, 3 * DAY, 0, 0
        );

        await expect(
          escrow.connect(stranger).acceptJob(1)
        ).to.be.revertedWithCustomError(escrow, "NotWorker");
      });

      it("should allow worker to deliver with URI", async function () {
        const jobId = await createAndAcceptJob(JOB_AMOUNT);

        await expect(
          escrow.connect(worker).deliverWork(jobId, "ipfs://delivery/v1")
        ).to.emit(escrow, "WorkDelivered")
          .withArgs(jobId, "ipfs://delivery/v1");

        const job = await escrow.getJob(jobId);
        expect(job.status).to.equal(2); // Delivered
        expect(job.reviewDeadline).to.be.gt(0);
      });

      it("should reject delivery after deadline", async function () {
        const jobId = await createAndAcceptJob(JOB_AMOUNT, fourEqualSpecs.map(w => w), 1);

        await time.increase(2 * DAY);

        await expect(
          escrow.connect(worker).deliverWork(jobId, "ipfs://late")
        ).to.be.revertedWithCustomError(escrow, "DeadlinePassed");
      });
    });

    // --- REVIEW: ALL PASS ---

    describe("Review: all specs pass", function () {
      it("should settle full amount to worker when all pass", async function () {
        const jobId = await createAndAcceptJob(JOB_AMOUNT);
        await escrow.connect(worker).deliverWork(jobId, "ipfs://delivery");

        const workerBefore = await usdc.balanceOf(worker.address);
        const treasuryBefore = await usdc.balanceOf(treasury.address);

        await escrow.connect(contractor).reviewSpecs(jobId, [true, true, true, true]);

        const job = await escrow.getJob(jobId);
        expect(job.status).to.equal(5); // Completed

        // Worker got paid (minus fees)
        const workerAfter = await usdc.balanceOf(worker.address);
        expect(workerAfter).to.be.gt(workerBefore);

        // Treasury collected fees
        const treasuryAfter = await usdc.balanceOf(treasury.address);
        expect(treasuryAfter).to.be.gt(treasuryBefore);
      });
    });

    // --- REVIEW: PARTIAL FAIL + ACCEPT ---

    describe("Review: partial fail, worker accepts", function () {
      it("should settle agreed portions when worker accepts all fails", async function () {
        const jobId = await createAndAcceptJob(JOB_AMOUNT);
        await escrow.connect(worker).deliverWork(jobId, "ipfs://delivery");

        // Contractor: 3 pass, 1 fail
        await escrow.connect(contractor).reviewSpecs(jobId, [true, true, false, true]);

        const job1 = await escrow.getJob(jobId);
        expect(job1.status).to.equal(3); // InReview

        // Worker accepts the fail
        const workerBefore = await usdc.balanceOf(worker.address);
        const contractorBefore = await usdc.balanceOf(contractor.address);

        await escrow.connect(worker).acceptFail(jobId, 2);

        const job2 = await escrow.getJob(jobId);
        expect(job2.status).to.equal(5); // Completed (all resolved)
      });
    });

    // --- CONTEST FLOW ---

    describe("Contest flow (RepNet Court)", function () {
      it("should allow worker to contest a failed spec", async function () {
        const jobId = await createAndAcceptJob(JOB_AMOUNT);
        await escrow.connect(worker).deliverWork(jobId, "ipfs://delivery");
        await escrow.connect(contractor).reviewSpecs(jobId, [true, true, false, true]);

        await expect(
          escrow.connect(worker).contestSpec(jobId, 2, "ipfs://evidence/worker")
        ).to.emit(escrow, "ContestFiled")
          .withArgs(jobId, 2, worker.address, "ipfs://evidence/worker");

        const spec = await escrow.getSpec(jobId, 2);
        expect(spec.status).to.equal(5); // Contested
      });

      it("should allow contractor to submit counter-evidence", async function () {
        const jobId = await createAndAcceptJob(JOB_AMOUNT);
        await escrow.connect(worker).deliverWork(jobId, "ipfs://delivery");
        await escrow.connect(contractor).reviewSpecs(jobId, [true, true, false, true]);
        await escrow.connect(worker).contestSpec(jobId, 2, "ipfs://evidence/worker");

        await expect(
          escrow.connect(contractor).submitEvidence(jobId, 2, "ipfs://evidence/contractor")
        ).to.emit(escrow, "EvidenceSubmitted");

        const spec = await escrow.getSpec(jobId, 2);
        expect(spec.contractorEvidenceURI).to.equal("ipfs://evidence/contractor");
      });

      it("should settle agreed specs immediately when worker contests one", async function () {
        const jobId = await createAndAcceptJob(JOB_AMOUNT);
        await escrow.connect(worker).deliverWork(jobId, "ipfs://delivery");
        await escrow.connect(contractor).reviewSpecs(jobId, [true, true, false, true]);

        const workerBefore = await usdc.balanceOf(worker.address);

        // Worker contests spec 2 — specs 0,1,3 should settle immediately
        await escrow.connect(worker).contestSpec(jobId, 2, "ipfs://evidence");

        const workerAfter = await usdc.balanceOf(worker.address);
        // Worker should have received payment for 75% (3 passed specs)
        expect(workerAfter).to.be.gt(workerBefore);

        const job = await escrow.getJob(jobId);
        expect(job.status).to.equal(4); // Settling
      });

      it("should apply 15% dispute fee when majority reached", async function () {
        const jobId = await createAndAcceptJob(JOB_AMOUNT);
        await escrow.connect(worker).deliverWork(jobId, "ipfs://delivery");
        await escrow.connect(contractor).reviewSpecs(jobId, [true, true, false, true]);
        await escrow.connect(worker).contestSpec(jobId, 2, "ipfs://evidence");

        const specAmount = JOB_AMOUNT * 2500n / 10000n; // $2,500
        const disputeFee = specAmount * 1500n / 10000n;  // 15% = $375
        const winnerAmount = specAmount - disputeFee;     // $2,125

        const contractorBefore = await usdc.balanceOf(contractor.address);
        const treasuryBefore = await usdc.balanceOf(treasury.address);

        // Judge 1 votes SpecNotMet — no settlement yet (need 2/3)
        await escrow.connect(judge1).castVote(jobId, 2, 2);
        expect((await escrow.getSpec(jobId, 2)).status).to.equal(5); // Still Contested

        // Judge 2 votes SpecNotMet — majority reached (2/3), auto-executes
        await escrow.connect(judge2).castVote(jobId, 2, 2);

        const contractorAfter = await usdc.balanceOf(contractor.address);
        const treasuryAfter = await usdc.balanceOf(treasury.address);

        expect(contractorAfter - contractorBefore).to.equal(winnerAmount);
        expect(treasuryAfter - treasuryBefore).to.equal(disputeFee);

        const job = await escrow.getJob(jobId);
        expect(job.disputeFeesCollected).to.equal(disputeFee);
        expect(job.status).to.equal(5); // Completed
      });

      it("should pay worker when 2/3 judges vote SpecMet", async function () {
        const jobId = await createAndAcceptJob(JOB_AMOUNT);
        await escrow.connect(worker).deliverWork(jobId, "ipfs://delivery");
        await escrow.connect(contractor).reviewSpecs(jobId, [true, true, false, true]);
        await escrow.connect(worker).contestSpec(jobId, 2, "ipfs://evidence");

        const specAmount = JOB_AMOUNT * 2500n / 10000n;
        const disputeFee = specAmount * 1500n / 10000n;
        const winnerAmount = specAmount - disputeFee;

        const workerBefore = await usdc.balanceOf(worker.address);

        // 2/3 vote SpecMet (worker wins)
        await escrow.connect(judge1).castVote(jobId, 2, 1);
        await escrow.connect(judge2).castVote(jobId, 2, 1);

        const workerAfter = await usdc.balanceOf(worker.address);
        expect(workerAfter - workerBefore).to.equal(winnerAmount);
      });

      it("should handle split vote (2-1) correctly", async function () {
        const jobId = await createAndAcceptJob(JOB_AMOUNT);
        await escrow.connect(worker).deliverWork(jobId, "ipfs://delivery");
        await escrow.connect(contractor).reviewSpecs(jobId, [true, true, false, true]);
        await escrow.connect(worker).contestSpec(jobId, 2, "ipfs://evidence");

        // Judge 1: SpecMet, Judge 2: SpecNotMet (1-1, no majority yet)
        await escrow.connect(judge1).castVote(jobId, 2, 1);
        await escrow.connect(judge2).castVote(jobId, 2, 2);
        expect((await escrow.getSpec(jobId, 2)).status).to.equal(5); // Still Contested

        // Judge 3: SpecMet → 2-1 majority for worker
        const workerBefore = await usdc.balanceOf(worker.address);
        await escrow.connect(judge3).castVote(jobId, 2, 1);

        const workerAfter = await usdc.balanceOf(worker.address);
        expect(workerAfter).to.be.gt(workerBefore);
        expect((await escrow.getSpec(jobId, 2)).status).to.equal(6); // Resolved
      });

      it("should reject vote from non-judge", async function () {
        const jobId = await createAndAcceptJob(JOB_AMOUNT);
        await escrow.connect(worker).deliverWork(jobId, "ipfs://delivery");
        await escrow.connect(contractor).reviewSpecs(jobId, [true, true, false, true]);
        await escrow.connect(worker).contestSpec(jobId, 2, "ipfs://evidence");

        await expect(
          escrow.connect(stranger).castVote(jobId, 2, 1)
        ).to.be.revertedWithCustomError(escrow, "NotAuthorizedJudge");
      });

      it("should reject double vote from same judge", async function () {
        const jobId = await createAndAcceptJob(JOB_AMOUNT);
        await escrow.connect(worker).deliverWork(jobId, "ipfs://delivery");
        await escrow.connect(contractor).reviewSpecs(jobId, [true, true, false, true]);
        await escrow.connect(worker).contestSpec(jobId, 2, "ipfs://evidence");

        await escrow.connect(judge1).castVote(jobId, 2, 1);
        await expect(
          escrow.connect(judge1).castVote(jobId, 2, 2)
        ).to.be.revertedWithCustomError(escrow, "AlreadyVoted");
      });

      it("should expose vote tally", async function () {
        const jobId = await createAndAcceptJob(JOB_AMOUNT);
        await escrow.connect(worker).deliverWork(jobId, "ipfs://delivery");
        await escrow.connect(contractor).reviewSpecs(jobId, [true, true, false, true]);
        await escrow.connect(worker).contestSpec(jobId, 2, "ipfs://evidence");

        await escrow.connect(judge1).castVote(jobId, 2, 1); // SpecMet
        await escrow.connect(judge2).castVote(jobId, 2, 2); // SpecNotMet

        const [metVotes, notMetVotes, voters] = await escrow.getVoteTally(jobId, 2);
        expect(metVotes).to.equal(1);
        expect(notMetVotes).to.equal(1);
        expect(voters.length).to.equal(2);
      });

      it("should handle multiple contested specs with separate votes", async function () {
        const jobId = await createAndAcceptJob(JOB_AMOUNT);
        await escrow.connect(worker).deliverWork(jobId, "ipfs://delivery");
        await escrow.connect(contractor).reviewSpecs(jobId, [false, false, false, false]);

        await escrow.connect(worker).acceptFail(jobId, 1);
        await escrow.connect(worker).acceptFail(jobId, 3);
        await escrow.connect(worker).contestSpec(jobId, 0, "ipfs://ev0");
        await escrow.connect(worker).contestSpec(jobId, 2, "ipfs://ev2");

        // Spec 0: worker wins (2/3 SpecMet)
        await escrow.connect(judge1).castVote(jobId, 0, 1);
        await escrow.connect(judge2).castVote(jobId, 0, 1);

        // Spec 2: contractor wins (2/3 SpecNotMet)
        await escrow.connect(judge1).castVote(jobId, 2, 2);
        await escrow.connect(judge2).castVote(jobId, 2, 2);

        const job = await escrow.getJob(jobId);
        expect(job.status).to.equal(5); // Completed
        expect(job.disputeFeesCollected).to.be.gt(0);
      });
    });

    // --- EXTRA WORK ---

    describe("Extra work flow", function () {
      it("should allow extension request and approval", async function () {
        const jobId = await createAndAcceptJob(JOB_AMOUNT);
        await escrow.connect(worker).deliverWork(jobId, "ipfs://delivery");
        await escrow.connect(contractor).reviewSpecs(jobId, [true, true, false, true]);

        const newDeadline = (await time.latest()) + 14 * DAY;
        await escrow.connect(worker).requestExtraWork(jobId, 2, newDeadline);

        let spec = await escrow.getSpec(jobId, 2);
        expect(spec.status).to.equal(4); // ExtraWork

        await escrow.connect(contractor).approveExtension(jobId, 2);

        spec = await escrow.getSpec(jobId, 2);
        expect(spec.status).to.equal(7); // ExtensionApproved (B1 fix: no longer resets to Pending)
      });

      it("should allow extension denial → worker must accept or contest", async function () {
        const jobId = await createAndAcceptJob(JOB_AMOUNT);
        await escrow.connect(worker).deliverWork(jobId, "ipfs://delivery");
        await escrow.connect(contractor).reviewSpecs(jobId, [true, true, false, true]);

        const newDeadline = (await time.latest()) + 14 * DAY;
        await escrow.connect(worker).requestExtraWork(jobId, 2, newDeadline);
        await escrow.connect(contractor).denyExtension(jobId, 2);

        const spec = await escrow.getSpec(jobId, 2);
        expect(spec.status).to.equal(2); // Back to Failed
      });
    });

    // --- TIMELINE ENFORCEMENT ---

    describe("Timeline enforcement", function () {
      it("should refund contractor when worker misses deadline", async function () {
        const jobId = await createAndAcceptJob(JOB_AMOUNT, fourEqualSpecs.map(w => w), 1);

        await time.increase(2 * DAY);

        const contractorBefore = await usdc.balanceOf(contractor.address);
        await escrow.connect(stranger).claimRefund(jobId);

        expect(await usdc.balanceOf(contractor.address)).to.equal(contractorBefore + JOB_AMOUNT);

        const job = await escrow.getJob(jobId);
        expect(job.status).to.equal(6); // Refunded
      });

      it("should auto-approve when contractor doesn't review in time", async function () {
        const jobId = await createAndAcceptJob(JOB_AMOUNT, fourEqualSpecs.map(w => w), 7, DAY);
        await escrow.connect(worker).deliverWork(jobId, "ipfs://delivery");

        // Advance past review period (1 day)
        await time.increase(2 * DAY);

        const workerBefore = await usdc.balanceOf(worker.address);

        await escrow.connect(stranger).claimAutoApprove(jobId);

        const workerAfter = await usdc.balanceOf(worker.address);
        expect(workerAfter).to.be.gt(workerBefore);

        const job = await escrow.getJob(jobId);
        expect(job.status).to.equal(5); // Completed
      });

      it("should reject auto-approve before review period expires", async function () {
        const jobId = await createAndAcceptJob(JOB_AMOUNT, fourEqualSpecs.map(w => w), 7, 3 * DAY);
        await escrow.connect(worker).deliverWork(jobId, "ipfs://delivery");

        await expect(
          escrow.connect(stranger).claimAutoApprove(jobId)
        ).to.be.revertedWithCustomError(escrow, "ReviewPeriodNotExpired");
      });

      it("should reject refund before deadline passes", async function () {
        const jobId = await createAndAcceptJob(JOB_AMOUNT);

        await expect(
          escrow.connect(contractor).claimRefund(jobId)
        ).to.be.revertedWithCustomError(escrow, "DeadlineNotPassed");
      });

      it("should allow refund for Created jobs (worker never accepted)", async function () {
        const deadline = (await time.latest()) + DAY;
        await usdc.connect(contractor).approve(await escrow.getAddress(), JOB_AMOUNT);
        await escrow.connect(contractor).createEscrow(
          worker.address, JOB_AMOUNT, agreementHash,
          fourEqualSpecs, deadline, 3 * DAY, 0, 0
        );
        // Worker never accepts

        await time.increase(2 * DAY);

        await expect(escrow.connect(contractor).claimRefund(1)).to.not.be.reverted;
      });
    });

    // --- VAULT ISOLATION ---

    describe("Per-job vault isolation", function () {
      it("should create separate vaults for each job", async function () {
        const job1 = await createAndAcceptJob(toUSDC(5000));
        const job2 = await createAndAcceptJob(toUSDC(3000));

        const [vault1] = await escrow.getVaultInfo(job1);
        const [vault2] = await escrow.getVaultInfo(job2);

        // Different addresses
        expect(vault1).to.not.equal(vault2);
        expect(vault1).to.not.equal(ethers.ZeroAddress);
        expect(vault2).to.not.equal(ethers.ZeroAddress);
      });

      it("should hold exact job amount in each vault", async function () {
        const job1 = await createAndAcceptJob(toUSDC(5000));
        const job2 = await createAndAcceptJob(toUSDC(3000));

        const [, balance1] = await escrow.getVaultInfo(job1);
        const [, balance2] = await escrow.getVaultInfo(job2);

        expect(balance1).to.equal(toUSDC(5000));
        expect(balance2).to.equal(toUSDC(3000));
      });

      it("should have zero balance in main escrow contract", async function () {
        await createAndAcceptJob(toUSDC(5000));

        // Main contract should hold nothing
        const mainBalance = await usdc.balanceOf(await escrow.getAddress());
        expect(mainBalance).to.equal(0);
      });

      it("should drain vault to zero after full settlement", async function () {
        const jobId = await createAndAcceptJob(toUSDC(5000));
        await escrow.connect(worker).deliverWork(jobId, "ipfs://delivery");
        await escrow.connect(contractor).reviewSpecs(jobId, [true, true, true, true]);

        const [, balance] = await escrow.getVaultInfo(jobId);
        expect(balance).to.equal(0);
      });

      it("vault refuses to release more than deposited (self-protecting)", async function () {
        const jobId = await createAndAcceptJob(toUSDC(5000));

        const [vaultAddr] = await escrow.getVaultInfo(jobId);
        const vault = await ethers.getContractAt("EscrowVault", vaultAddr);

        expect(await vault.totalDeposited()).to.equal(toUSDC(5000));
        expect(await vault.totalReleased()).to.equal(0);

        // Settle the job normally (drains vault to 0)
        await escrow.connect(worker).deliverWork(jobId, "ipfs://d");
        await escrow.connect(contractor).reviewSpecs(jobId, [true, true, true, true]);

        expect(await vault.totalReleased()).to.equal(toUSDC(5000));

        // Even if someone tried to call release again, it would fail
        // (vault has no balance AND invariant blocks it)
      });

      it("settling job 1 cannot affect job 2 vault", async function () {
        const job1 = await createAndAcceptJob(toUSDC(5000));
        const job2 = await createAndAcceptJob(toUSDC(3000));

        // Settle job 1 fully
        await escrow.connect(worker).deliverWork(job1, "ipfs://d1");
        await escrow.connect(contractor).reviewSpecs(job1, [true, true, true, true]);

        // Job 2 vault should be untouched
        const [, balance2] = await escrow.getVaultInfo(job2);
        expect(balance2).to.equal(toUSDC(3000));
      });
    });

    // --- VIEWS ---

    describe("View functions", function () {
      it("should return all spec statuses via getAllSpecs", async function () {
        const jobId = await createAndAcceptJob(JOB_AMOUNT);
        await escrow.connect(worker).deliverWork(jobId, "ipfs://delivery");
        await escrow.connect(contractor).reviewSpecs(jobId, [true, false, true, false]);

        const allSpecs = await escrow.getAllSpecs(jobId);
        expect(allSpecs[0].status).to.equal(1); // Passed
        expect(allSpecs[1].status).to.equal(2); // Failed
        expect(allSpecs[2].status).to.equal(1); // Passed
        expect(allSpecs[3].status).to.equal(2); // Failed
      });

      it("should return all spec details", async function () {
        const jobId = await createAndAcceptJob(JOB_AMOUNT);
        const allSpecs = await escrow.getAllSpecs(jobId);
        expect(allSpecs.length).to.equal(4);
        expect(allSpecs[0].weight).to.equal(2500);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  Collateral
  // ═══════════════════════════════════════════════════════════════

  describe("Collateral", function () {
    const JOB_AMOUNT = toUSDC(10000); // $10,000
    const COLLATERAL_BPS = 1500n; // 15%
    const COLLATERAL_AMOUNT = toUSDC(1500); // 15% of $10,000

    beforeEach(async function () {
      await identity.connect(contractor).register("contractor-card");
      await identity.connect(worker).register("worker-card");
    });

    // Helper: create escrow with collateral
    async function createCollateralJob(
      amount: bigint = JOB_AMOUNT,
      collateralBps: bigint = COLLATERAL_BPS,
      specWeights: bigint[] = [2500n, 2500n, 2500n, 2500n]
    ) {
      const collateral = (amount * collateralBps) / 10000n;
      const totalDeposit = amount + collateral;
      const deadline = (await time.latest()) + 7 * DAY;

      await usdc.connect(contractor).approve(await escrow.getAddress(), totalDeposit);
      const tx = await escrow.connect(contractor).createEscrow(
        worker.address, amount, agreementHash,
        specWeights, deadline, 3 * DAY, collateralBps, 0
      );
      const jobId = await escrow.nextJobId() - 1n;
      return { jobId, collateral };
    }

    // Helper: create + accept with collateral
    async function createAndAcceptCollateralJob(
      amount: bigint = JOB_AMOUNT,
      collateralBps: bigint = COLLATERAL_BPS,
      specWeights: bigint[] = [2500n, 2500n, 2500n, 2500n]
    ) {
      const { jobId, collateral } = await createCollateralJob(amount, collateralBps, specWeights);

      // Worker approves and deposits matching collateral
      await usdc.connect(worker).approve(await escrow.getAddress(), collateral);
      await escrow.connect(worker).acceptJob(jobId);

      return { jobId, collateral };
    }

    describe("Creation with collateral", function () {
      it("should create escrow with collateral and emit events", async function () {
        const deadline = (await time.latest()) + 7 * DAY;
        const totalDeposit = JOB_AMOUNT + COLLATERAL_AMOUNT;
        await usdc.connect(contractor).approve(await escrow.getAddress(), totalDeposit);

        await expect(
          escrow.connect(contractor).createEscrow(
            worker.address, JOB_AMOUNT, agreementHash,
            [2500n, 2500n, 2500n, 2500n], deadline, 3 * DAY, COLLATERAL_BPS, 0
          )
        ).to.emit(escrow, "EscrowCreated")
          .withArgs(1, contractor.address, worker.address, JOB_AMOUNT, agreementHash, 4, deadline, 3 * DAY, COLLATERAL_BPS, 0)
          .and.to.emit(escrow, "CollateralDeposited")
          .withArgs(1, contractor.address, COLLATERAL_AMOUNT);

        const job = await escrow.getJob(1);
        expect(job.collateralBps).to.equal(COLLATERAL_BPS);
        expect(job.contractorCollateral).to.equal(COLLATERAL_AMOUNT);
        expect(job.workerCollateral).to.equal(0); // Not yet accepted
      });

      it("should deposit totalAmount + collateral to vault", async function () {
        const { jobId } = await createCollateralJob();

        const [vaultAddr, vaultBalance] = await escrow.getVaultInfo(jobId);
        expect(vaultBalance).to.equal(JOB_AMOUNT + COLLATERAL_AMOUNT);
      });

      it("should store collateral info via getCollateralInfo", async function () {
        const { jobId } = await createCollateralJob();

        const [bps, cCol, wCol, settled] = await escrow.getCollateralInfo(jobId);
        expect(bps).to.equal(COLLATERAL_BPS);
        expect(cCol).to.equal(COLLATERAL_AMOUNT);
        expect(wCol).to.equal(0);
        expect(settled).to.equal(0);
      });
    });

    describe("Worker accepts with collateral", function () {
      it("should require worker to deposit matching collateral", async function () {
        const { jobId, collateral } = await createCollateralJob();

        await usdc.connect(worker).approve(await escrow.getAddress(), collateral);
        await expect(
          escrow.connect(worker).acceptJob(jobId)
        ).to.emit(escrow, "CollateralDeposited")
          .withArgs(jobId, worker.address, collateral);

        const job = await escrow.getJob(jobId);
        expect(job.workerCollateral).to.equal(collateral);
        expect(job.status).to.equal(1); // Active
      });

      it("should fail if worker hasn't approved collateral", async function () {
        const { jobId } = await createCollateralJob();

        // No approval → should fail
        await expect(
          escrow.connect(worker).acceptJob(jobId)
        ).to.be.reverted;
      });

      it("should update vault totalDeposited after worker deposits", async function () {
        const { jobId, collateral } = await createAndAcceptCollateralJob();

        const [vaultAddr] = await escrow.getVaultInfo(jobId);
        const vault = await ethers.getContractAt("EscrowVault", vaultAddr);
        expect(await vault.totalDeposited()).to.equal(JOB_AMOUNT + COLLATERAL_AMOUNT * 2n);
      });

      it("should hold total (jobAmount + both collaterals) in vault", async function () {
        const { jobId } = await createAndAcceptCollateralJob();

        const [, vaultBalance] = await escrow.getVaultInfo(jobId);
        expect(vaultBalance).to.equal(JOB_AMOUNT + COLLATERAL_AMOUNT * 2n);
      });
    });

    describe("Clean completion — all pass, collateral returned", function () {
      it("should return both collaterals when all specs pass", async function () {
        const { jobId } = await createAndAcceptCollateralJob();
        await escrow.connect(worker).deliverWork(jobId, "ipfs://delivery");

        const contractorBefore = await usdc.balanceOf(contractor.address);
        const workerBefore = await usdc.balanceOf(worker.address);

        await expect(
          escrow.connect(contractor).reviewSpecs(jobId, [true, true, true, true])
        ).to.emit(escrow, "CollateralReturned")
          .withArgs(jobId, contractor.address, COLLATERAL_AMOUNT)
          .and.to.emit(escrow, "CollateralReturned")
          .withArgs(jobId, worker.address, COLLATERAL_AMOUNT);

        const contractorAfter = await usdc.balanceOf(contractor.address);
        const workerAfter = await usdc.balanceOf(worker.address);

        // Contractor gets collateral back
        expect(contractorAfter - contractorBefore).to.equal(COLLATERAL_AMOUNT);
        // Worker gets payment + collateral back
        expect(workerAfter - workerBefore).to.be.gt(COLLATERAL_AMOUNT);

        // Vault should be drained
        const [, vaultBalance] = await escrow.getVaultInfo(jobId);
        expect(vaultBalance).to.equal(0);
      });

      it("should mark collateralSettled correctly after clean completion", async function () {
        const { jobId } = await createAndAcceptCollateralJob();
        await escrow.connect(worker).deliverWork(jobId, "ipfs://delivery");
        await escrow.connect(contractor).reviewSpecs(jobId, [true, true, true, true]);

        const [, , , settled] = await escrow.getCollateralInfo(jobId);
        expect(settled).to.equal(COLLATERAL_AMOUNT * 2n);
      });
    });

    describe("Dispute — collateral forfeited to winner", function () {
      it("should forfeit loser's collateral to winner (worker wins)", async function () {
        const { jobId } = await createAndAcceptCollateralJob();
        await escrow.connect(worker).deliverWork(jobId, "ipfs://delivery");
        await escrow.connect(contractor).reviewSpecs(jobId, [true, true, false, true]);
        await escrow.connect(worker).contestSpec(jobId, 2, "ipfs://evidence");

        // Contested spec = 25% weight, collateral at risk = 25% of $1500 = $375 each
        const propCollateral = COLLATERAL_AMOUNT * 2500n / 10000n; // $375

        const specAmount = JOB_AMOUNT * 2500n / 10000n; // $2500
        const disputeFee = specAmount * 1500n / 10000n; // $375
        const winnerAmount = specAmount - disputeFee; // $2125

        const workerBefore = await usdc.balanceOf(worker.address);

        // Worker wins: 2/3 judges say SpecMet
        await escrow.connect(judge1).castVote(jobId, 2, 1);
        await expect(
          escrow.connect(judge2).castVote(jobId, 2, 1)
        ).to.emit(escrow, "CollateralForfeited")
          .withArgs(jobId, contractor.address, worker.address, propCollateral)
          .and.to.emit(escrow, "CollateralReturned")
          .withArgs(jobId, worker.address, propCollateral);

        const workerAfter = await usdc.balanceOf(worker.address);
        // Worker gets: winnerAmount + loser's propCollateral + own propCollateral returned
        expect(workerAfter - workerBefore).to.equal(winnerAmount + propCollateral * 2n);
      });

      it("should forfeit loser's collateral to winner (contractor wins)", async function () {
        const { jobId } = await createAndAcceptCollateralJob();
        await escrow.connect(worker).deliverWork(jobId, "ipfs://delivery");
        await escrow.connect(contractor).reviewSpecs(jobId, [true, true, false, true]);
        await escrow.connect(worker).contestSpec(jobId, 2, "ipfs://evidence");

        const propCollateral = COLLATERAL_AMOUNT * 2500n / 10000n; // $375
        const specAmount = JOB_AMOUNT * 2500n / 10000n; // $2500
        const disputeFee = specAmount * 1500n / 10000n; // $375
        const winnerAmount = specAmount - disputeFee; // $2125

        const contractorBefore = await usdc.balanceOf(contractor.address);

        // Contractor wins: 2/3 judges say SpecNotMet
        await escrow.connect(judge1).castVote(jobId, 2, 2);
        await expect(
          escrow.connect(judge2).castVote(jobId, 2, 2)
        ).to.emit(escrow, "CollateralForfeited")
          .withArgs(jobId, worker.address, contractor.address, propCollateral)
          .and.to.emit(escrow, "CollateralReturned")
          .withArgs(jobId, contractor.address, propCollateral);

        const contractorAfter = await usdc.balanceOf(contractor.address);
        expect(contractorAfter - contractorBefore).to.equal(winnerAmount + propCollateral * 2n);
      });

      it("should make winner whole when collateral = dispute fee (15%)", async function () {
        // $10,000 job, 15% collateral ($1,500 each), 1 spec at 25% ($2,500)
        // Collateral at risk: 25% of $1,500 = $375
        // Dispute fee: 15% of $2,500 = $375
        // Winner gets: $2,125 (pot after fee) + $375 (loser collateral) = $2,500 (made whole!)
        // Plus own $375 returned
        const { jobId } = await createAndAcceptCollateralJob();
        await escrow.connect(worker).deliverWork(jobId, "ipfs://delivery");
        await escrow.connect(contractor).reviewSpecs(jobId, [true, true, false, true]);
        await escrow.connect(worker).contestSpec(jobId, 2, "ipfs://evidence");

        const propCollateral = COLLATERAL_AMOUNT * 2500n / 10000n; // $375
        const specAmount = JOB_AMOUNT * 2500n / 10000n; // $2,500
        const disputeFee = specAmount * 1500n / 10000n; // $375
        const winnerAmount = specAmount - disputeFee; // $2,125

        // With 15% collateral = dispute fee, winner is made whole:
        // winnerAmount ($2125) + loserPropCollateral ($375) = $2500 = specAmount
        expect(winnerAmount + propCollateral).to.equal(specAmount);

        const workerBefore = await usdc.balanceOf(worker.address);

        await escrow.connect(judge1).castVote(jobId, 2, 1);
        await escrow.connect(judge2).castVote(jobId, 2, 1);

        const workerAfter = await usdc.balanceOf(worker.address);
        // Worker's total from dispute = specAmount + own collateral = $2500 + $375 = $2875
        expect(workerAfter - workerBefore).to.equal(specAmount + propCollateral);
      });
    });

    describe("Partial settlement — collateral returned for agreed specs", function () {
      it("should return proportional collateral when worker accepts fail", async function () {
        const { jobId } = await createAndAcceptCollateralJob();
        await escrow.connect(worker).deliverWork(jobId, "ipfs://delivery");
        // 3 pass, 1 fail
        await escrow.connect(contractor).reviewSpecs(jobId, [true, true, false, true]);

        // Worker accepts fail (no contest) — all 4 specs now finalized
        await escrow.connect(worker).acceptFail(jobId, 2);

        // All collateral should be returned (no dispute = no forfeiture)
        const [, , , settled] = await escrow.getCollateralInfo(jobId);
        expect(settled).to.equal(COLLATERAL_AMOUNT * 2n);
      });

      it("should return collateral for non-disputed specs while keeping disputed spec collateral", async function () {
        const { jobId } = await createAndAcceptCollateralJob();
        await escrow.connect(worker).deliverWork(jobId, "ipfs://delivery");
        await escrow.connect(contractor).reviewSpecs(jobId, [true, true, false, true]);

        // Before contest — 3 passed specs are finalized (75%)
        // After contest — spec 2 is contested, other 3 are settled

        const contractorBefore = await usdc.balanceOf(contractor.address);
        const workerBefore = await usdc.balanceOf(worker.address);

        await escrow.connect(worker).contestSpec(jobId, 2, "ipfs://evidence");

        // 75% of collateral should be returned to both
        const expectedReturn = COLLATERAL_AMOUNT * 7500n / 10000n; // $1,125 each

        const [, , , settled] = await escrow.getCollateralInfo(jobId);
        // 75% of total collateral settled (both sides)
        expect(settled).to.equal(expectedReturn * 2n);
      });
    });

    describe("Refund — both collaterals returned", function () {
      it("should return contractor collateral on refund (worker never accepted)", async function () {
        const deadline = (await time.latest()) + DAY;
        const totalDeposit = JOB_AMOUNT + COLLATERAL_AMOUNT;
        await usdc.connect(contractor).approve(await escrow.getAddress(), totalDeposit);
        await escrow.connect(contractor).createEscrow(
          worker.address, JOB_AMOUNT, agreementHash,
          [2500n, 2500n, 2500n, 2500n], deadline, 3 * DAY, COLLATERAL_BPS, 0
        );

        await time.increase(2 * DAY);

        const contractorBefore = await usdc.balanceOf(contractor.address);

        await expect(
          escrow.connect(contractor).claimRefund(1)
        ).to.emit(escrow, "CollateralReturned")
          .withArgs(1, contractor.address, COLLATERAL_AMOUNT);

        const contractorAfter = await usdc.balanceOf(contractor.address);
        // Gets back job amount + collateral
        expect(contractorAfter - contractorBefore).to.equal(JOB_AMOUNT + COLLATERAL_AMOUNT);
      });

      it("should return both collaterals on refund (worker accepted but didn't deliver)", async function () {
        const { jobId } = await createAndAcceptCollateralJob();

        // Fast-forward past deadline
        await time.increase(8 * DAY);

        const contractorBefore = await usdc.balanceOf(contractor.address);
        const workerBefore = await usdc.balanceOf(worker.address);

        await escrow.claimRefund(jobId);

        const contractorAfter = await usdc.balanceOf(contractor.address);
        const workerAfter = await usdc.balanceOf(worker.address);

        // Contractor gets job amount + own collateral
        expect(contractorAfter - contractorBefore).to.equal(JOB_AMOUNT + COLLATERAL_AMOUNT);
        // Worker gets own collateral back (no penalty for timeout)
        expect(workerAfter - workerBefore).to.equal(COLLATERAL_AMOUNT);

        // Vault drained
        const [, vaultBalance] = await escrow.getVaultInfo(jobId);
        expect(vaultBalance).to.equal(0);
      });
    });

    describe("Auto-approve — both collaterals returned", function () {
      it("should return both collaterals on auto-approve", async function () {
        const collateral = COLLATERAL_AMOUNT;
        const totalDeposit = JOB_AMOUNT + collateral;
        const deadline = (await time.latest()) + 7 * DAY;

        await usdc.connect(contractor).approve(await escrow.getAddress(), totalDeposit);
        await escrow.connect(contractor).createEscrow(
          worker.address, JOB_AMOUNT, agreementHash,
          [2500n, 2500n, 2500n, 2500n], deadline, DAY, COLLATERAL_BPS, 0
        );
        const jobId = await escrow.nextJobId() - 1n;

        await usdc.connect(worker).approve(await escrow.getAddress(), collateral);
        await escrow.connect(worker).acceptJob(jobId);
        await escrow.connect(worker).deliverWork(jobId, "ipfs://delivery");

        // Advance past review period (1 day)
        await time.increase(2 * DAY);

        const contractorBefore = await usdc.balanceOf(contractor.address);
        const workerBefore = await usdc.balanceOf(worker.address);

        await escrow.claimAutoApprove(jobId);

        const contractorAfter = await usdc.balanceOf(contractor.address);
        const workerAfter = await usdc.balanceOf(worker.address);

        // Contractor gets collateral back
        expect(contractorAfter - contractorBefore).to.equal(collateral);
        // Worker gets payment + collateral
        expect(workerAfter - workerBefore).to.be.gt(collateral);

        // Vault drained
        const [, vaultBalance] = await escrow.getVaultInfo(jobId);
        expect(vaultBalance).to.equal(0);
      });
    });

    describe("Zero collateral — backwards compatibility", function () {
      it("should work identically to before when collateralBps=0", async function () {
        const deadline = (await time.latest()) + 7 * DAY;
        await usdc.connect(contractor).approve(await escrow.getAddress(), JOB_AMOUNT);
        await escrow.connect(contractor).createEscrow(
          worker.address, JOB_AMOUNT, agreementHash,
          [2500n, 2500n, 2500n, 2500n], deadline, 3 * DAY, 0, 0
        );
        const jobId = await escrow.nextJobId() - 1n;

        const job = await escrow.getJob(jobId);
        expect(job.collateralBps).to.equal(0);
        expect(job.contractorCollateral).to.equal(0);

        await escrow.connect(worker).acceptJob(jobId);
        const jobAfter = await escrow.getJob(jobId);
        expect(jobAfter.workerCollateral).to.equal(0);

        // Vault only holds job amount
        const [, vaultBalance] = await escrow.getVaultInfo(jobId);
        expect(vaultBalance).to.equal(JOB_AMOUNT);
      });
    });

    describe("Vault invariant with collateral", function () {
      it("should correctly track totalDeposited including both collaterals", async function () {
        const { jobId } = await createAndAcceptCollateralJob();

        const [vaultAddr] = await escrow.getVaultInfo(jobId);
        const vault = await ethers.getContractAt("EscrowVault", vaultAddr);

        const expectedTotal = JOB_AMOUNT + COLLATERAL_AMOUNT * 2n;
        expect(await vault.totalDeposited()).to.equal(expectedTotal);
        expect(await vault.totalReleased()).to.equal(0);
      });

      it("should drain vault completely after full settlement with collateral", async function () {
        const { jobId } = await createAndAcceptCollateralJob();
        await escrow.connect(worker).deliverWork(jobId, "ipfs://delivery");
        await escrow.connect(contractor).reviewSpecs(jobId, [true, true, true, true]);

        const [vaultAddr] = await escrow.getVaultInfo(jobId);
        const vault = await ethers.getContractAt("EscrowVault", vaultAddr);

        const expectedTotal = JOB_AMOUNT + COLLATERAL_AMOUNT * 2n;
        expect(await vault.totalReleased()).to.equal(expectedTotal);
        expect(await vault.balance(await usdc.getAddress())).to.equal(0);
      });
    });

    describe("Multiple disputes with collateral", function () {
      it("should handle multiple contested specs with correct proportional collateral", async function () {
        const { jobId } = await createAndAcceptCollateralJob();
        await escrow.connect(worker).deliverWork(jobId, "ipfs://delivery");
        // All 4 fail
        await escrow.connect(contractor).reviewSpecs(jobId, [false, false, false, false]);

        // Accept 2, contest 2
        await escrow.connect(worker).acceptFail(jobId, 1);
        await escrow.connect(worker).acceptFail(jobId, 3);
        await escrow.connect(worker).contestSpec(jobId, 0, "ipfs://ev0");
        await escrow.connect(worker).contestSpec(jobId, 2, "ipfs://ev2");

        // Spec 0: worker wins
        await escrow.connect(judge1).castVote(jobId, 0, 1);
        await escrow.connect(judge2).castVote(jobId, 0, 1);

        // Spec 2: contractor wins
        await escrow.connect(judge1).castVote(jobId, 2, 2);
        await escrow.connect(judge2).castVote(jobId, 2, 2);

        const job = await escrow.getJob(jobId);
        expect(job.status).to.equal(5); // Completed
        expect(job.disputeFeesCollected).to.be.gt(0);

        // All collateral should be fully settled
        const [, , , settled] = await escrow.getCollateralInfo(jobId);
        expect(settled).to.equal(COLLATERAL_AMOUNT * 2n);

        // Vault drained
        const [, vaultBalance] = await escrow.getVaultInfo(jobId);
        expect(vaultBalance).to.equal(0);
      });
    });

    describe("Edge cases", function () {
      it("should handle high collateral (50%)", async function () {
        const highBps = 5000n; // 50%
        const highCollateral = JOB_AMOUNT * highBps / 10000n; // $5,000

        const { jobId } = await createAndAcceptCollateralJob(JOB_AMOUNT, highBps);
        const job = await escrow.getJob(jobId);
        expect(job.contractorCollateral).to.equal(highCollateral);
        expect(job.workerCollateral).to.equal(highCollateral);

        // Complete normally
        await escrow.connect(worker).deliverWork(jobId, "ipfs://delivery");
        await escrow.connect(contractor).reviewSpecs(jobId, [true, true, true, true]);

        const [, vaultBalance] = await escrow.getVaultInfo(jobId);
        expect(vaultBalance).to.equal(0);
      });

      it("should handle low collateral (1%)", async function () {
        const lowBps = 100n; // 1%
        const lowCollateral = JOB_AMOUNT * lowBps / 10000n; // $100

        const { jobId } = await createAndAcceptCollateralJob(JOB_AMOUNT, lowBps);
        const job = await escrow.getJob(jobId);
        expect(job.contractorCollateral).to.equal(lowCollateral);
        expect(job.workerCollateral).to.equal(lowCollateral);
      });

      it("should handle single spec job (100% weight)", async function () {
        const { jobId } = await createAndAcceptCollateralJob(JOB_AMOUNT, COLLATERAL_BPS, [10000n]);
        await escrow.connect(worker).deliverWork(jobId, "ipfs://delivery");

        // Fail and contest the only spec
        await escrow.connect(contractor).reviewSpecs(jobId, [false]);
        await escrow.connect(worker).contestSpec(jobId, 0, "ipfs://evidence");

        // Full collateral at risk (100% weight)
        await escrow.connect(judge1).castVote(jobId, 0, 1);
        await escrow.connect(judge2).castVote(jobId, 0, 1);

        const [, , , settled] = await escrow.getCollateralInfo(jobId);
        expect(settled).to.equal(COLLATERAL_AMOUNT * 2n);

        const [, vaultBalance] = await escrow.getVaultInfo(jobId);
        expect(vaultBalance).to.equal(0);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  ReputationRegistry
  // ═══════════════════════════════════════════════════════════════

  describe("ReputationRegistry", function () {
    beforeEach(async function () {
      await identity.connect(contractor).register("contractor-card");
      await identity.connect(worker).register("worker-card");
    });

    it("should accept feedback from registered agents", async function () {
      // Updated: giveFeedback now takes wallet address instead of agentId
      await reputation.connect(contractor).giveFeedback(
        worker.address, 1, "repnet-job", "completed", "dkg://receipt/1", 0
      );

      const fb = await reputation.getFeedback(0);
      expect(fb.from).to.equal(contractor.address);
      // Updated: now returns AgentIdentity struct
      expect(fb.targetAgent.registry).to.equal(await identity.getAddress());
      expect(fb.targetAgent.agentId).to.equal(2);
      expect(fb.value).to.equal(1);
    });

    it("should track running totals", async function () {
      // Updated: giveFeedback now takes wallet address
      await reputation.connect(contractor).giveFeedback(worker.address, 1, "t1", "t2", "uri1", 0);
      await reputation.connect(contractor).giveFeedback(worker.address, 0, "t1", "t2", "uri2", 0);

      // Legacy getSummary with agentId still works
      const [count, satisfied] = await reputation.getSummary(2);
      expect(count).to.equal(2);
      expect(satisfied).to.equal(1);

      // New wallet-based lookup also works
      const [count2, satisfied2] = await reputation.getSummaryByWallet(worker.address);
      expect(count2).to.equal(2);
      expect(satisfied2).to.equal(1);
    });

    it("should reject from unregistered sender", async function () {
      await expect(
        reputation.connect(stranger).giveFeedback(contractor.address, 1, "t1", "t2", "uri", 0)
      ).to.be.revertedWithCustomError(reputation, "SenderNotRegistered");
    });

    it("should reject self-feedback", async function () {
      await expect(
        reputation.connect(contractor).giveFeedback(contractor.address, 1, "t1", "t2", "uri", 0)
      ).to.be.revertedWithCustomError(reputation, "CannotReviewSelf");
    });

    it("should reject invalid value (must be 0 or 1)", async function () {
      await expect(
        reputation.connect(contractor).giveFeedback(worker.address, 5, "t1", "t2", "uri", 0)
      ).to.be.revertedWithCustomError(reputation, "InvalidValue");
    });

    it("should reject feedback for non-registered wallet", async function () {
      await expect(
        reputation.connect(contractor).giveFeedback(stranger.address, 1, "test", "test", "", 0)
      ).to.be.revertedWithCustomError(reputation, "TargetNotRegistered");
    });

    it("should support bidirectional feedback", async function () {
      await reputation.connect(contractor).giveFeedback(worker.address, 1, "job", "quality", "uri1", 0);
      await reputation.connect(worker).giveFeedback(contractor.address, 1, "contractor", "payment", "uri2", 0);

      const [count1] = await reputation.getSummary(1);
      const [count2] = await reputation.getSummary(2);
      expect(count1).to.equal(1);
      expect(count2).to.equal(1);
    });

    it("should store jobId in feedback", async function () {
      await reputation.connect(contractor).giveFeedback(worker.address, 1, "escrow-job", "audit", "uri", 42);
      const fb = await reputation.getFeedback(0);
      expect(fb.jobId).to.equal(42);
    });

    it("should return correct fromAgent identity in feedback", async function () {
      await reputation.connect(contractor).giveFeedback(worker.address, 1, "test", "test", "uri", 0);
      const fb = await reputation.getFeedback(0);
      expect(fb.fromAgent.registry).to.equal(await identity.getAddress());
      expect(fb.fromAgent.agentId).to.equal(1);
    });

    it("should paginate feedback IDs by wallet to avoid unbounded full-array reads", async function () {
      await reputation.connect(contractor).giveFeedback(worker.address, 1, "t1", "t2", "uri1", 0);
      await reputation.connect(contractor).giveFeedback(worker.address, 0, "t1", "t2", "uri2", 0);
      await reputation.connect(contractor).giveFeedback(worker.address, 1, "t1", "t2", "uri3", 0);

      const firstPage = await reputation.getAgentFeedbackIdsByWalletPaginated(worker.address, 0, 2);
      expect(firstPage).to.deep.equal([0n, 1n]);

      const secondPage = await reputation.getAgentFeedbackIdsByWalletPaginated(worker.address, 2, 2);
      expect(secondPage).to.deep.equal([2n]);

      const emptyPage = await reputation.getAgentFeedbackIdsByWalletPaginated(worker.address, 3, 2);
      expect(emptyPage).to.deep.equal([]);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  Pausable Emergency Circuit Breaker
  // ═══════════════════════════════════════════════════════════════

  describe("Pausable", function () {
    beforeEach(async function () {
      await identity.connect(contractor).register("contractor-card");
      await identity.connect(worker).register("worker-card");
    });

    it("should block new escrows when paused", async function () {
      const deadline = (await time.latest()) + 7 * DAY;
      await usdc.connect(contractor).approve(await escrow.getAddress(), toUSDC(100));

      await escrow.connect(owner).pause();

      await expect(
        escrow.connect(contractor).createEscrow(
          worker.address, toUSDC(100), agreementHash,
          fourEqualSpecs, deadline, 3 * DAY, 0, 0
        )
      ).to.be.revertedWithCustomError(escrow, "EnforcedPause");
    });

    it("should block new registrations when paused", async function () {
      await identity.connect(owner).pause();
      await expect(
        identity.connect(stranger).registerWithFee("ipfs://new")
      ).to.be.revertedWithCustomError(identity, "EnforcedPause");
      await identity.connect(owner).unpause();
    });

    it("should block direct payments when paused", async function () {
      await usdc.connect(contractor).approve(await feeRouter.getAddress(), toUSDC(200));
      await feeRouter.connect(owner).pause();

      await expect(
        feeRouter.connect(contractor).routePayment(worker.address, toUSDC(100))
      ).to.be.revertedWithCustomError(feeRouter, "EnforcedPause");
    });

    it("should resume after unpause", async function () {
      await escrow.connect(owner).pause();
      await escrow.connect(owner).unpause();

      const deadline = (await time.latest()) + 7 * DAY;
      await usdc.connect(contractor).approve(await escrow.getAddress(), toUSDC(100));

      await expect(
        escrow.connect(contractor).createEscrow(
          worker.address, toUSDC(100), agreementHash,
          fourEqualSpecs, deadline, 3 * DAY, 0, 0
        )
      ).to.not.be.reverted;
    });

    it("should reject pause from non-owner", async function () {
      await expect(
        escrow.connect(stranger).pause()
      ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  Configurable Fees
  // ═══════════════════════════════════════════════════════════════

  describe("Configurable fees", function () {
    it("should allow owner to update fees within bounds", async function () {
      await feeRouter.connect(owner).setFees(200, 20_000, 50_000_000);
      expect(await feeRouter.feeBps()).to.equal(200);

      const fee = await feeRouter.calculateFee(toUSDC(100));
      expect(fee).to.equal(toUSDC(2));
    });

    it("should reject fees outside bounds", async function () {
      await expect(
        feeRouter.connect(owner).setFees(5, 10_000, 20_000_000)
      ).to.be.revertedWithCustomError(feeRouter, "BPSOutOfBounds");

      await expect(
        feeRouter.connect(owner).setFees(600, 10_000, 20_000_000)
      ).to.be.revertedWithCustomError(feeRouter, "BPSOutOfBounds");
    });

    it("should reject fee changes from non-owner", async function () {
      await expect(
        feeRouter.connect(stranger).setFees(200, 20_000, 50_000_000)
      ).to.be.revertedWithCustomError(feeRouter, "OwnableUnauthorizedAccount");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  Configurable Registration Fee
  // ═══════════════════════════════════════════════════════════════

  describe("Configurable registration fee", function () {
    it("should allow owner to update", async function () {
      await identity.connect(owner).setRegistrationFee(20 * 1e6);
      expect(await identity.registrationFee()).to.equal(20 * 1e6);
    });

    it("should reject below minimum ($1)", async function () {
      await expect(
        identity.connect(owner).setRegistrationFee(500_000)
      ).to.be.revertedWithCustomError(identity, "FeeBelowMinimum");
    });

    it("should reject above maximum ($100)", async function () {
      await expect(
        identity.connect(owner).setRegistrationFee(101 * 1e6)
      ).to.be.revertedWithCustomError(identity, "FeeAboveMaximum");
    });

    it("should clamp current registration fee when bounds move below it", async function () {
      expect(await identity.registrationFee()).to.equal(10n * 10n ** 6n);

      await identity.connect(owner).setRegistrationFeeBounds(1 * 1e6, 5 * 1e6);

      expect(await identity.minRegistrationFee()).to.equal(1n * 10n ** 6n);
      expect(await identity.maxRegistrationFee()).to.equal(5n * 10n ** 6n);
      expect(await identity.registrationFee()).to.equal(5n * 10n ** 6n);
    });

    it("should clamp current registration fee when bounds move above it", async function () {
      expect(await identity.registrationFee()).to.equal(10n * 10n ** 6n);

      await identity.connect(owner).setRegistrationFeeBounds(20 * 1e6, 100 * 1e6);

      expect(await identity.minRegistrationFee()).to.equal(20n * 10n ** 6n);
      expect(await identity.maxRegistrationFee()).to.equal(100n * 10n ** 6n);
      expect(await identity.registrationFee()).to.equal(20n * 10n ** 6n);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  Platform Bulk Registration
  // ═══════════════════════════════════════════════════════════════

  describe("Bulk registration", function () {
    beforeEach(async function () {
      // Approve platform for all bulk tests
      await identity.connect(owner).approvePlatform(platform.address);
    });

    it("should allow approved platform to bulk-register agents", async function () {
      const agents = [ethers.Wallet.createRandom().address, ethers.Wallet.createRandom().address];
      const uris = ["https://agent1.test/card.json", "https://agent2.test/card.json"];

      const totalBefore = await identity.totalPaidRegistrations();
      await identity.connect(platform).registerBulkForPlatform(agents, uris);
      const totalAfter = await identity.totalPaidRegistrations();

      expect(totalAfter - totalBefore).to.equal(2n);
    });

    it("should reject bulk registration from non-approved platform", async function () {
      const agents = [ethers.Wallet.createRandom().address];
      const uris = ["https://agent.test/card.json"];

      await expect(
        identity.connect(stranger).registerBulkForPlatform(agents, uris)
      ).to.be.revertedWithCustomError(identity, "NotApprovedPlatform");
    });

    it("should reject mismatched array lengths", async function () {
      await expect(
        identity.connect(platform).registerBulkForPlatform(
          [ethers.Wallet.createRandom().address],
          ["https://a.test/card.json", "https://b.test/card.json"]
        )
      ).to.be.revertedWithCustomError(identity, "ArrayLengthMismatch");
    });

    it("should respect maxBulkBatch limit", async function () {
      await identity.connect(owner).setMaxBulkBatch(2);

      const agents = [
        ethers.Wallet.createRandom().address,
        ethers.Wallet.createRandom().address,
        ethers.Wallet.createRandom().address,
      ];
      const uris = ["https://a.test/c.json", "https://b.test/c.json", "https://c.test/c.json"];

      await expect(
        identity.connect(platform).registerBulkForPlatform(agents, uris)
      ).to.be.revertedWithCustomError(identity, "BatchTooLarge");

      await identity.connect(owner).setMaxBulkBatch(50);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  E2E: Full Court Lifecycle
  // ═══════════════════════════════════════════════════════════════

  describe("E2E: Full escrow lifecycle with dispute", function () {
    it("should complete: create → accept → deliver → review → contest → verdict → feedback", async function () {
      // 1. Register both agents
      // Fee disabled by default (feeEnabled = false), so registration is free
      await identity.connect(contractor).registerWithFee("contractor.json");
      await identity.connect(worker).registerWithFee("worker.json");

      // 2. Create escrow ($10,000, 4 specs at 25% each)
      const jobAmount = toUSDC(10000);
      const deadline = (await time.latest()) + 14 * DAY;
      await usdc.connect(contractor).approve(await escrow.getAddress(), jobAmount);
      await escrow.connect(contractor).createEscrow(
        worker.address, jobAmount, agreementHash,
        fourEqualSpecs, deadline, 3 * DAY, 0, 0
      );

      // 3. Worker accepts
      await escrow.connect(worker).acceptJob(1);

      // 4. Worker delivers
      await escrow.connect(worker).deliverWork(1, "ipfs://delivery/final");

      // 5. Contractor reviews: 3 Pass, 1 Fail
      await escrow.connect(contractor).reviewSpecs(1, [true, true, false, true]);

      // 6. Worker contests the fail
      await escrow.connect(worker).contestSpec(1, 2, "ipfs://evidence/worker-statement");

      // 7. Contractor submits counter-evidence
      await escrow.connect(contractor).submitEvidence(1, 2, "ipfs://evidence/contractor-statement");

      // 8. Three judges vote: 2/3 say spec WAS met (worker wins)
      await escrow.connect(judge1).castVote(1, 2, 1); // SpecMet
      await escrow.connect(judge2).castVote(1, 2, 2); // SpecNotMet
      await escrow.connect(judge3).castVote(1, 2, 1); // SpecMet → 2/3 majority

      const job = await escrow.getJob(1);
      expect(job.status).to.equal(5); // Completed
      expect(job.disputeFeesCollected).to.be.gt(0);

      // 9. Bidirectional feedback (now uses wallet addresses)
      await reputation.connect(contractor).giveFeedback(worker.address, 1, "escrow-job", "development", "dkg://receipt", 1);
      await reputation.connect(worker).giveFeedback(contractor.address, 1, "contractor", "fair", "dkg://receipt2", 1);

      const [workerCount] = await reputation.getSummary(2);
      const [contractorCount] = await reputation.getSummary(1);
      expect(workerCount).to.equal(1);
      expect(contractorCount).to.equal(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  External Identity Support
  // ═══════════════════════════════════════════════════════════════

  describe("External Identity Support", function () {
    let externalRegistry: IdentityRegistry;
    let externalAgent: SignerWithAddress;

    beforeEach(async function () {
      // Deploy a separate "external" registry to simulate ERC-8004 identity from another system
      const IdentityRegistry = await ethers.getContractFactory("IdentityRegistry");
      externalRegistry = await IdentityRegistry.deploy();

      // Get a signer to be the external agent
      [, , , , , , , , , externalAgent] = await ethers.getSigners();

      // Register local agents as before
      await identity.connect(contractor).register("contractor-card");
      await identity.connect(worker).register("worker-card");
    });

    describe("Registry approval", function () {
      it("should allow owner to approve external registry", async function () {
        await expect(
          identity.connect(owner).approveRegistry(await externalRegistry.getAddress())
        ).to.emit(identity, "RegistryApproved")
          .withArgs(await externalRegistry.getAddress());

        expect(await identity.approvedRegistries(await externalRegistry.getAddress())).to.equal(true);
      });

      it("should allow owner to revoke external registry", async function () {
        await identity.connect(owner).approveRegistry(await externalRegistry.getAddress());

        await expect(
          identity.connect(owner).revokeRegistry(await externalRegistry.getAddress())
        ).to.emit(identity, "RegistryRevoked")
          .withArgs(await externalRegistry.getAddress());

        expect(await identity.approvedRegistries(await externalRegistry.getAddress())).to.equal(false);
      });

      it("should reject non-owner from approving registry", async function () {
        await expect(
          identity.connect(stranger).approveRegistry(await externalRegistry.getAddress())
        ).to.be.revertedWithCustomError(identity, "OwnableUnauthorizedAccount");
      });
    });

    describe("External agent registration", function () {
      beforeEach(async function () {
        // Approve the external registry
        await identity.connect(owner).approveRegistry(await externalRegistry.getAddress());

        // Register the agent on the external registry (they own token 1 there)
        await externalRegistry.connect(externalAgent).register("external-agent-card");
      });

      it("should allow wallet to link their external identity", async function () {
        await expect(
          identity.connect(externalAgent).registerExternal(
            await externalRegistry.getAddress(),
            1 // External agent ID
          )
        ).to.emit(identity, "ExternalAgentLinked")
          .withArgs(externalAgent.address, await externalRegistry.getAddress(), 1);

        // Check external agent mapping
        const ext = await identity.externalAgents(externalAgent.address);
        expect(ext.registry).to.equal(await externalRegistry.getAddress());
        expect(ext.agentId).to.equal(1);
      });

      it("should reject linking from non-owner of external token", async function () {
        await expect(
          identity.connect(stranger).registerExternal(
            await externalRegistry.getAddress(),
            1
          )
        ).to.be.revertedWithCustomError(identity, "NotExternalOwner");
      });

      it("should reject linking to non-approved registry", async function () {
        const UnapprovedRegistry = await ethers.getContractFactory("IdentityRegistry");
        const unapproved = await UnapprovedRegistry.deploy();
        await unapproved.connect(externalAgent).register("card");

        await expect(
          identity.connect(externalAgent).registerExternal(
            await unapproved.getAddress(),
            1
          )
        ).to.be.revertedWithCustomError(identity, "RegistryNotApproved");
      });

      it("should reject linking if already registered locally", async function () {
        // Contractor is already registered locally
        await expect(
          identity.connect(contractor).registerExternal(
            await externalRegistry.getAddress(),
            1
          )
        ).to.be.revertedWithCustomError(identity, "AlreadyRegisteredLocally");
      });

      it("should reject double-linking externally", async function () {
        await identity.connect(externalAgent).registerExternal(
          await externalRegistry.getAddress(),
          1
        );

        // Try to link again
        await externalRegistry.connect(stranger).register("another-card");
        await expect(
          identity.connect(externalAgent).registerExternal(
            await externalRegistry.getAddress(),
            2
          )
        ).to.be.revertedWithCustomError(identity, "AlreadyLinkedExternally");
      });
    });

    describe("isRegisteredWallet with external identities", function () {
      beforeEach(async function () {
        await identity.connect(owner).approveRegistry(await externalRegistry.getAddress());
        await externalRegistry.connect(externalAgent).register("external-agent-card");
        await identity.connect(externalAgent).registerExternal(
          await externalRegistry.getAddress(),
          1
        );
      });

      it("should return true for locally registered wallet", async function () {
        expect(await identity.isRegisteredWallet(contractor.address)).to.equal(true);
      });

      it("should return true for externally linked wallet", async function () {
        expect(await identity.isRegisteredWallet(externalAgent.address)).to.equal(true);
      });

      it("should return false for unregistered wallet", async function () {
        expect(await identity.isRegisteredWallet(stranger.address)).to.equal(false);
      });

      it("should return false if external token ownership changed", async function () {
        // Transfer the external NFT to someone else
        await externalRegistry.connect(externalAgent).transferFrom(
          externalAgent.address,
          stranger.address,
          1
        );

        // Now the original wallet should no longer be considered registered
        expect(await identity.isRegisteredWallet(externalAgent.address)).to.equal(false);
      });
    });

    describe("getAgentIdentity", function () {
      beforeEach(async function () {
        await identity.connect(owner).approveRegistry(await externalRegistry.getAddress());
        await externalRegistry.connect(externalAgent).register("external-agent-card");
        await identity.connect(externalAgent).registerExternal(
          await externalRegistry.getAddress(),
          1
        );
      });

      it("should return local identity for locally registered wallet", async function () {
        const agentIdentity = await identity.getAgentIdentity(contractor.address);
        expect(agentIdentity.registry).to.equal(await identity.getAddress());
        expect(agentIdentity.agentId).to.equal(1);
      });

      it("should return external identity for externally linked wallet", async function () {
        const agentIdentity = await identity.getAgentIdentity(externalAgent.address);
        expect(agentIdentity.registry).to.equal(await externalRegistry.getAddress());
        expect(agentIdentity.agentId).to.equal(1);
      });

      it("should return zero identity for unregistered wallet", async function () {
        const agentIdentity = await identity.getAgentIdentity(stranger.address);
        expect(agentIdentity.registry).to.equal(ethers.ZeroAddress);
        expect(agentIdentity.agentId).to.equal(0);
      });
    });

    describe("External agents in escrow", function () {
      beforeEach(async function () {
        await identity.connect(owner).approveRegistry(await externalRegistry.getAddress());
        await externalRegistry.connect(externalAgent).register("external-agent-card");
        await identity.connect(externalAgent).registerExternal(
          await externalRegistry.getAddress(),
          1
        );

        // Give the external agent some USDC
        await usdc.mint(externalAgent.address, toUSDC(100000));
      });

      it("should allow external agent to be a contractor", async function () {
        const deadline = (await time.latest()) + 7 * DAY;
        await usdc.connect(externalAgent).approve(await escrow.getAddress(), toUSDC(1000));

        await expect(
          escrow.connect(externalAgent).createEscrow(
            worker.address,
            toUSDC(1000),
            agreementHash,
            fourEqualSpecs,
            deadline,
            3 * DAY,
            0,
            0
          )
        ).to.emit(escrow, "EscrowCreated");
      });

      it("should allow external agent to be a worker", async function () {
        const deadline = (await time.latest()) + 7 * DAY;
        await usdc.connect(contractor).approve(await escrow.getAddress(), toUSDC(1000));

        await escrow.connect(contractor).createEscrow(
          externalAgent.address,
          toUSDC(1000),
          agreementHash,
          fourEqualSpecs,
          deadline,
          3 * DAY,
          0,
          0
        );

        await expect(escrow.connect(externalAgent).acceptJob(1)).to.emit(escrow, "JobAccepted");
      });
    });

    describe("External agents in reputation", function () {
      beforeEach(async function () {
        await identity.connect(owner).approveRegistry(await externalRegistry.getAddress());
        await externalRegistry.connect(externalAgent).register("external-agent-card");
        await identity.connect(externalAgent).registerExternal(
          await externalRegistry.getAddress(),
          1
        );
      });

      it("should allow external agent to give feedback", async function () {
        await expect(
          reputation.connect(externalAgent).giveFeedback(
            worker.address,
            1,
            "test",
            "feedback",
            "uri",
            0
          )
        ).to.emit(reputation, "FeedbackGiven");
      });

      it("should allow feedback to external agent", async function () {
        await expect(
          reputation.connect(contractor).giveFeedback(
            externalAgent.address,
            1,
            "test",
            "feedback",
            "uri",
            0
          )
        ).to.emit(reputation, "FeedbackGiven");

        // Verify via wallet-based lookup
        const [count, satisfied] = await reputation.getSummaryByWallet(externalAgent.address);
        expect(count).to.equal(1);
        expect(satisfied).to.equal(1);
      });

      it("should reject feedback if external registry is revoked", async function () {
        await identity.connect(owner).revokeRegistry(await externalRegistry.getAddress());

        // External agent is no longer considered registered
        await expect(
          reputation.connect(externalAgent).giveFeedback(
            worker.address,
            1,
            "test",
            "feedback",
            "uri",
            0
          )
        ).to.be.revertedWithCustomError(reputation, "SenderNotRegistered");
      });
    });
  });
});
