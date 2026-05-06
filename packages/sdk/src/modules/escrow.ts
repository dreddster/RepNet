import { ethers } from "ethers";
import type { RepNet } from "../client";

export enum JobStatus {
  Created = 0,
  Active = 1,
  Delivered = 2,
  InReview = 3,
  Settling = 4,
  Completed = 5,
  Refunded = 6,
}

export enum SpecStatus {
  Pending = 0,
  Passed = 1,
  Failed = 2,
  Accepted = 3,
  ExtraWork = 4,
  Contested = 5,
  Resolved = 6,
}

export enum Verdict {
  None = 0,
  SpecMet = 1,
  SpecNotMet = 2,
}

export interface EscrowJob {
  jobId: bigint;
  contractor: string;
  worker: string;
  totalAmount: bigint;
  agreementHash: string;
  specCount: bigint;
  deliveryDeadline: bigint;
  reviewDeadline: bigint;
  reviewPeriod: bigint;
  status: JobStatus;
  amountSettled: bigint;
  amountReleased: bigint;
  amountRefunded: bigint;
  disputeFeesCollected: bigint;
  createdAt: bigint;
  completedAt: bigint;
}

export interface SpecItem {
  weight: bigint;
  status: SpecStatus;
  verdict: Verdict;
  contractorEvidenceURI: string;
  workerEvidenceURI: string;
  extensionDeadline: bigint;
}

export interface EscrowCreateParams {
  /** Worker wallet address */
  worker: string;
  /** USDC amount (6 decimals) */
  jobAmount: bigint;
  /** Keccak256 hash of the off-chain Job Agreement */
  agreementHash: string;
  /** Spec weights array — must sum to 10000 (100%). e.g. [4000, 3000, 3000] */
  specWeights: number[];
  /** Unix timestamp for worker to deliver by */
  deliveryDeadline: number;
  /** Review period in seconds (how long contractor has to review after delivery) */
  reviewPeriod: number;
  /** Optional collateral in basis points (0 = none, e.g. 1500 = 15%) */
  collateralBps?: number;
}

export interface EscrowPreview {
  workerReceivesFull: bigint;
  feePerSide: bigint;
  totalFee: bigint;
  disputeFeePerSpec: bigint;
}

export class EscrowModule {
  constructor(private repnet: RepNet) {}

  /**
   * Preview escrow fees before creating.
   * @param totalAmount USDC job amount (6 decimals)
   * @param specCount Number of specs
   */
  async preview(totalAmount: bigint, specCount: number): Promise<EscrowPreview> {
    const [workerReceivesFull, feePerSide, totalFee, disputeFeePerSpec] =
      await this.repnet.contracts.escrow.previewEscrow(totalAmount, specCount);
    return { workerReceivesFull, feePerSide, totalFee, disputeFeePerSpec };
  }

  /**
   * Create an escrow job. Approves USDC, deposits funds, sets specs + deadline.
   * Contractor calls this to fund a job before the worker accepts.
   */
  async create(params: EscrowCreateParams) {
    const {
      worker,
      jobAmount,
      agreementHash,
      specWeights,
      deliveryDeadline,
      reviewPeriod,
      collateralBps = 0,
    } = params;

    // Approve escrow to pull USDC
    const approveTx = await this.repnet.contracts.usdc.approve(
      this.repnet.addresses.RepNetEscrow,
      jobAmount
    );
    await approveTx.wait();

    // Wait for state to settle (Base Sepolia read-after-write quirk)
    if (this.repnet.chainId === 84532) {
      await new Promise((r) => setTimeout(r, 2000));
    }

    const tx = await this.repnet.contracts.escrow.createEscrow(
      worker,
      jobAmount,
      agreementHash,
      specWeights,
      deliveryDeadline,
      reviewPeriod,
      collateralBps
    );
    const receipt = await tx.wait();

    // Extract jobId from EscrowCreated event
    let jobId = 0n;
    if (receipt && receipt.logs) {
      for (const log of receipt.logs) {
        try {
          const parsed = this.repnet.contracts.escrow.interface.parseLog({
            topics: log.topics as string[],
            data: log.data,
          });
          if (parsed && parsed.name === "EscrowCreated") {
            jobId = parsed.args[0]; // first indexed arg = jobId
            break;
          }
        } catch {
          // Not our event, skip
        }
      }
    }

    // Fallback to state read if event parsing fails
    if (jobId === 0n) {
      await new Promise((r) => setTimeout(r, 3000));
      const nextId = await this.repnet.contracts.escrow.nextJobId();
      jobId = nextId - 1n;
    }

    return { receipt, jobId };
  }

