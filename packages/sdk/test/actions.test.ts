import { ethers } from "ethers";
import { describe, expect, it } from "vitest";
import { createRepNetActions } from "../src/actions";

const receipt = { hash: "0xtx" };
const agentRegistered = new ethers.Interface([
  "event AgentRegistered(uint256 indexed agentId, address indexed owner, string agentURI)",
]);

function createMockClient(overrides: Record<string, unknown> = {}) {
  return {
    getAddress: async () => "0xabc",
    isRegistered: async () => true,
    getAgentId: async () => 42n,
    provider: { getBalance: async () => 1_000_000_000_000_000_000n },
    payment: {
      getBalance: async () => 12_500_000n,
      preview: async () => ({
        contractorPays: 105_000_000n,
        workerReceives: 95_000_000n,
        feePerSide: 5_000_000n,
        totalFee: 10_000_000n,
      }),
      pay: async () => receipt,
      getProtocolStats: async () => ({ totalJobs: 7n, totalFeesCollected: 3_000_000n }),
    },
    identity: {
      register: async () => receipt,
      getRegistrationStats: async () => ({ totalRegistrations: 5n, isFreeTier: true, freeSlots: 95n }),
    },
    reputation: {
      getByWallet: async (wallet: string) => wallet === "0xunknown" ? null : ({
        agentId: wallet === "0xpython" ? 42n : 43n,
        wallet,
        agentURI: "https://agent.example/card.json",
        feedback: wallet === "0xpython"
          ? { totalReviews: 6, satisfiedCount: 5, satisfactionRate: 5 / 6 }
          : { totalReviews: 2, satisfiedCount: 2, satisfactionRate: 1 },
      }),
      getById: async (agentId: bigint) => ({
        agentId,
        wallet: agentId === 42n ? "0xpython" : "0xother",
        agentURI: "https://agent.example/card.json",
        feedback: { totalReviews: 6, satisfiedCount: 5, satisfactionRate: 5 / 6 },
      }),
    },
    feedback: {
      getSummary: async () => ({ totalReviews: 4, satisfiedCount: 3, satisfactionRate: 0.75 }),
      give: async () => receipt,
      submitJobFeedback: async (params: any) => ({
        success: true,
        bothSubmitted: false,
        role: params.reviewerRole,
        metadataStored: !!params.publicJobMetadata || !!params.contractorFeedback,
      }),
    },
    dkg: {
      publishAgentProfile: async () => "did:dkg:agent:42",
      publishAgreementV10: async (params: any) => ({
        status: params.specVisibility === "private" ? "tentative" : "confirmed",
        contextGraphId: "repnet-demo-graph",
        receiptUri: params.specVisibility === "private" ? undefined : "did:dkg:agreement:42",
      }),
      queryWorkerFeedbackEvidence: async (wallet: string) => wallet === "0xpython" ? [
        {
          jobId: "123",
          satisfied: true,
          proofURI: "repnet:escrow:123",
          publicJobMetadata: {
            category: "software-development",
            workType: "coding",
            languages: ["python"],
            frameworks: ["fastapi"],
            domains: ["dkg", "ai-agents"],
            deliverableType: "api",
            publicJobSummary: "Built a Python FastAPI DKG ingestion API",
          },
        },
      ] : [],
    },
    discovery: { getTotalAgents: async () => 11n },
    escrow: {
      create: async () => ({ jobId: 9n, receipt }),
      acceptJob: async () => receipt,
      deliverWork: async () => receipt,
      reviewSpecs: async () => receipt,
      acceptFail: async () => receipt,
      contestSpec: async () => receipt,
      submitEvidence: async () => receipt,
      preview: async () => ({
        workerReceivesFull: 90_000_000n,
        feePerSide: 5_000_000n,
        totalFee: 10_000_000n,
        disputeFeePerSpec: 15_000_000n,
      }),
      getJob: async () => ({
        contractor: "0xcontractor",
        worker: "0xworker",
        totalAmount: 100_000_000n,
        status: 1,
        specCount: 2,
        deliveryDeadline: 1_700_000_000n,
        amountSettled: 0n,
        amountReleased: 25_000_000n,
        amountRefunded: 0n,
        disputeFeesCollected: 0n,
      }),
      getSpecStatuses: async () => [1, 0],
    },
    ...overrides,
  };
}

