import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRepNetActions } from "@repnet/sdk";
import { repnetActionProvider } from "./repnetActionProvider";

const repoRoot = resolve(__dirname, "../../..");

function createShapeOnlyClient() {
  return {
    getAddress: async () => "0xabc",
    isRegistered: async () => false,
    getAgentId: async () => 1n,
    provider: { getBalance: async () => 0n },
    payment: {
      getBalance: async () => 0n,
      preview: async () => ({ contractorPays: 0n, workerReceives: 0n, feePerSide: 0n, totalFee: 0n }),
      pay: async () => ({ hash: "0xpay" }),
      getProtocolStats: async () => ({ totalJobs: 0n, totalFeesCollected: 0n }),
    },
    identity: {
      register: async () => ({ hash: "0xregister" }),
      getRegistrationStats: async () => ({ totalRegistrations: 0n, isFreeTier: false }),
    },
    reputation: { getByWallet: async () => null },
    feedback: {
      getSummary: async () => ({ totalReviews: 0, satisfiedCount: 0, satisfactionRate: 0 }),
      give: async () => ({ hash: "0xfeedback" }),
    },
    discovery: { getTotalAgents: async () => 0n },
    escrow: {
      create: async () => ({ jobId: 1n, receipt: { hash: "0xescrow" } }),
      acceptJob: async () => ({ hash: "0xaccept" }),
      deliverWork: async () => ({ hash: "0xdeliver" }),
      reviewSpecs: async () => ({ hash: "0xreview" }),
      acceptFail: async () => ({ hash: "0xfail" }),
      contestSpec: async () => ({ hash: "0xcontest" }),
      submitEvidence: async () => ({ hash: "0xevidence" }),
      preview: async () => ({ workerReceivesFull: 0n, feePerSide: 0n, totalFee: 0n, disputeFeePerSpec: 0n }),
      getJob: async () => ({
        contractor: "0xcontractor",
        worker: "0xworker",
        totalAmount: 0n,
        status: 0,
        amountReleased: 0n,
        amountRefunded: 0n,
        disputeFeesCollected: 0n,
      }),
      getSpecStatuses: async () => [],
    },
  };
}

describe("RepNet AgentKit action provider", () => {
  it("exposes exactly the canonical RepNet action surface", () => {
    const client = createShapeOnlyClient();
    const provider = repnetActionProvider({ client });
    const agentKitActions = provider.getActions({} as any);
    const canonicalActions = createRepNetActions(client as any);

    expect(agentKitActions.map((action) => action.name)).toEqual(Object.keys(canonicalActions));

    for (const action of agentKitActions) {
      const canonical = canonicalActions[action.name];
      expect(action.description).toBe(canonical.description);
      expect(Object.keys((action.schema as any).shape)).toEqual(Object.keys(canonical.inputSchema.properties));
    }
  });

  it("delegates invocation to the canonical action registry", async () => {
    const calls: Array<{ worker: string; amount: bigint }> = [];
    const client = createShapeOnlyClient();
    client.payment.pay = async (worker: string, amount: bigint) => {
      calls.push({ worker, amount });
      return { hash: "0xpaid" };
    };

    const provider = repnetActionProvider({ client });
    const pay = provider.getActions({} as any).find((action) => action.name === "repnet_pay");

    await expect(pay?.invoke({ worker: "0xworker", amount: 12.5 })).resolves.toContain("0xpaid");
    expect(calls).toEqual([{ worker: "0xworker", amount: 12_500_000n }]);
  });

  it("does not reintroduce direct ABI/protocol execution logic", () => {
    const source = readFileSync(resolve(repoRoot, "packages/agentkit-plugin/src/repnetActionProvider.ts"), "utf-8");
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, "packages/agentkit-plugin/package.json"), "utf-8"));
    const bannedPatterns = [
      /encodeFunctionData/,
      /readContract\s*\(/,
      /sendTransaction\s*\(/,
      /\.payment\.(preview|pay|getBalance|getProtocolStats)\s*\(/,
      /\.identity\.(register|getRegistrationStats|getById|getByWallet)\s*\(/,
      /\.reputation\.getByWallet\s*\(/,
      /\.feedback\.(getSummary|give)\s*\(/,
      /\.discovery\.getTotalAgents\s*\(/,
      /\.escrow\.(create|acceptJob|deliverWork|reviewSpecs|acceptFail|contestSpec|submitEvidence|preview|getJob|getSpecStatuses)\s*\(/,
      /from\s+["']\.\/abi["']/,
      /from\s+["']@coinbase\/agentkit["']/,
      /import\(["']@coinbase\/agentkit["']\)/,
      /require\(["']@coinbase\/agentkit["']\)/,
    ];

    expect(source).toContain("createRepNetActions");
    expect(pkg.dependencies?.["@coinbase/agentkit"]).toBeUndefined();
    expect(pkg.devDependencies?.["@coinbase/agentkit"]).toBeUndefined();
    expect(pkg.peerDependencies?.["@coinbase/agentkit"]).toBe("^0.10.4");
    expect(pkg.peerDependenciesMeta?.["@coinbase/agentkit"]?.optional).toBe(true);
    for (const pattern of bannedPatterns) {
      expect(source, `repnetActionProvider.ts contains banned duplicated protocol/runtime logic: ${pattern}`).not.toMatch(pattern);
    }
  });

  it("does not carry stale local ABI/schema source files", () => {
    for (const relativePath of [
      "packages/agentkit-plugin/src/abi",
      "packages/agentkit-plugin/src/constants.ts",
      "packages/agentkit-plugin/src/schemas.ts",
    ]) {
      expect(existsSync(resolve(repoRoot, relativePath)), `${relativePath} should be removed`).toBe(false);
    }
  });
});
