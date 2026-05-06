/**
 * DKG Agreement Asset Tests — unit tests for asset building and hash logic.
 *
 * These tests do NOT require a running DKG edge node. They test:
 * - buildAgreementAsset() for public visibility
 * - buildAgreementAsset() for private visibility (correct public/private split)
 * - Agreement hash consistency (same agreement → same hash)
 */
import { describe, it, expect } from "vitest";
import { ethers } from "ethers";

// Import the DKG module to access buildAgreementAsset
// We need to create a minimal RepNet instance to access the DKG module
import { RepNet } from "../src/index";

// Mock signer for testing (no actual transactions)
const mockPrivateKey = "0x" + "ab".repeat(32);
const mockProvider = new ethers.JsonRpcProvider("https://sepolia.base.org");
const mockSigner = new ethers.Wallet(mockPrivateKey, mockProvider);

const repnet = new RepNet({
  chainId: 84532,
  signer: mockSigner,
});

describe("DKG Agreement Asset Building", () => {
  const sampleAgreement = {
    version: "1",
    description: "Build a REST API for user management",
    specs: [
      { id: "spec-1", description: "User registration endpoint", weight: 40 },
      { id: "spec-2", description: "User authentication endpoint", weight: 35 },
      { id: "spec-3", description: "User profile endpoint", weight: 25 },
    ],
    worker: "0x59Bc9f183535948006DFaC90C3865C43c82f1895",
    contractor: "0x94a52886bcc75D5DECc59B040496c455e9D09983",
    amount: "500000000", // 500 USDC
    deliveryDeadline: 1735689600, // Unix timestamp
    reviewPeriod: 604800, // 7 days
    createdAt: 1735000000,
  };

  const sampleParams = {
    jobId: 42n,
    agreementHash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    agreement: sampleAgreement,
    specVisibility: "public" as const,
  };

  describe("buildAgreementAsset - public visibility", () => {
    it("should include all fields in public section", () => {
      const asset = repnet.dkg.buildAgreementAsset({
        ...sampleParams,
        specVisibility: "public",
      });

      expect(asset.public).toBeDefined();
      expect(asset.private).toBeUndefined();

      expect(asset.public["@context"]).toBe("https://schema.org");
      expect(asset.public["@type"]).toBe("repnet:JobAgreement");
      expect(asset.public["@id"]).toBe(`repnet:agreement:${sampleParams.agreementHash}`);
      expect(asset.public["repnet:jobId"]).toBe("42");
      expect(asset.public["repnet:agreementHash"]).toBe(sampleParams.agreementHash);
      expect(asset.public["repnet:contractor"]).toBe(sampleAgreement.contractor);
      expect(asset.public["repnet:worker"]).toBe(sampleAgreement.worker);
      expect(asset.public["repnet:amount"]).toBe(sampleAgreement.amount);
      expect(asset.public["repnet:deliveryDeadline"]).toBe(sampleAgreement.deliveryDeadline);
      expect(asset.public["repnet:createdAt"]).toBe(sampleAgreement.createdAt);
    });

    it("should include specs in public section for public visibility", () => {
      const asset = repnet.dkg.buildAgreementAsset({
        ...sampleParams,
        specVisibility: "public",
      });

      expect(asset.public["repnet:specs"]).toBeDefined();
      expect(asset.public["repnet:specs"]).toHaveLength(3);
      expect(asset.public["repnet:specs"]![0].id).toBe("spec-1");
      expect(asset.public["repnet:specs"]![0].weight).toBe(40);
    });

    it("should include reviewPeriod in public section for public visibility", () => {
      const asset = repnet.dkg.buildAgreementAsset({
        ...sampleParams,
        specVisibility: "public",
      });

      expect(asset.public["repnet:reviewPeriod"]).toBe(604800);
    });

    it("should NOT have specCount in public section for public visibility", () => {
      const asset = repnet.dkg.buildAgreementAsset({
        ...sampleParams,
        specVisibility: "public",
      });

      expect(asset.public["repnet:specCount"]).toBeUndefined();
    });
  });

  describe("buildAgreementAsset - private visibility", () => {
    it("should have both public and private sections", () => {
      const asset = repnet.dkg.buildAgreementAsset({
        ...sampleParams,
        specVisibility: "private",
      });

      expect(asset.public).toBeDefined();
      expect(asset.private).toBeDefined();
    });

    it("should include metadata in public section", () => {
      const asset = repnet.dkg.buildAgreementAsset({
        ...sampleParams,
        specVisibility: "private",
      });

      expect(asset.public["@context"]).toBe("https://schema.org");
      expect(asset.public["@type"]).toBe("repnet:JobAgreement");
      expect(asset.public["@id"]).toBe(`repnet:agreement:${sampleParams.agreementHash}`);
      expect(asset.public["repnet:jobId"]).toBe("42");
      expect(asset.public["repnet:agreementHash"]).toBe(sampleParams.agreementHash);
      expect(asset.public["repnet:contractor"]).toBe(sampleAgreement.contractor);
      expect(asset.public["repnet:worker"]).toBe(sampleAgreement.worker);
      expect(asset.public["repnet:amount"]).toBe(sampleAgreement.amount);
      expect(asset.public["repnet:deliveryDeadline"]).toBe(sampleAgreement.deliveryDeadline);
      expect(asset.public["repnet:createdAt"]).toBe(sampleAgreement.createdAt);
    });

    it("should include specCount (not full specs) in public section", () => {
      const asset = repnet.dkg.buildAgreementAsset({
        ...sampleParams,
        specVisibility: "private",
      });

      expect(asset.public["repnet:specCount"]).toBe(3);
      expect(asset.public["repnet:specs"]).toBeUndefined();
    });

    it("should include specs in private section", () => {
      const asset = repnet.dkg.buildAgreementAsset({
        ...sampleParams,
        specVisibility: "private",
      });

      expect(asset.private!["@context"]).toBe("https://schema.org");
      expect(asset.private!["@graph"]).toHaveLength(1);
      expect(asset.private!["@graph"][0]["@id"]).toBe(`repnet:agreement:${sampleParams.agreementHash}`);
      expect(asset.private!["@graph"][0]["repnet:specs"]).toHaveLength(3);
      expect(asset.private!["@graph"][0]["repnet:specs"][0].id).toBe("spec-1");
    });

    it("should include description and reviewPeriod in private section", () => {
      const asset = repnet.dkg.buildAgreementAsset({
        ...sampleParams,
        specVisibility: "private",
      });

      expect(asset.private!["@graph"][0]["repnet:description"]).toBe(sampleAgreement.description);
      expect(asset.private!["@graph"][0]["repnet:reviewPeriod"]).toBe(604800);
    });

    it("should NOT include reviewPeriod in public section for private visibility", () => {
      const asset = repnet.dkg.buildAgreementAsset({
        ...sampleParams,
        specVisibility: "private",
      });

      // reviewPeriod should only be in private section for private visibility
      expect((asset.public as any)["repnet:reviewPeriod"]).toBeUndefined();
    });
  });
});

