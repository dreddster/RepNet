// Core
export { RepNet, RepNetConfig } from "./client";

// Modules
export { IdentityModule, AgentInfo } from "./modules/identity";
export { PaymentModule, PaymentPreview } from "./modules/payment";
export { EscrowModule, EscrowJob, EscrowCreateParams, EscrowPreview, SpecItem, JobStatus, SpecStatus, Verdict } from "./modules/escrow";
export { FeedbackModule, FeedbackParams, FeedbackSummary, StructuredFeedback, Tier1Feedback, Tier2Feedback, FeedbackGenerator, PublicJobMetadata, PublicContractorFeedback, SubmitJobFeedbackParams, SubmitJobFeedbackResult } from "./modules/feedback";
export { ReputationModule, AgentReputation } from "./modules/reputation";
export { DiscoveryModule, AgentCard } from "./modules/discovery";
export { AgreementModule, JobCompletionSignoff, JobContext, PlatformHookResult } from "./modules/agreement";
export { DKGModule, DKGConfig, DkgMode } from "./modules/dkg";
export type { RepNetReceipt, RepNetAgentProfile, PublishAgreementDKGParams, AgreementAsset } from "./dkg/assets";
export { buildAgentProfileAsset, buildReceiptAsset, buildAgreementAsset } from "./dkg/assets";
export * from "./dkg/types";
export { V10NodeDkgClient } from "./dkg/v10-client";
export type { DkgV10Config, DkgV10PublishInput, DkgWorkerFeedbackEvidence } from "./dkg/v10-client";
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
