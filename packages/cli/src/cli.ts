#!/usr/bin/env node

import { ethers } from "ethers";
import { RepNet, REPNET_OFFICIAL_CONTEXT_GRAPH_ID, createRepNetActions } from "@repnet/sdk";
import { runOnboarding } from "./onboard";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";

const CONFIG_PATH = path.join(
  process.env.HOME || "~",
  ".repnet",
  "config.json"
);

interface CLIConfig {
  chainId: number;
  privateKey?: string;
  rpcUrl?: string;
  addresses?: Record<string, string>;
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
  const gatewayUrl = process.env.REPNET_GATEWAY_URL;
  const addresses = {
    ...(config.addresses || {}),
    ...(process.env.REPNET_JOB_BOARD_ADDRESS ? { RepNetJobBoard: process.env.REPNET_JOB_BOARD_ADDRESS } : {}),
  };

  return new RepNet({
    chainId: config.chainId,
    signer,
    provider,
    addresses,
    ...(gatewayUrl ? { gatewayUrl } : {}),
    ...(dkgApiUrl ? {
      dkg: {
        mode: "node" as const,
        memory: {
          apiUrl: dkgApiUrl,
          authToken: process.env.REPNET_DKG_AUTH_TOKEN,
          contextGraphId: process.env.REPNET_DKG_CONTEXT_GRAPH_ID || REPNET_OFFICIAL_CONTEXT_GRAPH_ID,
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


function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      return Object.keys(entry as Record<string, unknown>).sort().reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = (entry as Record<string, unknown>)[key];
        return acc;
      }, {});
    }
    return entry;
  });
}

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex")}`;
}

type SigningTranscript = {
  actor: string;
  operation: string;
  challenge?: string;
  summary: string;
  signature?: string;
  txHash?: string;
  gatewayVerification?: string;
};

function fingerprint(value: string): string {
  return sha256(value).replace("sha256:", "sha256:").slice(0, "sha256:".length + 16);
}

function printSigningTranscript(input: SigningTranscript) {
  const lines = [
    "Signing transcript:",
    `- Actor wallet: ${input.actor}`,
    `- Operation: ${input.operation}`,
    input.challenge ? `- Challenge: ${input.challenge}` : undefined,
    `- Message summary: ${input.summary}`,
    input.signature ? `- Signature fingerprint: ${fingerprint(input.signature)}` : undefined,
    input.txHash ? `- Transaction hash: ${input.txHash}` : undefined,
    input.gatewayVerification ? `- Gateway verification: ${input.gatewayVerification}` : undefined,
  ].filter(Boolean).join("\n");
  console.log(lines);
}

function buildJobPostingTypedData(input: {
  chainId: number;
  contractor: string;
  title: string;
  publicSpecHash: string;
  privateSpecHash: string;
  budget: string;
  paymentMode: string;
  applicationDeadline: string;
  deliveryDeadline: string;
  reviewDeadline: string;
}) {
  return {
    domain: { name: "RepNet Job Board", version: "1", chainId: input.chainId },
    types: {
      JobPostingIntent: [
        { name: "contractor", type: "address" },
        { name: "title", type: "string" },
        { name: "publicSpecHash", type: "string" },
        { name: "privateSpecHash", type: "string" },
        { name: "budget", type: "string" },
        { name: "paymentMode", type: "string" },
        { name: "applicationDeadline", type: "string" },
        { name: "deliveryDeadline", type: "string" },
        { name: "reviewDeadline", type: "string" },
      ],
    },
    primaryType: "JobPostingIntent",
    message: {
      contractor: input.contractor,
      title: input.title,
      publicSpecHash: input.publicSpecHash,
      privateSpecHash: input.privateSpecHash,
      budget: input.budget,
      paymentMode: input.paymentMode,
      applicationDeadline: input.applicationDeadline,
      deliveryDeadline: input.deliveryDeadline,
      reviewDeadline: input.reviewDeadline,
    },
  };
}

