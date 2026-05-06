import { ethers } from "ethers";
import type { PublishAgreementDKGParams, RepNetAgentProfile } from "./dkg/assets";
import type { DkgPublishResult } from "./dkg/types";
import type { SubmitJobFeedbackParams, SubmitJobFeedbackResult } from "./modules/feedback";

export type RepNetJsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
};

export type RepNetAction<TInput extends Record<string, unknown> = Record<string, unknown>> = {
  name: string;
  description: string;
  inputSchema: RepNetJsonSchema;
  execute(input: TInput): Promise<string>;
};

export type RepNetActionMap = Record<string, RepNetAction>;

type RepNetActionClient = {
  getAddress(): Promise<string>;
  isRegistered(): Promise<boolean>;
  getAgentId(): Promise<bigint | number | string>;
  provider: { getBalance(address: string): Promise<bigint> };
  payment: {
    getBalance(): Promise<bigint>;
    preview(amount: bigint): Promise<{
      contractorPays: bigint;
      workerReceives: bigint;
      feePerSide: bigint;
      totalFee: bigint;
    }>;
    pay(worker: string, amount: bigint): Promise<{ hash: string }>;
    getProtocolStats(): Promise<{ totalJobs: bigint | number | string; totalFeesCollected: bigint }>;
  };
  identity: {
    register(agentCardUrl: string): Promise<{ hash: string; logs?: Array<{ topics: readonly string[]; data: string }> }>;
    getRegistrationStats(): Promise<{
      totalRegistrations: bigint | number | string;
      isFreeTier: boolean;
      freeSlots?: bigint | number | string;
    }>;
  };
  reputation: {
    getByWallet(wallet: string): Promise<null | {
      agentId: bigint | number | string;
      wallet: string;
      agentURI: string;
      feedback: { totalReviews: number | bigint; satisfiedCount: number | bigint; satisfactionRate: number };
    }>;
    getById?(agentId: bigint): Promise<null | {
      agentId: bigint | number | string;
      wallet: string;
      agentURI: string;
      feedback: { totalReviews: number | bigint; satisfiedCount: number | bigint; satisfactionRate: number };
    }>;
  };
  feedback: {
    getSummary(wallet: string): Promise<{ totalReviews: number; satisfiedCount: number; satisfactionRate: number }>;
    give(params: {
      targetWallet: string;
      satisfied: boolean;
      tag: string;
      category: string;
      receiptURI: string;
    }): Promise<{ hash: string }>;
    submitJobFeedback?(params: SubmitJobFeedbackParams): Promise<SubmitJobFeedbackResult>;
  };
  dkg?: {
    publishAgentProfile?(profile: RepNetAgentProfile): Promise<string>;
    publishAgreementV10?(params: PublishAgreementDKGParams): Promise<DkgPublishResult>;
    queryWorkerFeedbackEvidence?(wallet: string, jobSpec: Record<string, unknown>): Promise<Array<{
      jobId?: string | number;
      satisfied?: boolean;
      proofURI?: string;
      dkgUal?: string;
      publicJobMetadata?: Record<string, unknown>;
      summary?: string;
    }>>;
  };
  discovery: { getTotalAgents(): Promise<bigint | number | string> };
  escrow: {
    create(params: {
      worker: string;
      jobAmount: bigint;
      agreementHash: string;
      specWeights: number[];
      deliveryDeadline: number;
      reviewPeriod: number;
      collateralBps?: number;
    }): Promise<{ jobId: bigint | number | string; receipt: { hash: string } }>;
    acceptJob(jobId: bigint): Promise<{ hash: string }>;
    deliverWork(jobId: bigint, deliveryURI: string): Promise<{ hash: string }>;
    reviewSpecs(jobId: bigint, results: boolean[]): Promise<{ hash: string }>;
    acceptFail(jobId: bigint, specIndex: number): Promise<{ hash: string }>;
    contestSpec(jobId: bigint, specIndex: number, evidenceURI: string): Promise<{ hash: string }>;
    submitEvidence(jobId: bigint, specIndex: number, evidenceURI: string): Promise<{ hash: string }>;
    preview(amount: bigint, specCount: number): Promise<{
      workerReceivesFull: bigint;
      feePerSide: bigint;
      totalFee: bigint;
      disputeFeePerSpec: bigint;
    }>;
    getJob(jobId: bigint): Promise<{
      contractor: string;
      worker: string;
      totalAmount: bigint;
      status: number;
      specCount?: bigint | number | string;
      deliveryDeadline?: bigint | number | string;
      amountSettled?: bigint;
      amountReleased: bigint;
      amountRefunded: bigint;
      disputeFeesCollected: bigint;
    }>;
    getSpecStatuses(jobId: bigint): Promise<number[]>;
  };
};

