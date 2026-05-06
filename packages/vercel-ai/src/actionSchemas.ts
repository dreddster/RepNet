import { z } from "zod";

export const repnetActionSchemas = {
  repnet_status: z.object({}),
  repnet_register: z.object({
    agentCardUrl: z.string().describe("URL to your A2A Agent Card JSON"),
  }),
  repnet_publish_agent_profile: z.object({
    agentId: z.string().describe("RepNet/ERC-8004 agent ID"),
    wallet: z.string().describe("Public wallet address for the agent identity"),
    agentCardUrl: z.string().describe("Public A2A Agent Card URL or URI registered on-chain"),
    agentCardHash: z.string().optional().describe("Optional hash of the Agent Card content"),
    name: z.string().describe("Public self-declared agent name"),
    description: z.string().describe("Public self-declared agent description"),
    skills: z.array(z.string()).optional().describe("Public self-declared skills/capabilities"),
    frameworks: z.array(z.string()).optional().describe("Public agent frameworks or runtimes"),
    tools: z.array(z.string()).optional().describe("Public tools/integrations exposed by the agent"),
    createdAt: z.string().optional().describe("Optional ISO timestamp; defaults to now"),
    chainId: z.number().describe("Chain ID for the registered identity"),
    signature: z.string().optional().describe("Optional signature over profile/card content"),
  }),
  repnet_lookup: z.object({
    wallet: z.string().describe("Wallet address to look up"),
  }),
  repnet_evaluate_workers: z.object({
    jobSpec: z.record(z.any()).describe("Public job spec facets to match"),
    candidates: z.array(z.record(z.any())).describe("Candidate workers identified by wallet and/or ERC agentId"),
  }),
  repnet_preview_payment: z.object({
    amount: z.number().describe("Job amount in USDC"),
  }),
  repnet_pay: z.object({
    worker: z.string().describe("Worker wallet address"),
    amount: z.number().describe("Job amount in USDC"),
  }),
  repnet_feedback: z.object({
    targetWallet: z.string().describe("Target wallet address to review"),
    satisfied: z.boolean().describe("Satisfied with the work? (true/false)"),
    category: z.string().describe("Job category (e.g., research-synthesis)"),
    receiptURI: z.string().optional().describe("Payment tx / escrow job / verifiable job proof reference available at feedback time"),
  }),
  repnet_submit_job_feedback: z.object({
    jobId: z.number().describe("Escrow job ID with an open feedback window"),
    publisherUrl: z.string().describe("RepNet publisher API base URL"),
    reviewerRole: z.enum(["contractor", "worker"]).describe("Your role in this job"),
    satisfied: z.boolean().describe("Binary satisfaction signal"),
    summary: z.string().describe("Public one-sentence feedback summary"),
    tags: z.array(z.string()).optional().describe("Public searchable feedback tags"),
    proofURI: z.string().optional().describe("Payment tx / escrow job / verifiable job proof"),
    publicJobMetadata: z.record(z.any()).optional().describe("Contractor→Worker public searchable metadata"),
    contractorFeedback: z.record(z.any()).optional().describe("Worker→Contractor public behavior metadata"),
  }),
  repnet_stats: z.object({}),
  repnet_publish_agreement: z.object({
    jobId: z.number().describe("On-chain escrow job ID"),
    agreementHash: z.string().describe("Keccak256 hash anchored on-chain"),
    description: z.string().describe("Human-readable job agreement description"),
    specs: z.array(z.record(z.any())).describe("Agreement specs with id, description, weight"),
    worker: z.string().describe("Worker wallet"),
    contractor: z.string().describe("Contractor wallet"),
    amount: z.string().describe("USDC amount in 6-decimal base units"),
    deliveryDeadline: z.number().describe("Unix timestamp delivery deadline"),
    reviewPeriod: z.number().describe("Review period in seconds"),
    specVisibility: z.enum(["public", "private"]).optional().describe("Whether specs/requirements are public or private"),
  }),
  repnet_create_escrow: z.object({
    worker: z.string().describe("Worker wallet address"),
    amount: z.number().describe("Job amount in USDC"),
    agreementHash: z.string().describe("Hex-encoded keccak256 hash of the job agreement"),
    deadlineDays: z.number().describe("Days until delivery deadline"),
    reviewDays: z.number().optional().describe("Days for review period after delivery (default: 3)"),
    specWeights: z
      .array(z.number())
      .describe("Weight per spec in basis points, must sum to 10000 (e.g. [4000, 3000, 3000])"),
    collateralBps: z.number().optional().describe("Optional collateral in basis points (0 = none, 1500 = 15%)"),
  }),
  repnet_get_job: z.object({
    jobId: z.number().describe("On-chain escrow job ID"),
  }),
  repnet_job_status: z.object({
    jobId: z.number().describe("On-chain escrow job ID"),
  }),
  repnet_accept_job: z.object({
    jobId: z.number().describe("The escrow job ID to accept"),
  }),
  repnet_deliver_work: z.object({
    jobId: z.number().describe("The escrow job ID"),
    deliveryURI: z.string().describe("URI pointing to the delivered work (e.g. ipfs://..., https://...)"),
  }),
  repnet_review_specs: z.object({
    jobId: z.number().describe("The escrow job ID"),
    results: z.array(z.boolean()).describe("Array of Pass (true) / Fail (false) for each spec"),
  }),
  repnet_accept_fail: z.object({
    jobId: z.number().describe("The escrow job ID"),
    specIndex: z.number().describe("The spec index to accept as failed"),
  }),
  repnet_contest_spec: z.object({
    jobId: z.number().describe("The escrow job ID"),
    specIndex: z.number().describe("The spec index to contest"),
    evidenceURI: z.string().describe("URI pointing to evidence + statement supporting the contest"),
  }),
  repnet_submit_evidence: z.object({
    jobId: z.number().describe("The escrow job ID"),
    specIndex: z.number().describe("The contested spec index"),
    evidenceURI: z.string().describe("URI pointing to evidence + statement"),
  }),
  repnet_preview_escrow: z.object({
    amount: z.number().describe("Total USDC amount for the escrow"),
    specCount: z.number().describe("Number of spec items"),
  }),
} as const;

export type RepNetVercelToolName = keyof typeof repnetActionSchemas;
