export interface PublishAgreementDKGParams {
  /** On-chain job ID */
  jobId: bigint;
  /** Keccak256 hash of the agreement */
  agreementHash: string;
  /** Full agreement object */
  agreement: {
    version: string;
    description: string;
    specs: Array<{ id: string; description: string; weight: number }>;
    worker: string;
    contractor: string;
    amount: string;
    deliveryDeadline: number;
    reviewPeriod: number;
    createdAt: number;
  };
  /** Visibility for specs: 'public' or 'private' */
  specVisibility: "public" | "private";
}

export interface AgreementAsset {
  public: {
    "@context": string;
    "@type": string;
    "@id": string;
    "repnet:jobId": string;
    "repnet:agreementHash": string;
    "repnet:contractor": string;
    "repnet:worker": string;
    "repnet:amount": string;
    "repnet:deliveryDeadline": number;
    "repnet:createdAt": number;
    "repnet:specs"?: Array<{ id: string; description: string; weight: number }>;
    "repnet:specCount"?: number;
    "repnet:reviewPeriod"?: number;
  };
  private?: {
    "@context": string;
    "@graph": Array<{
      "@id": string;
      "repnet:specs": Array<{ id: string; description: string; weight: number }>;
      "repnet:description": string;
      "repnet:reviewPeriod": number;
    }>;
  };
}

export interface RepNetReceipt {
  /** On-chain job/feedback ID */
  jobId: string;
  /** Contractor agent ID */
  contractorAgentId: string;
  /** Worker agent ID */
  workerAgentId: string;
  /** Contractor wallet */
  contractorWallet: string;
  /** Worker wallet */
  workerWallet: string;
  /** Job amount in USDC */
  paymentAmount: number;
  /** RepNet fee collected */
  feeAmount: number;
  /** Binary satisfaction signal (true=satisfied, false=not) */
  satisfied: boolean;
  /** Feedback tag */
  tag: string;
  /** Job category */
  category: string;
  /** Source provenance */
  source: {
    type: "individual" | "platform" | "retroactive";
    platformId?: string;
  };
  /** Tier 2 fields (optional) */
  techStack?: string[];
  deliverableType?: string;
  dataScale?: string;
  specsCount?: number;
  specsDelivered?: number;
  reviewText?: string;
  /** Tier 3 platform-custom fields */
  customFields?: Record<string, any>;
  /** Timestamps */
  jobStartedAt?: string;
  jobCompletedAt: string;
  /** On-chain transaction hash */
  txHash: string;
  /** Chain ID */
  chainId: number;
}

export interface RepNetAgentProfile {
  /** ERC-8004/RepNet agent ID */
  agentId: string;
  /** Public owner/operator wallet */
  wallet: string;
  /** Public A2A Agent Card URL or URI registered on-chain */
  agentCardUrl: string;
  /** Hash of the Agent Card content when available */
  agentCardHash?: string;
  /** Self-declared public agent name */
  name: string;
  /** Self-declared public agent description */
  description: string;
  /** Self-declared skills/capabilities used for discovery before job evidence exists */
  skills?: string[];
  /** Agent frameworks or runtimes represented by this profile */
  frameworks?: string[];
  /** Public tools/integrations represented by this profile */
  tools?: string[];
  /** ISO timestamp for profile creation/publication */
  createdAt: string;
  /** Chain ID where the agent identity is registered */
  chainId: number;
  /** Optional signature over profile/card content, if supplied by the caller */
  signature?: string;
}

/**
 * Build a public JSON-LD Knowledge Asset from a RepNet Agent Profile.
 * Pure builder: no DKG client, fetch, signer, node auth, or runtime side effects.
 */
export function buildAgentProfileAsset(profile: RepNetAgentProfile) {
  const asset: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "repnet:AgentProfile",
    "@id": `repnet:agent:${profile.chainId}:${profile.agentId}`,
    "repnet:agentId": profile.agentId,
    "repnet:wallet": profile.wallet,
    "repnet:agentCardUrl": profile.agentCardUrl,
    "repnet:name": profile.name,
    "repnet:description": profile.description,
    "repnet:skills": profile.skills || [],
    "repnet:frameworks": profile.frameworks || [],
    "repnet:tools": profile.tools || [],
    "repnet:createdAt": profile.createdAt,
    "repnet:chainId": profile.chainId,
  };

  if (profile.agentCardHash) asset["repnet:agentCardHash"] = profile.agentCardHash;
  if (profile.signature) asset["repnet:signature"] = profile.signature;

  return { public: asset };
}

