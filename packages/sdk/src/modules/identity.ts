import { ethers } from "ethers";
import type { RepNet } from "../client";

export interface AgentInfo {
  agentId: bigint;
  owner: string;
  agentWallet: string;
  agentURI: string;
  isRegistered: boolean;
}

export interface AgentIdentity {
  registry: string;
  agentId: bigint;
}

export class IdentityModule {
  constructor(private repnet: RepNet) {}

  /**
   * Register a new agent identity. Pays fee + mints NFT in one transaction.
   * Free during free tier, $10 USDC after.
   * @param agentURI URI to A2A Agent Card JSON
   * @returns Transaction receipt
   */
  async register(agentURI: string) {
    // Check if free tier — if not, approve USDC first
    const isFree = await this.repnet.contracts.registration.isFreeTier();
    if (!isFree) {
      const fee = await this.repnet.contracts.registration.registrationFee();
      const approveTx = await this.repnet.contracts.usdc.approve(
        this.repnet.addresses.IdentityRegistry,
        fee
      );
      await approveTx.wait();
      // Wait for state to settle (Base Sepolia read-after-write quirk)
      if (this.repnet.chainId === 84532) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    const tx = await this.repnet.contracts.registration.registerWithFee(agentURI);
    return tx.wait();
  }

  /**
   * Get agent info by wallet address.
   */
  async getByWallet(wallet: string): Promise<AgentInfo | null> {
    const agentId = await this.repnet.contracts.identity.walletToAgent(wallet);
    if (agentId === 0n) return null;

    const owner = await this.repnet.contracts.identity.ownerOf(agentId);
    const agentWallet = await this.repnet.contracts.identity.agentWallet(agentId);
    const agentURI = await this.repnet.contracts.identity.tokenURI(agentId);

    return { agentId, owner, agentWallet, agentURI, isRegistered: true };
  }

  /**
   * Get agent info by agent ID.
   */
  async getById(agentId: bigint): Promise<AgentInfo | null> {
    try {
      const owner = await this.repnet.contracts.identity.ownerOf(agentId);
      const agentWallet = await this.repnet.contracts.identity.agentWallet(agentId);
      const agentURI = await this.repnet.contracts.identity.tokenURI(agentId);
      return { agentId, owner, agentWallet, agentURI, isRegistered: true };
    } catch {
      return null;
    }
  }

  /**
   * Update the agent's A2A Agent Card URI.
   */
  async updateURI(agentURI: string) {
    const agentId = await this.repnet.getAgentId();
    if (agentId === 0n) throw new Error("Not registered");
    const tx = await this.repnet.contracts.identity.updateAgentURI(agentId, agentURI);
    return tx.wait();
  }

  /**
   * Delegate signing to a different wallet via EIP-712.
   */
  async setAgentWallet(newWallet: string, newWalletSignature: string, deadline: bigint) {
    const agentId = await this.repnet.getAgentId();
    if (agentId === 0n) throw new Error("Not registered");
    const tx = await this.repnet.contracts.identity.setAgentWallet(
      agentId,
      newWallet,
      newWalletSignature,
      deadline
    );
    return tx.wait();
  }

  /**
   * Bulk-register agents via an approved platform.
   * Platform must be whitelisted via IdentityRegistry.approvePlatform().
   * No per-agent fee — platform pays via separate agreement.
   *
   * @param agents Array of agent wallet addresses
   * @param agentURIs Array of A2A Agent Card URIs (1:1 with agents)
   * @returns Transaction receipt
   */
  async registerBulk(agents: string[], agentURIs: string[]) {
    if (agents.length !== agentURIs.length) {
      throw new Error("agents and agentURIs must be the same length");
    }
    if (agents.length === 0) {
      throw new Error("Must register at least one agent");
    }
    const tx = await this.repnet.contracts.registration.registerBulkForPlatform(agents, agentURIs);
    return tx.wait();
  }

  /**
   * Get registration stats.
   */
  async getRegistrationStats() {
    const [totalRegistrations, isFreeTier] = await Promise.all([
      this.repnet.contracts.registration.totalPaidRegistrations(),
      this.repnet.contracts.registration.isFreeTier(),
    ]);
    return { totalRegistrations, isFreeTier };
  }

  /**
   * Register an external agent identity from an approved ERC-8004 registry.
   * Links an existing external agent NFT to this wallet for RepNet participation.
   * @param externalRegistry Address of the approved external registry
   * @param externalAgentId Token ID of the agent in the external registry
   */
  async registerExternal(externalRegistry: string, externalAgentId: bigint) {
    const tx = await this.repnet.contracts.identity.registerExternal(
      externalRegistry,
      externalAgentId
    );
    return tx.wait();
  }

  /**
   * Get the universal agent identity for a wallet address.
   * Returns both the registry address and agent ID, supporting both
   * native IdentityRegistry agents and externally-linked ERC-8004 agents.
   * @param wallet Wallet address to look up
   */
  async getAgentIdentity(wallet: string): Promise<AgentIdentity | null> {
    try {
      const result = await this.repnet.contracts.identity.getAgentIdentity(wallet);
      // Check if it's a valid identity (registry != zero address)
      if (result.registry === ethers.ZeroAddress) {
        return null;
      }
      return {
        registry: result.registry,
        agentId: result.agentId,
      };
    } catch {
      return null;
    }
  }
}
