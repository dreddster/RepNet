import type { RepNet } from "../client";
import type { JobContext } from "./agreement";
import type { JobCompletionSignoff } from "./agreement";

export interface FeedbackParams {
  /** Target wallet address to leave feedback for */
  targetWallet: string;
  /** Binary satisfaction signal (true=satisfied, false=not) */
  satisfied: boolean;
  /** Feedback type tag (e.g., "escrow-job", "direct-payment", "retroactive") */
  tag: string;
  /** Category (e.g., "smart-contract-audit", "research-synthesis") */
  category: string;
  /** Payment transaction, escrow job, or other verifiable job proof reference available at feedback time. The final DKG receipt may be published later by the publisher. */
  receiptURI: string;
  /** Optional escrow job ID to link feedback to (0 = unlinked) */
  jobId?: number;
}


export interface PublicJobMetadata {
  /** Broad public category, e.g. software-development, research, security */
  category: string;
  /** Work type, e.g. coding, audit, research-synthesis */
  workType?: string;
  /** Public searchable languages used by the worker, e.g. python, solidity */
  languages?: string[];
  /** Public searchable frameworks/tools, e.g. fastapi, hardhat */
  frameworks?: string[];
  /** Public searchable domains, e.g. defi, dkg, ai-agents */
  domains?: string[];
  /** Public deliverable type, e.g. api, report, dataset, audit */
  deliverableType?: string;
  /** Sanitized public summary of the completed job */
  publicJobSummary: string;
}

export interface PublicContractorFeedback {
  requirementsClarity?: string;
  scopeDiscipline?: string;
  reviewFairness?: string;
  responsiveness?: string;
  paymentPromptness?: string;
}

export interface SubmitJobFeedbackParams {
  jobId: number;
  publisherUrl: string;
  reviewerRole: "contractor" | "worker";
  rating: 0 | 1;
  summary: string;
  tags?: string[];
  /** Payment tx / escrow job / verifiable job proof available at feedback time. */
  proofURI?: string;
  /** Contractor→Worker public searchable job metadata. Required for contractor submissions. */
  publicJobMetadata?: PublicJobMetadata;
  /** Worker→Contractor public behavior metadata. Required for worker submissions. */
  contractorFeedback?: PublicContractorFeedback;
}

export interface SubmitJobFeedbackResult {
  success: boolean;
  bothSubmitted: boolean;
  role?: "contractor" | "worker";
  dkgUal?: string;
  metadataStored?: boolean;
  error?: string;
}

export interface FeedbackSummary {
  wallet: string;
  totalReviews: bigint;
  satisfiedCount: bigint;
  satisfactionRate: number;
}

/**
 * Tier 1 — auto-computed from job context (always present).
 */
export interface Tier1Feedback {
  totalDuration: number; // seconds
  paymentAmount: number; // USDC
  satisfied: boolean; // binary yes/no — the one subjective signal
  source: "individual" | "platform" | "retroactive";
  repeatEngagement: boolean;
}

/**
 * Tier 2 — agent-reported, factual fields (suggested).
 */
export interface Tier2Feedback {
  techStack?: string[];
  deliverableType?: string; // code, report, data, analysis, design, etc.
  deliverableFormat?: string; // json, pdf, api, repo, etc.
  dataScale?: string; // small (<1MB), medium (1-100MB), large (>100MB)
  specsCount?: number;
  specsDelivered?: number;
  text?: string; // free-text review
  reviewHighlight?: string; // one-line summary (generated at publish time)
}

/**
 * Tier 3 — platform-custom (negotiated per integration).
 */
export interface Tier3Feedback {
  [key: string]: any;
}

/**
 * Full structured feedback ready for DKG publishing.
 */
export interface StructuredFeedback {
  jobId: string;
  fromAgent: string; // wallet
  toAgent: string; // wallet
  fromAgentId?: bigint;
  toAgentId?: bigint;
  signoff?: JobCompletionSignoff;
  tier1: Tier1Feedback;
  tier2?: Tier2Feedback;
  tier3?: Tier3Feedback;
  timestamp: number;
}

/**
 * Callback for automated feedback generation.
 * Implement this to use your agent's LLM for auto-filling Tier 2 fields.
 */
export type FeedbackGenerator = (
  context: JobContext,
  satisfied: boolean
) => Promise<Tier2Feedback>;

export class FeedbackModule {
  private generator?: FeedbackGenerator;

  constructor(private repnet: RepNet) {}

  /**
   * Register an automated feedback generator.
   * Called during SDK setup. The generator uses the agent's LLM
   * to auto-fill Tier 2 fields from job context.
   *
   * Usage:
   *   repnet.feedback.setGenerator(async (context, satisfaction) => {
   *     const response = await myLLM.generate(`Summarize this job: ${context.category}...`);
   *     return {
   *       deliverableType: "code",
   *       techStack: ["typescript", "solidity"],
   *       text: response.text,
   *       reviewHighlight: response.oneLiner,
   *     };
   *   });
   */
  setGenerator(generator: FeedbackGenerator) {
    this.generator = generator;
  }

