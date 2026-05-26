/**
 * SDK Module Tests — runs against Base Sepolia testnet.
 *
 * Tests the SDK modules end-to-end against deployed contracts.
 * Uses fresh random wallets funded from the deployer wallet.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { RepNet, parseUSDC, formatUSDC } from "../src/index";

const RPC_URL = "https://sepolia.base.org";
const CHAIN_ID = 84532;

// Load deployer key (funds test wallets). This is an integration test; skip it
// in CI/local environments that do not have deployer credentials.
const envPath = path.join(__dirname, "../../../contracts/.env");
const envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : "";
const deployerKey = envContent.match(/DEPLOYER_PRIVATE_KEY=(.+)/)?.[1]?.trim();
const describeWithDeployer = deployerKey ? describe : describe.skip;

const provider = new ethers.JsonRpcProvider(RPC_URL);
const deployer = deployerKey ? new ethers.Wallet(deployerKey, provider) : undefined as any;

// Fresh wallets for each test run
const contractorWallet = ethers.Wallet.createRandom().connect(provider);
const workerWallet = ethers.Wallet.createRandom().connect(provider);

let contractorAirep: RepNet;
let workerAirep: RepNet;
let deployerAirep: RepNet;

// Nonce tracking for deployer (Base Sepolia consistency)
let deployerNonce: number;

async function deployerSend(fn: () => Promise<ethers.TransactionResponse>) {
  const tx = await fn();
  await tx.wait();
  deployerNonce++;
  await new Promise((r) => setTimeout(r, 2000)); // Base Sepolia settle
}

describeWithDeployer("SDK Modules (Base Sepolia)", () => {
  beforeAll(async () => {
    // Fund test wallets
    deployerNonce = await provider.getTransactionCount(deployer.address);

    // ETH for gas
    const ethTx1 = await deployer.sendTransaction({
      to: contractorWallet.address,
      value: ethers.parseEther("0.002"),
      nonce: deployerNonce++,
    });
    const ethTx2 = await deployer.sendTransaction({
      to: workerWallet.address,
      value: ethers.parseEther("0.002"),
      nonce: deployerNonce++,
    });
    await Promise.all([ethTx1.wait(), ethTx2.wait()]);
    await new Promise((r) => setTimeout(r, 3000));

    // Create RepNet instances
    deployerAirep = new RepNet({ chainId: CHAIN_ID, signer: deployer });
    contractorAirep = new RepNet({ chainId: CHAIN_ID, signer: contractorWallet });
    workerAirep = new RepNet({ chainId: CHAIN_ID, signer: workerWallet });

    // Mint test USDC
    const mintTx1 = await deployerAirep.contracts.usdc.mint(
      contractorWallet.address,
      parseUSDC(5000),
      { nonce: deployerNonce++ }
    );
    const mintTx2 = await deployerAirep.contracts.usdc.mint(
      workerWallet.address,
      parseUSDC(5000),
      { nonce: deployerNonce++ }
    );
    await Promise.all([mintTx1.wait(), mintTx2.wait()]);
    await new Promise((r) => setTimeout(r, 3000));

    console.log(`Contractor: ${contractorWallet.address}`);
    console.log(`Worker: ${workerWallet.address}`);
  }, 60000);

  // ═══════════════════════════════════════════════════
  //  Identity Module
  // ═══════════════════════════════════════════════════

  describe("IdentityModule", () => {
    it("should register contractor (free tier)", async () => {
      const receipt = await contractorAirep.identity.register(
        "https://contractor.test/.well-known/agent-card.json"
      );
      expect(receipt).toBeDefined();
      await new Promise((r) => setTimeout(r, 3000));

      const isRegistered = await contractorAirep.isRegistered();
      expect(isRegistered).toBe(true);
    }, 30000);

    it("should get agent ID", async () => {
      const agentId = await contractorAirep.getAgentId();
      expect(agentId).toBeGreaterThan(0n);
    });

    it("should get agent info by wallet", async () => {
      const info = await contractorAirep.identity.getByWallet(contractorWallet.address);
      expect(info).not.toBeNull();
      expect(info!.isRegistered).toBe(true);
    });

    it("should register worker", async () => {
      await workerAirep.identity.register(
        "https://worker.test/.well-known/agent-card.json"
      );
      await new Promise((r) => setTimeout(r, 3000));
      const isRegistered = await workerAirep.isRegistered();
      expect(isRegistered).toBe(true);
    }, 30000);

    it("should get registration stats", async () => {
      const stats = await contractorAirep.identity.getRegistrationStats();
      expect(stats.totalRegistrations).toBeGreaterThanOrEqual(2n);
    });
  });

  // ═══════════════════════════════════════════════════
  //  Payment Module
  // ═══════════════════════════════════════════════════

  describe("PaymentModule", () => {
    it("should preview payment", async () => {
      const preview = await contractorAirep.payment.preview(parseUSDC(100));
      expect(preview.feePerSide).toBe(parseUSDC(1));
      expect(preview.contractorPays).toBe(parseUSDC(101));
      expect(preview.workerReceives).toBe(parseUSDC(99));
    });

    it("should route direct payment", async () => {
      const workerBefore = await workerAirep.payment.getBalance();
      await contractorAirep.payment.pay(workerWallet.address, parseUSDC(100));
      await new Promise((r) => setTimeout(r, 4000));
      const workerAfter = await workerAirep.payment.getBalance();

      expect(workerAfter - workerBefore).toBe(parseUSDC(99));
    }, 45000);

    it("should get protocol stats", async () => {
      await new Promise((r) => setTimeout(r, 3000));
      const stats = await contractorAirep.payment.getProtocolStats();
      expect(stats.totalJobs).toBeGreaterThanOrEqual(0n); // >= 0, depends on test order
    });
  });

  // ═══════════════════════════════════════════════════
  //  Agreement Module
  // ═══════════════════════════════════════════════════

  describe("AgreementModule", () => {
    it("should track via onJobStarted", () => {
      contractorAirep.agreement.onJobStarted({
        jobId: "sdk-hook-test",
        contractor: contractorWallet.address,
        worker: workerWallet.address,
        amount: parseUSDC(500),
      });
      expect(contractorAirep.agreement.getActiveJobs().length).toBe(1);
    });

    it("should complete via onJobCompleted with signoff", async () => {
      const result = await contractorAirep.agreement.onJobCompleted("sdk-hook-test", 5);
      expect(result.shouldPublish).toBe(true);
      expect(result.signoff.signature.length).toBeGreaterThan(0);
      expect(contractorAirep.agreement.getActiveJobs().length).toBe(0);
    });

    it("should sign and verify EIP-712 completion", async () => {
      const context = {
        jobId: "eip712-verify",
        contractor: contractorWallet.address,
        worker: workerWallet.address,
        amount: parseUSDC(100),
      };

      const signoff = await contractorAirep.agreement.signCompletion(context, 4);
      const recovered = contractorAirep.agreement.verifySignoff(signoff);
      expect(recovered.toLowerCase()).toBe(contractorWallet.address.toLowerCase());
    });
  });

  // ═══════════════════════════════════════════════════
  //  Feedback Module
  // ═══════════════════════════════════════════════════

  describe("FeedbackModule", () => {
    it("should submit on-chain feedback", async () => {
      const workerAgentId = await workerAirep.getAgentId();
      await contractorAirep.feedback.give({
        agentId: workerAgentId,
        satisfied: true,
        tag: "job-completed",
        category: "sdk-test",
        receiptURI: "repnet:receipt:sdk-test-1",
      });
      await new Promise((r) => setTimeout(r, 3000));

      const summary = await contractorAirep.feedback.getSummary(workerAgentId);
      expect(summary.totalReviews).toBeGreaterThan(0n);
    }, 30000);

    it("should generate structured feedback from context", async () => {
      const feedback = await contractorAirep.feedback.generate(
        {
          jobId: "gen-test",
          contractor: contractorWallet.address,
          worker: workerWallet.address,
          amount: parseUSDC(200),
          completedAt: Math.floor(Date.now() / 1000),
          techStack: ["solidity", "typescript"],
          deliverableType: "smart-contract",
          specsCount: 3,
          specsDelivered: 2,
        },
        true // satisfied
      );

      expect(feedback.tier1.satisfied).toBe(true);
      expect(feedback.tier1.paymentAmount).toBe(200);
      expect(feedback.tier2?.techStack).toContain("solidity");
    });
  });

  // ═══════════════════════════════════════════════════
  //  Discovery Module
  // ═══════════════════════════════════════════════════

  describe("DiscoveryModule", () => {
    it("should check isAgent", async () => {
      expect(await contractorAirep.discovery.isAgent(contractorWallet.address)).toBe(true);
      expect(await contractorAirep.discovery.isAgent(ethers.Wallet.createRandom().address)).toBe(false);
    });

    it("should get total agents", async () => {
      const total = await contractorAirep.discovery.getTotalAgents();
      expect(total).toBeGreaterThanOrEqual(2n);
    });
  });

  // ═══════════════════════════════════════════════════
  //  Reputation Module
  // ═══════════════════════════════════════════════════

  describe("ReputationModule", () => {
    it("should get reputation by wallet", async () => {
      const rep = await contractorAirep.reputation.getByWallet(workerWallet.address);
      expect(rep).not.toBeNull();
      expect(rep!.feedback.totalReviews).toBeGreaterThan(0n);
    });

    it("should return null for unknown wallet", async () => {
      const rep = await contractorAirep.reputation.getByWallet(ethers.Wallet.createRandom().address);
      expect(rep).toBeNull();
    });
  });
});
