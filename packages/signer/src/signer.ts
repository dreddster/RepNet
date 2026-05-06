import { ethers } from 'ethers';
import type { SigningChallenge, SigningResponse, SignerConfig } from './types.js';

/**
 * Core signing logic. Validates challenges and produces signatures.
 * No network code — pure crypto operations.
 */
export class RepNetSigner {
  private wallet: ethers.Wallet;
  private config: SignerConfig;
  private seenNonces: Set<number> = new Set();

  constructor(config: SignerConfig) {
    this.config = config;
    // Normalize private key
    const key = config.privateKey.startsWith('0x')
      ? config.privateKey
      : `0x${config.privateKey}`;
    this.wallet = new ethers.Wallet(key);
  }

  get address(): string {
    return this.wallet.address;
  }

  /**
   * Process a signing challenge. Returns a signing response.
   * Validates the challenge before signing.
   */
  async sign(challenge: SigningChallenge): Promise<SigningResponse> {
    const base = { challengeId: challenge.challengeId, signer: this.address };

    // 1. Check expiry
    const now = Date.now();
    const expiresAt = new Date(challenge.expiresAt).getTime();
    if (now > expiresAt) {
      return { ...base, rejected: true, rejectionReason: 'Challenge expired' };
    }

    // 2. Check age (defense against old challenges replayed before expiry)
    const createdAt = new Date(challenge.createdAt).getTime();
    const ageSec = (now - createdAt) / 1000;
    if (ageSec > this.config.maxChallengeAgeSec) {
      return { ...base, rejected: true, rejectionReason: `Challenge too old (${ageSec.toFixed(0)}s > ${this.config.maxChallengeAgeSec}s)` };
    }

    // 3. Replay protection (nonce)
    if (this.seenNonces.has(challenge.nonce)) {
      return { ...base, rejected: true, rejectionReason: `Nonce ${challenge.nonce} already seen (replay?)` };
    }
    this.seenNonces.add(challenge.nonce);
    // Prune old nonces (keep last 10,000)
    if (this.seenNonces.size > 10_000) {
      const arr = [...this.seenNonces].sort((a, b) => a - b);
      for (let i = 0; i < arr.length - 5000; i++) {
        this.seenNonces.delete(arr[i]);
      }
    }

    // 4. Operation allowlist
    if (this.config.allowedOperations && this.config.allowedOperations.length > 0) {
      if (!this.config.allowedOperations.includes(challenge.operation)) {
        return { ...base, rejected: true, rejectionReason: `Operation '${challenge.operation}' not in allowlist` };
      }
    }

    // 5. Payload guardrails: chain, target contract, native value, and raw signing policy.
    const payloadRejection = this.validatePayload(challenge);
    if (payloadRejection) {
      return { ...base, rejected: true, rejectionReason: payloadRejection };
    }

    try {
      // 6. Sign based on challenge type
      if (challenge.transaction) {
        // Transaction signing — include all gas/EIP-1559 fields
        const txData = challenge.transaction as any;
        const tx: Record<string, any> = {
          to: txData.to,
          data: txData.data,
          value: txData.value || '0',
          chainId: txData.chainId,
        };
        if (txData.gasLimit) tx.gasLimit = txData.gasLimit;
        if (txData.maxFeePerGas) tx.maxFeePerGas = txData.maxFeePerGas;
        if (txData.maxPriorityFeePerGas) tx.maxPriorityFeePerGas = txData.maxPriorityFeePerGas;
        if (txData.type !== undefined) tx.type = txData.type;
        if (txData.nonce !== undefined) tx.nonce = txData.nonce;
        const signedTx = await this.wallet.signTransaction(tx);
        return { ...base, signedTransaction: signedTx };
      } else if (challenge.typedData) {
        // EIP-712 typed data signing
        const { domain, types, primaryType, message } = challenge.typedData;
        // Remove EIP712Domain from types (ethers adds it)
        const signingTypes = { ...types };
        delete signingTypes['EIP712Domain'];
        const signature = await this.wallet.signTypedData(domain, signingTypes, message);
        return { ...base, signature };
      } else if (challenge.message) {
        // Raw message signing (EIP-191)
        const messageBytes = ethers.getBytes(challenge.message);
        const signature = await this.wallet.signMessage(messageBytes);
        return { ...base, signature };
      } else {
        return { ...base, rejected: true, rejectionReason: 'No message, typedData, or transaction in challenge' };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ...base, rejected: true, rejectionReason: `Signing error: ${msg}` };
    }
  }

  /**
   * Get signer info (public, safe to expose)
   */
  info() {
    return {
      address: this.address,
      allowedOperations: this.config.allowedOperations || 'all',
      expectedChainId: this.config.expectedChainId,
      allowedContracts: this.config.allowedContracts || 'all',
      allowNativeValueTransfer: this.config.allowNativeValueTransfer === true,
      allowRawMessages: this.config.allowRawMessages === true,
      maxChallengeAgeSec: this.config.maxChallengeAgeSec,
    };
  }

  private validatePayload(challenge: SigningChallenge): string | undefined {
    if (this.config.expectedChainId !== undefined && challenge.chainId !== this.config.expectedChainId) {
      return `Unexpected chainId ${challenge.chainId}; expected ${this.config.expectedChainId}`;
    }

    if (challenge.transaction) {
      if (challenge.transaction.chainId !== challenge.chainId) {
        return `Transaction chainId mismatch: envelope ${challenge.chainId}, transaction ${challenge.transaction.chainId}`;
      }
      if (this.config.expectedChainId !== undefined && challenge.transaction.chainId !== this.config.expectedChainId) {
        return `Unexpected transaction chainId ${challenge.transaction.chainId}; expected ${this.config.expectedChainId}`;
      }

      if (!ethers.isAddress(challenge.transaction.to)) {
        return `Invalid transaction target address: ${challenge.transaction.to}`;
      }

      const allowedContracts = this.config.allowedContracts?.map((addr) => addr.toLowerCase());
      if (allowedContracts?.length && !allowedContracts.includes(challenge.transaction.to.toLowerCase())) {
        return `Transaction target ${challenge.transaction.to} not in contract allowlist`;
      }

      const value = BigInt(challenge.transaction.value || '0');
      if (value > 0n && this.config.allowNativeValueTransfer !== true) {
        return 'Native value transfer disabled';
      }

      return undefined;
    }

    if (challenge.message && !challenge.typedData && this.config.allowRawMessages !== true) {
      return 'Raw message signing disabled';
    }

    return undefined;
  }
}
