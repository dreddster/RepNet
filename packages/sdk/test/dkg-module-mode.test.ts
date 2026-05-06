import { describe, expect, it } from "vitest";
import { DKGModule, type DkgMode } from "../src/modules/dkg";
import type { DkgPublishResult } from "../src/dkg/types";

const fakeRepNet = {
  chainId: 84532,
  signer: {},
  getAddress: async () => "0x0000000000000000000000000000000000000001",
  contracts: { identity: { walletToAgent: async () => 1n } },
} as any;

describe("DKGModule mode facade", () => {
  it("defaults to disabled mode so public SDK consumers do not load legacy DKG clients", () => {
    const dkg = new DKGModule(fakeRepNet);

    expect(dkg.getMode()).toBe("disabled" satisfies DkgMode);
  });

  it("returns typed failed result when V10 publish is disabled", async () => {
    const dkg = new DKGModule(fakeRepNet, { mode: "disabled" });

    const result = await dkg.publishPublicV10({ public: { "@id": "urn:test" } });

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("DKG_DISABLED");
    expect(result.contextGraphId).toBe("");
  });


  it("delegates public JobFeedback evidence queries through the configured V10 client", async () => {
    const calls: any[] = [];
    const dkg = new DKGModule(fakeRepNet, {
      mode: "v10-node",
      v10: { apiUrl: "http://127.0.0.1:9200", contextGraphId: "repnet-test" },
      v10Client: {
        publishPublic: async () => ({ status: "confirmed", contextGraphId: "repnet-test" }) as DkgPublishResult,
        publishPrivate: async () => ({ status: "confirmed", contextGraphId: "repnet-test" }) as DkgPublishResult,
        queryWorkerFeedbackEvidence: async (wallet, jobSpec) => {
          calls.push([wallet, jobSpec]);
          return [{
            jobId: "123",
            proofURI: "repnet:escrow:123",
            dkgUal: "repnet:feedback:123",
            satisfied: true,
            publicJobMetadata: { languages: ["python"], frameworks: ["fastapi"] },
          }];
        },
      },
    });

    const evidence = await dkg.queryWorkerFeedbackEvidence("0xWorker", { languages: ["python"] });

    expect(calls).toEqual([["0xWorker", { languages: ["python"] }]]);
    expect(evidence[0]).toMatchObject({ jobId: "123", dkgUal: "repnet:feedback:123" });
  });

  it("publishes public AgentProfile assets through the V10 public path with context graph", async () => {
    const calls: any[] = [];
    const dkg = new DKGModule(fakeRepNet, {
      mode: "v10-node",
      v10: { apiUrl: "http://127.0.0.1:9200", contextGraphId: "repnet-test" },
      v10Client: {
        publishPublic: async (input) => { calls.push(input); return { status: "confirmed", contextGraphId: "repnet-test", receiptUri: "did:dkg:agent:42" } as DkgPublishResult; },
        publishPrivate: async () => ({ status: "confirmed", contextGraphId: "repnet-test" }) as DkgPublishResult,
      },
    });

    const locator = await dkg.publishAgentProfile({
      agentId: "42",
      wallet: "0xworker",
      agentCardUrl: "https://agent.example/.well-known/agent-card.json",
      name: "Worker Agent",
      description: "Research and coding agent",
      skills: ["research", "typescript"],
      createdAt: "2026-05-05T12:00:00.000Z",
      chainId: 84532,
    });

    expect(locator).toBe("did:dkg:agent:42");
    expect(calls).toHaveLength(1);
    expect(calls[0].contextGraphId).toBe("repnet-test");
    expect(calls[0].public["@type"]).toBe("repnet:AgentProfile");
    expect(calls[0].public["repnet:skills"]).toEqual(["research", "typescript"]);
  });

  it("publishes private agreement assets through the V10 private path without leaking specs publicly", async () => {
    const calls: any[] = [];
    const dkg = new DKGModule(fakeRepNet, {
      mode: "v10-node",
      v10: { apiUrl: "http://127.0.0.1:9200", contextGraphId: "repnet-test" },
      v10Client: {
        publishPublic: async (input) => { calls.push(["public", input]); return { status: "confirmed", contextGraphId: "repnet-test" } as DkgPublishResult; },
        publishPrivate: async (input) => { calls.push(["private", input]); return { status: "tentative", contextGraphId: "repnet-test" } as DkgPublishResult; },
      },
    });

    const result = await dkg.publishAgreementV10({
      jobId: 42n,
      agreementHash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      specVisibility: "private",
      agreement: {
        version: "1",
        description: "Private audit requirements",
        specs: [{ id: "spec-1", description: "Review Solidity contract", weight: 100 }],
        worker: "0xworker",
        contractor: "0xcontractor",
        amount: "500000000",
        deliveryDeadline: 1735689600,
        reviewPeriod: 604800,
        createdAt: 1735000000,
      },
    });

    expect(result.status).toBe("tentative");
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("private");
    expect(calls[0][1].public["repnet:specs"]).toBeUndefined();
    expect(calls[0][1].private["@graph"][0]["repnet:specs"]).toHaveLength(1);
  });
});
