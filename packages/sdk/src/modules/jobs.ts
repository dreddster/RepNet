import type { RepNet } from "../client";

export enum PaymentMode {
  Upfront = 0,
  ReviewGatedDeliveryHold = 1,
}

export enum JobStatus {
  Created = 0,
  Accepted = 1,
  SubmittedForReview = 2,
  OpinionPublished = 3,
  AdditionalWorkRequested = 4,
  AdditionalWorkAccepted = 5,
  AdditionalWorkRefused = 6,
  ResubmittedForReview = 7,
  Released = 8,
  CancelledBeforeDelivery = 9,
  CancelledAfterReview = 10,
  WorkerWithdrawn = 11,
  DeclinedBeforeAccept = 12,
  ExpiredBeforeAccept = 13,
  UpfrontPaid = 14,
}

export interface JobSnapshot {
  contractor: string;
  worker: string;
  amount: bigint;
  agreementHash: string;
  publicSpecHash: string;
  privateSpecHash: string;
  deliveryDeadline: bigint;
  reviewDeadline: bigint;
  paymentMode: PaymentMode;
  status: JobStatus;
  createdAt: bigint;
  acceptanceDeadline: bigint;
  acceptedAt: bigint;
  finalizedAt: bigint;
  cancellationReason: string;
  deliveryHandle: string;
  opinionHash: string;
  opinionSchemaVersion: string;
  additionalWorkDeadline: bigint;
  additionalWorkRefusalReason: string;
  additionalWorkRequestsUsed: number;
  contractorReviewsUsed: number;
}

export interface CreateJobParams {
  worker: string;
  amount: bigint;
  agreementHash: string;
  publicSpecHash: string;
  privateSpecHash: string;
  deliveryDeadline: bigint;
  reviewDeadline: bigint;
}

export interface DeliveryArtifactReference {
  path: string;
  contentHash: string;
  artifactType: string;
  openInstruction: string;
}

export interface DeliverySubmitParams {
  jobId: bigint;
  payload: string;
  signerUrl: string;
  contentType?: string;
  artifacts?: DeliveryArtifactReference[];
}

export interface DeliveryPrecheckParams {
  jobId: bigint;
  payload: string;
  worker: string;
  contentType?: string;
}

export interface DeliveryReportParams {
  jobId: bigint;
  contractor: string;
  reportSignature: string;
}

export interface DeliveryReadParams {
  jobId: bigint;
  contractor: string;
  deliveryHandle: string;
  readSignature: string;
}

export type JobBoardPaymentMode = "UPFRONT" | "REVIEW_GATED_DELIVERY_HOLD";
export type JobBoardStatus = "open" | "worker_selected" | "funded" | "cancelled";