const parseUSDC = (amount: number) => BigInt(Math.round(amount * 1e6));
const formatUSDC = (amount: bigint) => Number(amount) / 1e6;

const objectSchema = (properties: Record<string, unknown>, required: string[] = []): RepNetJsonSchema => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
});

const tx = (receipt: { hash: string }) => receipt.hash;
const agentRegisteredEvent = new ethers.Interface([
  "event AgentRegistered(uint256 indexed agentId, address indexed owner, string agentURI)",
]);

const agentIdFromRegistrationReceipt = (receipt: { logs?: Array<{ topics: readonly string[]; data: string }> }): string | undefined => {
  for (const log of receipt.logs ?? []) {
    try {
      const parsed = agentRegisteredEvent.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === "AgentRegistered") return parsed.args.agentId.toString();
    } catch {
      // Ignore unrelated logs in the same transaction receipt.
    }
  }
  return undefined;
};

const toCount = (value: number | bigint | string | undefined): number => Number(value ?? 0);
const normalizeList = (value: unknown): string[] => Array.isArray(value)
  ? value.map(String).map((item) => item.toLowerCase()).filter(Boolean)
  : value ? [String(value).toLowerCase()] : [];

const jobSpecSignals = (jobSpec: Record<string, unknown>): string[] => Array.from(new Set([
  ...normalizeList(jobSpec.category),
  ...normalizeList(jobSpec.workType),
  ...normalizeList(jobSpec.languages),
  ...normalizeList(jobSpec.frameworks),
  ...normalizeList(jobSpec.domains),
  ...normalizeList(jobSpec.deliverableType),
]));

const evidenceSignals = (metadata: Record<string, unknown> | undefined): string[] => metadata ? jobSpecSignals(metadata) : [];

const matchedSignals = (jobSpec: Record<string, unknown>, metadata: Record<string, unknown> | undefined): string[] => {
  const wanted = new Set(jobSpecSignals(jobSpec));
  return evidenceSignals(metadata).filter((signal) => wanted.has(signal));
};

const fitLabel = (registered: boolean, evidenceMatchCount: number, totalReviews: number): "strong" | "moderate" | "weak" | "unknown" => {
  if (!registered) return "unknown";
  if (evidenceMatchCount >= 4) return "strong";
  if (evidenceMatchCount >= 2) return "moderate";
  if (totalReviews > 0) return "weak";
  return "unknown";
};

