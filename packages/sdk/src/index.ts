// Core
export { RepNet, RepNetConfig } from "./client";

// Modules
export { IdentityModule, AgentInfo } from "./modules/identity";
export { PaymentModule, PaymentPreview } from "./modules/payment";
export { FeedbackModule, FeedbackParams, FeedbackSummary, StructuredFeedback, Tier1Feedback, Tier2Feedback, FeedbackGenerator, PublicJobMetadata, PublicContractorFeedback, SubmitJobFeedbackParams, SubmitJobFeedbackResult } from "./modules/feedback";
export { ReputationModule, AgentReputation } from "./modules/reputation";
export { DiscoveryModule, AgentCard } from "./modules/discovery";
export { AgreementModule, JobCompletionSignoff, JobContext, PlatformHookResult } from "./modules/agreement";
export { JobsModule, PaymentMode, JobStatus } from "./modules/jobs";
export type { JobSnapshot, CreateJobParams, DeliverySubmitParams } from "./modules/jobs";
export { DKGModule, DKGConfig, DkgMode } from "./modules/dkg";
export type { RepNetReceipt, RepNetAgentProfile, PublishAgreementDKGParams, AgreementAsset } from "./dkg/assets";
export { buildAgentProfileAsset, buildReceiptAsset, buildAgreementAsset } from "./dkg/assets";
export * from "./dkg/types";
export { DkgMemoryClient } from "./dkg/memory-client";
export { REPNET_OFFICIAL_CONTEXT_GRAPH_ID, REPNET_OFFICIAL_CONTEXT_GRAPH_URI } from "./dkg/defaults";
export type {
  DkgReputationEvidenceResult,
  DkgReputationEvent,
  DkgReputationQueryOptions,
  DkgReputationRole,
  DkgRoleReputationSummary,
  DkgMemoryConfig,
  DkgMemoryPublishInput,
  DkgWorkerFeedbackEvidence,
} from "./dkg/memory-client";
export { createRepNetActions } from "./actions";
export type { RepNetAction, RepNetActionMap, RepNetJsonSchema } from "./actions";
export { EvidenceBuilder, StructuredEvidence, CounterEvidence, CriterionClaim, CriterionRebuttal, AgreementSpec } from "./modules/evidence";

// Addresses & ABIs
export { getAddresses, ADDRESSES, RPC_URLS, DeploymentAddresses } from "./addresses";
export * from "./abi";

// Verification
export { verifyPrivateContent } from "./verify";

// Helpers
export const parseUSDC = (amount: number) => BigInt(Math.round(amount * 1e6));
export const formatUSDC = (amount: bigint) => Number(amount) / 1e6;