describe("createRepNetActions", () => {
  it("exposes canonical JSON-schema actions shared by integration adapters", () => {
    const actions = createRepNetActions(createMockClient() as any);

    expect(Object.keys(actions)).toEqual([
      "repnet_status",
      "repnet_register",
      "repnet_publish_agent_profile",
      "repnet_lookup",
      "repnet_evaluate_workers",
      "repnet_preview_payment",
      "repnet_pay",
      "repnet_feedback",
      "repnet_submit_job_feedback",
      "repnet_stats",
      "repnet_publish_agreement",
      "repnet_create_escrow",
      "repnet_accept_job",
      "repnet_deliver_work",
      "repnet_review_specs",
      "repnet_accept_fail",
      "repnet_contest_spec",
      "repnet_submit_evidence",
      "repnet_preview_escrow",
      "repnet_job_status",
    ]);

    expect(actions.repnet_register.inputSchema).toMatchObject({
      type: "object",
      required: ["agentCardUrl"],
      properties: {
        agentCardUrl: { type: "string" },
      },
    });
  });

  it("keeps business behavior in the canonical action instead of adapters", async () => {
    const actions = createRepNetActions(createMockClient() as any);

    await expect(actions.repnet_status.execute({})).resolves.toContain("Wallet: 0xabc");
    await expect(actions.repnet_lookup.execute({ wallet: "0xdef" })).resolves.toContain("Interactions: 2 (2 satisfied, 100%)");
    await expect(actions.repnet_review_specs.execute({ jobId: 9, results: [true, false, true] })).resolves.toContain("2 passed, 1 failed");
  });

  it("reports the registered agent ID from the registration receipt when Base Sepolia reads are still stale", async () => {
    const owner = "0x0000000000000000000000000000000000000abc";
    const event = agentRegistered.encodeEventLog(
      agentRegistered.getEvent("AgentRegistered")!,
      [28n, owner, "file:///tmp/agent-card.json"],
    );
    const actions = createRepNetActions(createMockClient({
      getAgentId: async () => 0n,
      identity: {
        register: async () => ({
          hash: "0xregistered",
          logs: [{ topics: event.topics, data: event.data }],
        }),
        getRegistrationStats: async () => ({ totalRegistrations: 5n, isFreeTier: true, freeSlots: 95n }),
      },
    }) as any);

    await expect(actions.repnet_register.execute({ agentCardUrl: "file:///tmp/agent-card.json" }))
      .resolves.toContain("Registered! Agent ID: 28");
  });

  it("evaluates proposed worker candidates against job specs using identity, on-chain reputation, and DKG feedback evidence", async () => {
    const actions = createRepNetActions(createMockClient() as any);

    const output = await actions.repnet_evaluate_workers.execute({
      jobSpec: {
        category: "software-development",
        workType: "coding",
        languages: ["python"],
        frameworks: ["fastapi"],
        domains: ["dkg"],
        deliverableType: "api",
      },
      candidates: [
        { wallet: "0xother" },
        { wallet: "0xpython" },
        { wallet: "0xunknown" },
      ],
    });

    const result = JSON.parse(output);
    expect(result.rankedCandidates[0]).toMatchObject({
      wallet: "0xpython",
      agentId: "42",
      registered: true,
      fit: "strong",
    });
    expect(result.rankedCandidates[0].matchedSignals).toEqual(expect.arrayContaining(["python", "fastapi", "dkg", "api", "coding", "software-development"]));
    expect(result.rankedCandidates[0].evidence[0]).toMatchObject({
      jobId: "123",
      proofURI: "repnet:escrow:123",
    });
    expect(result.rankedCandidates[2]).toMatchObject({
      wallet: "0xunknown",
      registered: false,
      fit: "unknown",
    });
  });

  it("submits contractor-side public searchable job metadata through the publisher feedback action", async () => {
    const actions = createRepNetActions(createMockClient() as any);

    await expect(actions.repnet_submit_job_feedback.execute({
      jobId: 9,
      publisherUrl: "http://localhost:8787",
      reviewerRole: "contractor",
      satisfied: true,
      summary: "Delivered a Python FastAPI ingestion API with clean tests",
      publicJobMetadata: {
        category: "software-development",
        workType: "coding",
        languages: ["python"],
        frameworks: ["fastapi"],
        domains: ["data-ingestion", "api"],
        deliverableType: "api",
        publicJobSummary: "Built a Python FastAPI ingestion service",
      },
      proofURI: "base-sepolia:tx/0xpay",
    })).resolves.toContain("Public job metadata: python, fastapi, data-ingestion, api");
  });

  it("submits worker-side public contractor behavior feedback through the publisher feedback action", async () => {
    const actions = createRepNetActions(createMockClient() as any);

    await expect(actions.repnet_submit_job_feedback.execute({
      jobId: 9,
      publisherUrl: "http://localhost:8787",
      reviewerRole: "worker",
      satisfied: true,
      summary: "Clear scope, fair review, prompt signoff",
      contractorFeedback: {
        requirementsClarity: "clear",
        scopeDiscipline: "stable",
        reviewFairness: "fair",
        responsiveness: "fast",
        paymentPromptness: "prompt",
      },
      proofURI: "repnet:escrow:9",
    })).resolves.toContain("Contractor behavior feedback: clear, stable, fair, fast, prompt");
  });

  it("publishes safe public AgentProfile assets through the DKG action", async () => {
    const actions = createRepNetActions(createMockClient() as any);

    expect(actions.repnet_publish_agent_profile.inputSchema.required).toEqual([
      "agentId",
      "wallet",
      "agentCardUrl",
      "name",
      "description",
      "chainId",
    ]);
    expect(Object.keys(actions.repnet_publish_agent_profile.inputSchema.properties)).not.toContain("privateKey");
    expect(Object.keys(actions.repnet_publish_agent_profile.inputSchema.properties)).not.toContain("dkgAuthToken");

    await expect(actions.repnet_publish_agent_profile.execute({
      agentId: "42",
      wallet: "0xworker",
      agentCardUrl: "https://agent.example/.well-known/agent-card.json",
      name: "Worker Agent",
      description: "Research and coding agent",
      skills: ["research", "typescript"],
      chainId: 84532,
    })).resolves.toContain("Agent Profile published to DKG: did:dkg:agent:42");
  });

  it("publishes product-native agreement assets through the DKG action", async () => {
    const actions = createRepNetActions(createMockClient() as any);

    await expect(actions.repnet_publish_agreement.execute({
      jobId: 42,
      agreementHash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      description: "Build a private Solidity audit report",
      specs: [
        { id: "audit", description: "Review three Solidity contracts", weight: 100 },
      ],
      worker: "0xworker",
      contractor: "0xcontractor",
      amount: "500000000",
      deliveryDeadline: 1735689600,
      reviewPeriod: 604800,
      specVisibility: "private",
    })).resolves.toContain("Agreement published to DKG: tentative");
  });
});
