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
      publishAgreementMemory: async (params: any) => ({
        status: params.specVisibility === "private" ? "tentative" : "confirmed",
        contextGraphId: "repnet-demo-graph",
        receiptUri: params.specVisibility === "private" ? undefined : "did:dkg:agreement:42",
      }),
      queryReputationEvidence: async (identityOrWallet: string, opts: any = {}) => {
        const signals = [
          ...(opts.filters?.skills || []),
          ...(opts.filters?.text || []),
          ...(opts.filters?.domains || []),
          ...(opts.filters?.frameworks || []),
        ].map(String);
        const hasPythonMatch = identityOrWallet === "0xpython" && signals.some((signal) => ["python", "api", "fastapi", "dkg", "coding", "software-development"].includes(signal));
        const events = hasPythonMatch ? [
          { jobId: "102", role: "worker", summary: "Delivered Python API.", tags: ["python", "api"], event: "urn:repnet:job-reputation-event:102" },
        ] : [];
        return {
          identityOrWallet,
          eventCount: opts.role ? events.length : 2,
          highlights: events.length ? ["Clear scope and fast review cycle.", "Delivered Python API."] : [],
          jobIds: events.length ? ["101", "102"] : [],
          roles: {
            contractor: { eventCount: opts.role ? 0 : 1, highlights: events.length ? ["Clear scope and fast review cycle."] : [], jobIds: events.length ? ["101"] : [] },
            worker: { eventCount: events.length, highlights: events.length ? ["Delivered Python API."] : [], jobIds: events.length ? ["102"] : [] },
          },
          events,
        };
      },
      queryReputationJob: async (jobId: string) => [{ jobId, role: "worker", summary: "Delivered Python API." }],
      queryWorkerFeedbackEvidence: async (wallet: string) => wallet === "0xpython" ? [
        {
          jobId: "123",
          satisfied: true,
          proofURI: "repnet:job-board:123",
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
    gatewayUrl: "http://gateway.local",
    jobs: {
      createJobBoardJob: async () => ({ jobId: "repnet-job:1", title: "Audit gateway", status: "open", applicationCount: 0 }),
      applyToJobBoardJob: async () => ({
        jobId: "repnet-job:1",
        applicant: "0xworker",
        ercIdentity: "43",
        profileRef: "dkg://profiles/worker-43/security-skill",
        skills: ["TypeScript", "security scanning"],
        frameworks: ["Vitest"],
        tools: ["skilllens", "eslint"],
        publicSummary: "I can implement the skill scanner against the public criteria.",
        proposal: "I will add CLI tests, scanner fixtures, and documentation mapped to every acceptance criterion.",
        priorWork: ["CLI onboarding bugfix", "API docs cleanup"],
        privateProposalHash: "sha256:applicationhash",
      }),
      selectJobBoardWorker: async () => ({ jobId: "repnet-job:1", selectedWorker: "0xworker", status: "funded", chainJobId: "7", chainTxHash: "0xselect" }),
      getJobBoardJob: async () => ({ jobId: "repnet-job:1", title: "Audit gateway", status: "funded", selectedWorker: "0xworker", applicationCount: 1 }),
      readJobBoardPrivateSpecs: async () => ({
        jobId: "repnet-job:1",
        worker: "0xworker",
        privateSpec: { repository: "private/repo", brief: "Use customer staging fixtures" },
        privateSpecHash: "sha256:privatehash",
        verification: { signer: "0xworker", selectedWorker: "0xworker", status: "funded", timestamp: "2026-05-23T09:00:00.000Z" },
      }),
      listOpenJobBoardJobs: async () => [{ jobId: "repnet-job:2", title: "Build indexer", status: "open", budget: "10000000", applicationCount: 2 }],
      createUpfrontJob: async () => ({ jobId: 1n, hash: "0xcurrentupfront" }),
      createReviewHoldJob: async () => ({ jobId: 2n, hash: "0xcurrentreview" }),
      acceptJob: async () => receipt,
      declineBeforeAccept: async () => receipt,
      refundBeforeAccept: async () => receipt,
      preparePrivateDelivery: async () => ({ deliveryHandle: "repnet-delivery:2:test" }),
      submitDelivery: async () => receipt,
      requestMoreWork: async () => receipt,
      acceptMoreWork: async () => receipt,
      refuseMoreWork: async () => receipt,
      release: async () => receipt,
      cancel: async () => receipt,
      getJob: async () => ({
        contractor: "0xcontractor",
        worker: "0xworker",
        amount: 10_000_000n,
        privateSpecHash: "0xprivate",
        deliveryDeadline: 1_765_000_000n,
        reviewDeadline: 1_765_086_400n,
        paymentMode: 1,
        status: 1,
        deliveryHandle: "repnet-delivery:2:test",
        opinionHash: ethers.ZeroHash,
        cancellationReason: "",
      }),
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
      "repnet_query_reputation",
      "repnet_query_reputation_job",
      "repnet_submit_job_feedback",
      "repnet_stats",
      "repnet_job_board_create",
      "repnet_job_board_apply",
      "repnet_job_board_select",
      "repnet_job_board_get",
      "repnet_job_board_private_specs",
      "repnet_job_board_list",
      "repnet_create_upfront_job",
      "repnet_create_review_hold_job",
      "repnet_accept_job",
      "repnet_decline_before_accept",
      "repnet_refund_before_accept",
      "repnet_submit_private_delivery",
      "repnet_request_more_work",
      "repnet_accept_more_work",
      "repnet_refuse_more_work",
      "repnet_release",
      "repnet_cancel",
      "repnet_job_status",
    ]);

    expect(Object.keys(actions).some((name) => name.includes("escrow"))).toBe(false);
    expect(Object.keys(actions).some((name) => name.includes("_current_"))).toBe(false);
    expect(Object.keys(actions)).not.toEqual(expect.arrayContaining([
      "repnet_preview_payment",
      "repnet_pay",
      "repnet_feedback",
    ]));

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
    await expect(actions.repnet_job_status.execute({ jobId: 2 })).resolves.toContain("RepNet job #2");
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


  it("queries public DKG reputation memory by wallet across C/W roles with filters", async () => {
    const actions = createRepNetActions(createMockClient() as any);

    const output = await actions.repnet_query_reputation.execute({
      identityOrWallet: "0xpython",
      skills: ["python"],
      text: ["api"],
    });

    const result = JSON.parse(output);
    expect(result).toMatchObject({
      identityOrWallet: "0xpython",
      eventCount: 2,
      highlights: ["Clear scope and fast review cycle.", "Delivered Python API."],
      jobIds: ["101", "102"],
      roles: {
        contractor: { eventCount: 1, jobIds: ["101"] },
        worker: { eventCount: 1, jobIds: ["102"] },
      },
    });
    expect(result.note).toBeUndefined();
  });

  it("submits contractor-side public searchable job metadata through the publisher feedback action", async () => {
    const actions = createRepNetActions(createMockClient() as any);

    await expect(actions.repnet_submit_job_feedback.execute({
      jobId: 9,
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
      proofURI: "repnet:job-board:9",
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

  it("formats job-board list as compact discovery and get as full public job detail", async () => {
    const actions = createRepNetActions(createMockClient({
      jobs: {
        ...createMockClient().jobs,
        listOpenJobBoardJobs: async () => [{
          jobId: "repnet-job:2",
          title: "Build indexer",
          status: "open",
          contractor: "0xcontractor",
          contractorReputationEventCount: 7,
          budget: "10000000",
          paymentMode: "REVIEW_GATED_DELIVERY_HOLD",
          applicationDeadline: "2026-05-12T00:00:00.000Z",
          applicationCount: 2,
          publicSpec: {
            description: "Full detail should not appear in discovery list.",
            deliverables: ["Indexer package"],
            acceptanceCriteria: ["Indexes every finalized job"],
            publicConstraints: ["No private keys"],
            evaluationBasis: "Compare delivered indexer against acceptance criteria.",
          },
        }],
        getJobBoardJob: async () => ({
          jobId: "repnet-job:2",
          title: "Build indexer",
          status: "open",
          contractor: "0xcontractor",
          contractorReputationEventCount: 7,
          budget: "10000000",
          paymentMode: "REVIEW_GATED_DELIVERY_HOLD",
          applicationDeadline: "2026-05-12T00:00:00.000Z",
          deliveryDeadline: "2026-05-20T00:00:00.000Z",
          reviewDeadline: "2026-05-23T00:00:00.000Z",
          applicationCount: 2,
          publicSpec: {
            description: "Build a durable finalized-job indexer for public RepNet reputation queries.",
            deliverables: ["Indexer package", "README", "Tests"],
            acceptanceCriteria: ["Indexes every finalized job", "Exposes query by worker wallet"],
            publicConstraints: ["No private keys", "No private delivery payloads"],
            evaluationBasis: "Compare delivered indexer against acceptance criteria and privacy constraints.",
          },
          privateSpecHash: "sha256:privatehash",
          applications: [{
            applicant: "0xworker",
            ercIdentity: "43",
            profileRef: "dkg://profiles/worker-43/indexer",
            skills: ["TypeScript", "indexers"],
            frameworks: ["Fastify", "Vitest"],
            tools: ["Postgres", "DKG query"],
            publicSummary: "I have built comparable reputation indexers.",
            proposal: "I will build the finalized-job indexer, README, and query-by-worker tests against the acceptance criteria.",
            priorWork: ["Data export validation", "CLI onboarding bugfix"],
            privateProposalHash: "sha256:proposalhash",
          }],
        }),
      },
    }) as any);

    const listOutput = await actions.repnet_job_board_list.execute({});
    expect(listOutput).toContain("Job-board job repnet-job:2");
    expect(listOutput).toContain("Contractor: 0xcontractor");
    expect(listOutput).toContain("Contractor reputation events: 7");
    expect(listOutput).toContain("Applications: 2");
    expect(listOutput).not.toContain("Full detail should not appear");
    expect(listOutput).not.toContain("Acceptance criteria");
    expect(listOutput).not.toContain("privatehash");

    const detailOutput = await actions.repnet_job_board_get.execute({ jobId: "repnet-job:2" });
    expect(detailOutput).toContain("Description: Build a durable finalized-job indexer");
    expect(detailOutput).toContain("Deliverables:\n- Indexer package\n- README\n- Tests");
    expect(detailOutput).toContain("Acceptance criteria:\n- Indexes every finalized job\n- Exposes query by worker wallet");
    expect(detailOutput).toContain("Public constraints:\n- No private keys\n- No private delivery payloads");
    expect(detailOutput).toContain("Evaluation basis: Compare delivered indexer against acceptance criteria and privacy constraints.");
    expect(detailOutput).toContain("Application from 0xworker");
    expect(detailOutput).toContain("ERC identity: 43");
    expect(detailOutput).toContain("Profile: dkg://profiles/worker-43/indexer");
    expect(detailOutput).toContain("Skills:\n- TypeScript\n- indexers");
    expect(detailOutput).toContain("Proposal: I will build the finalized-job indexer");
    expect(detailOutput).toContain("Relevant prior work:\n- Data export validation\n- CLI onboarding bugfix");
    expect(detailOutput).not.toContain("Actions:");
    expect(detailOutput).not.toContain("privatehash");
  });

  it("exposes RepNet job-board actions through the canonical action registry", async () => {
    const actions = createRepNetActions(createMockClient() as any);

    await expect(actions.repnet_job_board_create.execute({
      title: "Audit gateway",
      publicSpec: { summary: "Audit public API" },
      privateSpec: { hiddenRepo: "private" },
      budget: "10000000",
      paymentMode: "REVIEW_GATED_DELIVERY_HOLD",
      applicationDeadline: "2026-05-12T00:00:00.000Z",
      deliveryDeadline: "2026-05-20T00:00:00.000Z",
      reviewDeadline: "2026-05-23T00:00:00.000Z",
    })).resolves.toContain("Job-board job created: repnet-job:1");
    const applicationOutput = await actions.repnet_job_board_apply.execute({
      jobId: "repnet-job:1",
      profileRef: "dkg://profiles/worker-43/security-skill",
      publicSummary: "I can do it",
      ercIdentity: "43",
      skills: ["TypeScript", "security scanning"],
      frameworks: ["Vitest"],
      tools: ["skilllens", "eslint"],
      proposal: "I will add CLI tests and documentation mapped to every criterion.",
      priorWork: ["CLI onboarding bugfix"],
      privateProposal: "private terms",
    });
    expect(applicationOutput).toContain("Application submitted for RepNet job-board job repnet-job:1");
    expect(applicationOutput).toContain("Application from 0xworker");
    expect(applicationOutput).toContain("ERC identity: 43");
    expect(applicationOutput).toContain("Profile: dkg://profiles/worker-43/security-skill");
    expect(applicationOutput).toContain("Skills:\n- TypeScript\n- security scanning");
    expect(applicationOutput).toContain("Proposal: I will add CLI tests");
    expect(applicationOutput).toContain("Relevant prior work:\n- CLI onboarding bugfix");
    expect(applicationOutput).not.toContain("Actions:");
    await expect(actions.repnet_job_board_select.execute({
      jobId: "repnet-job:1",
      worker: "0xworker",
    })).resolves.toContain("Chain job ID: 7");
    await expect(actions.repnet_job_board_get.execute({ jobId: "repnet-job:1" })).resolves.toContain("Status: funded");
    const privateSpecsOutput = await actions.repnet_job_board_private_specs.execute({
      jobId: "repnet-job:1",
      worker: "0xworker",
      timestamp: "2026-05-23T09:00:00.000Z",
      readSignature: "0xsig",
    });
    expect(privateSpecsOutput).toContain("Private specs unlocked for RepNet job-board job repnet-job:1");
    expect(privateSpecsOutput).toContain("Signed by: 0xworker");
    expect(privateSpecsOutput).toContain('"repository": "private/repo"');
    await expect(actions.repnet_job_board_list.execute({})).resolves.toContain("repnet-job:2");

    await expect(actions.repnet_create_review_hold_job.execute({
      worker: "0xworker",
      amount: 10,
      agreementHash: ethers.ZeroHash,
      publicSpecHash: ethers.ZeroHash,
      privateSpecHash: ethers.ZeroHash,
      deliveryDeadline: 1_765_000_000,
      reviewDeadline: 1_765_086_400,
    })).resolves.toContain("Job ID: 2");
    await expect(actions.repnet_submit_private_delivery.execute({
      jobId: 2,
      payload: "private result",
    })).resolves.toContain("Handle: repnet-delivery:2:test");
    await expect(actions.repnet_request_more_work.execute({
      jobId: 2,
      request: "tighten the report",
      deadline: 1_765_172_800,
    })).resolves.toContain("Additional work requested");
    await expect(actions.repnet_refuse_more_work.execute({
      jobId: 2,
      reason: "scope mismatch",
    })).resolves.toContain("Additional work refused");
    await expect(actions.repnet_job_status.execute({ jobId: 2 })).resolves.toContain("RepNet job #2: Accepted");
  });

});