export interface JobBoardApplication {
  jobId: string;
  applicant: string;
  ercIdentity?: string;
  profileRef: string;
  skills?: string[];
  frameworks?: string[];
  tools?: string[];
  publicSummary: string;
  proposal?: string;
  priorWork?: string[];
  privateProposalHash?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface JobBoardJob {
  jobId: string;
  contractor?: string;
  title?: string;
  publicSpec?: Record<string, unknown>;
  agreementHash?: string;
  publicSpecHash?: string;
  privateSpecHash?: string;
  budget?: string;
  paymentMode?: JobBoardPaymentMode;
  applicationDeadline?: string;
  deliveryDeadline?: string;
  reviewDeadline?: string;
  status?: JobBoardStatus | string;
  selectedWorker?: string | null;
  chainJobId?: string;
  chainTxHash?: string;
  chainBlockNumber?: number;
  applications?: JobBoardApplication[];
  applicationCount?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateJobBoardJobParams {
  contractor: string;
  jobPostingSignature: string;
  title: string;
  publicSpec: Record<string, unknown>;
  privateSpec: Record<string, unknown>;
  budget: string;
  paymentMode: JobBoardPaymentMode;
  applicationDeadline: string;
  deliveryDeadline: string;
  reviewDeadline: string;
}

export interface ApplyJobBoardJobParams {
  jobId: string;
  applicant: string;
  applicationSignature: string;
  ercIdentity?: string;
  profileRef: string;
  skills?: string[];
  frameworks?: string[];
  tools?: string[];
  publicSummary: string;
  proposal?: string;
  priorWork?: string[];
  privateProposal?: string;
}

export interface SelectJobBoardWorkerParams {
  jobId: string;
  contractor: string;
  worker: string;
  chainTxHash: string;
  chainBlockNumber: number;
  chainJobId?: string;
}

export interface ReadJobBoardPrivateSpecsParams {
  jobId: string;
  worker: string;
  timestamp: string;
  readSignature: string;
}

export interface JobBoardPrivateSpecsRead {
  jobId: string;
  worker: string;
  privateSpec: Record<string, unknown>;
  privateSpecHash: string;
  verification: {
    signer: string;
    selectedWorker: string;
    status: string;
    timestamp: string;
  };
}

const fee = (amount: bigint) => amount / 100n;
const hash = (receipt: { hash: string }) => receipt.hash;

function normalizeJob(raw: any): JobSnapshot {
  return {
    contractor: raw.contractor ?? raw[0],
    worker: raw.worker ?? raw[1],
    amount: raw.amount ?? raw[2],
    agreementHash: raw.agreementHash ?? raw[3],
    publicSpecHash: raw.publicSpecHash ?? raw[4],
    privateSpecHash: raw.privateSpecHash ?? raw[5],
    deliveryDeadline: raw.deliveryDeadline ?? raw[6],
    reviewDeadline: raw.reviewDeadline ?? raw[7],
    paymentMode: Number(raw.paymentMode ?? raw[8]) as PaymentMode,
    status: Number(raw.status ?? raw[9]) as JobStatus,
    createdAt: raw.createdAt ?? raw[10],
    acceptanceDeadline: raw.acceptanceDeadline ?? raw[11],
    acceptedAt: raw.acceptedAt ?? raw[12],
    finalizedAt: raw.finalizedAt ?? raw[13],
    cancellationReason: raw.cancellationReason ?? raw[14],
    deliveryHandle: raw.deliveryHandle ?? raw[15],
    opinionHash: raw.opinionHash ?? raw[16],
    opinionSchemaVersion: raw.opinionSchemaVersion ?? raw[17],
    additionalWorkDeadline: raw.additionalWorkDeadline ?? raw[18],
    additionalWorkRefusalReason: raw.additionalWorkRefusalReason ?? raw[19],
    additionalWorkRequestsUsed: Number(raw.additionalWorkRequestsUsed ?? raw[20]),
    contractorReviewsUsed: Number(raw.contractorReviewsUsed ?? raw[21]),
  };
}

export class JobsModule {
  constructor(private repnet: RepNet) {}

  async createReviewHoldJob(params: CreateJobParams): Promise<{ jobId: bigint; hash: string }> {
    const nextNonce = await this.approveJobSpend(params.amount + fee(params.amount));
    const tx = await this.repnet.contracts.jobBoardContract.createJob(
      params.worker,
      params.amount,
      params.agreementHash,
      params.publicSpecHash,
      params.privateSpecHash,
      params.deliveryDeadline,
      params.reviewDeadline,
      { nonce: nextNonce },
    );
    const receipt = await tx.wait();
    return { jobId: await this.jobIdFromReceiptOrCounter(receipt), hash: hash(receipt) };
  }

  async createUpfrontJob(params: CreateJobParams): Promise<{ jobId: bigint; hash: string }> {
    const nextNonce = await this.approveJobSpend(params.amount + fee(params.amount));
    const tx = await this.repnet.contracts.jobBoardContract.createUpfrontJob(
      params.worker,
      params.amount,
      params.agreementHash,
      params.publicSpecHash,
      params.privateSpecHash,
      params.deliveryDeadline,
      params.reviewDeadline,
      { nonce: nextNonce },
    );
    const receipt = await tx.wait();
    return { jobId: await this.jobIdFromReceiptOrCounter(receipt), hash: hash(receipt) };
  }

  async acceptJob(jobId: bigint) {
    const tx = await this.repnet.contracts.jobBoardContract.acceptJob(jobId);
    return tx.wait();
  }

  async declineBeforeAccept(jobId: bigint) {
    const tx = await this.repnet.contracts.jobBoardContract.declineJobBeforeAccept(jobId);
    return tx.wait();
  }

  async refundBeforeAccept(jobId: bigint) {
    const tx = await this.repnet.contracts.jobBoardContract.refundBeforeAccept(jobId);
    return tx.wait();
  }

  async submitDelivery(jobId: bigint, deliveryHandle: string) {
    const tx = await this.repnet.contracts.jobBoardContract.submitDelivery(jobId, deliveryHandle);
    return tx.wait();
  }

  async resubmitDelivery(jobId: bigint, deliveryHandle: string) {
    const tx = await this.repnet.contracts.jobBoardContract.resubmitDelivery(jobId, deliveryHandle);
    return tx.wait();
  }

  async preparePrivateDelivery(params: { jobId: bigint; payload: string; worker: string; contentType?: string; artifacts?: DeliveryArtifactReference[] }) {
    return this.gatewayPost(`/jobs/${params.jobId.toString()}/delivery/prepare`, {
      payload: params.payload,
      worker: params.worker,
      ...(params.contentType ? { contentType: params.contentType } : {}),
      ...(params.artifacts ? { artifacts: params.artifacts } : {}),
    }, "RepNet gateway delivery preparation");
  }

  async precheckPrivateDelivery(params: DeliveryPrecheckParams) {
    return this.gatewayPost(`/jobs/${params.jobId.toString()}/delivery/precheck`, {
      payload: params.payload,
      worker: params.worker,
      ...(params.contentType ? { contentType: params.contentType } : {}),
    }, "RepNet gateway delivery precheck");
  }

  async getPrivateDeliveryReport(params: DeliveryReportParams) {
    return this.gatewayPost(`/jobs/${params.jobId.toString()}/delivery/report`, {
      contractor: params.contractor,
      reportSignature: params.reportSignature,
    }, "RepNet gateway delivery report");
  }

  async readPrivateDelivery(params: DeliveryReadParams) {
    return this.gatewayPost(`/jobs/${params.jobId.toString()}/delivery/read`, {
      contractor: params.contractor,
      deliveryHandle: params.deliveryHandle,
      readSignature: params.readSignature,
    }, "RepNet gateway delivery read");
  }

  async submitPrivateDelivery(params: DeliverySubmitParams) {
    return this.gatewayPost(`/jobs/${params.jobId.toString()}/delivery`, {
      payload: params.payload,
      signerUrl: params.signerUrl,
      ...(params.contentType ? { contentType: params.contentType } : {}),
      ...(params.artifacts ? { artifacts: params.artifacts } : {}),
    }, "RepNet gateway delivery submission");
  }

  async createJobBoardJob(params: CreateJobBoardJobParams): Promise<JobBoardJob> {
    return this.gatewayPost("/job-board/jobs", params, "RepNet job-board create");
  }

  async applyToJobBoardJob(params: ApplyJobBoardJobParams): Promise<JobBoardApplication> {
    const { jobId, ...body } = params;
    return this.gatewayPost(`/job-board/jobs/${encodeURIComponent(jobId)}/applications`, body, "RepNet job-board application");
  }

  async selectJobBoardWorker(params: SelectJobBoardWorkerParams): Promise<JobBoardJob> {
    const { jobId, ...body } = params;
    return this.gatewayPost(`/job-board/jobs/${encodeURIComponent(jobId)}/select`, body, "RepNet job-board worker selection");
  }

  async getJobBoardJob(jobId: string): Promise<JobBoardJob> {
    return this.gatewayGet(`/job-board/jobs/${encodeURIComponent(jobId)}`, "RepNet job-board read");
  }

  async readJobBoardPrivateSpecs(params: ReadJobBoardPrivateSpecsParams): Promise<JobBoardPrivateSpecsRead> {
    const { jobId, ...body } = params;
    return this.gatewayPost(`/job-board/jobs/${encodeURIComponent(jobId)}/private-specs`, body, "RepNet job-board private specs read");
  }

  async listOpenJobBoardJobs(): Promise<JobBoardJob[]> {
    return this.gatewayGet("/job-board/jobs", "RepNet job-board list");
  }

  async publishOpinion(jobId: bigint, opinionHash: string, opinionSchemaVersion: string) {
    const tx = await this.repnet.contracts.jobBoardContract.publishOpinionReport(jobId, opinionHash, opinionSchemaVersion);
    return tx.wait();
  }

  async requestMoreWork(jobId: bigint, request: string, deadline: bigint) {
    const tx = await this.repnet.contracts.jobBoardContract.requestAdditionalWork(jobId, request, deadline);
    return tx.wait();
  }

  async acceptMoreWork(jobId: bigint) {
    const tx = await this.repnet.contracts.jobBoardContract.acceptAdditionalWork(jobId);
    return tx.wait();
  }

  async refuseMoreWork(jobId: bigint, reason: string) {
    const tx = await this.repnet.contracts.jobBoardContract.refuseAdditionalWork(jobId, reason);
    return tx.wait();
  }

  async release(jobId: bigint) {
    const tx = await this.repnet.contracts.jobBoardContract.releaseJob(jobId);
    return tx.wait();
  }

  async cancel(jobId: bigint, reason: string, stage: "before-delivery" | "after-review" = "after-review") {
    const tx = stage === "before-delivery"
      ? await this.repnet.contracts.jobBoardContract.cancelBeforeDelivery(jobId, reason)
      : await this.repnet.contracts.jobBoardContract.cancelAfterReview(jobId, reason);
    return tx.wait();
  }

  async workerWithdrawAfterAccept(jobId: bigint) {
    const tx = await this.repnet.contracts.jobBoardContract.workerWithdrawAfterAccept(jobId);
    return tx.wait();
  }

  async getJob(jobId: bigint): Promise<JobSnapshot> {
    return normalizeJob(await this.repnet.contracts.jobBoardContract.jobs(jobId));
  }

  private async approveJobSpend(amount: bigint): Promise<number> {
    const approveTx = await this.repnet.contracts.usdc.approve(this.repnet.addresses.RepNetJobBoard, amount);
    await approveTx.wait();
    return Number(approveTx.nonce) + 1;
  }

  private async jobIdFromReceiptOrCounter(receipt: any): Promise<bigint> {
    for (const log of receipt?.logs ?? []) {
      try {
        const parsed = this.repnet.contracts.jobBoardContract.interface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed?.name === "JobAgreementCreated") return parsed.args.jobId;
      } catch {
        // Ignore unrelated logs in the same receipt.
      }
    }
    const nextId = await this.repnet.contracts.jobBoardContract.nextJobId();
    return nextId - 1n;
  }

  private gatewayUrl(): string {
    if (!this.repnet.gatewayUrl) throw new Error("RepNet gatewayUrl is required for gateway-backed operations");
    return this.repnet.gatewayUrl.replace(/\/$/, "");
  }

  private async gatewayPost(path: string, payload: unknown, label: string) {
    const response = await (globalThis as any).fetch(`${this.gatewayUrl()}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return this.gatewayData(response, label);
  }

  private async gatewayGet(path: string, label: string) {
    const response = await (globalThis as any).fetch(`${this.gatewayUrl()}${path}`);
    return this.gatewayData(response, label);
  }

  private async gatewayData(response: any, label: string) {
    const body = await response.json();
    if (!response.ok || body?.ok === false) {
      throw new Error(body?.error?.message || `${label} failed with HTTP ${response.status}`);
    }
    return body.data;
  }
}