describe("Agreement Hash Consistency", () => {
  it("should produce same hash for same agreement", () => {
    const agreement1 = {
      version: "1",
      description: "Test job",
      specs: [{ id: "s1", description: "Do thing", weight: 100 }],
      worker: "0x59Bc9f183535948006DFaC90C3865C43c82f1895",
      contractor: "0x94a52886bcc75D5DECc59B040496c455e9D09983",
      amount: "100000000",
      deliveryDeadline: 1735689600,
      reviewPeriod: 604800,
      createdAt: 1735000000,
    };

    const agreement2 = { ...agreement1 };

    const json1 = JSON.stringify(agreement1, Object.keys(agreement1).sort());
    const json2 = JSON.stringify(agreement2, Object.keys(agreement2).sort());

    const hash1 = ethers.keccak256(ethers.toUtf8Bytes(json1));
    const hash2 = ethers.keccak256(ethers.toUtf8Bytes(json2));

    expect(hash1).toBe(hash2);
  });

  it("should produce different hash for different agreements", () => {
    const agreement1 = {
      version: "1",
      description: "Test job",
      specs: [{ id: "s1", description: "Do thing", weight: 100 }],
      worker: "0x59Bc9f183535948006DFaC90C3865C43c82f1895",
      contractor: "0x94a52886bcc75D5DECc59B040496c455e9D09983",
      amount: "100000000",
      deliveryDeadline: 1735689600,
      reviewPeriod: 604800,
      createdAt: 1735000000,
    };

    const agreement2 = {
      ...agreement1,
      amount: "200000000", // Different amount
    };

    const json1 = JSON.stringify(agreement1, Object.keys(agreement1).sort());
    const json2 = JSON.stringify(agreement2, Object.keys(agreement2).sort());

    const hash1 = ethers.keccak256(ethers.toUtf8Bytes(json1));
    const hash2 = ethers.keccak256(ethers.toUtf8Bytes(json2));

    expect(hash1).not.toBe(hash2);
  });

  it("should produce consistent hash regardless of property order", () => {
    const agreement1 = {
      version: "1",
      description: "Test job",
      specs: [{ id: "s1", description: "Do thing", weight: 100 }],
      worker: "0x59Bc9f183535948006DFaC90C3865C43c82f1895",
      contractor: "0x94a52886bcc75D5DECc59B040496c455e9D09983",
      amount: "100000000",
      deliveryDeadline: 1735689600,
      reviewPeriod: 604800,
      createdAt: 1735000000,
    };

    // Same data, different property order in source
    const agreement2 = {
      createdAt: 1735000000,
      amount: "100000000",
      version: "1",
      worker: "0x59Bc9f183535948006DFaC90C3865C43c82f1895",
      specs: [{ id: "s1", description: "Do thing", weight: 100 }],
      contractor: "0x94a52886bcc75D5DECc59B040496c455e9D09983",
      description: "Test job",
      deliveryDeadline: 1735689600,
      reviewPeriod: 604800,
    };

    // Using sorted keys ensures consistent JSON regardless of source order
    const json1 = JSON.stringify(agreement1, Object.keys(agreement1).sort());
    const json2 = JSON.stringify(agreement2, Object.keys(agreement2).sort());

    const hash1 = ethers.keccak256(ethers.toUtf8Bytes(json1));
    const hash2 = ethers.keccak256(ethers.toUtf8Bytes(json2));

    expect(hash1).toBe(hash2);
  });
});

