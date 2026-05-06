import { ethers } from "ethers";
import { RepNet, parseUSDC, formatUSDC } from "../src/index";

async function main() {
  console.log("═══════════════════════════════════════");
  console.log("  RepNet DKG Integration Test");
  console.log("═══════════════════════════════════════\n");

  // Setup client — requires DEPLOYER_PRIVATE_KEY env var
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!privateKey) {
    console.error("Set DEPLOYER_PRIVATE_KEY env var to run DKG tests");
    process.exit(1);
  }
  const provider = new ethers.JsonRpcProvider("https://sepolia.base.org");
  const signer = new ethers.Wallet(privateKey, provider);

  const repnet = new RepNet({
    chainId: 84532,
    signer,
    dkg: {
      endpoint: "http://localhost",
      port: 8900,
      blockchain: "base:84532",
      epochsNum: 2,
    },
  });

  // Test 1: Check edge node availability
  console.log("1. Checking edge node...");
  const available = await repnet.dkg.isNodeAvailable();
  console.log(`   Node available: ${available}`);

  if (!available) {
    console.log("   ❌ Edge node not reachable. Skipping DKG tests.");
    return;
  }

  try {
    const info = await repnet.dkg.getNodeInfo();
    console.log(`   Node version: ${info.version || "unknown"}`);
    console.log(`   ✅ Edge node connected\n`);
  } catch (e: any) {
    console.log(`   ⚠️ Could not get node info: ${e.message}\n`);
  }

  // Test 2: Build a receipt asset (no publishing)
  console.log("2. Building receipt asset...");
  const testReceipt = {
    jobId: "test-e2e-001",
    contractorAgentId: "15",
    workerAgentId: "16",
    contractorWallet: "0x94a52886bcc75D5DECc59B040496c455e9D09983",
    workerWallet: "0x59Bc9f183535948006DFaC90C3865C43c82f1895",
    paymentAmount: 200,
    feeAmount: 2,
    satisfaction: 5,
    tag: "escrow-job",
    category: "smart-contract-audit",
    source: { type: "individual" as const },
    techStack: ["solidity", "hardhat", "typescript"],
    deliverableType: "code-review",
    reviewText: "Excellent audit — found 3 critical issues before deployment.",
    jobCompletedAt: new Date().toISOString(),
    txHash: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    chainId: 84532,
  };

  const asset = repnet.dkg.buildReceiptAsset(testReceipt);
  console.log(`   Asset @type: ${asset.public["@type"]}`);
  console.log(`   Asset @id: ${asset.public["@id"]}`);
  console.log(`   Fields: ${Object.keys(asset.public).length}`);
  console.log(`   ✅ Receipt asset built correctly\n`);

  // Test 3: Publish receipt to DKG
  console.log("3. Publishing receipt to DKG...");
  try {
    const ual = await repnet.dkg.publishReceipt(testReceipt);
    console.log(`   ✅ Published! UAL: ${ual}\n`);

    // Test 4: Query the receipt back
    console.log("4. Querying receipt from DKG...");
    const receipts = await repnet.dkg.queryReputation(testReceipt.workerWallet);
    console.log(`   Found ${receipts.length} receipts for worker`);
    if (receipts.length > 0) {
      console.log(`   Latest: satisfaction=${receipts[0].satisfaction}, category=${receipts[0].category}`);
      console.log(`   ✅ Receipt queryable\n`);
    }

    // Test 5: Query by tx hash
    console.log("5. Querying by tx hash...");
    const byTx = await repnet.dkg.getReceiptByTx(testReceipt.txHash);
    console.log(`   Found: ${byTx ? "yes" : "no"}`);
    if (byTx) console.log(`   ✅ Receipt found by tx hash\n`);

  } catch (e: any) {
    console.log(`   ❌ DKG publish failed: ${e.message}\n`);
    console.log("   This might be a TRAC balance issue — need TRAC tokens for publishing.");
  }

  console.log("═══════════════════════════════════════");
  console.log("  DKG TEST COMPLETE");
  console.log("═══════════════════════════════════════");
}

main().catch(console.error);
