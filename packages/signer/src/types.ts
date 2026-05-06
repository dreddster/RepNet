/**
 * A signing challenge sent by the RepNet API Gateway.
 * The sidecar must sign the message and return the signature.
 */
export interface SigningChallenge {
  /** Unique challenge ID (for idempotency / tracking) */
  challengeId: string;
  /** The operation being requested */
  operation: 'register' | 'feedback' | 'escrow.create' | 'escrow.complete' | 'escrow.contest' | 'escrow.release' | 'raw';
  /** Human-readable description of what's being signed */
  description: string;
  /** The raw bytes to sign (hex-encoded, 0x-prefixed) */
  message: string;
  /** EIP-712 typed data (if applicable, alternative to message) */
  typedData?: {
    domain: Record<string, unknown>;
    types: Record<string, Array<{ name: string; type: string }>>;
    primaryType: string;
    message: Record<string, unknown>;
  };
  /** The chain ID this transaction targets */
  chainId: number;
  /** Unsigned transaction data (for sendTransaction-style signing) */
  transaction?: {
    to: string;
    data: string;
    value?: string;
    gasLimit?: string;
    chainId: number;
    maxFeePerGas?: string;
    maxPriorityFeePerGas?: string;
    type?: number;
    nonce?: number;
  };
  /** Timestamp when challenge was created (ISO-8601) */
  createdAt: string;
  /** Challenge expires at (ISO-8601) — signer should reject expired challenges */
  expiresAt: string;
  /** Nonce to prevent replay (monotonically increasing per gateway) */
  nonce: number;
  /** Gateway's own signature over this challenge (for verification) */
  gatewaySignature?: string;
}

/**
 * Response from the signer sidecar back to the gateway.
 */
export interface SigningResponse {
  challengeId: string;
  /** The signature (hex-encoded, 0x-prefixed) */
  signature?: string;
  /** Signed transaction (hex-encoded, for sendTransaction challenges) */
  signedTransaction?: string;
  /** If the signer rejected the challenge */
  rejected?: boolean;
  /** Reason for rejection */
  rejectionReason?: string;
  /** The wallet address that signed */
  signer: string;
}

/**
 * Signer sidecar configuration.
 */
export interface SignerConfig {
  /** Private key (hex, with or without 0x prefix) */
  privateKey: string;
  /** Port to listen on (default: 4001) */
  port: number;
  /** Host to bind to (default: 127.0.0.1) */
  host: string;
  /** Gateway URL to register with (optional) */
  gatewayUrl?: string;
  /** Allowed operations (if set, only these operations will be signed) */
  allowedOperations?: string[];
  /** Expected chain ID. Rejects challenges for any other chain when set. */
  expectedChainId?: number;
  /** Allowed transaction target contract addresses. Empty/undefined allows any target. */
  allowedContracts?: string[];
  /** Allow native ETH/value transfer in signed transactions. Defaults to false. */
  allowNativeValueTransfer?: boolean;
  /** Allow raw EIP-191 message signing. Defaults to false; transaction/typed-data signing remains enabled. */
  allowRawMessages?: boolean;
  /** Max challenge age in seconds before auto-reject (default: 300) */
  maxChallengeAgeSec: number;
  /** Log level */
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}
