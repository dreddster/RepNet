import { ethers } from "ethers";
import type { RepNetAgentProfile } from "./dkg/assets";
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
    queryReputationEvidence?(identityOrWallet: string, opts?: {
      role?: "contractor" | "worker";
      filters?: {
        skills?: string[];
        domains?: string[];
        frameworks?: string[];
        text?: string[];
      };
      limit?: number;
    }): Promise<Record<string, unknown>>;
    queryReputationJob?(jobId: string): Promise<Array<Record<string, unknown>>>;
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
  gatewayUrl?: string;
  jobs?: {
    createJobBoardJob(params: {
      contractor: string;
      jobPostingSignature: string;
      title: string;
      publicSpec: Record<string, unknown>;
      privateSpec: Record<string, unknown>;
      budget: string;
      paymentMode: "UPFRONT" | "REVIEW_GATED_DELIVERY_HOLD";
      applicationDeadline: string;
      deliveryDeadline: string;
      reviewDeadline: string;
    }): Promise<any>;
    applyToJobBoardJob(params: { jobId: string; applicant: string; applicationSignature: string; ercIdentity?: string; profileRef: string; skills?: string[]; frameworks?: string[]; tools?: string[]; publicSummary: string; proposal?: string; priorWork?: string[]; privateProposal?: string }): Promise<any>;
    selectJobBoardWorker(params: { jobId: string; contractor: string; worker: string; chainTxHash: string; chainBlockNumber: number; chainJobId?: string }): Promise<any>;
    getJobBoardJob(jobId: string): Promise<any>;
    readJobBoardPrivateSpecs(params: { jobId: string; worker: string; timestamp: string; readSignature: string }): Promise<any>;
    listOpenJobBoardJobs(): Promise<any[]>;
    createUpfrontJob(params: { worker: string; amount: bigint; agreementHash: string; publicSpecHash: string; privateSpecHash: string; deliveryDeadline: bigint; reviewDeadline: bigint }): Promise<{ jobId: bigint | number | string; hash: string }>;
    createReviewHoldJob(params: { worker: string; amount: bigint; agreementHash: string; publicSpecHash: string; privateSpecHash: string; deliveryDeadline: bigint; reviewDeadline: bigint }): Promise<{ jobId: bigint | number | string; hash: string }>;
    acceptJob(jobId: bigint): Promise<{ hash: string }>;
    declineBeforeAccept(jobId: bigint): Promise<{ hash: string }>;
    refundBeforeAccept(jobId: bigint): Promise<{ hash: string }>;
    preparePrivateDelivery(params: { jobId: bigint; payload: string; worker: string; contentType?: string }): Promise<{ deliveryHandle: string; deliveryContentHash?: string; payloadBytes?: number }>;
    submitDelivery(jobId: bigint, deliveryHandle: string): Promise<{ hash: string }>;
    requestMoreWork(jobId: bigint, request: string, deadline: bigint): Promise<{ hash: string }>;
    acceptMoreWork(jobId: bigint): Promise<{ hash: string }>;
    refuseMoreWork(jobId: bigint, reason: string): Promise<{ hash: string }>;
    release(jobId: bigint): Promise<{ hash: string }>;
    cancel(jobId: bigint, reason: string, stage?: "before-delivery" | "after-review"): Promise<{ hash: string }>;
    getJob(jobId: bigint): Promise<{
      contractor: string;
      worker: string;
      amount: bigint;
      paymentMode: number;
      status: number;
      deliveryHandle: string;
      opinionHash: string;
      cancellationReason: string;
    }>;
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

const requireJobs = (client: RepNetActionClient) => {
  if (!client.jobs) throw new Error("RepNet jobs module is not configured in this client.");
  return client.jobs;
};
const resolvePublisherUrl = (client: RepNetActionClient, explicit?: unknown): string => {
  const env = ((globalThis as any).process?.env || {}) as Record<string, string | undefined>;
  const publisherUrl = explicit ? String(explicit) : env.REPNET_PUBLISHER_URL || client.gatewayUrl || env.REPNET_GATEWAY_URL;
  if (!publisherUrl) throw new Error("Missing RepNet publisher URL. Set REPNET_PUBLISHER_URL or REPNET_GATEWAY_URL.");
  return publisherUrl;
};
const jobIdArg = (jobId: unknown): bigint => BigInt(String(jobId));
const jobBoardIdArg = (jobId: unknown): string => String(jobId);

const formatMaybeList = (value: unknown): string | undefined => {
  if (Array.isArray(value)) return value.map((item) => `- ${String(item)}`).join("\n");
  if (typeof value === "string" && value.trim()) return value;
  return undefined;
};

const publicSpecValue = (job: any, ...keys: string[]): unknown => {
  for (const key of keys) {
    const value = job.publicSpec?.[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
};

const formatJobBoardDiscoveryJob = (job: any): string => [
  `Job-board job ${job.jobId}`,
  job.title ? `Title: ${job.title}` : undefined,
  job.budget ? `Budget: ${job.budget}` : undefined,
  job.paymentMode ? `Mode: ${job.paymentMode}` : undefined,
  job.contractor ? `Contractor: ${job.contractor}` : undefined,
  job.contractorAgentId ? `Contractor ERC identity: ${job.contractorAgentId}` : undefined,
  job.contractorReputationEventCount !== undefined ? `Contractor reputation events: ${job.contractorReputationEventCount}` : undefined,
  job.applicationDeadline ? `Application deadline: ${job.applicationDeadline}` : undefined,
  job.deliveryDeadline ? `Delivery deadline: ${job.deliveryDeadline}` : undefined,
  job.applicationCount !== undefined ? `Applications: ${job.applicationCount}` : undefined,
  job.status ? `Status: ${job.status}` : undefined,
].filter(Boolean).join("\n");

const formatJobBoardApplication = (application: any): string => {
  const skills = formatMaybeList(application.skills);
  const frameworks = formatMaybeList(application.frameworks);
  const tools = formatMaybeList(application.tools);
  const priorWork = formatMaybeList(application.priorWork);
  return [
    `Application from ${application.applicant}`,
    application.ercIdentity ? `ERC identity: ${application.ercIdentity}` : undefined,
    application.profileRef ? `Profile: ${application.profileRef}` : undefined,
    skills ? `Skills:\n${skills}` : undefined,
    frameworks ? `Frameworks:\n${frameworks}` : undefined,
    tools ? `Tools:\n${tools}` : undefined,
    application.publicSummary ? `Summary: ${application.publicSummary}` : undefined,
    application.proposal ? `Proposal: ${application.proposal}` : undefined,
    priorWork ? `Relevant prior work:\n${priorWork}` : undefined,
    application.privateProposalHash ? `Private proposal hash: ${application.privateProposalHash}` : undefined,
  ].filter(Boolean).join("\n");
};

const formatJobBoardPrivateSpecs = (read: any): string => [
  `Private specs unlocked for RepNet job-board job ${read.jobId}`,
  read.worker ? `Worker: ${read.worker}` : undefined,
  read.privateSpecHash ? `Private spec hash: ${read.privateSpecHash}` : undefined,
  read.verification?.signer ? `Signed by: ${read.verification.signer}` : undefined,
  read.verification?.selectedWorker ? `Selected worker: ${read.verification.selectedWorker}` : undefined,
  read.verification?.status ? `Verified job state: ${read.verification.status}` : undefined,
  "Private specs:",
  JSON.stringify(read.privateSpec ?? {}, null, 2),
].filter(Boolean).join("\n");

const formatJobBoardDetailJob = (job: any): string => {
  const deliverables = formatMaybeList(publicSpecValue(job, "deliverables", "deliverable", "expectedDeliverables"));
  const acceptanceCriteria = formatMaybeList(publicSpecValue(job, "acceptanceCriteria", "criteria"));
  const publicConstraints = formatMaybeList(publicSpecValue(job, "publicConstraints", "constraints", "nonGoals", "non-goals"));
  const evaluationBasis = publicSpecValue(job, "evaluationBasis", "llmEvaluationBasis", "reviewRubric", "reviewCriteria");

  return [
    `Job-board job ${job.jobId}`,
    job.title ? `Title: ${job.title}` : undefined,
    job.status ? `Status: ${job.status}` : undefined,
    job.paymentMode ? `Mode: ${job.paymentMode}` : undefined,
    job.budget ? `Budget: ${job.budget}` : undefined,
    job.contractor ? `Contractor: ${job.contractor}` : undefined,
    job.contractorAgentId ? `Contractor ERC identity: ${job.contractorAgentId}` : undefined,
    job.contractorReputationEventCount !== undefined ? `Contractor reputation events: ${job.contractorReputationEventCount}` : undefined,
    job.applicationDeadline ? `Application deadline: ${job.applicationDeadline}` : undefined,
    job.deliveryDeadline ? `Delivery deadline: ${job.deliveryDeadline}` : undefined,
    job.reviewDeadline ? `Review deadline: ${job.reviewDeadline}` : undefined,
    job.applicationCount !== undefined ? `Applications: ${job.applicationCount}` : undefined,
    job.selectedWorker ? `Selected worker: ${job.selectedWorker}` : undefined,
    job.chainJobId ? `Chain job ID: ${job.chainJobId}` : undefined,
    job.chainTxHash ? `TX: ${job.chainTxHash}` : undefined,
    publicSpecValue(job, "description") ? `Description: ${publicSpecValue(job, "description")}` : undefined,
    deliverables ? `Deliverables:\n${deliverables}` : undefined,
    acceptanceCriteria ? `Acceptance criteria:\n${acceptanceCriteria}` : undefined,
    publicConstraints ? `Public constraints:\n${publicConstraints}` : undefined,
    evaluationBasis ? `Evaluation basis: ${String(evaluationBasis)}` : undefined,
    Array.isArray(job.applications) && job.applications.length
      ? `Applications:\n${job.applications.map(formatJobBoardApplication).join("\n\n")}`
      : undefined,
  ].filter(Boolean).join("\n");
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
      name: "repnet_query_reputation",
      description: "Query public DKG reputation memory for a wallet or identity across contractor and worker roles. Supports role and skill/text filters and returns summary, highlights, job IDs, and event locators.",
      inputSchema: objectSchema(
        {
          identityOrWallet: { type: "string", description: "Wallet address or RepNet identity to query in the public DKG reputation graph" },
          role: { type: "string", enum: ["contractor", "worker"], description: "Optional role filter: contractor or worker" },
          skills: { type: "array", items: { type: "string" }, description: "Optional skill/tag filters such as python or coding" },
          domains: { type: "array", items: { type: "string" }, description: "Optional domain filters" },
          frameworks: { type: "array", items: { type: "string" }, description: "Optional framework filters such as fastapi" },
          text: { type: "array", items: { type: "string" }, description: "Optional free-text filters over public summaries/tags" },
          since: { type: "string", description: "Optional ISO timestamp lower bound over publishedAt/finalActionAt/feedbackWindowClosedAt" },
          until: { type: "string", description: "Optional ISO timestamp upper bound over publishedAt/finalActionAt/feedbackWindowClosedAt" },
          terminalPath: { type: "string", description: "Optional terminal path filter such as released, cancelled, withdrawn, expired, or upfront_paid" },
          counterparty: { type: "string", description: "Optional wallet filter for the other side of the job" },
          paymentMode: { type: "string", description: "Optional payment mode filter such as REVIEW_GATED_DELIVERY_HOLD or UPFRONT" },
          jobType: { type: "string", description: "Optional structured job/work type filter when stored on the public event" },
          amountMin: { type: "string", description: "Optional minimum job amount in base units" },
          amountMax: { type: "string", description: "Optional maximum job amount in base units" },
          limit: { type: "number", description: "Maximum public DKG events to return; capped by SDK" },
        },
        ["identityOrWallet"],
      ),
      execute: async ({ identityOrWallet, role, skills, domains, frameworks, text, since, until, terminalPath, counterparty, paymentMode, jobType, amountMin, amountMax, limit }) => {
        if (!client.dkg?.queryReputationEvidence) {
          return "DKG reputation querying is not configured in this client.";
        }

        const filters = {
          ...(Array.isArray(skills) ? { skills: skills.map(String) } : {}),
          ...(Array.isArray(domains) ? { domains: domains.map(String) } : {}),
          ...(Array.isArray(frameworks) ? { frameworks: frameworks.map(String) } : {}),
          ...(Array.isArray(text) ? { text: text.map(String) } : {}),
        };
        const result = await client.dkg.queryReputationEvidence(String(identityOrWallet), {
          ...(role === "contractor" || role === "worker" ? { role } : {}),
          ...(Object.keys(filters).length ? { filters } : {}),
          ...(since ? { since: String(since) } : {}),
          ...(until ? { until: String(until) } : {}),
          ...(terminalPath ? { terminalPath: String(terminalPath) } : {}),
          ...(counterparty ? { counterparty: String(counterparty) } : {}),
          ...(paymentMode ? { paymentMode: String(paymentMode) } : {}),
          ...(jobType ? { jobType: String(jobType) } : {}),
          ...(amountMin !== undefined ? { amountMin: String(amountMin) } : {}),
          ...(amountMax !== undefined ? { amountMax: String(amountMax) } : {}),
          ...(limit !== undefined ? { limit: Number(limit) } : {}),
        });

        return JSON.stringify(result, null, 2);
      },
    },
    {
      name: "repnet_query_reputation_job",
      description: "Query detailed public DKG reputation events for one job ID returned by repnet_query_reputation.",
      inputSchema: objectSchema({ jobId: { type: "string", description: "Public RepNet job ID to inspect in DKG reputation memory" } }, ["jobId"]),
      execute: async ({ jobId }) => {
        if (!client.dkg?.queryReputationJob) {
          return "DKG reputation job querying is not configured in this client.";
        }
        const events = await client.dkg.queryReputationJob(String(jobId));
        return JSON.stringify({
          jobId: String(jobId),
          eventCount: events.length,
          events,
        }, null, 2);
      },
    },
    {
      name: "repnet_submit_job_feedback",
      description: "Submit role-aware public job feedback to the RepNet publisher. Contractor feedback makes worker skills searchable; worker feedback rates contractor behavior. The publisher materializes the combined public DKG JobFeedback/receipt after both parties submit or the window closes.",
      inputSchema: objectSchema(
        {
          jobId: { type: "number", description: "Escrow job ID with an open feedback window" },
          reviewerRole: { type: "string", enum: ["contractor", "worker"], description: "Your role in this job" },
          satisfied: { type: "boolean", description: "Binary satisfaction signal" },
          summary: { type: "string", description: "Public one-sentence feedback summary (≤500 chars)" },
          tags: { type: "array", items: { type: "string" }, description: "Public searchable feedback tags" },
          proofURI: { type: "string", description: "Payment tx / job / verifiable job proof available at feedback time" },
          publicJobMetadata: { type: "object", description: "Contractor→Worker public searchable metadata: category, workType, languages, frameworks, domains, deliverableType, publicJobSummary" },
          contractorFeedback: { type: "object", description: "Worker→Contractor public behavior metadata: requirementsClarity, scopeDiscipline, reviewFairness, responsiveness, paymentPromptness" },
        },
        ["jobId", "reviewerRole", "satisfied", "summary"],
      ),
      execute: async ({ jobId, publisherUrl, reviewerRole, satisfied, summary, tags, proofURI, publicJobMetadata, contractorFeedback }) => {
        if (!client.feedback.submitJobFeedback) {
          return "RepNet publisher feedback submission is not configured in this client.";
        }

        const role = String(reviewerRole) as "contractor" | "worker";
        const result = await client.feedback.submitJobFeedback({
          jobId: Number(jobId),
          publisherUrl: resolvePublisherUrl(client, publisherUrl),
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
      name: "repnet_job_board_create",
      description: "Create an open RepNet job-board job through the gateway before worker selection/funding.",
      inputSchema: objectSchema({
        contractor: { type: "string", description: "Contractor wallet address that signed the job posting intent" },
        jobPostingSignature: { type: "string", description: "EIP-712 JobPostingIntent signature from the contractor wallet" },
        title: { type: "string" },
        publicSpec: { type: "object" },
        privateSpec: { type: "object" },
        budget: { type: "string", description: "USDC amount in 6-decimal base units" },
        paymentMode: { type: "string", enum: ["UPFRONT", "REVIEW_GATED_DELIVERY_HOLD"] },
        applicationDeadline: { type: "string", description: "ISO timestamp" },
        deliveryDeadline: { type: "string", description: "ISO timestamp" },
        reviewDeadline: { type: "string", description: "ISO timestamp" },
      }, ["contractor", "jobPostingSignature", "title", "publicSpec", "privateSpec", "budget", "paymentMode", "applicationDeadline", "deliveryDeadline", "reviewDeadline"]),
      execute: async ({ contractor, jobPostingSignature, title, publicSpec, privateSpec, budget, paymentMode, applicationDeadline, deliveryDeadline, reviewDeadline }) => {
        const job = await requireJobs(client).createJobBoardJob({
          contractor: String(contractor),
          jobPostingSignature: String(jobPostingSignature),
          title: String(title),
          publicSpec: publicSpec as Record<string, unknown>,
          privateSpec: privateSpec as Record<string, unknown>,
          budget: String(budget),
          paymentMode: paymentMode === "UPFRONT" ? "UPFRONT" : "REVIEW_GATED_DELIVERY_HOLD",
          applicationDeadline: String(applicationDeadline),
          deliveryDeadline: String(deliveryDeadline),
          reviewDeadline: String(reviewDeadline),
        });
        return `Job-board job created: ${job.jobId}\n${formatJobBoardDetailJob(job)}`;
      },
    },
    {
      name: "repnet_job_board_apply",
      description: "Apply to an open RepNet job-board job through the gateway as the worker signer.",
      inputSchema: objectSchema({ jobId: { type: "string" }, applicant: { type: "string" }, applicationSignature: { type: "string" }, ercIdentity: { type: "string" }, profileRef: { type: "string" }, skills: { type: "array", items: { type: "string" } }, frameworks: { type: "array", items: { type: "string" } }, tools: { type: "array", items: { type: "string" } }, publicSummary: { type: "string" }, proposal: { type: "string" }, priorWork: { type: "array", items: { type: "string" } }, privateProposal: { type: "string" } }, ["jobId", "applicant", "applicationSignature", "profileRef", "publicSummary"]),
      execute: async ({ jobId, applicant, applicationSignature, ercIdentity, profileRef, skills, frameworks, tools, publicSummary, proposal, priorWork, privateProposal }) => {
        const application = await requireJobs(client).applyToJobBoardJob({
          jobId: jobBoardIdArg(jobId),
          applicant: String(applicant),
          applicationSignature: String(applicationSignature),
          ...(ercIdentity ? { ercIdentity: String(ercIdentity) } : {}),
          profileRef: String(profileRef),
          ...(Array.isArray(skills) ? { skills: skills.map(String) } : {}),
          ...(Array.isArray(frameworks) ? { frameworks: frameworks.map(String) } : {}),
          ...(Array.isArray(tools) ? { tools: tools.map(String) } : {}),
          publicSummary: String(publicSummary),
          ...(proposal ? { proposal: String(proposal) } : {}),
          ...(Array.isArray(priorWork) ? { priorWork: priorWork.map(String) } : {}),
          ...(privateProposal ? { privateProposal: String(privateProposal) } : {}),
        });
        return `Application submitted for RepNet job-board job ${application.jobId}.\n${formatJobBoardApplication(application)}`;
      },
    },
    {
      name: "repnet_job_board_select",
      description: "Select an applicant for a RepNet job-board job and bridge it into the on-chain job path.",
      inputSchema: objectSchema({ jobId: { type: "string" }, contractor: { type: "string" }, worker: { type: "string" }, chainTxHash: { type: "string" }, chainBlockNumber: { type: "number" }, chainJobId: { type: "string" } }, ["jobId", "contractor", "worker", "chainTxHash", "chainBlockNumber"]),
      execute: async ({ jobId, contractor, worker, chainTxHash, chainBlockNumber, chainJobId }) => {
        const job = await requireJobs(client).selectJobBoardWorker({ jobId: jobBoardIdArg(jobId), contractor: String(contractor), worker: String(worker), chainTxHash: String(chainTxHash), chainBlockNumber: Number(chainBlockNumber), ...(chainJobId ? { chainJobId: String(chainJobId) } : {}) });
        return `Worker selected for RepNet job-board job ${job.jobId}.\n${formatJobBoardDetailJob(job)}`;
      },
    },
    {
      name: "repnet_job_board_get",
      description: "Read a RepNet gateway job-board job by off-chain job-board ID.",
      inputSchema: objectSchema({ jobId: { type: "string" } }, ["jobId"]),
      execute: async ({ jobId }) => formatJobBoardDetailJob(await requireJobs(client).getJobBoardJob(jobBoardIdArg(jobId))),
    },
    {
      name: "repnet_job_board_private_specs",
      description: "Read selected worker private job specs after contractor approval and funded hold.",
      inputSchema: objectSchema({ jobId: { type: "string" }, worker: { type: "string" }, timestamp: { type: "string" }, readSignature: { type: "string" } }, ["jobId", "worker", "timestamp", "readSignature"]),
      execute: async ({ jobId, worker, timestamp, readSignature }) => formatJobBoardPrivateSpecs(await requireJobs(client).readJobBoardPrivateSpecs({
        jobId: jobBoardIdArg(jobId),
        worker: String(worker),
        timestamp: String(timestamp),
        readSignature: String(readSignature),
      })),
    },
    {
      name: "repnet_job_board_list",
      description: "List open RepNet gateway job-board jobs.",
      inputSchema: objectSchema({}),
      execute: async () => {
        const jobs = await requireJobs(client).listOpenJobBoardJobs();
        if (!jobs.length) return "No open RepNet job-board jobs.";
        return jobs.map(formatJobBoardDiscoveryJob).join("\n\n");
      },
    },
    {
      name: "repnet_create_upfront_job",
      description: "Create a RepNet upfront job with immediate payment and feedback rights.",
      inputSchema: objectSchema(
        {
          worker: { type: "string" },
          amount: { type: "number" },
          agreementHash: { type: "string" },
          publicSpecHash: { type: "string" },
          privateSpecHash: { type: "string" },
          deliveryDeadline: { type: "number" },
          reviewDeadline: { type: "number" },
        },
        ["worker", "amount", "agreementHash", "publicSpecHash", "privateSpecHash", "deliveryDeadline", "reviewDeadline"]
      ),
      execute: async ({ worker, amount, agreementHash, publicSpecHash, privateSpecHash, deliveryDeadline, reviewDeadline }) => {
        const usdcAmount = Number(amount);
        const result = await requireJobs(client).createUpfrontJob({
          worker: String(worker),
          amount: parseUSDC(usdcAmount),
          agreementHash: String(agreementHash),
          publicSpecHash: String(publicSpecHash),
          privateSpecHash: String(privateSpecHash),
          deliveryDeadline: BigInt(Number(deliveryDeadline)),
          reviewDeadline: BigInt(Number(reviewDeadline)),
        });
        return `RepNet upfront job created. Job ID: ${result.jobId}\nWorker: ${worker}\nAmount: $${usdcAmount}\nTX: ${result.hash}`;
      },
    },
    {
      name: "repnet_create_review_hold_job",
      description: "Create a RepNet review-hold job funded by the contractor and accepted by the worker before delivery.",
      inputSchema: objectSchema(
        {
          worker: { type: "string" },
          amount: { type: "number" },
          agreementHash: { type: "string" },
          publicSpecHash: { type: "string" },
          privateSpecHash: { type: "string" },
          deliveryDeadline: { type: "number" },
          reviewDeadline: { type: "number" },
        },
        ["worker", "amount", "agreementHash", "publicSpecHash", "privateSpecHash", "deliveryDeadline", "reviewDeadline"]
      ),
      execute: async ({ worker, amount, agreementHash, publicSpecHash, privateSpecHash, deliveryDeadline, reviewDeadline }) => {
        const usdcAmount = Number(amount);
        const result = await requireJobs(client).createReviewHoldJob({
          worker: String(worker),
          amount: parseUSDC(usdcAmount),
          agreementHash: String(agreementHash),
          publicSpecHash: String(publicSpecHash),
          privateSpecHash: String(privateSpecHash),
          deliveryDeadline: BigInt(Number(deliveryDeadline)),
          reviewDeadline: BigInt(Number(reviewDeadline)),
        });
        return `RepNet review-hold job created. Job ID: ${result.jobId}\nWorker: ${worker}\nAmount: $${usdcAmount}\nTX: ${result.hash}`;
      },
    },
    {
      name: "repnet_accept_job",
      description: "Accept a RepNet review-hold job as the designated worker.",
      inputSchema: objectSchema({ jobId: { type: "number" } }, ["jobId"]),
      execute: async ({ jobId }) => `RepNet job #${jobId} accepted.\nTX: ${tx(await requireJobs(client).acceptJob(jobIdArg(jobId)))}`,
    },
    {
      name: "repnet_decline_before_accept",
      description: "Decline a RepNet review-hold job before accepting; contractor receives a full refund and no feedback rights are recorded.",
      inputSchema: objectSchema({ jobId: { type: "number" } }, ["jobId"]),
      execute: async ({ jobId }) => `RepNet job #${jobId} declined before accept.\nTX: ${tx(await requireJobs(client).declineBeforeAccept(jobIdArg(jobId)))}`,
    },
    {
      name: "repnet_refund_before_accept",
      description: "Refund a RepNet review-hold job after the worker acceptance deadline passes without acceptance.",
      inputSchema: objectSchema({ jobId: { type: "number" } }, ["jobId"]),
      execute: async ({ jobId }) => `RepNet job #${jobId} refunded after acceptance timeout.\nTX: ${tx(await requireJobs(client).refundBeforeAccept(jobIdArg(jobId)))}`,
    },
    {
      name: "repnet_submit_private_delivery",
      description: "Submit private delivery through the RepNet gateway. The gateway stores the payload and writes only an opaque handle on-chain.",
      inputSchema: objectSchema({ jobId: { type: "number" }, payload: { type: "string" }, contentType: { type: "string" } }, ["jobId", "payload"]),
      execute: async ({ jobId, payload, contentType }) => {
        const jobs = requireJobs(client);
        const worker = await client.getAddress();
        const prepared = await jobs.preparePrivateDelivery({ jobId: jobIdArg(jobId), payload: String(payload), worker, ...(contentType ? { contentType: String(contentType) } : {}) });
        const receipt = await jobs.submitDelivery(jobIdArg(jobId), prepared.deliveryHandle);
        return `Private delivery submitted for RepNet job #${jobId}.\nHandle: ${prepared.deliveryHandle}\nTX: ${receipt.hash}`;
      },
    },
    {
      name: "repnet_request_more_work",
      description: "Request the single allowed additional-work pass after official opinion review with a worker response/resubmission deadline.",
      inputSchema: objectSchema({ jobId: { type: "number" }, request: { type: "string" }, deadline: { type: "number" } }, ["jobId", "request", "deadline"]),
      execute: async ({ jobId, request, deadline }) => `Additional work requested for RepNet job #${jobId}.\nTX: ${tx(await requireJobs(client).requestMoreWork(jobIdArg(jobId), String(request), BigInt(Number(deadline))))}`,
    },
    {
      name: "repnet_accept_more_work",
      description: "Accept the contractor's additional-work request as worker.",
      inputSchema: objectSchema({ jobId: { type: "number" } }, ["jobId"]),
      execute: async ({ jobId }) => `Additional work accepted for RepNet job #${jobId}.\nTX: ${tx(await requireJobs(client).acceptMoreWork(jobIdArg(jobId)))}`,
    },
    {
      name: "repnet_refuse_more_work",
      description: "Refuse the contractor's additional-work request as worker with a reason.",
      inputSchema: objectSchema({ jobId: { type: "number" }, reason: { type: "string" } }, ["jobId", "reason"]),
      execute: async ({ jobId, reason }) => `Additional work refused for RepNet job #${jobId}.\nTX: ${tx(await requireJobs(client).refuseMoreWork(jobIdArg(jobId), String(reason)))}`,
    },
    {
      name: "repnet_release",
      description: "Release held funds to the worker after official opinion review or additional-work decision.",
      inputSchema: objectSchema({ jobId: { type: "number" } }, ["jobId"]),
      execute: async ({ jobId }) => `RepNet job #${jobId} released.\nTX: ${tx(await requireJobs(client).release(jobIdArg(jobId)))}`,
    },
    {
      name: "repnet_cancel",
      description: "Cancel a RepNet review-hold job before delivery or after official opinion review.",
      inputSchema: objectSchema({ jobId: { type: "number" }, reason: { type: "string" }, stage: { type: "string", enum: ["before-delivery", "after-review"] } }, ["jobId", "reason"]),
      execute: async ({ jobId, reason, stage }) => `RepNet job #${jobId} cancelled.\nTX: ${tx(await requireJobs(client).cancel(jobIdArg(jobId), String(reason), stage === "before-delivery" ? "before-delivery" : "after-review"))}`,
    },
    {
      name: "repnet_job_status",
      description: "Read RepNet job-board/review-hold state from the contract.",
      inputSchema: objectSchema({ jobId: { type: "number" } }, ["jobId"]),
      execute: async ({ jobId }) => {
        const PAYMENT_MODES = ["UPFRONT", "REVIEW_GATED_DELIVERY_HOLD"];
        const STATUSES = ["Created", "Accepted", "SubmittedForReview", "OpinionPublished", "AdditionalWorkRequested", "AdditionalWorkAccepted", "AdditionalWorkRefused", "ResubmittedForReview", "Released", "CancelledBeforeDelivery", "CancelledAfterReview", "WorkerWithdrawn", "DeclinedBeforeAccept", "ExpiredBeforeAccept", "UpfrontPaid"];
        const job = await requireJobs(client).getJob(jobIdArg(jobId));
        return `RepNet job #${jobId}: ${STATUSES[job.status] || "Unknown"}\nMode: ${PAYMENT_MODES[job.paymentMode] || "Unknown"}\nContractor: ${job.contractor}\nWorker: ${job.worker}\nAmount: $${formatUSDC(job.amount)}${job.deliveryHandle ? `\nDelivery handle: ${job.deliveryHandle}` : ""}${job.opinionHash && job.opinionHash !== ethers.ZeroHash ? `\nOpinion hash: ${job.opinionHash}` : ""}${job.cancellationReason ? `\nCancellation reason: ${job.cancellationReason}` : ""}`;
      },
    },
  ];

  return Object.fromEntries(actions.map((action) => [action.name, action]));
}