  // ─── Worker Actions ──────────────────────────────

  /**
   * Worker accepts an escrow job. Moves status from Created → Active.
   * Only the designated worker can call this.
   */
  async acceptJob(jobId: bigint) {
    const tx = await this.repnet.contracts.escrow.acceptJob(jobId);
    return tx.wait();
  }

  /**
   * Worker delivers work. Moves status from Active → Delivered.
   * @param jobId The escrow job ID
   * @param deliveryURI URI pointing to the delivered work (IPFS, DKG, etc.)
   */
  async deliverWork(jobId: bigint, deliveryURI: string) {
    const tx = await this.repnet.contracts.escrow.deliverWork(jobId, deliveryURI);
    return tx.wait();
  }

  /**
   * Worker accepts a failed spec (agrees it wasn't completed).
   * Funds for this spec go back to contractor.
   */
  async acceptFail(jobId: bigint, specIndex: number) {
    const tx = await this.repnet.contracts.escrow.acceptFail(jobId, specIndex);
    return tx.wait();
  }

  /**
   * Worker requests extra time/work for a failed spec.
   * @param newDeadline New unix timestamp for delivery
   */
  async requestExtraWork(jobId: bigint, specIndex: number, newDeadline: number) {
    const tx = await this.repnet.contracts.escrow.requestExtraWork(jobId, specIndex, newDeadline);
    return tx.wait();
  }

  /**
   * Worker contests a failed spec. Triggers LLM judge dispute resolution.
   * Evidence can be submitted on-chain (via evidenceURI) or privately via the Gateway API.
   * @param evidenceURI Optional URI pointing to worker's evidence. Pass "" to submit evidence privately via gateway.
   */
  async contestSpec(jobId: bigint, specIndex: number, evidenceURI: string = "") {
    const tx = await this.repnet.contracts.escrow.contestSpec(jobId, specIndex, evidenceURI);
    return tx.wait();
  }

  /**
   * Either party submits additional evidence during a dispute (on-chain).
   * For private evidence submission, use submitEvidencePrivate() instead.
   */
  async submitEvidence(jobId: bigint, specIndex: number, evidenceURI: string) {
    const tx = await this.repnet.contracts.escrow.submitEvidence(jobId, specIndex, evidenceURI);
    return tx.wait();
  }

