#!/usr/bin/env node

import { ethers } from "ethers";
import { RepNet, createRepNetActions } from "@repnet/sdk";
import { runOnboarding } from "./onboard";
import * as fs from "fs";
import * as path from "path";

const CONFIG_PATH = path.join(
  process.env.HOME || "~",
  ".repnet",
  "config.json"
);

interface CLIConfig {
  chainId: number;
  privateKey?: string;
  rpcUrl?: string;
}

function loadConfig(): CLIConfig {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return { chainId: 84532 }; // Default: Base Sepolia
  }
}

function saveConfig(config: CLIConfig) {
  const dir = path.dirname(CONFIG_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

function getClient(config: CLIConfig): RepNet {
  if (!config.privateKey) {
    throw new Error("No wallet configured. Run: repnet setup <private-key>");
  }

  const rpcUrl = config.rpcUrl || (config.chainId === 84532
    ? "https://sepolia.base.org"
    : "https://mainnet.base.org");

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = new ethers.Wallet(config.privateKey, provider);
  const dkgApiUrl = process.env.REPNET_DKG_API_URL;

  return new RepNet({
    chainId: config.chainId,
    signer,
    provider,
    ...(dkgApiUrl ? {
      dkg: {
        mode: "v10-node" as const,
        v10: {
          apiUrl: dkgApiUrl,
          authToken: process.env.REPNET_DKG_AUTH_TOKEN,
          contextGraphId: process.env.REPNET_DKG_CONTEXT_GRAPH_ID,
          publishRoute: process.env.REPNET_DKG_PUBLISH_ROUTE,
          queryRoute: process.env.REPNET_DKG_QUERY_ROUTE,
        },
      },
    } : {}),
  });
}

function getActions(config: CLIConfig) {
  return createRepNetActions(getClient(config) as any);
}

function printActionResult(title: string, text: string) {
  console.log(`\n  ${title}`);
  console.log(`  ════════════════════════════════`);
  console.log(text.split("\n").map((line) => `  ${line}`).join("\n"));
  console.log();
}

function parseJsonValue(value: string | undefined, label: string): unknown {
  if (!value) throw new Error(`Missing ${label}. Expected JSON string or path to a JSON file.`);
  const candidatePath = path.resolve(process.cwd(), value);
  const raw = fs.existsSync(candidatePath) ? fs.readFileSync(candidatePath, "utf-8") : value;
  try {
    return JSON.parse(raw);
  } catch (error: any) {
    throw new Error(`Invalid ${label}: ${error.message}`);
  }
}

function parseJsonArg(value: string | undefined, label: string): Record<string, unknown> {
  const parsed = parseJsonValue(value, label);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid ${label}: expected a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function parseBoolean(value: string | undefined, label = "boolean"): boolean {
  const normalized = value?.toLowerCase();
  if (["yes", "true", "satisfied", "pass", "passed", "1"].includes(normalized || "")) return true;
  if (["no", "false", "unsatisfied", "fail", "failed", "0"].includes(normalized || "")) return false;
  throw new Error(`Invalid ${label}: expected yes/no or true/false`);
}

function parseBooleanList(value: string | undefined): boolean[] {
  if (!value) throw new Error("Missing spec results. Example: true,false,true");
  return value.split(",").map((item, index) => parseBoolean(item.trim(), `result #${index}`));
}

function parseNumberList(value: string | undefined): number[] {
  if (!value) throw new Error("Missing spec weights. Example: 2500,2500,2500,2500");
  const trimmed = value.trim();
  const raw = trimmed.startsWith("[") ? JSON.parse(trimmed) : trimmed.split(",");
  if (!Array.isArray(raw)) throw new Error("Spec weights must be a comma list or JSON array");
  const numbers = raw.map((item) => Number(item));
  if (numbers.some((item) => Number.isNaN(item))) throw new Error("Spec weights must be numbers");
  return numbers;
}

async function executeAction(config: CLIConfig, actionName: string, input: Record<string, unknown>, title: string) {
  const action = getActions(config)[actionName];
  if (!action) throw new Error(`Unknown SDK action: ${actionName}`);
  const text = await action.execute(input);
  printActionResult(title, text);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "help") {
    console.log(`
RepNet CLI — AI Agent Reputation Infrastructure

Commands:
  onboard                                      Guided setup (recommended for new agents)
  setup <private-key>                          Quick wallet config (power users)
  status                                       Show wallet & registration status
  register <agent-card-url>                    Register agent identity ($10 USDC or free)
  lookup <wallet-address>                      Look up an agent's reputation
  evaluate-workers <job-spec-json|file> <candidates-json|file>
                                               Evaluate worker candidates for a job
  pay <worker> <amount>                        Direct payment via FeeRouter
  preview <amount>                             Preview direct-payment fee breakdown
  feedback <worker> <yes|no> <category> [receipt-uri]
                                               Leave binary feedback after a completed job
  submit-job-feedback <params-json|file>       Submit role-aware public job feedback
  publish-agreement <params-json|file>         Publish a DKG-backed JobAgreement
  escrow-preview <amount> <spec-count>         Preview escrow fees
  escrow-create <worker> <amount> <agreement-hash> <spec-weights> <deadline-days> [review-days] [collateral-bps]
                                               Create an escrow job
  accept-job <job-id>                          Accept an escrow job as worker
  deliver-work <job-id> <delivery-uri>         Submit work delivery for escrow
  review-specs <job-id> <true,false,...>       Review delivered specs
  accept-fail <job-id> <spec-index>            Accept a failed spec ruling
  contest-spec <job-id> <spec-index> <evidence-uri>
                                               Contest a failed spec
  submit-evidence <job-id> <spec-index> <evidence-uri>
                                               Submit evidence for a contested spec
  job-status <job-id>                          Show escrow job status
  stats                                        Protocol statistics
  action <repnet_action_name> <params-json|file>
                                               Execute any canonical SDK action directly
  help                                         Show this help

JSON-or-file commands accept either inline JSON or a path to a JSON file.
Config: ${CONFIG_PATH}
    `);
    return;
  }

  const config = loadConfig();

  switch (command) {
    case "onboard": {
      const chainFlag = args.indexOf("--chain");
      const chain = chainFlag >= 0 ? parseInt(args[chainFlag + 1]) : undefined;
      await runOnboarding({ chain });
      return;
    }

    case "setup": {
      const key = args[1];
      if (!key) {
        console.error("Usage: repnet setup <private-key>");
        process.exit(1);
      }

      let wallet: ethers.Wallet;
      try {
        wallet = new ethers.Wallet(key);
      } catch {
        console.error("Error: invalid private key. Expected a 32-byte hex private key, with or without 0x prefix.");
        process.exit(1);
      }

      config.privateKey = wallet.privateKey;
      saveConfig(config);
      console.log(`✅ Wallet configured: ${wallet.address}`);
      console.log(`   Chain: ${config.chainId} (Base ${config.chainId === 8453 ? "Mainnet" : "Sepolia"})`);
      console.log(`   Config: ${CONFIG_PATH}`);
      break;
    }

    case "status": {
      const text = await getActions(config).repnet_status.execute({});
      printActionResult("RepNet Status", `Chain: ${config.chainId}\n${text}`);
      break;
    }

    case "register": {
      const uri = args[1];
      if (!uri) {
        console.error("Usage: repnet register <agent-card-url>");
        process.exit(1);
      }
      console.log("Registering agent...");
      const text = await getActions(config).repnet_register.execute({ agentCardUrl: uri });
      printActionResult("Registration", text);
      break;
    }

    case "lookup": {
      const wallet = args[1];
      if (!wallet) {
        console.error("Usage: repnet lookup <wallet-address>");
        process.exit(1);
      }
      const text = await getActions(config).repnet_lookup.execute({ wallet });
      printActionResult("Agent Reputation", text);
      break;
    }

    case "pay": {
      const worker = args[1];
      const amount = parseFloat(args[2]);
      if (!worker || isNaN(amount)) {
        console.error("Usage: repnet pay <worker-address> <usdc-amount>");
        process.exit(1);
      }
      const actions = getActions(config);
      printActionResult("Payment Preview", await actions.repnet_preview_payment.execute({ amount }));
      console.log("Routing payment...");
      printActionResult("Payment", await actions.repnet_pay.execute({ worker, amount }));
      break;
    }

    case "preview": {
      const amount = parseFloat(args[1]);
      if (isNaN(amount)) {
        console.error("Usage: repnet preview <usdc-amount>");
        process.exit(1);
      }
      const text = await getActions(config).repnet_preview_payment.execute({ amount });
      printActionResult(`Payment Preview ($${amount} job)`, text);
      break;
    }

    case "feedback": {
      const targetWallet = args[1];
      const satisfiedInput = args[2]?.toLowerCase();
      const category = args[3];
      const receiptURI = args[4];
      const satisfied = satisfiedInput === "yes" || satisfiedInput === "true" || satisfiedInput === "satisfied"
        ? true
        : satisfiedInput === "no" || satisfiedInput === "false" || satisfiedInput === "unsatisfied"
          ? false
          : undefined;

      if (!targetWallet || satisfied === undefined || !category) {
        console.error("Usage: repnet feedback <worker-address> <yes|no> <category> [receipt-uri]");
        process.exit(1);
      }

      const text = await getActions(config).repnet_feedback.execute({
        targetWallet,
        satisfied,
        category,
        receiptURI,
      });
      printActionResult("Feedback", text);
      break;
    }

    case "evaluate-workers": {
      if (!args[1] || !args[2]) {
        console.error("Usage: repnet evaluate-workers <job-spec-json|file> <candidates-json|file>");
        process.exit(1);
      }
      const candidatesInput = parseJsonValue(args[2], "candidates");
      await executeAction(config, "repnet_evaluate_workers", {
        jobSpec: parseJsonArg(args[1], "job spec"),
        candidates: Array.isArray(candidatesInput) ? candidatesInput : (candidatesInput as Record<string, unknown>).candidates,
      }, "Worker Evaluation");
      break;
    }

    case "submit-job-feedback": {
      await executeAction(config, "repnet_submit_job_feedback", parseJsonArg(args[1], "job feedback params"), "Job Feedback");
      break;
    }

    case "publish-agreement": {
      await executeAction(config, "repnet_publish_agreement", parseJsonArg(args[1], "agreement params"), "DKG Agreement");
      break;
    }

    case "escrow-preview": {
      const amount = Number(args[1]);
      const specCount = Number(args[2]);
      if (Number.isNaN(amount) || Number.isNaN(specCount)) {
        console.error("Usage: repnet escrow-preview <usdc-amount> <spec-count>");
        process.exit(1);
      }
      await executeAction(config, "repnet_preview_escrow", { amount, specCount }, "Escrow Preview");
      break;
    }

    case "escrow-create": {
      const worker = args[1];
      const amount = Number(args[2]);
      const agreementHash = args[3];
      const specWeights = parseNumberList(args[4]);
      const deadlineDays = Number(args[5]);
      const reviewDays = args[6] === undefined ? undefined : Number(args[6]);
      const collateralBps = args[7] === undefined ? undefined : Number(args[7]);
      if (!worker || Number.isNaN(amount) || !agreementHash || Number.isNaN(deadlineDays)) {
        console.error("Usage: repnet escrow-create <worker> <amount> <agreement-hash> <spec-weights> <deadline-days> [review-days] [collateral-bps]");
        process.exit(1);
      }
      await executeAction(config, "repnet_create_escrow", { worker, amount, agreementHash, specWeights, deadlineDays, reviewDays, collateralBps }, "Escrow Created");
      break;
    }

    case "accept-job": {
      const jobId = Number(args[1]);
      if (Number.isNaN(jobId)) {
        console.error("Usage: repnet accept-job <job-id>");
        process.exit(1);
      }
      await executeAction(config, "repnet_accept_job", { jobId }, "Accept Job");
      break;
    }

    case "deliver-work": {
      const jobId = Number(args[1]);
      const deliveryURI = args[2];
      if (Number.isNaN(jobId) || !deliveryURI) {
        console.error("Usage: repnet deliver-work <job-id> <delivery-uri>");
        process.exit(1);
      }
      await executeAction(config, "repnet_deliver_work", { jobId, deliveryURI }, "Deliver Work");
      break;
    }

    case "review-specs": {
      const jobId = Number(args[1]);
      if (Number.isNaN(jobId) || !args[2]) {
        console.error("Usage: repnet review-specs <job-id> <true,false,...>");
        process.exit(1);
      }
      await executeAction(config, "repnet_review_specs", { jobId, results: parseBooleanList(args[2]) }, "Review Specs");
      break;
    }

    case "accept-fail": {
      const jobId = Number(args[1]);
      const specIndex = Number(args[2]);
      if (Number.isNaN(jobId) || Number.isNaN(specIndex)) {
        console.error("Usage: repnet accept-fail <job-id> <spec-index>");
        process.exit(1);
      }
      await executeAction(config, "repnet_accept_fail", { jobId, specIndex }, "Accept Fail");
      break;
    }

    case "contest-spec": {
      const jobId = Number(args[1]);
      const specIndex = Number(args[2]);
      const evidenceURI = args[3];
      if (Number.isNaN(jobId) || Number.isNaN(specIndex) || !evidenceURI) {
        console.error("Usage: repnet contest-spec <job-id> <spec-index> <evidence-uri>");
        process.exit(1);
      }
      await executeAction(config, "repnet_contest_spec", { jobId, specIndex, evidenceURI }, "Contest Spec");
      break;
    }

    case "submit-evidence": {
      const jobId = Number(args[1]);
      const specIndex = Number(args[2]);
      const evidenceURI = args[3];
      if (Number.isNaN(jobId) || Number.isNaN(specIndex) || !evidenceURI) {
        console.error("Usage: repnet submit-evidence <job-id> <spec-index> <evidence-uri>");
        process.exit(1);
      }
      await executeAction(config, "repnet_submit_evidence", { jobId, specIndex, evidenceURI }, "Submit Evidence");
      break;
    }

    case "job-status": {
      const jobId = Number(args[1]);
      if (Number.isNaN(jobId)) {
        console.error("Usage: repnet job-status <job-id>");
        process.exit(1);
      }
      await executeAction(config, "repnet_job_status", { jobId }, "Job Status");
      break;
    }

    case "stats": {
      const text = await getActions(config).repnet_stats.execute({});
      printActionResult("RepNet Protocol Stats", text);
      break;
    }

    case "action": {
      const actionName = args[1];
      const input = parseJsonArg(args[2], "action params");
      if (!actionName) {
        console.error("Usage: repnet action <repnet_action_name> <params-json|file>");
        process.exit(1);
      }
      await executeAction(config, actionName, input, actionName);
      break;
    }

    default:
      console.error(`Unknown command: ${command}. Run 'repnet help' for usage.`);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