async function signJobBoardApplyInput(config: CLIConfig, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  if ("signerUrl" in input) {
    throw new Error("job-board-apply no longer accepts signerUrl. The CLI signs the application locally and sends applicant + applicationSignature to the gateway.");
  }
  if (!config.privateKey) throw new Error("No wallet configured. Run: repnet setup <private-key>");
  const required = ["jobId", "profileRef", "publicSummary"];
  for (const key of required) if (!(key in input)) throw new Error(`Missing job-board apply field: ${key}`);
  const wallet = new ethers.Wallet(config.privateKey);
  const applicant = wallet.address;
  const privateProposal = input.privateProposal ? String(input.privateProposal) : undefined;
  const typedData = {
    domain: { name: "RepNet Job Board", version: "1", chainId: config.chainId },
    types: {
      JobApplicationIntent: [
        { name: "applicant", type: "address" },
        { name: "jobId", type: "string" },
        { name: "profileRef", type: "string" },
        { name: "publicSummary", type: "string" },
        { name: "privateProposalHash", type: "string" },
      ],
    },
    primaryType: "JobApplicationIntent",
    message: {
      applicant,
      jobId: String(input.jobId),
      profileRef: String(input.profileRef),
      publicSummary: String(input.publicSummary),
      privateProposalHash: sha256(privateProposal ?? ""),
    },
  };
  const applicationSignature = await wallet.signTypedData(typedData.domain, typedData.types, typedData.message);
  printSigningTranscript({
    actor: applicant,
    operation: "job.application",
    challenge: String(input.jobId),
    summary: `Apply to ${String(input.jobId)} with profile ${String(input.profileRef)} and privateProposalHash ${typedData.message.privateProposalHash}`,
    signature: applicationSignature,
    gatewayVerification: "Gateway verifies applicant signature and selected public application fields",
  });
  return { applicant, applicationSignature, ...input };
}

function bytes32FromSha256(value: string): string {
  if (!value.startsWith("sha256:") || value.length !== "sha256:".length + 64) throw new Error(`Expected sha256-prefixed bytes32 hash, got ${value}`);
  return `0x${value.slice("sha256:".length)}`;
}

