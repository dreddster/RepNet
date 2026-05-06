import { describe, expect, it } from "vitest";
import { IdentityModule } from "../src/modules/identity";
import IdentityRegistryABI from "../src/abi/IdentityRegistry.json";

function txReceipt(hash = "0xtx") {
  return { wait: async () => ({ hash }) };
}

function createRepNetMock(options: { freeTier: boolean } = { freeTier: true }) {
  const calls: string[] = [];
  const registration = {
    isFreeTier: async () => {
      calls.push("isFreeTier");
      return options.freeTier;
    },
    registrationFee: async () => {
      calls.push("registrationFee");
      return 10_000_000n;
    },
    registerWithFee: async (agentURI: string) => {
      calls.push(`registerWithFee:${agentURI}`);
      return txReceipt("0xregister");
    },
    registerBulkForPlatform: async (agents: string[], agentURIs: string[]) => {
      calls.push(`registerBulkForPlatform:${agents.length}:${agentURIs.length}`);
      return txReceipt("0xbulk");
    },
    totalPaidRegistrations: async () => {
      calls.push("totalPaidRegistrations");
      return 3n;
    },
  };

  return {
    calls,
    repnet: {
      chainId: 31337,
      addresses: { IdentityRegistry: "0x0000000000000000000000000000000000000001" },
      contracts: {
        registration,
        usdc: {
          approve: async (spender: string, amount: bigint) => {
            calls.push(`approve:${spender}:${amount}`);
            return txReceipt("0xapprove");
          },
        },
      },
    },
  };
}

describe("IdentityModule contract API", () => {
  it("uses current IdentityRegistry paid-registration method names", async () => {
    const { repnet, calls } = createRepNetMock({ freeTier: false });
    const identity = new IdentityModule(repnet as any);

    await expect(identity.register("https://agent.example/card.json")).resolves.toMatchObject({ hash: "0xregister" });

    expect(calls).toEqual([
      "isFreeTier",
      "registrationFee",
      "approve:0x0000000000000000000000000000000000000001:10000000",
      "registerWithFee:https://agent.example/card.json",
    ]);
  });

  it("uses current bulk-registration and stats method names", async () => {
    const { repnet, calls } = createRepNetMock();
    const identity = new IdentityModule(repnet as any);

    await expect(identity.registerBulk(["0x0000000000000000000000000000000000000002"], ["https://agent.example/card.json"])).resolves.toMatchObject({ hash: "0xbulk" });
    await expect(identity.getRegistrationStats()).resolves.toEqual({ totalRegistrations: 3n, isFreeTier: true });

    expect(calls).toEqual([
      "registerBulkForPlatform:1:1",
      "totalPaidRegistrations",
      "isFreeTier",
    ]);
  });

  it("ships ABI entries for every current registration method the SDK calls", () => {
    const functionNames = new Set(
      IdentityRegistryABI.filter((entry: any) => entry.type === "function").map((entry: any) => entry.name)
    );

    expect([...functionNames]).toEqual(expect.arrayContaining([
      "isFreeTier",
      "registrationFee",
      "registerWithFee",
      "registerBulkForPlatform",
      "totalPaidRegistrations",
      "REPNET_VERSION",
    ]));

    expect(functionNames).not.toContain("REGISTRATION_FEE");
    expect(functionNames).not.toContain("registerIndividual");
    expect(functionNames).not.toContain("registerBulk");
    expect(functionNames).not.toContain("totalRegistrations");
  });
});
