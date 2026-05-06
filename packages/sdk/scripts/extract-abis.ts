#!/usr/bin/env node
/**
 * Extract ABIs from Hardhat artifacts and generate SDK ABI exports.
 * Also updates addresses from deployment file.
 */
import * as fs from "fs";
import * as path from "path";

const ARTIFACTS_DIR = path.join(__dirname, "../../../contracts/artifacts/contracts");
const DEPLOYMENT_FILE = path.join(__dirname, "../../../contracts/deployments/base-sepolia.json");
const ABI_OUT = path.join(__dirname, "../src/abi/index.ts");
const ADDR_OUT = path.join(__dirname, "../src/addresses.ts");

const CONTRACTS = [
  "MockUSDC",
  "IdentityRegistry",
  "ReputationRegistry",
  "RepNetFeeRouter",
  "EscrowVault",
  "RepNetEscrow",
];

// Extract ABIs
let abiCode = "// Auto-generated from Hardhat artifacts — do not edit manually\n\n";

for (const name of CONTRACTS) {
  const artifactPath = path.join(ARTIFACTS_DIR, `${name}.sol`, `${name}.json`);
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf-8"));
  abiCode += `export const ${name}ABI = ${JSON.stringify(artifact.abi, null, 2)} as const;\n\n`;
}

fs.mkdirSync(path.dirname(ABI_OUT), { recursive: true });
fs.writeFileSync(ABI_OUT, abiCode);
console.log(`✅ ABIs extracted to ${ABI_OUT}`);

// Update addresses
const deployment = JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, "utf-8"));
const addrs = deployment.contracts;
const escrowAddress = typeof addrs.RepNetEscrow === "string" ? addrs.RepNetEscrow : addrs.RepNetEscrow.proxy;
const deployedLabel = deployment.deployedAt || deployment.manifestCreatedAt || deployment.resumedAt || "unknown";

const addrCode = `export interface DeploymentAddresses {
  MockUSDC: string;
  IdentityRegistry: string;
  ReputationRegistry: string;
  RepNetFeeRouter: string;
  EscrowVault: string;
  RepNetEscrow: string;
}

export const ADDRESSES: Record<number, DeploymentAddresses> = {
  // Base Sepolia (testnet) — deployed ${deployedLabel}
  84532: {
    MockUSDC: "${addrs.MockUSDC}",
    IdentityRegistry: "${addrs.IdentityRegistry}",
    ReputationRegistry: "${addrs.ReputationRegistry}",
    RepNetFeeRouter: "${addrs.RepNetFeeRouter}",
    EscrowVault: "${addrs.EscrowVault}",
    RepNetEscrow: "${escrowAddress}",
  },
  // Base Mainnet (future)
  // 8453: { ... }
};

export const RPC_URLS: Record<number, string> = {
  84532: "https://sepolia.base.org",
  8453: "https://mainnet.base.org",
};

export function getAddresses(chainId: number): DeploymentAddresses {
  const addrs = ADDRESSES[chainId];
  if (!addrs) throw new Error(\`RepNet not deployed on chain \${chainId}\`);
  return addrs;
}
`;

fs.writeFileSync(ADDR_OUT, addrCode);
console.log(`✅ Addresses updated in ${ADDR_OUT}`);
