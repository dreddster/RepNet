import { describe, expect, it } from "vitest";
import {
  buildAgentProfileAsset,
  buildAgreementAsset,
  buildReceiptAsset,
  type PublishAgreementDKGParams,
  type RepNetReceipt,
} from "../src/dkg/assets";

const sampleAgreement = {
  version: "1",
  description: "Build a private REST API for user management",
  specs: [
    { id: "spec-1", description: "User registration endpoint", weight: 40 },
    { id: "spec-2", description: "User authentication endpoint", weight: 60 },
  ],
  worker: "0x59Bc9f183535948006DFaC90C3865C43c82f1895",
  contractor: "0x94a52886bcc75D5DECc59B040496c455e9D09983",
  amount: "500000000",
  deliveryDeadline: 1735689600,
  reviewPeriod: 604800,
  createdAt: 1735000000,
};

const baseAgreementParams: PublishAgreementDKGParams = {
  jobId: 42n,
  agreementHash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  agreement: sampleAgreement,
  specVisibility: "public",
};

const sampleReceipt: RepNetReceipt = {
  jobId: "job-1",
  contractorAgentId: "17",
  workerAgentId: "42",
  contractorWallet: "0x94a52886bcc75D5DECc59B040496c455e9D09983",
  workerWallet: "0x59Bc9f183535948006DFaC90C3865C43c82f1895",
  paymentAmount: 100,
  feeAmount: 1,
  satisfied: true,
  tag: "job-completed",
  category: "api-development",
  source: { type: "individual" },
  techStack: ["typescript", "fastify"],
  deliverableType: "api",
  specsCount: 2,
  specsDelivered: 2,
  reviewText: "Delivered on time with clean docs",
  jobCompletedAt: "2026-04-29T12:00:00.000Z",
  txHash: "0xabc123",
  chainId: 84532,
};

describe("pure DKG asset builders", () => {
  it("builds public agreement assets with full specs in the public section", () => {
    const asset = buildAgreementAsset({
      ...baseAgreementParams,
      specVisibility: "public",
    });

    expect(asset.private).toBeUndefined();
    expect(asset.public["@type"]).toBe("repnet:JobAgreement");
    expect(asset.public["repnet:jobId"]).toBe("42");
    expect(asset.public["repnet:specs"]).toEqual(sampleAgreement.specs);
    expect(asset.public["repnet:reviewPeriod"]).toBe(604800);
  });

  it("builds private agreement assets without leaking specs publicly", () => {
    const asset = buildAgreementAsset({
      ...baseAgreementParams,
      specVisibility: "private",
    });

    expect(asset.public["repnet:specCount"]).toBe(2);
    expect(asset.public["repnet:specs"]).toBeUndefined();
    expect(asset.public["repnet:reviewPeriod"]).toBeUndefined();
    expect(asset.private?.["@graph"][0]["repnet:specs"]).toEqual(sampleAgreement.specs);
    expect(asset.private?.["@graph"][0]["repnet:description"]).toBe(sampleAgreement.description);
    expect(asset.private?.["@graph"][0]["repnet:reviewPeriod"]).toBe(604800);
  });

  it("builds receipt assets without runtime DKG dependencies", () => {
    const asset = buildReceiptAsset(sampleReceipt);

    expect(asset.public["@type"]).toBe("repnet:ReputationReceipt");
    expect(asset.public["@id"]).toBe("repnet:receipt:0xabc123");
    expect(asset.public["repnet:txHash"]).toBe("0xabc123");
    expect(asset.public["repnet:workerWallet"]).toBe(sampleReceipt.workerWallet);
    expect(asset.public["repnet:contractorWallet"]).toBe(sampleReceipt.contractorWallet);
    expect(asset.public["repnet:techStack"]).toEqual(["typescript", "fastify"]);
  });

  it("builds public AgentProfile assets without private fields", () => {
    const asset = buildAgentProfileAsset({
      agentId: "42",
      wallet: "0x59Bc9f183535948006DFaC90C3865C43c82f1895",
      agentCardUrl: "https://agent.example/.well-known/agent-card.json",
      agentCardHash: "sha256:abc123",
      name: "Audit Bot",
      description: "Solidity audit agent",
      skills: ["solidity", "security-review"],
      frameworks: ["Hermes"],
      tools: ["repnet-mcp"],
      createdAt: "2026-05-05T12:00:00.000Z",
      chainId: 84532,
      signature: "0xsig",
    });

    expect(asset.public["@type"]).toBe("repnet:AgentProfile");
    expect(asset.public["@id"]).toBe("repnet:agent:84532:42");
    expect(asset.public["repnet:wallet"]).toBe("0x59Bc9f183535948006DFaC90C3865C43c82f1895");
    expect(asset.public["repnet:agentCardUrl"]).toBe("https://agent.example/.well-known/agent-card.json");
    expect(asset.public["repnet:name"]).toBe("Audit Bot");
    expect(asset.public["repnet:description"]).toBe("Solidity audit agent");
    expect(asset.public["repnet:skills"]).toEqual(["solidity", "security-review"]);
    expect(JSON.stringify(asset)).not.toContain("privateKey");
    expect(JSON.stringify(asset)).not.toContain("mnemonic");
    expect(JSON.stringify(asset)).not.toContain("dkgAuthToken");
  });
});
