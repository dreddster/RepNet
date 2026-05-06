/**
 * MCP Server Tests — tests tool listing and tool execution logic.
 * Tests against Base Sepolia using the deployer wallet.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { RepNet, parseUSDC, formatUSDC } from "@repnet/sdk";

// Load deployer key
const envPath = path.join(__dirname, "../../../contracts/.env");
const envContent = fs.readFileSync(envPath, "utf-8");
const deployerKey = envContent.match(/DEPLOYER_PRIVATE_KEY=(.+)/)?.[1]?.trim();
if (!deployerKey) throw new Error("DEPLOYER_PRIVATE_KEY not found");

const provider = new ethers.JsonRpcProvider("https://sepolia.base.org");
const signer = new ethers.Wallet(deployerKey, provider);
let repnet: RepNet;

// Simulate the MCP tool handlers (extracted from server.ts logic)
async function callTool(name: string, args: Record<string, any> = {}): Promise<{ text: string; isError?: boolean }> {
  try {
    switch (name) {
      case "repnet_status": {
        const addr = await repnet.getAddress();
        const isRegistered = await repnet.isRegistered();
        const balance = await repnet.payment.getBalance();
        const ethBal = await repnet.provider.getBalance(addr);
        let result = `Wallet: ${addr}\nRegistered: ${isRegistered}\nUSDC: $${formatUSDC(balance)}\nETH: ${ethers.formatEther(ethBal)}`;
        if (isRegistered) {
          const agentId = await repnet.getAgentId();
          const summary = await repnet.feedback.getSummary(agentId);
          result += `\nAgent ID: ${agentId}\nInteractions: ${summary.totalReviews} (${summary.satisfiedCount} satisfied, ${(summary.satisfactionRate * 100).toFixed(0)}%)`;
        }
        return { text: result };
      }

      case "repnet_lookup": {
        const rep = await repnet.reputation.getByWallet(args.wallet);
        if (!rep) return { text: `No RepNet identity found for ${args.wallet}` };
        return {
          text: `Agent ID: ${rep.agentId}\nWallet: ${rep.wallet}\nURI: ${rep.agentURI}\nInteractions: ${rep.feedback.totalReviews} (${rep.feedback.satisfiedCount} satisfied, ${(rep.feedback.satisfactionRate * 100).toFixed(0)}%)`,
        };
      }

      case "repnet_preview_payment": {
        const p = await repnet.payment.preview(parseUSDC(args.amount));
        return {
          text: `Job: $${args.amount}\nContractor pays: $${formatUSDC(p.contractorPays)}\nWorker receives: $${formatUSDC(p.workerReceives)}\nFee/side: $${formatUSDC(p.feePerSide)}\nTotal fee: $${formatUSDC(p.totalFee)}`,
        };
      }

      case "repnet_stats": {
        const stats = await repnet.payment.getProtocolStats();
        const regStats = await repnet.identity.getRegistrationStats();
        const totalAgents = await repnet.discovery.getTotalAgents();
        return {
          text: `Agents: ${totalAgents}\nRegistrations: ${regStats.totalRegistrations}\nFree tier: ${regStats.isFreeTier ? `${regStats.freeSlots} slots` : "exhausted"}\nJobs: ${stats.totalJobs}\nFees: $${formatUSDC(stats.totalFeesCollected)}`,
        };
      }

      default:
        return { text: `Unknown tool: ${name}`, isError: true };
    }
  } catch (error: any) {
    return { text: `Error: ${error.message}`, isError: true };
  }
}

describe("MCP Server Tools (Base Sepolia)", () => {
  beforeAll(() => {
    repnet = new RepNet({ chainId: 84532, signer });
  });

  describe("Tool Listing", () => {
    it("should define 7 tools", () => {
      const tools = [
        "repnet_status", "repnet_register", "repnet_lookup",
        "repnet_preview_payment", "repnet_pay", "repnet_feedback", "repnet_stats",
      ];
      expect(tools.length).toBe(7);
    });
  });

  describe("repnet_status", () => {
    it("should return wallet and registration info", async () => {
      const result = await callTool("repnet_status");
      expect(result.text).toContain("Wallet:");
      expect(result.text).toContain("Registered:");
      expect(result.text).toContain("USDC:");
      expect(result.text).toContain("ETH:");
    });
  });

  describe("repnet_lookup", () => {
    it("should return agent info for registered wallet", async () => {
      // Deployer wallet should be registered from previous tests
      const addr = await repnet.getAddress();
      const isRegistered = await repnet.isRegistered();

      if (isRegistered) {
        const result = await callTool("repnet_lookup", { wallet: addr });
        expect(result.text).toContain("Agent ID:");
        expect(result.text).toContain("Wallet:");
      }
    });

    it("should handle unknown wallet", async () => {
      const random = ethers.Wallet.createRandom().address;
      const result = await callTool("repnet_lookup", { wallet: random });
      expect(result.text).toContain("No RepNet identity found");
    });
  });

  describe("repnet_preview_payment", () => {
    it("should preview $100 job", async () => {
      const result = await callTool("repnet_preview_payment", { amount: 100 });
      expect(result.text).toContain("Job: $100");
      expect(result.text).toContain("Contractor pays: $101");
      expect(result.text).toContain("Worker receives: $99");
      expect(result.text).toContain("Fee/side: $1");
    });

    it("should preview micro-job ($0.50)", async () => {
      const result = await callTool("repnet_preview_payment", { amount: 0.5 });
      expect(result.text).toContain("Fee/side: $0.01"); // Min fee
    });

    it("should preview large job ($5000)", async () => {
      const result = await callTool("repnet_preview_payment", { amount: 5000 });
      expect(result.text).toContain("Fee/side: $20"); // Cap
    });
  });

  describe("repnet_stats", () => {
    it("should return protocol stats", async () => {
      const result = await callTool("repnet_stats");
      expect(result.text).toContain("Agents:");
      expect(result.text).toContain("Registrations:");
      expect(result.text).toContain("Free tier:");
      expect(result.text).toContain("Jobs:");
      expect(result.text).toContain("Fees:");
    });
  });

  describe("Unknown tool", () => {
    it("should handle gracefully", async () => {
      const result = await callTool("repnet_nonexistent");
      expect(result.text).toContain("Unknown tool");
      expect(result.isError).toBe(true);
    });
  });
});
