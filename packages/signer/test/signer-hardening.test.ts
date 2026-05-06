import { describe, expect, it } from "vitest";
import { RepNetSigner, type SignerConfig, type SigningChallenge } from "../src/index";

const PRIVATE_KEY = "0x0000000000000000000000000000000000000000000000000000000000000001";
const ALLOWED_TO = "0x000000000000000000000000000000000000dEaD";
const OTHER_TO = "0x000000000000000000000000000000000000bEEF";

function config(overrides: Partial<SignerConfig> = {}): SignerConfig {
  return {
    privateKey: PRIVATE_KEY,
    port: 4001,
    host: "127.0.0.1",
    maxChallengeAgeSec: 300,
    logLevel: "error",
    ...overrides,
  };
}

function challenge(overrides: Partial<SigningChallenge> = {}): SigningChallenge {
  const now = new Date();
  return {
    challengeId: `ch_${crypto.randomUUID()}`,
    operation: "escrow.create",
    description: "Create escrow",
    message: "0x",
    chainId: 84532,
    transaction: {
      to: ALLOWED_TO,
      data: "0x1234",
      value: "0",
      chainId: 84532,
    },
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    nonce: Math.floor(Math.random() * 1_000_000),
    ...overrides,
  };
}

describe("RepNetSigner hardening", () => {
  it("rejects transaction challenges when envelope and transaction chain IDs differ", async () => {
    const signer = new RepNetSigner(config({ expectedChainId: 84532 }));

    const response = await signer.sign(challenge({
      chainId: 84532,
      transaction: { to: ALLOWED_TO, data: "0x1234", value: "0", chainId: 8453 },
    }));

    expect(response.rejected).toBe(true);
    expect(response.rejectionReason).toContain("chainId mismatch");
  });

  it("rejects transaction challenges outside the configured contract allowlist", async () => {
    const signer = new RepNetSigner(config({ allowedContracts: [ALLOWED_TO] }));

    const response = await signer.sign(challenge({
      transaction: { to: OTHER_TO, data: "0x1234", value: "0", chainId: 84532 },
    }));

    expect(response.rejected).toBe(true);
    expect(response.rejectionReason).toContain("not in contract allowlist");
  });

  it("rejects raw message signing unless explicitly enabled", async () => {
    const signer = new RepNetSigner(config());

    const response = await signer.sign(challenge({
      operation: "raw",
      transaction: undefined,
      message: "0x1234",
    }));

    expect(response.rejected).toBe(true);
    expect(response.rejectionReason).toContain("Raw message signing disabled");
  });
});