  /**
   * Generate structured feedback for a completed job.
   * Auto-computes Tier 1, uses generator for Tier 2 if registered.
   * Operator should review before signing.
   *
   * @param context Job context from agreement module
   * @param satisfied Binary satisfaction signal (true/false)
   * @param signoff Optional EIP-712 signoff
   * @param isContractor Whether caller is the contractor (affects "from" perspective)
   */
  async generate(
    context: JobContext,
    satisfied: boolean,
    signoff?: JobCompletionSignoff,
    isContractor: boolean = true
  ): Promise<StructuredFeedback> {
    const myAddress = await this.repnet.getAddress();
    const counterparty = isContractor ? context.worker : context.contractor;

    // Tier 1 — auto-computed
    const tier1: Tier1Feedback = {
      totalDuration: context.completedAt
        ? context.completedAt - Math.floor(Date.now() / 1000)
        : 0,
      paymentAmount: Number(context.amount) / 1e6,
      satisfied,
      source: "individual",
      repeatEngagement: false, // TODO: check past jobs with same counterparty
    };

    // Tier 2 — auto-generated if generator registered
    let tier2: Tier2Feedback | undefined;
    if (this.generator) {
      tier2 = await this.generator(context, satisfied);
    } else if (context.techStack || context.deliverableType || context.specsCount) {
      // Use context fields if no LLM generator
      tier2 = {
        techStack: context.techStack,
        deliverableType: context.deliverableType,
        specsCount: context.specsCount,
        specsDelivered: context.specsDelivered,
      };
    }

    // Lookup agent IDs
    let fromAgentId: bigint | undefined;
    let toAgentId: bigint | undefined;
    try {
      fromAgentId = await this.repnet.contracts.identity.walletToAgent(myAddress);
      toAgentId = await this.repnet.contracts.identity.walletToAgent(counterparty);
    } catch {
      // Non-critical — IDs are optional in the feedback struct
    }

    return {
      jobId: context.jobId,
      fromAgent: myAddress,
      toAgent: counterparty,
      fromAgentId: fromAgentId && fromAgentId > 0n ? fromAgentId : undefined,
      toAgentId: toAgentId && toAgentId > 0n ? toAgentId : undefined,
      signoff,
      tier1,
      tier2,
      timestamp: Math.floor(Date.now() / 1000),
    };
  }

  /**
   * Submit feedback on-chain. Posts to ReputationRegistry.
   * Call after reviewing the generated StructuredFeedback.
   */
  async submit(feedback: StructuredFeedback) {
    if (!feedback.toAgent) {
      throw new Error("Cannot submit: counterparty wallet address unknown");
    }

    const tag = feedback.tier1.source === "retroactive"
      ? "retroactive"
      : feedback.signoff
        ? "job-completed"
        : "direct-review";

    const category = feedback.tier2?.deliverableType || "general";

    // Use a stable job proof placeholder. Publisher/DKG flows can later materialize the final DKG receipt.
    const receiptURI = `repnet:job:${feedback.jobId}`;

    return this.give({
      targetWallet: feedback.toAgent,
      satisfied: feedback.tier1.satisfied,
      tag,
      category,
      receiptURI,
    });
  }

  /**
   * Submit raw feedback to ReputationRegistry.
   * Uses wallet-based addressing for universal agent identity support.
   */
  async give(params: FeedbackParams) {
    const tx = await this.repnet.contracts.reputation.giveFeedback(
      params.targetWallet,
      params.satisfied ? 1 : 0, // Binary: 1=satisfied, 0=not
      params.tag,
      params.category,
      params.receiptURI,
      params.jobId ?? 0 // 0 = unlinked
    );
    return tx.wait();
  }

  /**
   * Get feedback summary for a wallet. O(1) — uses running totals.
   * Supports both native and externally-linked agents via wallet addressing.
   */
  async getSummary(wallet: string): Promise<FeedbackSummary> {
    const [totalReviews, satisfied] =
      await this.repnet.contracts.reputation.getSummaryByWallet(wallet);
    return {
      wallet,
      totalReviews,
      satisfiedCount: satisfied,
      satisfactionRate: totalReviews > 0n
        ? Number(satisfied) / Number(totalReviews)
        : 0,
    };
  }

  /**
   * Get feedback IDs for a wallet.
   */
  async getFeedbackIds(wallet: string): Promise<bigint[]> {
    return this.repnet.contracts.reputation.getAgentFeedbackIdsByWallet(wallet);
  }

  /**
   * Helper: quick bidirectional feedback after a job.
   */
  async reviewCounterparty(
    counterpartyWallet: string,
    satisfied: boolean,
    category: string,
    receiptURI: string,
    isContractor: boolean = true
  ) {
    return this.give({
      targetWallet: counterpartyWallet,
      satisfied,
      tag: isContractor ? "job-completed" : "contractor-review",
      category,
      receiptURI,
    });
  }

