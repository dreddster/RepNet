import { describe, expect, it } from "vitest";
import { createRepNetActions } from "@repnet/sdk";

function createShapeOnlyClient() {
  return {
    getAddress: async () => "0xabc",
    isRegistered: async () => false,
    getAgentId: async () => 1n,
    provider: { getBalance: async () => 0n },
    payment: {
      getBalance: async () => 0n,
      getProtocolStats: async () => ({ totalJobs: 0n, totalFeesCollected: 0n }),
    },
    identity: {
      register: async () => ({ hash: "0x" }),
      getRegistrationStats: async () => ({ totalRegistrations: 0n, isFreeTier: false }),
    },
    reputation: { getByWallet: async () => null, getById: async () => null },
    feedback: {
      getSummary: async () => ({ totalReviews: 0, satisfiedCount: 0, satisfactionRate: 0 }),
      submitJobFeedback: async () => ({ success: true, bothSubmitted: false }),
    },
    dkg: {
      publishAgentProfile: async () => "did:dkg:agent",
      publishAgreementMemory: async () => ({ status: "confirmed", contextGraphId: "graph", receiptUri: "did:dkg:agreement" }),
      queryReputationEvidence: async (identityOrWallet: string) => ({ identityOrWallet, eventCount: 0, highlights: [], jobIds: [], roles: {}, events: [] }),
      queryReputationJob: async () => [],
      queryWorkerFeedbackEvidence: async () => [],
    },
    discovery: { getTotalAgents: async () => 0n },
    jobs: {
      createJobBoardJob: async () => ({ jobId: "repnet-job:1" }),
      applyToJobBoardJob: async () => ({ jobId: "repnet-job:1", applicant: "0xworker" }),
      selectJobBoardWorker: async () => ({ jobId: "repnet-job:1", selectedWorker: "0xworker" }),
      getJobBoardJob: async () => ({ jobId: "repnet-job:1" }),
      listOpenJobBoardJobs: async () => [],
      createUpfrontJob: async () => ({ jobId: 1n, hash: "0xupfront" }),
      createReviewHoldJob: async () => ({ jobId: 2n, hash: "0xreview" }),
      acceptJob: async () => ({ hash: "0xaccept" }),
      declineBeforeAccept: async () => ({ hash: "0xdecline" }),
      refundBeforeAccept: async () => ({ hash: "0xrefund" }),
      preparePrivateDelivery: async () => ({ deliveryHandle: "repnet-delivery:2:test" }),
      submitDelivery: async () => ({ hash: "0xdelivery" }),
      requestMoreWork: async () => ({ hash: "0xmore" }),
      acceptMoreWork: async () => ({ hash: "0xmoreaccept" }),
      refuseMoreWork: async () => ({ hash: "0xmorerefuse" }),
      release: async () => ({ hash: "0xrelease" }),
      cancel: async () => ({ hash: "0xcancel" }),
      getJob: async () => ({ contractor: "0xcontractor", worker: "0xworker", amount: 10_000_000n, paymentMode: 1, status: 1, deliveryHandle: "", opinionHash: "0x0000000000000000000000000000000000000000000000000000000000000000", cancellationReason: "" }),
    },
  };
}

describe("MCP Server tool surface", () => {
  it("inherits the maintained canonical RepNet action surface", () => {
    const actions = createRepNetActions(createShapeOnlyClient() as any);
    const names = Object.keys(actions);

    expect(names).toEqual(expect.arrayContaining([
      "repnet_status",
      "repnet_register",
      "repnet_lookup",
      "repnet_query_reputation",
      "repnet_query_reputation_job",
      "repnet_submit_job_feedback",
      "repnet_job_board_create",
      "repnet_accept_job",
      "repnet_job_status",
    ]));
    expect(names).not.toEqual(expect.arrayContaining([
      "repnet_preview_payment",
      "repnet_pay",
      "repnet_feedback",
    ]));
    expect(names.some((name) => name.includes("_current_"))).toBe(false);
  });
});
