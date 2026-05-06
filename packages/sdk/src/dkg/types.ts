export const DKG_PUBLISH_STATUSES = ["confirmed", "tentative", "failed"] as const;

export type DkgPublishStatus = (typeof DKG_PUBLISH_STATUSES)[number];

export const DKG_PRIVATE_STORAGE_STATUSES = [
  "none",
  "local",
  "replicated",
  "confirmed",
  "failed",
] as const;

export type DkgPrivateStorageStatus = (typeof DKG_PRIVATE_STORAGE_STATUSES)[number];

export interface DkgPublishError {
  code: string;
  message: string;
  retryable?: boolean;
}

export interface DkgPublishDiagnostics {
  ackCount?: number;
  requiredAckCount?: number;
  finalityReason?: string;
}

export interface DkgPublishResult {
  status: DkgPublishStatus;
  contextGraphId: string;
  kcId?: string;
  txHash?: string;
  receiptUri?: string;
  localId?: string;
  publicAnchorStatus?: DkgPublishStatus;
  privateStorageStatus?: DkgPrivateStorageStatus;
  privateLocalOnly?: boolean;
  error?: DkgPublishError;
  diagnostics?: DkgPublishDiagnostics;
}
