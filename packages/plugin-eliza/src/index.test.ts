import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRepNetActions } from "@repnet/sdk";
import { createRepNetElizaActions, createRepNetPlugin } from "./index";

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

describe("RepNet ElizaOS plugin", () => {
  it("exposes exactly the canonical RepNet action surface", () => {
    const client = createShapeOnlyClient();
    const elizaActions = createRepNetElizaActions({ client });
    const canonicalActions = createRepNetActions(client as any);

    expect(elizaActions.map((action) => action.name)).toEqual(Object.keys(canonicalActions));
    for (const action of elizaActions) {
      expect(action.description).toBe(canonicalActions[action.name].description);
      expect(typeof action.handler).toBe("function");
      expect(typeof action.validate).toBe("function");
    }
  });

  it("delegates invocation to the canonical action registry", async () => {
    const calls: Array<{ worker: string; amount: bigint }> = [];
    const client = createShapeOnlyClient();
    client.payment.pay = async (worker: string, amount: bigint) => {
      calls.push({ worker, amount });
      return { hash: "0xpaid" };
    };

    const [pay] = createRepNetElizaActions({
      client,
      getInput: async (actionName) => actionName === "repnet_pay" ? { worker: "0xworker", amount: 12.5 } : {},
    }).filter((action) => action.name === "repnet_pay");

    const callbackMessages: unknown[] = [];
    const result = await pay.handler({} as any, { content: { text: "pay worker" } } as any, undefined, undefined, async (content) => {
      callbackMessages.push(content);
      return [] as any;
    });

    expect(result?.success).toBe(true);
    expect(String(result?.text)).toContain("0xpaid");
    expect(callbackMessages).toEqual([{ text: expect.stringContaining("0xpaid") }]);
    expect(calls).toEqual([{ worker: "0xworker", amount: 12_500_000n }]);
  });

  it("creates a plugin with canonical actions and no stale service/provider baggage", () => {
    const plugin = createRepNetPlugin({ client: createShapeOnlyClient() });
    expect(plugin.name).toBe("@repnet/plugin-eliza");
    expect(plugin.actions?.length).toBe(Object.keys(createRepNetActions(createShapeOnlyClient() as any)).length);
    expect(plugin.providers ?? []).toEqual([]);
    expect(plugin.services ?? []).toEqual([]);
  });

  it("does not reintroduce direct SDK business calls or stale DKG/service source", () => {
    const source = readFileSync(resolve(repoRoot, "packages/plugin-eliza/src/index.ts"), "utf-8");
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, "packages/plugin-eliza/package.json"), "utf-8"));
    const bannedPatterns = [
      /\.payment\.(preview|pay|getBalance|getProtocolStats)\s*\(/,
      /\.identity\.(register|getRegistrationStats|getById|getByWallet)\s*\(/,
      /\.reputation\.getByWallet\s*\(/,
      /\.feedback\.(getSummary|give)\s*\(/,
      /\.discovery\.getTotalAgents\s*\(/,
      /\.escrow\.(create|acceptJob|deliverWork|reviewSpecs|acceptFail|contestSpec|submitEvidence|preview|getJob|getSpecStatuses)\s*\(/,
      /\.dkg\.publish\s*\(/,
      /getRepNet\s*\(/,
      /from\s+["']@elizaos\/core["']/,
      /import\(["']@elizaos\/core["']\)/,
      /require\(["']@elizaos\/core["']\)/,
    ];

    expect(source).toContain("createRepNetActions");
    expect(pkg.dependencies?.["@elizaos/core"]).toBeUndefined();
    expect(pkg.devDependencies?.["@elizaos/core"]).toBeUndefined();
    expect(pkg.peerDependencies?.["@elizaos/core"]).toBe("^1.7.2");
    expect(pkg.peerDependenciesMeta?.["@elizaos/core"]?.optional).toBe(true);
    for (const pattern of bannedPatterns) {
      expect(source, `index.ts contains duplicated/stale protocol/runtime logic: ${pattern}`).not.toMatch(pattern);
    }

    for (const relativePath of [
      "packages/plugin-eliza/src/actions",
      "packages/plugin-eliza/src/providers",
      "packages/plugin-eliza/src/services",
    ]) {
      expect(existsSync(resolve(repoRoot, relativePath)), `${relativePath} should be removed`).toBe(false);
    }
  });
});