function isoToUnixSeconds(value: string): bigint {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Expected ISO date-time, got ${value}`);
  return BigInt(Math.floor(parsed / 1000));
}

async function fundAndBuildJobBoardSelectInput(config: CLIConfig, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  if ("signerUrl" in input) {
    throw new Error("job-board-select no longer accepts signerUrl. The CLI funds/signs locally and sends chain proof to the gateway.");
  }
  if (!input.jobId || !input.worker) throw new Error("Missing job-board select fields: jobId and worker");
  const client = getClient(config);
  const job = await client.jobs.getJobBoardJob(String(input.jobId));
  if (!job.budget || !job.publicSpecHash || !job.privateSpecHash || !job.agreementHash || !job.deliveryDeadline || !job.reviewDeadline || !job.paymentMode) {
    throw new Error("Job-board job is missing funding metadata");
  }
  const params = {
    worker: String(input.worker),
    amount: BigInt(job.budget),
    agreementHash: bytes32FromSha256(job.agreementHash),
    publicSpecHash: bytes32FromSha256(job.publicSpecHash),
    privateSpecHash: bytes32FromSha256(job.privateSpecHash),
    deliveryDeadline: isoToUnixSeconds(job.deliveryDeadline),
    reviewDeadline: isoToUnixSeconds(job.reviewDeadline),
  };
  const result = job.paymentMode === "UPFRONT"
    ? await client.jobs.createUpfrontJob(params)
    : await client.jobs.createReviewHoldJob(params);
  printSigningTranscript({
    actor: await client.signer.getAddress(),
    operation: `job.select_and_fund.${job.paymentMode}`,
    challenge: String(input.jobId),
    summary: `Select worker ${String(input.worker)} and fund hold for job-board job ${String(input.jobId)}`,
    txHash: result.hash,
    gatewayVerification: "Gateway records chain proof and selected worker funding metadata",
  });
  const receipt = await client.provider.getTransactionReceipt(result.hash);
  return {
    contractor: await client.signer.getAddress(),
    worker: String(input.worker),
    jobId: String(input.jobId),
    chainTxHash: result.hash,
    chainBlockNumber: receipt?.blockNumber ?? 0,
    chainJobId: result.jobId.toString(),
  };
}


function deliveryReportMessage(jobId: string): string {
  return `RepNet delivery report\njobId:${jobId}`;
}

function deliveryReadMessage(jobId: string, deliveryHandle: string): string {
  return `RepNet read delivery\njobId:${jobId}\ndeliveryHandle:${deliveryHandle}`;
}

function jobBoardPrivateSpecsMessage(jobId: string, worker: string, timestamp: string): string {
  return `RepNet private job details\njobId:${jobId}\nworker:${worker}\ntimestamp:${timestamp}`;
}

async function signJobBoardPrivateSpecsInput(config: CLIConfig, jobId: string): Promise<Record<string, unknown>> {
  if (!jobId) throw new Error("Usage: repnet job-board-private-specs <job-board-id>");
  if (!config.privateKey) throw new Error("No wallet configured. Run: repnet setup <private-key>");
  const wallet = new ethers.Wallet(config.privateKey);
  const worker = wallet.address;
  const timestamp = new Date().toISOString();
  const readSignature = await wallet.signMessage(jobBoardPrivateSpecsMessage(jobId, worker, timestamp));
  printSigningTranscript({
    actor: worker,
    operation: "job.private_spec_read",
    challenge: timestamp,
    summary: `Read private specs for ${jobId}`,
    signature: readSignature,
    gatewayVerification: "Gateway verifies selected worker, funded status, and read signature",
  });
  return { jobId, worker, timestamp, readSignature };
}

async function signDeliveryReportIntent(config: CLIConfig, jobId: bigint): Promise<{ contractor: string; reportSignature: string }> {
  if (!config.privateKey) throw new Error("No wallet configured. Run: repnet setup <private-key>");
  const wallet = new ethers.Wallet(config.privateKey);
  const contractor = wallet.address;
  const reportSignature = await wallet.signMessage(deliveryReportMessage(jobId.toString()));
  printSigningTranscript({
    actor: contractor,
    operation: "delivery.report_request",
    challenge: jobId.toString(),
    summary: `Request sanitized delivery report for chain job ${jobId}`,
    signature: reportSignature,
    gatewayVerification: "Gateway verifies contractor signature and job role",
  });
  return { contractor, reportSignature };
}

async function signDeliveryReadIntent(config: CLIConfig, jobId: bigint, deliveryHandle: string): Promise<{ contractor: string; readSignature: string }> {
  if (!config.privateKey) throw new Error("No wallet configured. Run: repnet setup <private-key>");
  const wallet = new ethers.Wallet(config.privateKey);
  const contractor = wallet.address;
  const readSignature = await wallet.signMessage(deliveryReadMessage(jobId.toString(), deliveryHandle));
  printSigningTranscript({
    actor: contractor,
    operation: "delivery.read_released_payload",
    challenge: deliveryHandle,
    summary: `Read released delivery for chain job ${jobId}`,
    signature: readSignature,
    gatewayVerification: "Gateway verifies contractor signature, release state, and delivery handle",
  });
  return { contractor, readSignature };
}

function parseJobBoardSelectArgs(args: string[]): Record<string, unknown> {
  const [jobId, worker, ...extra] = args;
  if (!jobId || !worker || extra.length > 0 || jobId.endsWith(".json") || jobId.trim().startsWith("{")) {
    throw new Error("Usage: repnet job-board-select <job-board-id> <worker-wallet>");
  }
  return { jobId, worker };
}

async function signJobBoardCreateInput(config: CLIConfig, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  if ("signerUrl" in input) {
    throw new Error("job-board-create no longer accepts signerUrl in job JSON. The CLI signs locally and sends contractor + jobPostingSignature to the gateway.");
  }
  if (!config.privateKey) throw new Error("No wallet configured. Run: repnet setup <private-key>");
  const required = ["title", "publicSpec", "privateSpec", "budget", "paymentMode", "applicationDeadline", "deliveryDeadline", "reviewDeadline"];
  for (const key of required) {
    if (!(key in input)) throw new Error(`Missing job-board create field: ${key}`);
  }
  const wallet = new ethers.Wallet(config.privateKey);
  const contractor = wallet.address;
  const typedData = buildJobPostingTypedData({
    chainId: config.chainId,
    contractor,
    title: String(input.title),
    publicSpecHash: sha256(input.publicSpec),
    privateSpecHash: sha256(input.privateSpec),
    budget: String(input.budget),
    paymentMode: String(input.paymentMode),
    applicationDeadline: String(input.applicationDeadline),
    deliveryDeadline: String(input.deliveryDeadline),
    reviewDeadline: String(input.reviewDeadline),
  });
  const jobPostingSignature = await wallet.signTypedData(typedData.domain, typedData.types, typedData.message);
  printSigningTranscript({
    actor: contractor,
    operation: "job.post",
    challenge: sha256(typedData.message),
    summary: `Post ${String(input.title)} with publicSpecHash ${typedData.message.publicSpecHash} and privateSpecHash ${typedData.message.privateSpecHash}`,
    signature: jobPostingSignature,
    gatewayVerification: "Gateway verifies registered contractor identity and posting signature",
  });
  return { contractor, jobPostingSignature, ...input };
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

function splitList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function parseOptionArgs(values: string[]): Record<string, string | boolean> {
  const options: Record<string, string | boolean> = {};

  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token?.startsWith("-")) continue;

    const normalized = token.replace(/^-+/, "");
    const separatorIndex = [normalized.indexOf("="), normalized.indexOf(":")]
      .filter((item) => item >= 0)
      .sort((a, b) => a - b)[0];

    let key: string;
    let value: string | boolean;
    if (separatorIndex !== undefined) {
      key = normalized.slice(0, separatorIndex);
      value = normalized.slice(separatorIndex + 1);
      if (value === "" && values[index + 1] && !values[index + 1].startsWith("-")) {
        value = values[index + 1];
        index += 1;
      }
    } else {
      key = normalized;
      if (values[index + 1] && !values[index + 1].startsWith("-")) {
        value = values[index + 1];
        index += 1;
      } else {
        value = true;
      }
    }

    options[key.toLowerCase()] = value;
  }

  return options;
}

function parseReputationQueryArgs(values: string[]): Record<string, unknown> {
  if (values.length === 1 && values[0] && !values[0].startsWith("-")) {
    return parseJsonArg(values[0], "reputation query params");
  }

  const options = parseOptionArgs(values);
  const optionValue = (...keys: string[]) => keys.map((key) => options[key]).find((value) => value !== undefined);
  const positionalIdentity = values.find((item) => item && !item.startsWith("-"));
  const identity = optionValue("identityorwallet", "identity", "wallet") || positionalIdentity;
  if (!identity || typeof identity !== "string") {
    throw new Error("Usage: repnet query-reputation --identity <wallet-or-id> [--role contractor|worker] [--limit 15] [--since ISO] [--until ISO]");
  }

  const roleValue = optionValue("role");
  const role = typeof roleValue === "string" ? roleValue.toLowerCase() : undefined;
  if (role && role !== "contractor" && role !== "worker") {
    throw new Error("Invalid role: expected contractor or worker");
  }

  const limit = optionValue("limit", "n");
  const parsedLimit = typeof limit === "string" ? Number(limit) : undefined;
  if (limit !== undefined && (!Number.isFinite(parsedLimit) || parsedLimit! <= 0)) {
    throw new Error("Invalid limit: expected a positive number");
  }

  const query: Record<string, unknown> = {
    identityOrWallet: identity,
    ...(role ? { role } : {}),
    ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
  };

  for (const key of ["skills", "domains", "frameworks", "text"] as const) {
    const value = options[key];
    if (typeof value === "string") query[key] = splitList(value);
  }
  for (const key of ["since", "until"] as const) {
    const value = options[key];
    if (typeof value === "string") query[key] = value;
  }
  const exactOptionMap = {
    terminalPath: ["terminalpath", "terminal-path"],
    counterparty: ["counterparty"],
    paymentMode: ["paymentmode", "payment-mode"],
    jobType: ["jobtype", "job-type", "worktype", "work-type"],
    amountMin: ["amountmin", "amount-min"],
    amountMax: ["amountmax", "amount-max"],
  } as const;
  for (const [queryKey, optionKeys] of Object.entries(exactOptionMap)) {
    const value = optionValue(...optionKeys);
    if (typeof value === "string") query[queryKey] = value;
  }

  return query;
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

async function getPrivateDeliveryReportLocally(config: CLIConfig, jobIdArg: string | undefined) {
  if (!jobIdArg) throw new Error("Usage: repnet delivery-report <job-id>");
  const jobId = BigInt(jobIdArg);
  const client = getClient(config);
  const signed = await signDeliveryReportIntent(config, jobId);
  const result = await client.jobs.getPrivateDeliveryReport({
    jobId,
    contractor: signed.contractor,
    reportSignature: signed.reportSignature,
  }) as any;
  printActionResult("RepNet Delivery Report", JSON.stringify(result, null, 2));
}

async function readPrivateDeliveryLocally(config: CLIConfig, jobIdArg: string | undefined) {
  if (!jobIdArg) throw new Error("Usage: repnet read-delivery <job-id>");
  const jobId = BigInt(jobIdArg);
  const client = getClient(config);
  const job = await client.jobs.getJob(jobId);
  const contractor = await client.signer.getAddress();
  if (String(job.contractor).toLowerCase() !== contractor.toLowerCase()) {
    throw new Error("Delivery read requires the job contractor wallet");
  }
  if (Number(job.status) !== 8) {
    throw new Error("Delivery is still locked until the job is released");
  }
  if (!job.deliveryHandle) {
    throw new Error("No delivery handle is recorded for this job");
  }
  const signed = await signDeliveryReadIntent(config, jobId, job.deliveryHandle);
  const result = await client.jobs.readPrivateDelivery({
    jobId,
    contractor: signed.contractor,
    deliveryHandle: job.deliveryHandle,
    readSignature: signed.readSignature,
  }) as any;
  const payload = Buffer.from(String(result.payloadBase64 || ""), "base64").toString("utf-8");
  let renderedPayload = payload;
  if (String(result.contentType || "").includes("json")) {
    try {
      renderedPayload = JSON.stringify(JSON.parse(payload), null, 2);
    } catch {
      renderedPayload = payload;
    }
  }
  const artifactLines = Array.isArray(result.artifacts) && result.artifacts.length
    ? result.artifacts.map((artifact: any, index: number) => `${index + 1}. ${artifact.artifactType}: ${artifact.path}\n   Hash: ${artifact.contentHash}\n   Open: ${artifact.openInstruction}`).join("\n")
    : "none";
  printActionResult("RepNet Delivery Unlocked", `Job: ${result.jobId}\nHandle: ${result.deliveryHandle}\nContent-Type: ${result.contentType}\nHash: ${result.resultReference?.deliveryContentHash || "unknown"}\n\nArtifacts:\n${artifactLines}\n\nDelivery:\n${renderedPayload}`);
}

function normalizeDeliveryAction(input: Record<string, unknown>): "precheck" | "submit" | "abort" {
  const raw = String(input.deliveryAction ?? input.action ?? "submit").trim().toLowerCase();
  if (["o", "precheck", "llm-precheck", "llm_precheck"].includes(raw)) return "precheck";
  if (["s", "submit"].includes(raw)) return "submit";
  if (["a", "abort", "cancel"].includes(raw)) return "abort";
  throw new Error("Invalid deliveryAction: expected O/precheck, S/submit, or A/abort");
}

function deliveryArtifacts(input: Record<string, unknown>): any[] | undefined {
  return Array.isArray(input.artifacts) ? input.artifacts : undefined;
}

function printDeliverySubmissionSummary(input: Record<string, unknown>, action: string) {
  const artifacts = deliveryArtifacts(input) ?? [];
  const lines = [
    "Delivery submission summary",
    `Job: ${String(input.jobId)}`,
    `Content-Type: ${String(input.contentType ?? "application/octet-stream")}`,
    `Payload hash: ${sha256(String(input.payload ?? ""))}`,
    `Artifacts: ${artifacts.length}`,
    ...artifacts.map((artifact, index) => `  ${index + 1}. ${String(artifact?.artifactType ?? "artifact")} ${String(artifact?.path ?? "")}`),
    "Options:",
    "[O] LLM precheck",
    "[S] Submit",
    "[A] Abort Submission",
    `Selected: ${action}`,
  ];
  console.log(lines.join("\n"));
}

async function submitPrivateDeliveryLocally(config: CLIConfig, input: Record<string, unknown>) {
  if ("signerUrl" in input) {
    throw new Error("submit-private-delivery no longer accepts signerUrl. The CLI stores the private payload, signs submitDelivery locally, and broadcasts from the worker wallet.");
  }
  if (!input.jobId || !input.payload) throw new Error("Missing private delivery fields: jobId and payload");
  const action = normalizeDeliveryAction(input);
  printDeliverySubmissionSummary(input, action);
  if (action === "abort") {
    printActionResult("RepNet Private Delivery", "DELIVERY_SUBMISSION_ABORTED: no precheck, custody write, or on-chain submission was performed.");
    return;
  }
  if (action === "precheck") {
    await precheckPrivateDelivery(config, input);
    return;
  }
  const client = getClient(config);
  const jobId = BigInt(String(input.jobId));
  const worker = await client.signer.getAddress();
  const prepared = await client.jobs.preparePrivateDelivery({
    jobId,
    worker,
    payload: String(input.payload),
    ...(input.contentType ? { contentType: String(input.contentType) } : {}),
    ...(deliveryArtifacts(input) ? { artifacts: deliveryArtifacts(input) } : {}),
  }) as any;
  const receipt = await client.jobs.submitDelivery(jobId, prepared.deliveryHandle);
  printSigningTranscript({
    actor: worker,
    operation: "delivery.submit",
    challenge: prepared.deliveryHandle,
    summary: `Submit private delivery for chain job ${jobId}; content hash ${prepared.deliveryContentHash || "pending"}`,
    txHash: receipt.hash,
    gatewayVerification: "Gateway prepared custody handle; chain records submitDelivery",
  });
  printActionResult("RepNet Private Delivery", `Private delivery submitted for RepNet job #${jobId}.
Handle: ${prepared.deliveryHandle}
TX: ${receipt.hash}
Artifacts: ${(prepared.artifacts ?? []).length}`);
}

async function resubmitPrivateDeliveryLocally(config: CLIConfig, input: Record<string, unknown>) {
  if ("signerUrl" in input) {
    throw new Error("resubmit-private-delivery no longer accepts signerUrl. The CLI stores the private payload, signs resubmitDelivery locally, and broadcasts from the worker wallet.");
  }
  if (!input.jobId || !input.payload) throw new Error("Missing private delivery resubmission fields: jobId and payload");
  const client = getClient(config);
  const jobId = BigInt(String(input.jobId));
  const worker = await client.signer.getAddress();
  const prepared = await client.jobs.preparePrivateDelivery({
    jobId,
    worker,
    payload: String(input.payload),
    ...(input.contentType ? { contentType: String(input.contentType) } : {}),
    ...(deliveryArtifacts(input) ? { artifacts: deliveryArtifacts(input) } : {}),
  }) as any;
  const receipt = await client.jobs.resubmitDelivery(jobId, prepared.deliveryHandle);
  printSigningTranscript({
    actor: worker,
    operation: "delivery.resubmit",
    challenge: prepared.deliveryHandle,
    summary: `Resubmit improved private delivery for chain job ${jobId}; content hash ${prepared.deliveryContentHash || "pending"}`,
    txHash: receipt.hash,
    gatewayVerification: "Gateway prepared custody handle; chain records resubmitDelivery",
  });
  printActionResult("RepNet Private Delivery Resubmission", `Private delivery resubmitted for RepNet job #${jobId}.
Handle: ${prepared.deliveryHandle}
TX: ${receipt.hash}`);
}


async function precheckPrivateDelivery(config: CLIConfig, input: Record<string, unknown>) {
  if (!input.jobId || !input.payload) throw new Error("Missing delivery precheck fields: jobId and payload");
  const client = getClient(config);
  const jobId = BigInt(String(input.jobId));
  const worker = await client.signer.getAddress();
  const result = await client.jobs.precheckPrivateDelivery({
    jobId,
    worker,
    payload: String(input.payload),
    ...(input.contentType ? { contentType: String(input.contentType) } : {}),
  }) as any;
  printSigningTranscript({
    actor: worker,
    operation: "delivery.precheck",
    challenge: result.draftContentHash || sha256(String(input.payload)),
    summary: `Run W-only private precheck for chain job ${jobId}; payload is not submitted as official delivery`,
    gatewayVerification: "Gateway verifies worker role and stores only precheck metadata",
  });
  printActionResult("RepNet Delivery Precheck", JSON.stringify(result, null, 2));
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
  query-reputation [flags|params-json|file]    Query public DKG reputation memory by wallet/identity
  query-reputation-job <job-id>                Query public DKG reputation events for one job
  submit-job-feedback <params-json|file>       Submit role-aware public job feedback
  job-board-create <params-json|file>          Create an open job-board job via gateway
  job-board-apply <params-json|file>           Apply to an open job-board job via gateway
  job-board-select <job-board-id> <worker-wallet>
                                               Select applicant and fund/create chain job
  job-board-get <job-board-id>                 Read one job-board job
  job-board-private-specs <job-board-id>       Worker-signed private spec read after approval/funding
  job-board-list                               List open job-board jobs
  upfront-create <params-json|file>            Create upfront job
  review-hold-create <params-json|file>        Create review-hold job
  accept-job <job-id>                          Accept review-hold job
  decline-before-accept <job-id>               Decline job before accepting
  refund-before-accept <job-id>                Refund expired job before accept
  delivery-precheck <params-json|file>         Run W's one private delivery precheck
  submit-private-delivery <params-json|file>   Submit private delivery via gateway
  resubmit-private-delivery <params-json|file> Resubmit improved private delivery after more-work request
  delivery-report <job-id>                     Show C-visible sanitized delivery report
  read-delivery <job-id>                       Read unlocked delivery after C releases payment
  request-more-work <params-json|file>         Request additional work
                                               Example: request-more-work {"jobId":2,"request":"tighten the report","deadline":1765172800}
  accept-more-work <job-id>                    Accept additional work
  refuse-more-work <params-json|file>          Refuse additional work with reason
                                               Example: refuse-more-work {"jobId":2,"reason":"deadline is not workable"}
  release <job-id>                             Release job
  cancel <params-json|file>                    Cancel job
  job-status <job-id>                          Show job status
  stats                                        Protocol statistics
  action <repnet_action_name> <params-json|file>
                                               Execute any canonical SDK action directly
  help                                         Show this help

JSON-or-file commands accept either inline JSON or a path to a JSON file.
Additional-work JSON shapes:
  request: { jobId, request, deadline }
  refuse: { jobId, reason }
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

    case "query-reputation": {
      await executeAction(config, "repnet_query_reputation", parseReputationQueryArgs(args.slice(1)), "DKG Reputation Memory");
      break;
    }

    case "query-reputation-job": {
      const jobId = args[1];
      if (!jobId) throw new Error("Usage: repnet query-reputation-job <job-id>");
      await executeAction(config, "repnet_query_reputation_job", { jobId }, "DKG Reputation Job Evidence");
      break;
    }

    case "submit-job-feedback": {
      await executeAction(config, "repnet_submit_job_feedback", parseJsonArg(args[1], "job feedback params"), "Job Feedback");
      break;
    }

    case "job-board-create": {
      const input = await signJobBoardCreateInput(config, parseJsonArg(args[1], "job-board create params"));
      await executeAction(config, "repnet_job_board_create", input, "RepNet Job Board Create");
      break;
    }

    case "job-board-apply": {
      const input = await signJobBoardApplyInput(config, parseJsonArg(args[1], "job-board application params"));
      await executeAction(config, "repnet_job_board_apply", input, "RepNet Job Board Apply");
      break;
    }

    case "job-board-select": {
      const input = await fundAndBuildJobBoardSelectInput(config, parseJobBoardSelectArgs(args.slice(1)));
      await executeAction(config, "repnet_job_board_select", input, "RepNet Job Board Select");
      break;
    }

    case "job-board-get": {
      const jobId = args[1];
      if (!jobId) throw new Error("Usage: repnet job-board-get <job-board-id>");
      await executeAction(config, "repnet_job_board_get", { jobId }, "RepNet Job Board Job");
      break;
    }

    case "job-board-private-specs": {
      const input = await signJobBoardPrivateSpecsInput(config, args[1]);
      await executeAction(config, "repnet_job_board_private_specs", input, "RepNet Job Board Private Specs");
      break;
    }

    case "job-board-list": {
      await executeAction(config, "repnet_job_board_list", {}, "RepNet Job Board Jobs");
      break;
    }


    case "upfront-create": {
      await executeAction(config, "repnet_create_upfront_job", parseJsonArg(args[1], "upfront job params"), "RepNet Upfront Job");
      break;
    }

    case "review-hold-create": {
      await executeAction(config, "repnet_create_review_hold_job", parseJsonArg(args[1], "review-hold job params"), "RepNet Review-Hold Job");
      break;
    }

    case "accept-job": {
      const jobId = Number(args[1]);
      if (Number.isNaN(jobId)) throw new Error("Usage: repnet accept-job <job-id>");
      await executeAction(config, "repnet_accept_job", { jobId }, "RepNet Accept Job");
      break;
    }

    case "decline-before-accept": {
      const jobId = Number(args[1]);
      if (Number.isNaN(jobId)) throw new Error("Usage: repnet decline-before-accept <job-id>");
      await executeAction(config, "repnet_decline_before_accept", { jobId }, "RepNet Decline Before Accept");
      break;
    }

    case "refund-before-accept": {
      const jobId = Number(args[1]);
      if (Number.isNaN(jobId)) throw new Error("Usage: repnet refund-before-accept <job-id>");
      await executeAction(config, "repnet_refund_before_accept", { jobId }, "RepNet Refund Before Accept");
      break;
    }

    case "submit-private-delivery": {
      // Replaces the legacy repnet_submit_private_delivery action path: local signing only, no signerUrl callback.
      await submitPrivateDeliveryLocally(config, parseJsonArg(args[1], "private delivery params"));
      break;
    }

    case "resubmit-private-delivery": {
      await resubmitPrivateDeliveryLocally(config, parseJsonArg(args[1], "private delivery resubmission params"));
      break;
    }

    case "delivery-precheck": {
      await precheckPrivateDelivery(config, parseJsonArg(args[1], "delivery precheck params"));
      break;
    }

    case "delivery-report": {
      await getPrivateDeliveryReportLocally(config, args[1]);
      break;
    }

    case "read-delivery": {
      await readPrivateDeliveryLocally(config, args[1]);
      break;
    }

    case "request-more-work": {
      await executeAction(config, "repnet_request_more_work", parseJsonArg(args[1], "additional-work params"), "RepNet Additional Work Request");
      break;
    }

    case "accept-more-work": {
      const jobId = Number(args[1]);
      if (Number.isNaN(jobId)) throw new Error("Usage: repnet accept-more-work <job-id>");
      await executeAction(config, "repnet_accept_more_work", { jobId }, "RepNet Accept More Work");
      break;
    }

    case "refuse-more-work": {
      await executeAction(config, "repnet_refuse_more_work", parseJsonArg(args[1], "refuse additional-work params"), "RepNet Refuse More Work");
      break;
    }

    case "release": {
      const jobId = Number(args[1]);
      if (Number.isNaN(jobId)) throw new Error("Usage: repnet release <job-id>");
      await executeAction(config, "repnet_release", { jobId }, "RepNet Release");
      break;
    }

    case "cancel": {
      await executeAction(config, "repnet_cancel", parseJsonArg(args[1], "cancel params"), "RepNet Cancel");
      break;
    }

    case "job-status": {
      const jobId = Number(args[1]);
      if (Number.isNaN(jobId)) throw new Error("Usage: repnet job-status <job-id>");
      await executeAction(config, "repnet_job_status", { jobId }, "RepNet Job Status");
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

main().then(() => {
  process.exit(0);
}).catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
