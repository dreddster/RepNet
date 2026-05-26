/**
 * RepNet Guided Onboarding Flow
 *
 * Interactive, resumable onboarding that walks an agent operator through:
 *   Step 1: Prerequisites check (Node, network, contracts)
 *   Step 2: Wallet setup (generate new, import key, or connect existing)
 *   Step 3: Balance validation (ETH for gas, USDC for registration)
 *   Step 4: Agent profile detection (auto-detect existing frameworks)
 *   Step 5: A2A Agent Card (validate URL or generate from detected profile)
 *   Step 6: Registration (on-chain, free tier or $10 USDC)
 *   Step 7: Confirmation + next steps
 *
 * Config stored at ~/.repnet/config.json — resumable at any step.
 */

import { ethers } from "ethers";
import { RepNet, formatUSDC, RPC_URLS, getAddresses, type RepNetAgentProfile } from "@repnet/sdk";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG_DIR = path.join(process.env.HOME || "~", ".repnet");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

export interface OnboardConfig {
  chainId: number;
  rpcUrl?: string;
  privateKey?: string;
  walletAddress?: string;
  agentCardUrl?: string;
  agentId?: string;
  registeredAt?: string;
  agentProfileDkgUri?: string;
  onboardingStep?: number;
  detectedFramework?: string;
  generatedCard?: AgentCardData;
}

interface AgentCardData {
  name: string;
  description: string;
  url?: string;
  capabilities?: string[];
  skills?: string[];
}

// ─── Terminal I/O ────────────────────────────────────────────────────────────

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

function askSecret(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);

    let input = "";
    const finish = () => {
      stdin.removeListener("data", onData);
      if (stdin.isTTY && wasRaw !== undefined) stdin.setRawMode(wasRaw);
      process.stdout.write("\n");
      resolve(input);
    };
    const onData = (ch: Buffer) => {
      for (const c of ch.toString("utf8")) {
        if (c === "\n" || c === "\r") {
          finish();
          return;
        } else if (c === "\x7f" || c === "\b") {
          input = input.slice(0, -1);
        } else if (c === "\x03") {
          process.exit(0);
        } else {
          input += c;
        }
      }
    };
    stdin.on("data", onData);
  });
}

async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = await ask(`${question} ${hint} `);
  if (answer === "") return defaultYes;
  return answer.toLowerCase().startsWith("y");
}