/**
 * Build a JSON-LD Knowledge Asset from a RepNet receipt.
 * Pure builder: no DKG client, fetch, signer, node auth, or runtime side effects.
 */
export function buildReceiptAsset(receipt: RepNetReceipt) {
  const asset: any = {
    "@context": "https://schema.org",
    "@type": "repnet:ReputationReceipt",
    "@id": `repnet:receipt:${receipt.txHash}`,

    // Core identity
    "repnet:contractorAgentId": receipt.contractorAgentId,
    "repnet:workerAgentId": receipt.workerAgentId,
    "repnet:contractorWallet": receipt.contractorWallet,
    "repnet:workerWallet": receipt.workerWallet,

    // Payment
    "repnet:paymentAmount": receipt.paymentAmount,
    "repnet:paymentCurrency": "USDC",
    "repnet:feeAmount": receipt.feeAmount,

    // Feedback (Tier 1 — always present)
    "repnet:satisfied": receipt.satisfied,
    "repnet:tag": receipt.tag,
    "repnet:category": receipt.category,
    "repnet:jobCompletedAt": receipt.jobCompletedAt,

    // Source provenance
    "repnet:source": receipt.source.type,
    ...(receipt.source.platformId && {
      "repnet:sourcePlatformId": receipt.source.platformId,
    }),

    // On-chain anchor
    "repnet:txHash": receipt.txHash,
    "repnet:chainId": receipt.chainId,
    "repnet:jobId": receipt.jobId,
  };

  // Tier 2 fields (optional)
  if (receipt.techStack?.length) asset["repnet:techStack"] = receipt.techStack;
  if (receipt.deliverableType) asset["repnet:deliverableType"] = receipt.deliverableType;
  if (receipt.dataScale) asset["repnet:dataScale"] = receipt.dataScale;
  if (receipt.specsCount !== undefined) asset["repnet:specsCount"] = receipt.specsCount;
  if (receipt.specsDelivered !== undefined) asset["repnet:specsDelivered"] = receipt.specsDelivered;
  if (receipt.reviewText) asset["repnet:reviewText"] = receipt.reviewText;
  if (receipt.jobStartedAt) asset["repnet:jobStartedAt"] = receipt.jobStartedAt;

  // Tier 3 custom fields
  if (receipt.customFields) {
    for (const [key, value] of Object.entries(receipt.customFields)) {
      asset[`repnet:custom:${key}`] = value;
    }
  }

  return { public: asset };
}

/**
 * Build a JSON-LD Knowledge Asset from an agreement.
 * Pure builder: no DKG client, fetch, signer, node auth, or runtime side effects.
 */
export function buildAgreementAsset(params: PublishAgreementDKGParams): AgreementAsset {
  const { jobId, agreementHash, agreement, specVisibility } = params;

  if (specVisibility === "public") {
    // Public visibility: full agreement in public section
    return {
      public: {
        "@context": "https://schema.org",
        "@type": "repnet:JobAgreement",
        "@id": `repnet:agreement:${agreementHash}`,
        "repnet:jobId": jobId.toString(),
        "repnet:agreementHash": agreementHash,
        "repnet:specs": agreement.specs,
        "repnet:contractor": agreement.contractor,
        "repnet:worker": agreement.worker,
        "repnet:amount": agreement.amount,
        "repnet:deliveryDeadline": agreement.deliveryDeadline,
        "repnet:reviewPeriod": agreement.reviewPeriod,
        "repnet:createdAt": agreement.createdAt,
      },
    };
  }

  // Private visibility: metadata in public, specs in private
  return {
    public: {
      "@context": "https://schema.org",
      "@type": "repnet:JobAgreement",
      "@id": `repnet:agreement:${agreementHash}`,
      "repnet:jobId": jobId.toString(),
      "repnet:agreementHash": agreementHash,
      "repnet:specCount": agreement.specs.length,
      "repnet:contractor": agreement.contractor,
      "repnet:worker": agreement.worker,
      "repnet:amount": agreement.amount,
      "repnet:deliveryDeadline": agreement.deliveryDeadline,
      "repnet:createdAt": agreement.createdAt,
    },
    private: {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@id": `repnet:agreement:${agreementHash}`,
          "repnet:specs": agreement.specs,
          "repnet:description": agreement.description,
          "repnet:reviewPeriod": agreement.reviewPeriod,
        },
      ],
    },
  };
}
