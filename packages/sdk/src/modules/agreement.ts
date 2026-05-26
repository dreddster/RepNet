import { ethers } from "ethers";
import type { RepNet } from "../client";

/**
 * EIP-712 domain for RepNet signoffs.
 */
const SIGNOFF_TYPES = {
  JobCompletion: [
    { name: "jobId", type: "string" },
    { name: "worker", type: "address" },
    { name: "contractor", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "satisfied", type: "bool" },
    { name: "completedAt", type: "uint256" },
  ],
};

export interface JobCompletionSignoff {
  jobId: string;
  worker: string;
  contractor: string;
  amount: bigint;
  satisfied: boolean; // binary yes/no
  completedAt: number;
  signature: string;
}

export interface JobContext {
  /** Unique job identifier (tx hash, platform ID, or UUID) */
  jobId: string;
  /** Contractor wallet */
  contractor: string;
  /** Worker wallet */
  worker: string;
  /** USDC amount (6 decimals) */
  amount: bigint;
  /** Unix timestamp of completion */
  completedAt?: number;
  /** Job category / description */
  category?: string;
  /** Tech stack used */
  techStack?: string[];
  /** Deliverable type (code, report, data, analysis, etc.) */
  deliverableType?: string;
  /** Number of specs defined */
  specsCount?: number;
  /** Number of specs delivered */
  specsDelivered?: number;
}

export interface PlatformHookResult {
  jobContext: JobContext;
  shouldPublish: boolean;
}

export interface JobSpec {
  /** Spec identifier */
  id: string;
  /** Human-readable description of the deliverable */
  description: string;
  /** Weight as percentage (all weights must sum to 100) */
  weight: number;
}

export interface PublishAgreementParams {
  /** Human-readable job description */
  description: string;
  /** Spec items with weights (must sum to 100) */
  specs: JobSpec[];
  /** Worker wallet address */
  worker: string;
  /** USDC amount as string (e.g. "100.00") or bigint (6 decimals) */
  amount: string | bigint;
  /** Unix timestamp for worker to deliver by */
  deliveryDeadline: number;
  /** Review period in seconds (default: 7 days) */
  reviewPeriod?: number;
  /** Spec visibility on DKG: 'public' (default) or 'private' */
  specVisibility?: "public" | "private";
}

export interface PublishedAgreement {
  /** On-chain escrow job ID */
  jobId: bigint;
  /** Keccak256 hash of the agreement (stored on-chain) */
  agreementHash: string;
  /** Full agreement object (store off-chain / publish to DKG) */
  agreement: object;
  /** Transaction receipt */
  receipt: ethers.TransactionReceipt;
  /** UAL of the DKG Knowledge Asset (if published) */
  ual?: string;
}

/**
 * AgreementModule — handles job lifecycle hooks and EIP-712 signoffs.
 *
 * Platform integration:
 *   repnet.agreement.onJobStarted(context)   → records job start
 *   repnet.agreement.onJobCompleted(context)  → triggers signoff + feedback
 *
 * Standalone (Scenario A — RepNet-native x402):
 *   repnet.agreement.signCompletion(context, satisfied)
 */
export class AgreementModule {
  /** In-memory job tracking for this session */
  private activeJobs: Map<string, JobContext> = new Map();

  constructor(private repnet: RepNet) {}

  // ─── Legacy Agreement Entry Point ─────────────────────

  /**
   * Legacy compatibility entry point retained only to fail closed.
   *
   * RepNet publishes job agreements through the DKG module and job-board
   * lifecycle instead of the removed escrow funding path.
   */
  async publishAgreement(_params: PublishAgreementParams): Promise<PublishedAgreement> {
    throw new Error(
      "Legacy agreement funding is removed from the product path. Use RepNet job-board and DKG agreement flows instead.",
    );
  }

  // ─── Platform Hooks ─────────────────────────────────