  /**
   * Submit evidence PRIVATELY to the RepNet Gateway.
   * Neither party can see the other's submission during the evidence window.
   * Returns a signed hash receipt as cryptographic proof of submission.
   *
   * Requires gatewayUrl to be set in RepNet config.
   */
  async submitEvidencePrivate(
    jobId: bigint,
    specIndex: number,
    evidence: Record<string, unknown> | string
  ): Promise<{
    evidenceHash: string;
    submittedAt: string;
    gatewaySignature: string;
  }> {
    if (!this.repnet.gatewayUrl) {
      throw new Error("gatewayUrl not configured — set it in RepNet config to use private evidence submission");
    }

    const wallet = await this.repnet.getAddress();
    const evidenceStr = typeof evidence === "string" ? evidence : JSON.stringify(evidence);
    const evidenceHash = ethers.keccak256(ethers.toUtf8Bytes(evidenceStr));

    // Sign: repnet:evidence:{jobId}:{specIndex}:{evidenceHash}
    const message = `repnet:evidence:${jobId.toString()}:${specIndex}:${evidenceHash}`;
    const signature = await this.repnet.signer.signMessage(message);

    const response = await fetch(
      `${this.repnet.gatewayUrl}/disputes/${jobId.toString()}/${specIndex}/evidence`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ evidence, signature, wallet }),
      }
    );

    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as any;
      throw new Error(
        `Gateway evidence submission failed (${response.status}): ${body?.error?.message ?? response.statusText}`
      );
    }

    const result = (await response.json()) as any;
    return {
      evidenceHash: result.data.evidenceHash,
      submittedAt: result.data.submittedAt,
      gatewaySignature: result.data.gatewaySignature,
    };
  }

  // ─── Contractor Actions ──────────────────────────

  /**
   * Contractor reviews all specs at once. Pass/fail for each spec.
   * If all pass → auto-settles to worker.
   * If any fail → moves to InReview, worker can respond per-spec.
   *
   * @param results Array of booleans, one per spec. true = passed, false = failed.
   */
  async reviewSpecs(jobId: bigint, results: boolean[]) {
    const tx = await this.repnet.contracts.escrow.reviewSpecs(jobId, results);
    return tx.wait();
  }

  /**
   * Contractor approves a worker's extension request for a failed spec.
   */
  async approveExtension(jobId: bigint, specIndex: number) {
    const tx = await this.repnet.contracts.escrow.approveExtension(jobId, specIndex);
    return tx.wait();
  }

  /**
   * Contractor denies a worker's extension request for a failed spec.
   */
  async denyExtension(jobId: bigint, specIndex: number) {
    const tx = await this.repnet.contracts.escrow.denyExtension(jobId, specIndex);
    return tx.wait();
  }

  /**
   * Contractor reviews an extended spec after the worker re-delivers.
   * Called after approving an extension and worker completing the extra work.
   * @param passed true = spec now passes, false = spec still fails
   */
  async reviewExtendedSpec(jobId: bigint, specIndex: number, passed: boolean) {
    const tx = await this.repnet.contracts.escrow.reviewExtendedSpec(jobId, specIndex, passed);
    return tx.wait();
  }

  // ─── Timeouts / Claims ───────────────────────────

  /**
   * Claim refund if worker didn't deliver by deadline. Anyone can call.
   */
  async claimRefund(jobId: bigint) {
    const tx = await this.repnet.contracts.escrow.claimRefund(jobId);
    return tx.wait();
  }

  /**
   * Claim auto-approve if contractor didn't review after delivery. Anyone can call.
   * Auto-settles all specs as passed → funds go to worker.
   */
  async claimAutoApprove(jobId: bigint) {
    const tx = await this.repnet.contracts.escrow.claimAutoApprove(jobId);
    return tx.wait();
  }

  /**
   * Claim settlement for unresponded failed specs. Contractor can call this
   * if worker doesn't respond to failed specs within the worker response deadline.
   * Settles all unresponded Failed specs in contractor's favor.
   */
  async claimUnrespondedFails(jobId: bigint) {
    const tx = await this.repnet.contracts.escrow.claimUnrespondedFails(jobId);
    return tx.wait();
  }

  /**
   * Claim settlement for an ExtraWork spec that worker didn't complete in time.
   * Contractor can call this after the extension deadline passes without delivery.
   */
  async claimExtraWorkTimeout(jobId: bigint, specIndex: number) {
    const tx = await this.repnet.contracts.escrow.claimExtraWorkTimeout(jobId, specIndex);
    return tx.wait();
  }

  // ─── Judge Actions ───────────────────────────────

  /**
   * Authorized judge casts a vote on a contested spec.
   * @param vote true = spec was met (worker wins), false = spec not met (contractor wins)
   */
  async castVote(jobId: bigint, specIndex: number, vote: boolean) {
    // Solidity Verdict enum: 1 = SpecMet (worker wins), 2 = SpecNotMet (contractor wins).
    const verdict = vote ? Verdict.SpecMet : Verdict.SpecNotMet;
    const tx = await this.repnet.contracts.escrow.castVote(jobId, specIndex, verdict);
    return tx.wait();
  }

  // ─── Read Methods ────────────────────────────────

  /**
   * Get escrow job details.
   */
  async getJob(jobId: bigint): Promise<EscrowJob> {
    const job = await this.repnet.contracts.escrow.getJob(jobId);
    return {
      jobId,
      contractor: job.contractor,
      worker: job.worker,
      totalAmount: job.totalAmount,
      agreementHash: job.agreementHash,
      specCount: job.specCount,
      deliveryDeadline: job.deliveryDeadline,
      reviewDeadline: job.reviewDeadline,
      reviewPeriod: job.reviewPeriod,
      status: Number(job.status) as JobStatus,
      amountSettled: job.amountSettled,
      amountReleased: job.amountReleased,
      amountRefunded: job.amountRefunded,
      disputeFeesCollected: job.disputeFeesCollected,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
    };
  }

  /**
   * Get a single spec item by index.
   */
  async getSpec(jobId: bigint, specIndex: number): Promise<SpecItem> {
    const spec = await this.repnet.contracts.escrow.getSpec(jobId, specIndex);
    return {
      weight: spec.weight,
      status: Number(spec.status) as SpecStatus,
      verdict: Number(spec.verdict) as Verdict,
      contractorEvidenceURI: spec.contractorEvidenceURI,
      workerEvidenceURI: spec.workerEvidenceURI,
      extensionDeadline: spec.extensionDeadline,
    };
  }

  /**
   * Get all specs for a job.
   */
  async getAllSpecs(jobId: bigint): Promise<SpecItem[]> {
    const specs = await this.repnet.contracts.escrow.getAllSpecs(jobId);
    return specs.map((spec: any) => ({
      weight: spec.weight,
      status: Number(spec.status) as SpecStatus,
      verdict: Number(spec.verdict) as Verdict,
      contractorEvidenceURI: spec.contractorEvidenceURI,
      workerEvidenceURI: spec.workerEvidenceURI,
      extensionDeadline: spec.extensionDeadline,
    }));
  }

  /**
   * Get spec statuses as an array of SpecStatus enums.
   */
  async getSpecStatuses(jobId: bigint): Promise<SpecStatus[]> {
    const statuses = await this.repnet.contracts.escrow.getSpecStatuses(jobId);
    return statuses.map((s: any) => Number(s) as SpecStatus);
  }

  /**
   * Get vote tally for a contested spec.
   */
  async getVoteTally(jobId: bigint, specIndex: number) {
    const [specMetVotes, specNotMetVotes, voters] =
      await this.repnet.contracts.escrow.getVoteTally(jobId, specIndex);
    return { specMetVotes, specNotMetVotes, voters };
  }

  /**
   * Get vault info for a job (vault address + balance).
   */
  async getVaultInfo(jobId: bigint) {
    const [vault, vaultBalance] =
      await this.repnet.contracts.escrow.getVaultInfo(jobId);
    return { vault, vaultBalance };
  }

  /**
   * Get collateral info for a job.
   */
  async getCollateralInfo(jobId: bigint) {
    const [contractorCollateral, workerCollateral, collateralBps, collateralSettled] =
      await this.repnet.contracts.escrow.getCollateralInfo(jobId);
    return { contractorCollateral, workerCollateral, collateralBps, collateralSettled };
  }

  /**
   * Get the delivery URI for a job.
   */
  async getDeliveryURI(jobId: bigint): Promise<string> {
    return this.repnet.contracts.escrow.deliveryURIs(jobId);
  }

  // ─── Convenience Methods ─────────────────────────

  /**
   * Review all specs as passed. Convenience for the common case.
   * Equivalent to reviewSpecs(jobId, [true, true, ...]).
   */
  async approveAll(jobId: bigint) {
    const job = await this.getJob(jobId);
    const allPass = Array(Number(job.specCount)).fill(true);
    return this.reviewSpecs(jobId, allPass);
  }
}