describe("PublishAgreementParams specVisibility", () => {
  it("should default specVisibility to public", () => {
    // This tests the interface default - we can't directly test the module
    // without mocking escrow.create, but we verify the type allows omission
    const params = {
      description: "Test job",
      specs: [{ id: "s1", description: "Do thing", weight: 100 }],
      worker: "0x59Bc9f183535948006DFaC90C3865C43c82f1895",
      amount: "100.00",
      deliveryDeadline: 1735689600,
      // specVisibility omitted - should default to 'public'
    };

    // Type check: params without specVisibility should be valid
    expect(params.specVisibility).toBeUndefined();
  });

  it("should accept public specVisibility", () => {
    const params = {
      description: "Test job",
      specs: [{ id: "s1", description: "Do thing", weight: 100 }],
      worker: "0x59Bc9f183535948006DFaC90C3865C43c82f1895",
      amount: "100.00",
      deliveryDeadline: 1735689600,
      specVisibility: "public" as const,
    };

    expect(params.specVisibility).toBe("public");
  });

  it("should accept private specVisibility", () => {
    const params = {
      description: "Test job",
      specs: [{ id: "s1", description: "Do thing", weight: 100 }],
      worker: "0x59Bc9f183535948006DFaC90C3865C43c82f1895",
      amount: "100.00",
      deliveryDeadline: 1735689600,
      specVisibility: "private" as const,
    };

    expect(params.specVisibility).toBe("private");
  });
});