  /**
   * Submit post-job feedback to the publisher API.
   * Uses wallet signature auth (EIP-191). If a generator is registered,
   * auto-drafts the feedback from job context before submitting.
   *
   * @param jobId On-chain escrow job ID
   * @param publisherUrl Publisher API base URL (e.g., "http://localhost:8787")
   * @param rating Binary: 1=satisfied, 0=unsatisfied
   * @param summary One-sentence summary (≤500 chars). If omitted, uses generator.
   * @param tags Optional tags (e.g., ["punctual", "quality"])
   */
  async submitJobFeedback(
    paramsOrJobId: SubmitJobFeedbackParams | number,
    publisherUrl?: string,
    rating?: 0 | 1,
    summary?: string,
    tags?: string[]
  ): Promise<SubmitJobFeedbackResult> {
    const params: SubmitJobFeedbackParams = typeof paramsOrJobId === "number"
      ? {
        jobId: paramsOrJobId,
        publisherUrl: String(publisherUrl),
        reviewerRole: "contractor",
        rating: rating as 0 | 1,
        summary: String(summary),
        tags,
      }
      : paramsOrJobId;

    this.validateRoleAwareFeedback(params);

    const signer = this.repnet.getSigner();
    const address = await signer.getAddress();
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const message = `RepNet Access: feedback:${params.jobId}\nTimestamp: ${timestamp}\nWallet: ${address}`;
    const signature = await signer.signMessage(message);

    const res = await fetch(`${params.publisherUrl}/api/feedback/${params.jobId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-wallet": address,
        "x-signature": signature,
        "x-timestamp": timestamp,
      },
      body: JSON.stringify({
        rating: params.rating,
        summary: params.summary,
        tags: params.tags,
        role: params.reviewerRole,
        proofURI: params.proofURI,
        publicJobMetadata: params.publicJobMetadata,
        contractorFeedback: params.contractorFeedback,
      }),
    });

    const data = (await res.json()) as { error?: string; bothSubmitted?: boolean; role?: "contractor" | "worker"; dkgUal?: string; metadataStored?: boolean };
    if (!res.ok) {
      return { success: false, bothSubmitted: false, error: data.error };
    }
    return {
      success: true,
      bothSubmitted: !!data.bothSubmitted,
      role: data.role,
      dkgUal: data.dkgUal,
      metadataStored: data.metadataStored,
    };
  }

  private validateRoleAwareFeedback(params: SubmitJobFeedbackParams): void {
    if (params.rating !== 0 && params.rating !== 1) {
      throw new Error("rating must be 0 or 1");
    }
    if (!params.summary?.trim()) {
      throw new Error("summary is required");
    }
    if (params.summary.length > 500) {
      throw new Error("summary must be ≤500 characters");
    }
    if (params.reviewerRole === "contractor" && !params.publicJobMetadata) {
      throw new Error("contractor feedback requires publicJobMetadata");
    }
    if (params.reviewerRole === "worker" && !params.contractorFeedback) {
      throw new Error("worker feedback requires contractorFeedback");
    }
  }

  /**
   * Auto-generate and submit feedback using the registered LLM generator.
   * Generates Tier 2 fields from job context, extracts a one-line summary,
   * then submits to the publisher API.
   *
   * @param jobId On-chain escrow job ID
   * @param publisherUrl Publisher API base URL
   * @param context Job context from agreement module
   * @param satisfied Binary satisfaction signal
   * @param isContractor Whether the caller is the contractor
   */
  async autoSubmitFeedback(
    jobId: number,
    publisherUrl: string,
    context: JobContext,
    satisfied: boolean,
    isContractor: boolean = true
  ): Promise<{ success: boolean; bothSubmitted: boolean; error?: string }> {
    let summary = `Job ${jobId} completed — ${satisfied ? "satisfied" : "not satisfied"}`;
    const tags: string[] = [];

    if (this.generator) {
      const tier2 = await this.generator(context, satisfied);
      if (tier2.reviewHighlight) {
        summary = tier2.reviewHighlight;
      } else if (tier2.text) {
        // Take first sentence
        const firstSentence = tier2.text.split(/[.!?]/)[0];
        summary = firstSentence.length > 10 ? firstSentence.trim() : summary;
      }
      if (tier2.techStack) tags.push(...tier2.techStack.slice(0, 3));
      if (tier2.deliverableType) tags.push(tier2.deliverableType);
    }

    return this.submitJobFeedback({
      jobId,
      publisherUrl,
      reviewerRole: isContractor ? "contractor" : "worker",
      rating: satisfied ? 1 : 0,
      summary,
      tags,
      ...(isContractor
        ? { publicJobMetadata: {
          category: context.category || "general",
          languages: context.techStack,
          deliverableType: context.deliverableType,
          publicJobSummary: summary,
        } }
        : { contractorFeedback: { reviewFairness: satisfied ? "fair" : "disputed" } }),
    });
  }
}