  /**
   * Hook 1: Call when a job starts. Records context for later signoff.
   * Platform integration: place this in your job-start handler.
   *
   * @param context Job details (jobId, contractor, worker, amount, etc.)
   * @returns PlatformHookResult with shouldPublish=false (nothing to publish yet)
   */
  onJobStarted(context: JobContext): PlatformHookResult {
    this.activeJobs.set(context.jobId, {
      ...context,
      completedAt: undefined,
    });

    return {
      jobContext: context,
      shouldPublish: false,
    };
  }

  /**
   * Hook 2: Call when a job completes. Triggers signoff flow.
   * Platform integration: place this in your job-complete handler.
   *
   * @param jobId The job ID from onJobStarted
   * @param satisfied Binary satisfaction signal (true/false)
   * @param overrides Optional context overrides (e.g., actual amount, specs delivered)
   * @returns PlatformHookResult with shouldPublish=true and signoff data
   */
  async onJobCompleted(
    jobId: string,
    satisfied: boolean,
    overrides?: Partial<JobContext>
  ): Promise<PlatformHookResult & { signoff: JobCompletionSignoff }> {
    let context = this.activeJobs.get(jobId);

    if (!context) {
      // Job wasn't tracked via onJobStarted — create context from overrides
      if (!overrides?.contractor || !overrides?.worker || !overrides?.amount) {
        throw new Error(
          "Job not found. Either call onJobStarted first, or provide full overrides."
        );
      }
      context = {
        jobId,
        contractor: overrides.contractor,
        worker: overrides.worker,
        amount: overrides.amount,
        ...overrides,
      };
    }

    if (overrides) {
      context = { ...context, ...overrides };
    }
    context.completedAt = Math.floor(Date.now() / 1000);

    const signoff = await this.signCompletion(context, satisfied);

    // Remove from active jobs
    this.activeJobs.delete(jobId);

    return {
      jobContext: context,
      shouldPublish: true,
      signoff,
    };
  }

  // ─── EIP-712 Signoff ───────────────────────────────

  /**
   * Sign an EIP-712 job completion confirmation.
   * This is the cryptographic proof that the contractor approved the work.
   *
   * @param context Job context
   * @param satisfied Binary satisfaction signal (true/false)
   * @returns Signed completion data
   */
  async signCompletion(
    context: JobContext,
    satisfied: boolean
  ): Promise<JobCompletionSignoff> {
    const completedAt = context.completedAt || Math.floor(Date.now() / 1000);

    const domain = {
      name: "RepNet Protocol",
      version: "1",
      chainId: this.repnet.chainId,
      verifyingContract: this.repnet.addresses.IdentityRegistry,
    };

    const value = {
      jobId: context.jobId,
      worker: context.worker,
      contractor: context.contractor,
      amount: context.amount,
      satisfied,
      completedAt,
    };

    const signature = await (this.repnet.signer as ethers.Signer & {
      signTypedData: (
        domain: ethers.TypedDataDomain,
        types: Record<string, ethers.TypedDataField[]>,
        value: Record<string, any>
      ) => Promise<string>;
    }).signTypedData(domain, SIGNOFF_TYPES, value);

    return {
      jobId: context.jobId,
      worker: context.worker,
      contractor: context.contractor,
      amount: context.amount,
      satisfied,
      completedAt,
      signature,
    };
  }

  /**
   * Verify an EIP-712 completion signoff.
   * @param signoff The signed completion data
   * @returns The recovered signer address
   */
  verifySignoff(signoff: JobCompletionSignoff): string {
    const domain = {
      name: "RepNet Protocol",
      version: "1",
      chainId: this.repnet.chainId,
      verifyingContract: this.repnet.addresses.IdentityRegistry,
    };

    const value = {
      jobId: signoff.jobId,
      worker: signoff.worker,
      contractor: signoff.contractor,
      amount: signoff.amount,
      satisfied: signoff.satisfied,
      completedAt: signoff.completedAt,
    };

    return ethers.verifyTypedData(domain, SIGNOFF_TYPES, value, signoff.signature);
  }

  /**
   * Get currently tracked active jobs (this session only).
   */
  getActiveJobs(): JobContext[] {
    return Array.from(this.activeJobs.values());
  }
}