export function createRepNetActions(client: RepNetActionClient): RepNetActionMap {
  const actions: RepNetAction[] = [
    {
      name: "repnet_status",
      description: "Get your RepNet agent registration status, balances, and reputation",
      inputSchema: objectSchema({}),
      execute: async () => {
        const addr = await client.getAddress();
        const isRegistered = await client.isRegistered();
        const balance = await client.payment.getBalance();
        const ethBal = await client.provider.getBalance(addr);

        let result = `Wallet: ${addr}\nRegistered: ${isRegistered}\nUSDC: $${formatUSDC(balance)}\nETH: ${ethers.formatEther(ethBal)}`;

        if (isRegistered) {
          const agentId = await client.getAgentId();
          const summary = await client.feedback.getSummary(addr);
          result += `\nAgent ID: ${agentId}\nInteractions: ${summary.totalReviews} (${summary.satisfiedCount} satisfied, ${(summary.satisfactionRate * 100).toFixed(0)}%)`;
        }

        return result;
      },
    },
    {
      name: "repnet_register",
      description: "Register as an RepNet agent with your A2A Agent Card URL",
      inputSchema: objectSchema(
        { agentCardUrl: { type: "string", description: "URL to your A2A Agent Card JSON" } },
        ["agentCardUrl"],
      ),
      execute: async ({ agentCardUrl }) => {
        const receipt = await client.identity.register(String(agentCardUrl));
        const agentId = agentIdFromRegistrationReceipt(receipt) ?? await client.getAgentId();
        return `Registered! Agent ID: ${agentId}\nTX: ${tx(receipt)}`;
      },
    },
    {
      name: "repnet_publish_agent_profile",
      description: "Publish a public DKG AgentProfile Knowledge Asset for a registered agent. Profiles are self-declared discovery data; receipts and feedback are the evidence trail.",
      inputSchema: objectSchema(
        {
          agentId: { type: "string", description: "RepNet/ERC-8004 agent ID" },
          wallet: { type: "string", description: "Public wallet address for the agent identity" },
          agentCardUrl: { type: "string", description: "Public A2A Agent Card URL or URI registered on-chain" },
          agentCardHash: { type: "string", description: "Optional hash of the Agent Card content" },
          name: { type: "string", description: "Public self-declared agent name" },
          description: { type: "string", description: "Public self-declared agent description" },
          skills: { type: "array", items: { type: "string" }, description: "Public self-declared skills/capabilities" },
          frameworks: { type: "array", items: { type: "string" }, description: "Public agent frameworks or runtimes" },
          tools: { type: "array", items: { type: "string" }, description: "Public tools/integrations exposed by the agent" },
          createdAt: { type: "string", description: "Optional ISO timestamp; defaults to now" },
          chainId: { type: "number", description: "Chain ID for the registered identity" },
          signature: { type: "string", description: "Optional signature over profile/card content" },
        },
        ["agentId", "wallet", "agentCardUrl", "name", "description", "chainId"],
      ),
      execute: async ({ agentId, wallet, agentCardUrl, agentCardHash, name, description, skills, frameworks, tools, createdAt, chainId, signature }) => {
        if (!client.dkg?.publishAgentProfile) {
          return "DKG agent profile publishing is not configured in this client.";
        }

        const profile: RepNetAgentProfile = {
          agentId: String(agentId),
          wallet: String(wallet),
          agentCardUrl: String(agentCardUrl),
          name: String(name),
          description: String(description),
          skills: Array.isArray(skills) ? skills.map(String) : undefined,
          frameworks: Array.isArray(frameworks) ? frameworks.map(String) : undefined,
          tools: Array.isArray(tools) ? tools.map(String) : undefined,
          createdAt: createdAt ? String(createdAt) : new Date().toISOString(),
          chainId: Number(chainId),
          ...(agentCardHash ? { agentCardHash: String(agentCardHash) } : {}),
          ...(signature ? { signature: String(signature) } : {}),
        };

        const locator = await client.dkg.publishAgentProfile(profile);
        return `Agent Profile published to DKG: ${locator}`;
      },
    },
    {
      name: "repnet_lookup",
      description: "Look up an agent's reputation by wallet address",
      inputSchema: objectSchema({ wallet: { type: "string", description: "Wallet address to look up" } }, ["wallet"]),
      execute: async ({ wallet }) => {
        const walletAddress = String(wallet);
        const rep = await client.reputation.getByWallet(walletAddress);
        if (!rep) return `No RepNet identity found for ${walletAddress}`;

        return `Agent ID: ${rep.agentId}\nWallet: ${rep.wallet}\nURI: ${rep.agentURI}\nInteractions: ${rep.feedback.totalReviews} (${rep.feedback.satisfiedCount} satisfied, ${(rep.feedback.satisfactionRate * 100).toFixed(0)}%)`;
      },
    },
    {
      name: "repnet_evaluate_workers",
      description: "Evaluate proposed worker candidates for a job using ERC identity, wallet/agent-id resolution, on-chain reputation summaries, and available public DKG JobFeedback evidence. Returns evidence, not a magic score.",
      inputSchema: objectSchema(
        {
          jobSpec: { type: "object", description: "Public job spec facets to match: category, workType, languages, frameworks, domains, deliverableType" },
          candidates: { type: "array", items: { type: "object" }, description: "Candidate workers identified by wallet and/or ERC agentId" },
        },
        ["jobSpec", "candidates"],
      ),
      execute: async ({ jobSpec, candidates }) => {
        const spec = (jobSpec || {}) as Record<string, unknown>;
        const candidateList = Array.isArray(candidates) ? candidates as Array<Record<string, unknown>> : [];

        const evaluated = await Promise.all(candidateList.map(async (candidate, index) => {
          const walletInput = candidate.wallet ? String(candidate.wallet) : undefined;
          const agentIdInput = candidate.agentId !== undefined ? BigInt(String(candidate.agentId)) : undefined;

          const profile = walletInput
            ? await client.reputation.getByWallet(walletInput)
            : agentIdInput !== undefined && client.reputation.getById
              ? await client.reputation.getById(agentIdInput)
              : null;

          if (!profile) {
            return {
              input: candidate,
              wallet: walletInput,
              agentId: agentIdInput?.toString(),
              registered: false,
              fit: "unknown",
              matchedSignals: [],
              evidence: [],
              summary: { totalReviews: 0, satisfiedCount: 0, satisfactionRate: 0 },
              risks: ["No registered RepNet ERC identity found for this candidate"],
              _rank: -1000 + index * -0.001,
            };
          }

          const evidence = client.dkg?.queryWorkerFeedbackEvidence
            ? await client.dkg.queryWorkerFeedbackEvidence(profile.wallet, spec)
            : [];

          const normalizedEvidence = evidence.map((item) => {
            const matches = matchedSignals(spec, item.publicJobMetadata);
            return {
              jobId: item.jobId !== undefined ? String(item.jobId) : undefined,
              proofURI: item.proofURI,
              dkgUal: item.dkgUal,
              satisfied: item.satisfied,
              summary: item.summary,
              matched: matches,
              publicJobMetadata: item.publicJobMetadata,
            };
          });

          const allMatches = Array.from(new Set(normalizedEvidence.flatMap((item) => item.matched)));
          const totalReviews = toCount(profile.feedback.totalReviews);
          const satisfiedCount = toCount(profile.feedback.satisfiedCount);
          const fit = fitLabel(true, allMatches.length, totalReviews);
          const risks: string[] = [];
          if (normalizedEvidence.length === 0) risks.push("No matching public DKG JobFeedback evidence returned for this job spec");
          if (totalReviews === 0) risks.push("No on-chain feedback summary yet");
          if (profile.feedback.satisfactionRate < 0.75 && totalReviews > 0) risks.push("Satisfaction rate is below 75%; inspect individual evidence before hiring");

          return {
            input: candidate,
            wallet: profile.wallet,
            agentId: String(profile.agentId),
            agentURI: profile.agentURI,
            registered: true,
            fit,
            matchedSignals: allMatches,
            evidence: normalizedEvidence,
            summary: {
              totalReviews,
              satisfiedCount,
              satisfactionRate: profile.feedback.satisfactionRate,
            },
            risks,
            _rank: (allMatches.length * 100) + (satisfiedCount * 5) + profile.feedback.satisfactionRate - index * 0.001,
          };
        }));

        const rankedCandidates = evaluated
          .sort((a, b) => b._rank - a._rank)
          .map(({ _rank, ...candidate }) => candidate);

        return JSON.stringify({
          jobSpec: spec,
          evaluatedAt: new Date(0).toISOString(),
          rankedCandidates,
          note: "Evidence-first evaluation. Fit labels are derived from matching public DKG feedback metadata and on-chain reputation summaries; consuming agents should inspect evidence before hiring.",
        }, null, 2);
      },
    },
    {
      name: "repnet_preview_payment",
      description: "Preview fee breakdown for a job payment",
      inputSchema: objectSchema({ amount: { type: "number", description: "Job amount in USDC" } }, ["amount"]),
      execute: async ({ amount }) => {
        const usdcAmount = Number(amount);
        const p = await client.payment.preview(parseUSDC(usdcAmount));
        return `Job: $${usdcAmount}\nContractor pays: $${formatUSDC(p.contractorPays)}\nWorker receives: $${formatUSDC(p.workerReceives)}\nFee/side: $${formatUSDC(p.feePerSide)}\nTotal fee: $${formatUSDC(p.totalFee)}`;
      },
    },
    {
      name: "repnet_pay",
      description: "Pay a worker via RepNet FeeRouter (USDC on Base)",
      inputSchema: objectSchema(
        {
          worker: { type: "string", description: "Worker wallet address" },
          amount: { type: "number", description: "Job amount in USDC" },
        },
        ["worker", "amount"],
      ),
      execute: async ({ worker, amount }) => {
        const usdcAmount = Number(amount);
        const receipt = await client.payment.pay(String(worker), parseUSDC(usdcAmount));
        return `Payment sent! $${usdcAmount} to ${worker}\nTX: ${tx(receipt)}`;
      },
    },
    {
      name: "repnet_feedback",
      description: "Submit feedback for an agent after a completed job. Binary satisfaction — no scores.",
      inputSchema: objectSchema(
        {
          targetWallet: { type: "string", description: "Target wallet address to review" },
          satisfied: { type: "boolean", description: "Satisfied with the work? (true/false)" },
          category: { type: "string", description: "Job category (e.g., research-synthesis)" },
          receiptURI: { type: "string", description: "Payment tx / escrow job / verifiable job proof reference available at feedback time" },
        },
        ["targetWallet", "satisfied", "category"],
      ),
      execute: async ({ targetWallet, satisfied, category, receiptURI }) => {
        const receipt = await client.feedback.give({
          targetWallet: String(targetWallet),
          satisfied: Boolean(satisfied),
          tag: "job-completed",
          category: String(category),
          receiptURI: receiptURI ? String(receiptURI) : "",
        });
        return `Feedback submitted to ${targetWallet}! Satisfied: ${satisfied ? "Yes ✅" : "No ❌"}\nTX: ${tx(receipt)}`;
      },
    },
    {
      name: "repnet_submit_job_feedback",
      description: "Submit role-aware public job feedback to the RepNet publisher. Contractor feedback makes worker skills searchable; worker feedback rates contractor behavior. The publisher materializes the combined public DKG JobFeedback/receipt after both parties submit or the window closes.",
      inputSchema: objectSchema(
        {
          jobId: { type: "number", description: "Escrow job ID with an open feedback window" },
          publisherUrl: { type: "string", description: "RepNet publisher API base URL" },
          reviewerRole: { type: "string", enum: ["contractor", "worker"], description: "Your role in this job" },
          satisfied: { type: "boolean", description: "Binary satisfaction signal" },
          summary: { type: "string", description: "Public one-sentence feedback summary (≤500 chars)" },
          tags: { type: "array", items: { type: "string" }, description: "Public searchable feedback tags" },
          proofURI: { type: "string", description: "Payment tx / escrow job / verifiable job proof available at feedback time" },
          publicJobMetadata: { type: "object", description: "Contractor→Worker public searchable metadata: category, workType, languages, frameworks, domains, deliverableType, publicJobSummary" },
          contractorFeedback: { type: "object", description: "Worker→Contractor public behavior metadata: requirementsClarity, scopeDiscipline, reviewFairness, responsiveness, paymentPromptness" },
        },
        ["jobId", "publisherUrl", "reviewerRole", "satisfied", "summary"],
      ),
      execute: async ({ jobId, publisherUrl, reviewerRole, satisfied, summary, tags, proofURI, publicJobMetadata, contractorFeedback }) => {
        if (!client.feedback.submitJobFeedback) {
          return "RepNet publisher feedback submission is not configured in this client.";
        }

        const role = String(reviewerRole) as "contractor" | "worker";
        const result = await client.feedback.submitJobFeedback({
          jobId: Number(jobId),
          publisherUrl: String(publisherUrl),
          reviewerRole: role,
          rating: satisfied ? 1 : 0,
          summary: String(summary),
          tags: Array.isArray(tags) ? tags.map(String) : undefined,
          proofURI: proofURI ? String(proofURI) : undefined,
          publicJobMetadata: publicJobMetadata as any,
          contractorFeedback: contractorFeedback as any,
        });

        if (!result.success) {
          return `Feedback submission failed: ${result.error || "unknown error"}`;
        }

        const metadataLine = role === "contractor" && publicJobMetadata
          ? `\nPublic job metadata: ${[
            ...(((publicJobMetadata as any).languages || []) as string[]),
            ...(((publicJobMetadata as any).frameworks || []) as string[]),
            ...(((publicJobMetadata as any).domains || []) as string[]),
          ].join(", ")}`
          : role === "worker" && contractorFeedback
            ? `\nContractor behavior feedback: ${[
              (contractorFeedback as any).requirementsClarity,
              (contractorFeedback as any).scopeDiscipline,
              (contractorFeedback as any).reviewFairness,
              (contractorFeedback as any).responsiveness,
              (contractorFeedback as any).paymentPromptness,
            ].filter(Boolean).join(", ")}`
            : "";

        return `Job feedback submitted as ${role}. Both submitted: ${result.bothSubmitted ? "yes" : "no"}${metadataLine}${result.dkgUal ? `\nDKG UAL: ${result.dkgUal}` : ""}`;
      },
    },
    {
      name: "repnet_stats",
      description: "Get RepNet protocol statistics",
      inputSchema: objectSchema({}),
      execute: async () => {
        const stats = await client.payment.getProtocolStats();
        const regStats = await client.identity.getRegistrationStats();
        const totalAgents = await client.discovery.getTotalAgents();
        const freeTier = regStats.isFreeTier
          ? regStats.freeSlots === undefined ? "active" : `${regStats.freeSlots} slots`
          : "exhausted";
        return `Agents: ${totalAgents}\nRegistrations: ${regStats.totalRegistrations}\nFree tier: ${freeTier}\nJobs: ${stats.totalJobs}\nFees: $${formatUSDC(stats.totalFeesCollected)}`;
      },
    },
    {
      name: "repnet_publish_agreement",
      description: "Publish a product-native JobAgreement Knowledge Asset to DKG. Use private visibility for escrow/collateral requirements/specs; public metadata remains hash/provenance only.",
      inputSchema: objectSchema(
        {
          jobId: { type: "number", description: "On-chain escrow job ID" },
          agreementHash: { type: "string", description: "Keccak256 hash anchored on-chain" },
          description: { type: "string", description: "Human-readable job agreement description" },
          specs: { type: "array", items: { type: "object" }, description: "Agreement specs with id, description, weight (sum 100)" },
          worker: { type: "string", description: "Worker wallet" },
          contractor: { type: "string", description: "Contractor wallet" },
          amount: { type: "string", description: "USDC amount in 6-decimal base units" },
          deliveryDeadline: { type: "number", description: "Unix timestamp delivery deadline" },
          reviewPeriod: { type: "number", description: "Review period in seconds" },
          specVisibility: { type: "string", enum: ["public", "private"], description: "Whether specs/requirements are public or private on DKG" },
        },
        ["jobId", "agreementHash", "description", "specs", "worker", "contractor", "amount", "deliveryDeadline", "reviewPeriod"],
      ),
      execute: async ({ jobId, agreementHash, description, specs, worker, contractor, amount, deliveryDeadline, reviewPeriod, specVisibility }) => {
        if (!client.dkg?.publishAgreementV10) {
          return "DKG agreement publishing is not configured in this client.";
        }

        const result = await client.dkg.publishAgreementV10({
          jobId: BigInt(Number(jobId)),
          agreementHash: String(agreementHash),
          specVisibility: (specVisibility === "public" ? "public" : "private"),
          agreement: {
            version: "1",
            description: String(description),
            specs: specs as any,
            worker: String(worker),
            contractor: String(contractor),
            amount: String(amount),
            deliveryDeadline: Number(deliveryDeadline),
            reviewPeriod: Number(reviewPeriod),
            createdAt: Math.floor(Date.now() / 1000),
          },
        });

        return `Agreement published to DKG: ${result.status}\nContext graph: ${result.contextGraphId || "n/a"}${result.receiptUri ? `\nLocator: ${result.receiptUri}` : ""}${result.error ? `\nError: ${result.error.message}` : ""}`;
      },
    },
    {
      name: "repnet_create_escrow",
      description: "Create a Tier C escrow job with structured agreement. Locks USDC in an isolated per-job vault. Worker must call accept_job to start.",
      inputSchema: objectSchema(
        {
          worker: { type: "string", description: "Worker wallet address (must be registered)" },
          amount: { type: "number", description: "Total USDC to deposit" },
          agreementHash: { type: "string", description: "Keccak256 hash of the job agreement text (hex string)" },
          specWeights: { type: "array", items: { type: "number" }, description: "Array of spec weights in basis points (must sum to 10000). E.g. [2500, 2500, 2500, 2500] for 4 equal specs" },
          deadlineDays: { type: "number", description: "Days from now for delivery deadline" },
          reviewDays: { type: "number", description: "Days contractor has to review after delivery (default: 3)" },
          collateralBps: { type: "number", description: "Optional collateral in basis points (0 = none, 1500 = 15%). Both parties deposit proportional collateral; loser forfeits." },
        },
        ["worker", "amount", "agreementHash", "specWeights", "deadlineDays"],
      ),
      execute: async ({ worker, amount, agreementHash, specWeights, deadlineDays, reviewDays, collateralBps }) => {
        const usdcAmount = Number(amount);
        const weights = specWeights as number[];
        const days = Number(deadlineDays);
        const now = Math.floor(Date.now() / 1000);
        const result = await client.escrow.create({
          worker: String(worker),
          jobAmount: parseUSDC(usdcAmount),
          agreementHash: String(agreementHash),
          specWeights: weights,
          deliveryDeadline: now + days * 86400,
          reviewPeriod: Number(reviewDays || 3) * 86400,
          collateralBps: collateralBps === undefined ? undefined : Number(collateralBps),
        });
        return `Escrow created! Job ID: ${result.jobId}\nWorker: ${worker}\nAmount: $${usdcAmount}\nSpecs: ${weights.length}\nDeadline: ${days} days\nTX: ${tx(result.receipt)}`;
      },
    },
    {
      name: "repnet_accept_job",
      description: "Accept an escrow job as a worker. This is your on-chain signature agreeing to the terms. The delivery deadline clock starts now.",
      inputSchema: objectSchema({ jobId: { type: "number", description: "The escrow job ID to accept" } }, ["jobId"]),
      execute: async ({ jobId }) => {
        const receipt = await client.escrow.acceptJob(BigInt(Number(jobId)));
        return `Job #${jobId} accepted! Delivery deadline is now active.\nTX: ${tx(receipt)}`;
      },
    },
    {
      name: "repnet_deliver_work",
      description: "Submit delivery for an escrow job. Must be done before the delivery deadline. The contractor's review period starts after this.",
      inputSchema: objectSchema(
        {
          jobId: { type: "number", description: "The escrow job ID" },
          deliveryURI: { type: "string", description: "URI pointing to the delivered work (e.g. ipfs://..., https://...)" },
        },
        ["jobId", "deliveryURI"],
      ),
      execute: async ({ jobId, deliveryURI }) => {
        const receipt = await client.escrow.deliverWork(BigInt(Number(jobId)), String(deliveryURI));
        return `Work delivered for job #${jobId}.\nDelivery: ${deliveryURI}\nTX: ${tx(receipt)}\nContractor review period has started.`;
      },
    },
    {
      name: "repnet_review_specs",
      description: "Review all specs for a delivered job. Mark each spec as Pass (true) or Fail (false). If all pass, worker gets paid immediately. If any fail, worker must respond.",
      inputSchema: objectSchema(
        {
          jobId: { type: "number", description: "The escrow job ID" },
          results: { type: "array", items: { type: "boolean" }, description: "Array of Pass (true) / Fail (false) for each spec" },
        },
        ["jobId", "results"],
      ),
      execute: async ({ jobId, results }) => {
        const specResults = results as boolean[];
        const receipt = await client.escrow.reviewSpecs(BigInt(Number(jobId)), specResults);
        const passed = specResults.filter((r) => r).length;
        const failed = specResults.length - passed;
        return `Specs reviewed for job #${jobId}.\n${passed} passed, ${failed} failed.${failed > 0 ? " Worker must respond to failed specs." : " All passed — worker payment processing."}\nTX: ${tx(receipt)}`;
      },
    },
    {
      name: "repnet_accept_fail",
      description: "Accept a failed spec ruling as the worker. Funds for this spec go back to the contractor. Use when you agree the spec wasn't met.",
      inputSchema: objectSchema(
        {
          jobId: { type: "number", description: "The escrow job ID" },
          specIndex: { type: "number", description: "The spec index to accept as failed" },
        },
        ["jobId", "specIndex"],
      ),
      execute: async ({ jobId, specIndex }) => {
        const receipt = await client.escrow.acceptFail(BigInt(Number(jobId)), Number(specIndex));
        return `Accepted fail for spec #${specIndex} on job #${jobId}. Funds returned to contractor.\nTX: ${tx(receipt)}`;
      },
    },
    {
      name: "repnet_contest_spec",
      description: "Contest a failed spec — take it to RepNet Court. Three independent LLM judges evaluate evidence and vote. 15% dispute fee applies. Winner gets 85% of the contested amount.",
      inputSchema: objectSchema(
        {
          jobId: { type: "number", description: "The escrow job ID" },
          specIndex: { type: "number", description: "The spec index to contest" },
          evidenceURI: { type: "string", description: "URI pointing to evidence + statement supporting the contest" },
        },
        ["jobId", "specIndex", "evidenceURI"],
      ),
      execute: async ({ jobId, specIndex, evidenceURI }) => {
        const receipt = await client.escrow.contestSpec(BigInt(Number(jobId)), Number(specIndex), String(evidenceURI));
        return `Contest filed for spec #${specIndex} on job #${jobId}.\nEvidence: ${evidenceURI}\nCase entered RepNet Court. 3 LLM judges will evaluate. 15% dispute fee applies.\nTX: ${tx(receipt)}`;
      },
    },
    {
      name: "repnet_submit_evidence",
      description: "Submit evidence for a contested spec. Both parties can submit evidence. Contractor can add counter-evidence after worker files contest.",
      inputSchema: objectSchema(
        {
          jobId: { type: "number", description: "The escrow job ID" },
          specIndex: { type: "number", description: "The contested spec index" },
          evidenceURI: { type: "string", description: "URI pointing to evidence + statement" },
        },
        ["jobId", "specIndex", "evidenceURI"],
      ),
      execute: async ({ jobId, specIndex, evidenceURI }) => {
        const receipt = await client.escrow.submitEvidence(BigInt(Number(jobId)), Number(specIndex), String(evidenceURI));
        return `Evidence submitted for spec #${specIndex} on job #${jobId}.\nEvidence: ${evidenceURI}\nTX: ${tx(receipt)}`;
      },
    },
    {
      name: "repnet_preview_escrow",
      description: "Preview escrow fees and net amounts before creating a job. Shows fee per side, total fee, and dispute fee per spec.",
      inputSchema: objectSchema(
        {
          amount: { type: "number", description: "Total USDC amount for the escrow" },
          specCount: { type: "number", description: "Number of spec items" },
        },
        ["amount", "specCount"],
      ),
      execute: async ({ amount, specCount }) => {
        const usdcAmount = Number(amount);
        const count = Number(specCount);
        const preview = await client.escrow.preview(parseUSDC(usdcAmount), count);
        return `Escrow preview for $${usdcAmount} with ${count} specs:\nWorker receives (full pass): $${formatUSDC(preview.workerReceivesFull)}\nFee per side: $${formatUSDC(preview.feePerSide)}\nTotal fee (both sides): $${formatUSDC(preview.totalFee)}\nDispute fee per spec (15%): $${formatUSDC(preview.disputeFeePerSpec)}`;
      },
    },
    {
      name: "repnet_job_status",
      description: "Check the current status of an escrow job. Shows job state, amounts settled, spec statuses, and vault balance.",
      inputSchema: objectSchema({ jobId: { type: "number", description: "The escrow job ID to check" } }, ["jobId"]),
      execute: async ({ jobId }) => {
        const STATUS_NAMES = ["Created", "Active", "Delivered", "InReview", "Settling", "Completed", "Refunded"];
        const SPEC_NAMES = ["Pending", "Passed", "Failed", "Accepted", "ExtraWork", "Contested", "Resolved"];
        const id = BigInt(Number(jobId));
        const job = await client.escrow.getJob(id);
        const specStatuses = await client.escrow.getSpecStatuses(id);
        const status = STATUS_NAMES[job.status] || "Unknown";
        const specList = specStatuses.map((s: number, i: number) => `  Spec ${i}: ${SPEC_NAMES[s] || "Unknown"}`).join("\n");
        return `Job #${jobId}: ${status}\nContractor: ${job.contractor}\nWorker: ${job.worker}\nTotal: $${formatUSDC(job.totalAmount)}\nReleased: $${formatUSDC(job.amountReleased)}\nRefunded: $${formatUSDC(job.amountRefunded)}\nDispute fees: $${formatUSDC(job.disputeFeesCollected)}\n\nSpecs:\n${specList}`;
      },
    },
  ];

  return Object.fromEntries(actions.map((action) => [action.name, action]));
}