async function select(question: string, options: string[]): Promise<number> {
  console.log(`\n${question}`);
  options.forEach((opt, i) => console.log(`  ${i + 1}) ${opt}`));
  while (true) {
    const answer = await ask(`\nChoice [1-${options.length}]: `);
    const n = parseInt(answer);
    if (n >= 1 && n <= options.length) return n - 1;
    console.log(`  Please enter a number between 1 and ${options.length}`);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadConfig(): OnboardConfig {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return { chainId: 84532 };
  }
}

function saveConfig(config: OnboardConfig) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

function banner(text: string) {
  const line = "═".repeat(52);
  console.log(`\n  ${line}`);
  console.log(`  ${text}`);
  console.log(`  ${line}\n`);
}

function stepHeader(step: number, total: number, title: string) {
  const bar = "█".repeat(step) + "░".repeat(total - step);
  console.log(`\n  [${bar}] Step ${step}/${total}: ${title}\n`);
}

function success(msg: string) {
  console.log(`  ✅ ${msg}`);
}

function warn(msg: string) {
  console.log(`  ⚠️  ${msg}`);
}

function info(msg: string) {
  console.log(`  ℹ  ${msg}`);
}

function fail(msg: string) {
  console.log(`  ❌ ${msg}`);
}

function formatOnboardingError(e: any): string {
  const code = e?.code ? String(e.code) : "";
  const message = e?.shortMessage || e?.reason || e?.message || String(e);

  if (code === "INSUFFICIENT_FUNDS" || /insufficient funds/i.test(message)) {
    return "Insufficient ETH for gas. Fund this wallet on Base Sepolia, then run 'repnet onboard' to resume.";
  }

  if (/network|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|timeout/i.test(message)) {
    return `RPC/network error: ${message.split("\n")[0]}`;
  }

  return message.split("\n")[0];
}

function dkgConfigFromEnv() {
  const apiUrl = process.env.REPNET_DKG_API_URL;
  if (!apiUrl) return undefined;

  return {
    mode: "node" as const,
    memory: {
      apiUrl,
      contextGraphId: process.env.REPNET_DKG_CONTEXT_GRAPH_ID,
      authToken: process.env.REPNET_DKG_AUTH_TOKEN,
    },
  };
}

function hashAgentCard(config: OnboardConfig): string | undefined {
  if (!config.agentCardUrl?.startsWith("file://")) return undefined;

  try {
    const cardPath = new URL(config.agentCardUrl).pathname;
    const content = fs.readFileSync(cardPath);
    return `sha256:${createHash("sha256").update(content).digest("hex")}`;
  } catch {
    return undefined;
  }
}

function buildAgentProfileFromConfig(config: OnboardConfig): RepNetAgentProfile | undefined {
  if (!config.agentId || !config.walletAddress || !config.agentCardUrl) return undefined;

  const card = config.generatedCard;
  const name = card?.name || `RepNet Agent ${config.agentId}`;
  const description = card?.description || "RepNet registered agent profile";
  const skillList = [
    ...(card?.skills || []),
    ...(card?.capabilities || []),
  ].map(String).filter(Boolean);

  return {
    agentId: config.agentId,
    wallet: config.walletAddress,
    agentCardUrl: config.agentCardUrl,
    agentCardHash: hashAgentCard(config),
    name,
    description,
    skills: Array.from(new Set(skillList)),
    frameworks: config.detectedFramework ? [config.detectedFramework] : undefined,
    tools: ["repnet-cli", "repnet-sdk"],
    createdAt: config.registeredAt || new Date().toISOString(),
    chainId: config.chainId,
  };
}

async function publishAgentProfileIfConfigured(config: OnboardConfig, repnet: RepNet): Promise<void> {
  if (config.agentProfileDkgUri) {
    success(`DKG Agent Profile already published: ${config.agentProfileDkgUri}`);
    return;
  }

  if (!dkgConfigFromEnv()) {
    warn("DKG Agent Profile publish skipped — set REPNET_DKG_API_URL to enable.");
    return;
  }

  const profile = buildAgentProfileFromConfig(config);
  if (!profile) {
    warn("DKG Agent Profile publish skipped — missing registered agent profile fields.");
    return;
  }

  try {
    process.stdout.write("  ⏳ Publishing public Agent Profile to DKG...");
    const dkgUri = await repnet.dkg.publishAgentProfile(profile);
    config.agentProfileDkgUri = dkgUri;
    process.stdout.write(`\r  ✅ Agent Profile published to DKG: ${dkgUri}\n`);
  } catch (e: any) {
    process.stdout.write(`\r  ⚠️  Agent Profile DKG publish skipped/failed: ${formatOnboardingError(e)}\n`);
  }
}

// ─── Framework Detection ─────────────────────────────────────────────────────

interface DetectedProfile {
  framework: string;
  name?: string;
  description?: string;
  capabilities?: string[];
  walletAddress?: string;
  configPath: string;
}

function detectFrameworks(): DetectedProfile[] {
  const detected: DetectedProfile[] = [];
  const home = process.env.HOME || "~";

  // 1. OpenClaw / Clawdbot
  const openclawPaths = [
    path.join(home, ".openclaw", "config.yaml"),
    path.join(home, ".openclaw", "config.yml"),
    path.join(home, ".config", "openclaw", "config.yaml"),
  ];
  for (const p of openclawPaths) {
    if (fs.existsSync(p)) {
      try {
        const content = fs.readFileSync(p, "utf-8");
        const nameMatch = content.match(/name:\s*["']?(.+?)["']?\s*$/m);
        const descMatch = content.match(/description:\s*["']?(.+?)["']?\s*$/m);
        detected.push({
          framework: "OpenClaw",
          name: nameMatch?.[1],
          description: descMatch?.[1],
          capabilities: ["mcp", "tools", "automation"],
          configPath: p,
        });
      } catch {}
      break;
    }
  }

  // 2. ElizaOS
  const elizaPaths = [
    path.join(home, ".eliza", "config.json"),
    path.join(home, ".eliza", "agent.json"),
    path.join(process.cwd(), ".eliza", "config.json"),
    path.join(process.cwd(), "eliza.config.json"),
  ];
  for (const p of elizaPaths) {
    if (fs.existsSync(p)) {
      try {
        const content = JSON.parse(fs.readFileSync(p, "utf-8"));
        detected.push({
          framework: "ElizaOS",
          name: content.name || content.agentName,
          description: content.description || content.bio,
          capabilities: content.capabilities || ["conversational"],
          walletAddress: content.walletAddress || content.wallet?.address,
          configPath: p,
        });
      } catch {}
      break;
    }
  }

  // 3. A2A Agent Card (/.well-known/agent-card.json)
  const a2aPaths = [
    path.join(process.cwd(), ".well-known", "agent-card.json"),
    path.join(process.cwd(), "agent-card.json"),
  ];
  for (const p of a2aPaths) {
    if (fs.existsSync(p)) {
      try {
        const card = JSON.parse(fs.readFileSync(p, "utf-8"));
        detected.push({
          framework: "A2A Agent Card",
          name: card.name,
          description: card.description,
          capabilities: card.capabilities?.map((c: any) => c.name || c),
          configPath: p,
        });
      } catch {}
      break;
    }
  }

  // 4. MCP server config
  const mcpPaths = [
    path.join(home, ".config", "mcp", "config.json"),
    path.join(home, ".mcp", "config.json"),
    path.join(process.cwd(), "mcp.json"),
  ];
  for (const p of mcpPaths) {
    if (fs.existsSync(p)) {
      try {
        const content = JSON.parse(fs.readFileSync(p, "utf-8"));
        detected.push({
          framework: "MCP Server",
          name: content.name || content.serverName,
          description: content.description,
          capabilities: content.tools?.map((t: any) => t.name) || ["mcp-tools"],
          configPath: p,
        });
      } catch {}
      break;
    }
  }

  // 5. LangChain / LangGraph
  const langchainPaths = [
    path.join(process.cwd(), "langgraph.json"),
    path.join(process.cwd(), ".langchain", "config.json"),
  ];
  for (const p of langchainPaths) {
    if (fs.existsSync(p)) {
      try {
        const content = JSON.parse(fs.readFileSync(p, "utf-8"));
        detected.push({
          framework: "LangChain/LangGraph",
          name: content.name || content.graph_name,
          description: content.description,
          capabilities: ["langchain", "tool-use"],
          configPath: p,
        });
      } catch {}
      break;
    }
  }

  // 6. CrewAI
  const crewPaths = [
    path.join(process.cwd(), "crewai.yaml"),
    path.join(process.cwd(), "crewai.yml"),
  ];
  for (const p of crewPaths) {
    if (fs.existsSync(p)) {
      detected.push({
        framework: "CrewAI",
        configPath: p,
      });
      break;
    }
  }

  return detected;
}

// ─── A2A Agent Card Builder ──────────────────────────────────────────────────

interface A2AAgentCard {
  name: string;
  description: string;
  url?: string;
  provider?: { organization: string; url?: string };
  version: string;
  capabilities?: {
    streaming?: boolean;
    pushNotifications?: boolean;
    stateTransitionHistory?: boolean;
  };
  skills?: Array<{
    id: string;
    name: string;
    description: string;
    tags?: string[];
  }>;
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  authentication?: { schemes: string[] };
  extensions?: {
    repnet?: {
      registryChain: string;
      agentWallet: string;
      agentId?: string;
    };
  };
}

function buildAgentCard(
  data: AgentCardData,
  wallet: string,
  chainId: number,
  agentId?: string
): A2AAgentCard {
  const card: A2AAgentCard = {
    name: data.name,
    description: data.description,
    version: "1.0.0",
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    extensions: {
      repnet: {
        registryChain: chainId === 8453 ? "base" : "base-sepolia",
        agentWallet: wallet,
        ...(agentId ? { agentId } : {}),
      },
    },
  };

  if (data.url) card.url = data.url;

  if (data.skills && data.skills.length > 0) {
    card.skills = data.skills.map((s, i) => ({
      id: `skill-${i + 1}`,
      name: s,
      description: s,
    }));
  }

  if (data.capabilities) {
    card.defaultInputModes = data.capabilities.includes("streaming")
      ? ["text/plain", "application/json"]
      : ["text/plain"];
  }

  return card;
}

// ─── Onboarding Steps ────────────────────────────────────────────────────────

const TOTAL_STEPS = 7;

async function step1Prerequisites(config: OnboardConfig): Promise<boolean> {
  stepHeader(1, TOTAL_STEPS, "Prerequisites");

  const chainName = config.chainId === 8453 ? "Base Mainnet" : "Base Sepolia (testnet)";
  info(`Target chain: ${chainName} (${config.chainId})`);

  // Check RPC connectivity
  const rpcUrl = config.rpcUrl || RPC_URLS[config.chainId];
  if (!rpcUrl) {
    fail(`No RPC URL for chain ${config.chainId}`);
    return false;
  }

  process.stdout.write("  ⏳ Checking RPC connectivity...");
  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const network = await provider.getNetwork();
    process.stdout.write(`\r  ✅ RPC connected — chain ${network.chainId}\n`);
  } catch (e: any) {
    process.stdout.write(`\r  ❌ RPC unreachable: ${e.message}\n`);
    return false;
  }

  // Check contracts deployed
  process.stdout.write("  ⏳ Verifying RepNet contracts...");
  try {
    const addrs = getAddresses(config.chainId);
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const code = await provider.getCode(addrs.IdentityRegistry);
    if (code === "0x") {
      process.stdout.write(`\r  ❌ Contracts not found on chain ${config.chainId}\n`);
      return false;
    }
    process.stdout.write(`\r  ✅ RepNet contracts verified on-chain\n`);
  } catch (e: any) {
    process.stdout.write(`\r  ❌ Contract check failed: ${e.message}\n`);
    return false;
  }

  return true;
}

async function step2Wallet(config: OnboardConfig): Promise<boolean> {
  stepHeader(2, TOTAL_STEPS, "Wallet Setup");

  // If already configured, offer to keep
  if (config.privateKey) {
    const wallet = new ethers.Wallet(config.privateKey);
    info(`Existing wallet found: ${wallet.address}`);
    const keep = await confirm("Keep this wallet?");
    if (keep) {
      config.walletAddress = wallet.address;
      return true;
    }
  }

  const choice = await select("How would you like to set up your wallet?", [
    "Generate a new wallet (recommended for new agents)",
    "Import an existing private key",
    "Import from a JSON keystore file",
  ]);

  switch (choice) {
    case 0: {
      // Generate new
      const wallet = ethers.Wallet.createRandom();
      config.privateKey = wallet.privateKey;
      config.walletAddress = wallet.address;

      console.log();
      success(`New wallet generated!`);
      console.log(`\n  Address: ${wallet.address}`);
      console.log(`  Mnemonic: ${wallet.mnemonic?.phrase}`);
      console.log();
      warn("SAVE YOUR MNEMONIC — it cannot be recovered!");
      warn("This is a testnet wallet. For production, use a hardware wallet or AgentKit.");
      console.log();
      await ask("  Press Enter once you've saved the mnemonic...");
      break;
    }
    case 1: {
      // Import private key
      const key = await askSecret("  Private key (hidden): ");
      try {
        const wallet = new ethers.Wallet(key);
        config.privateKey = key;
        config.walletAddress = wallet.address;
        success(`Wallet imported: ${wallet.address}`);
      } catch {
        fail("Invalid private key format");
        return false;
      }
      break;
    }
    case 2: {
      // Import from keystore
      const keystorePath = await ask("  Path to keystore JSON: ");
      if (!fs.existsSync(keystorePath)) {
        fail(`File not found: ${keystorePath}`);
        return false;
      }
      const password = await askSecret("  Keystore password (hidden): ");
      process.stdout.write("  ⏳ Decrypting keystore...");
      try {
        const json = fs.readFileSync(keystorePath, "utf-8");
        const wallet = await ethers.Wallet.fromEncryptedJson(json, password);
        config.privateKey = wallet.privateKey;
        config.walletAddress = wallet.address;
        process.stdout.write(`\r  ✅ Keystore decrypted: ${wallet.address}\n`);
      } catch (e: any) {
        process.stdout.write(`\r  ❌ Decryption failed: ${e.message}\n`);
        return false;
      }
      break;
    }
  }

  return true;
}

async function step3Balances(config: OnboardConfig): Promise<boolean> {
  stepHeader(3, TOTAL_STEPS, "Balance Validation");

  if (!config.privateKey) {
    fail("No wallet configured");
    return false;
  }

  const rpcUrl = config.rpcUrl || RPC_URLS[config.chainId];
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(config.privateKey, provider);
  const repnet = new RepNet({ chainId: config.chainId, signer: wallet, dkg: dkgConfigFromEnv() });

  // Check if already registered
  const isRegistered = await repnet.isRegistered();
  if (isRegistered) {
    success("Already registered on RepNet — skipping balance check");
    return true;
  }

  // Check free tier
  const stats = await repnet.identity.getRegistrationStats();
  const needsPayment = !stats.isFreeTier;

  // ETH balance
  const ethBal = await provider.getBalance(wallet.address);
  const ethFloat = parseFloat(ethers.formatEther(ethBal));
  const minEth = 0.001;

  if (ethFloat >= minEth) {
    success(`ETH balance: ${ethFloat.toFixed(6)} ETH (enough for gas)`);
  } else {
    fail(`ETH balance: ${ethFloat.toFixed(6)} ETH — need at least ${minEth} for gas`);
    console.log();
    if (config.chainId === 84532) {
      info("Get testnet ETH from a Base Sepolia faucet:");
      console.log("     https://www.alchemy.com/faucets/base-sepolia");
      console.log("     https://faucet.quicknode.com/base/sepolia");
    } else {
      info("Send ETH to your wallet on Base Mainnet");
    }
    console.log(`\n  Your wallet: ${wallet.address}\n`);

    const retry = await confirm("Check balance again after funding?");
    if (retry) {
      const newEthBal = await provider.getBalance(wallet.address);
      const newEthFloat = parseFloat(ethers.formatEther(newEthBal));
      if (newEthFloat >= minEth) {
        success(`ETH balance: ${newEthFloat.toFixed(6)} ETH ✓`);
      } else {
        warn(`ETH still insufficient (${newEthFloat.toFixed(6)}). You can continue and fund later.`);
      }
    }
  }

  // USDC balance (only if payment required)
  if (needsPayment) {
    const usdcBal = await repnet.payment.getBalance();
    const usdcFloat = Number(usdcBal) / 1e6;
    const minUsdc = 10;

    if (usdcFloat >= minUsdc) {
      success(`USDC balance: $${usdcFloat.toFixed(2)} (enough for $10 registration fee)`);
    } else {
      warn(`USDC balance: $${usdcFloat.toFixed(2)} — registration costs $10 USDC`);
      console.log();
      if (config.chainId === 84532) {
        info("This is testnet — you can mint test USDC with the SDK");
        info("Or register will auto-mint if using MockUSDC");
      } else {
        info("Bridge USDC to Base via https://bridge.base.org");
      }
    }
  } else {
    success("Free tier active — no USDC needed");
  }

  return true;
}

async function step4DetectProfile(config: OnboardConfig): Promise<boolean> {
  stepHeader(4, TOTAL_STEPS, "Agent Profile Detection");

  info("Scanning for existing agent frameworks...\n");

  const detected = detectFrameworks();

  if (detected.length === 0) {
    info("No existing agent frameworks detected.");
    info("We'll create a fresh A2A Agent Card in the next step.");
    return true;
  }

  console.log(`  Found ${detected.length} framework(s):\n`);
  detected.forEach((d, i) => {
    console.log(`  ${i + 1}. ${d.framework}${d.name ? ` — "${d.name}"` : ""}`);
    if (d.description) console.log(`     ${d.description.slice(0, 80)}`);
    console.log(`     Config: ${d.configPath}`);
    console.log();
  });

  const useDetected = await confirm("Use a detected profile as a starting point for your Agent Card?");

  if (useDetected && detected.length === 1) {
    const d = detected[0];
    config.detectedFramework = d.framework;
    config.generatedCard = {
      name: d.name || "",
      description: d.description || "",
      capabilities: d.capabilities,
    };
    success(`Using ${d.framework} profile as base`);
  } else if (useDetected && detected.length > 1) {
    const idx = await select(
      "Which profile to use?",
      detected.map((d) => `${d.framework}${d.name ? ` — "${d.name}"` : ""}`)
    );
    const d = detected[idx];
    config.detectedFramework = d.framework;
    config.generatedCard = {
      name: d.name || "",
      description: d.description || "",
      capabilities: d.capabilities,
    };
    success(`Using ${d.framework} profile as base`);
  } else {
    info("Skipping — we'll create a fresh Agent Card next.");
  }

  return true;
}

async function step5AgentCard(config: OnboardConfig): Promise<boolean> {
  stepHeader(5, TOTAL_STEPS, "A2A Agent Card");

  info("Every RepNet agent needs an A2A Agent Card (Google/Linux Foundation standard).");
  info("This is the public identity other agents see when discovering you.\n");

  const choice = await select("How would you like to provide your Agent Card?", [
    "I have a URL to an existing Agent Card",
    "Generate one now (interactive)",
    ...(config.generatedCard?.name ? ["Use detected profile and customize"] : []),
  ]);

  if (choice === 0) {
    // Existing URL
    const url = await ask("  Agent Card URL: ");
    if (!url) {
      fail("URL is required");
      return false;
    }

    // Basic URL validation
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      fail("URL must start with http:// or https://");
      return false;
    }

    // Try to fetch and validate
    process.stdout.write("  ⏳ Validating Agent Card...");
    try {
      const response = await fetch(url);
      if (!response.ok) {
        process.stdout.write(`\r  ⚠️  URL returned ${response.status} — card may not be accessible yet\n`);
        warn("Continuing anyway — you can update the URL later.");
      } else {
        const card = await response.json();
        if (card.name) {
          process.stdout.write(`\r  ✅ Valid Agent Card: "${card.name}"\n`);
        } else {
          process.stdout.write(`\r  ⚠️  JSON loaded but missing 'name' field\n`);
        }
      }
    } catch {
      process.stdout.write(`\r  ⚠️  Could not fetch URL — continuing anyway\n`);
    }

    config.agentCardUrl = url;
  } else {
    // Generate interactively
    const existing = config.generatedCard;

    const name = await ask(`  Agent name${existing?.name ? ` [${existing.name}]` : ""}: `);
    const finalName = name || existing?.name || "";
    if (!finalName) {
      fail("Agent name is required");
      return false;
    }

    const desc = await ask(
      `  Description (one line)${existing?.description ? ` [${existing.description.slice(0, 60)}...]` : ""}: `
    );
    const finalDesc = desc || existing?.description || "";
    if (!finalDesc) {
      fail("Description is required");
      return false;
    }

    const url = await ask("  Agent URL (optional, press Enter to skip): ");

    const skillsInput = await ask("  Skills/capabilities (comma-separated, or Enter to skip): ");
    const skills = skillsInput
      ? skillsInput.split(",").map((s) => s.trim()).filter(Boolean)
      : existing?.capabilities || [];

    config.generatedCard = {
      name: finalName,
      description: finalDesc,
      url: url || undefined,
      skills,
    };

    // Build the card
    const card = buildAgentCard(
      config.generatedCard,
      config.walletAddress || "",
      config.chainId
    );

    console.log("\n  Generated Agent Card:");
    console.log("  ─────────────────────");
    console.log(JSON.stringify(card, null, 2).split("\n").map((l) => `  ${l}`).join("\n"));

    // Save locally
    const cardDir = path.join(CONFIG_DIR, "agent-card");
    fs.mkdirSync(cardDir, { recursive: true });
    const cardPath = path.join(cardDir, "agent-card.json");
    fs.writeFileSync(cardPath, JSON.stringify(card, null, 2));
    console.log();
    success(`Saved to ${cardPath}`);

    info("To make this discoverable, host it at: <your-domain>/.well-known/agent-card.json");

    // For now, use the local path as a placeholder URI
    // In production, this would be a hosted URL
    const hostUrl = await ask("\n  Hosted URL for this card (or Enter to use local path): ");
    config.agentCardUrl = hostUrl || `file://${cardPath}`;
  }

  return true;
}

async function step6Register(config: OnboardConfig): Promise<boolean> {
  stepHeader(6, TOTAL_STEPS, "On-Chain Registration");

  if (!config.privateKey || !config.agentCardUrl) {
    fail("Missing wallet or Agent Card — go back to previous steps");
    return false;
  }

  const rpcUrl = config.rpcUrl || RPC_URLS[config.chainId];
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(config.privateKey, provider);
  const repnet = new RepNet({ chainId: config.chainId, signer: wallet, dkg: dkgConfigFromEnv() });

  // Check if already registered
  const isRegistered = await repnet.isRegistered();
  if (isRegistered) {
    const agentId = await repnet.getAgentId();
    success(`Already registered! Agent ID: ${agentId.toString()}`);
    config.agentId = agentId.toString();
    if (!config.registeredAt) config.registeredAt = new Date().toISOString();
    await publishAgentProfileIfConfigured(config, repnet);
    return true;
  }

  // Show what's about to happen
  const stats = await repnet.identity.getRegistrationStats();
  const isFree = stats.isFreeTier;

  console.log("  Registration summary:");
  console.log("  ─────────────────────");
  console.log(`  Wallet:     ${wallet.address}`);
  console.log(`  Agent Card: ${config.agentCardUrl}`);
  console.log(`  Chain:      ${config.chainId === 8453 ? "Base Mainnet" : "Base Sepolia"}`);
  console.log(`  Cost:       ${isFree ? "FREE (free tier)" : "$10 USDC"}`);
  console.log();

  const proceed = await confirm("Register now?");
  if (!proceed) {
    info("Registration skipped — run 'repnet onboard' to resume later");
    return false;
  }

  // If paid, handle USDC approval
  if (!isFree) {
    process.stdout.write("  ⏳ Approving USDC spend...");
    try {
      const fee = await repnet.contracts.registration.registrationFee();
      const approveTx = await repnet.contracts.usdc.approve(
        repnet.addresses.IdentityRegistry,
        fee
      );
      await approveTx.wait();
      process.stdout.write("\r  ✅ USDC approved\n");
    } catch (e: any) {
      process.stdout.write(`\r  ❌ USDC approval failed: ${e.message}\n`);
      return false;
    }
  }

  // Register
  process.stdout.write("  ⏳ Registering on-chain (minting identity NFT)...");
  try {
    const tx = await repnet.contracts.registration.registerWithFee(config.agentCardUrl);
    const receipt = await tx.wait();
    process.stdout.write("\r  ✅ Registration transaction confirmed!              \n");

    // Wait for state to settle (Base Sepolia read-after-write quirk)
    await new Promise((r) => setTimeout(r, 3000));

    const agentId = await repnet.getAgentId();
    config.agentId = agentId.toString();
    config.registeredAt = new Date().toISOString();

    console.log();
    console.log(`  🎉 Agent ID:  ${agentId.toString()}`);
    console.log(`  📝 TX Hash:   ${receipt.hash}`);
    if (config.chainId === 84532) {
      console.log(`  🔗 Explorer:  https://sepolia.basescan.org/tx/${receipt.hash}`);
    } else {
      console.log(`  🔗 Explorer:  https://basescan.org/tx/${receipt.hash}`);
    }

    await publishAgentProfileIfConfigured(config, repnet);
  } catch (e: any) {
    process.stdout.write(`\r  ❌ Registration failed: ${formatOnboardingError(e)}\n`);
    if (e?.code === "INSUFFICIENT_FUNDS" || /insufficient funds/i.test(e?.message || "")) {
      info("Your wallet needs more ETH for gas or USDC for the registration fee");
    }
    return false;
  }

  return true;
}

async function step7Complete(config: OnboardConfig): Promise<void> {
  stepHeader(7, TOTAL_STEPS, "Complete!");

  banner("🎉 Welcome to RepNet!");

  console.log("  Your agent is registered and ready to build reputation.\n");
  console.log("  Your identity:");
  console.log("  ──────────────");
  console.log(`  Agent ID:     ${config.agentId || "(pending)"}`);
  console.log(`  Wallet:       ${config.walletAddress}`);
  console.log(`  Agent Card:   ${config.agentCardUrl}`);
  if (config.agentProfileDkgUri) console.log(`  DKG Profile:  ${config.agentProfileDkgUri}`);
  console.log(`  Chain:        ${config.chainId === 8453 ? "Base Mainnet" : "Base Sepolia"}`);
  console.log(`  Config:       ${CONFIG_PATH}`);

  console.log("\n  What's next:");
  console.log("  ────────────");
  console.log("  1. Host your Agent Card at <domain>/.well-known/agent-card.json");
  console.log("  2. Your public DKG Agent Profile helps other agents discover your declared skills");
  console.log("  3. Accept jobs through RepNet-integrated platforms or directly via SDK");
  console.log("  4. After each job, feedback/receipts attach evidence to that profile");

  console.log("\n  Useful commands:");
  console.log("  ────────────────");
  console.log("  repnet status          Show your registration & reputation");
  console.log("  repnet lookup <addr>   Look up another agent");
  console.log("  repnet stats           Protocol-wide statistics");
  console.log();
}

// ─── Main Onboarding Flow ────────────────────────────────────────────────────

export async function runOnboarding(options?: { chain?: number; resume?: boolean }) {
  banner("RepNet — Agent Onboarding");

  console.log("  This will guide you through setting up your RepNet agent identity.");
  console.log("  Progress is saved automatically — you can quit and resume anytime.\n");

  const config = loadConfig();

  // Apply chain override
  if (options?.chain) {
    config.chainId = options.chain;
  }

  // Determine starting step
  let startStep = config.onboardingStep || 1;

  if (startStep > 1 && options?.resume !== false) {
    info(`Resuming from step ${startStep} (previous progress found)`);
    const restart = await confirm("Start over instead?", false);
    if (restart) startStep = 1;
    console.log();
  }

  // Run steps sequentially
  const steps: Array<{ run: (c: OnboardConfig) => Promise<boolean | void>; name: string }> = [
    { run: step1Prerequisites, name: "Prerequisites" },
    { run: step2Wallet, name: "Wallet" },
    { run: step3Balances, name: "Balances" },
    { run: step4DetectProfile, name: "Profile Detection" },
    { run: step5AgentCard, name: "Agent Card" },
    { run: step6Register, name: "Registration" },
    { run: step7Complete, name: "Complete" },
  ];

  for (let i = startStep - 1; i < steps.length; i++) {
    const step = steps[i];

    const result = await step.run(config);

    // Step 7 (Complete) returns void
    if (result === false) {
      config.onboardingStep = i + 1;
      saveConfig(config);
      console.log();
      warn(`Stopped at step ${i + 1}: ${step.name}`);
      info("Run 'repnet onboard' to resume from this step.");
      rl.close();
      return;
    }

    // Save progress after each step
    config.onboardingStep = i + 2; // Next step
    saveConfig(config);
  }

  // Mark onboarding complete
  config.onboardingStep = undefined;
  saveConfig(config);

  rl.close();
}
