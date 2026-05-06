import { ethers } from "ethers";
import type { RepNet } from "../client";

export interface AgentCard {
  name: string;
  description: string;
  url: string;
  capabilities?: string[];
  skills?: Array<{ id: string; name: string; description: string }>;
  repnet?: {
    agentId: bigint;
    chainId: number;
    registryAddress: string;
  };
}

export class DiscoveryModule {
  constructor(private repnet: RepNet) {}

  /**
   * Fetch and parse an A2A Agent Card from a URI.
   * Supports HTTPS and IPFS URIs.
   */
  async fetchAgentCard(agentURI: string): Promise<AgentCard | null> {
    try {
      const response = await fetch(agentURI);
      if (!response.ok) return null;
      return response.json() as Promise<AgentCard>;
    } catch {
      return null;
    }
  }

  /**
   * Look up an agent by wallet, get their Agent Card.
   */
  async discoverByWallet(wallet: string): Promise<AgentCard | null> {
    const agentId = await this.repnet.contracts.identity.walletToAgent(wallet);
    if (agentId === 0n) return null;

    const uri = await this.repnet.contracts.identity.tokenURI(agentId);
    return this.fetchAgentCard(uri);
  }

  /**
   * Check if a wallet is a registered RepNet agent.
   */
  async isAgent(wallet: string): Promise<boolean> {
    return this.repnet.contracts.identity.isRegisteredWallet(wallet);
  }

  /**
   * Get the total number of registered agents.
   */
  async getTotalAgents(): Promise<bigint> {
    const nextId = await this.repnet.contracts.identity.nextAgentId();
    return nextId - 1n;
  }

  /**
   * Scan a range of agent IDs and return their info.
   * Useful for building agent directories.
   */
  async scanAgents(fromId: bigint, toId: bigint) {
    const agents = [];
    for (let id = fromId; id <= toId; id++) {
      try {
        const owner = await this.repnet.contracts.identity.ownerOf(id);
        const wallet = await this.repnet.contracts.identity.agentWallet(id);
        const uri = await this.repnet.contracts.identity.tokenURI(id);
        const [count, sum] = await this.repnet.contracts.reputation.getSummary(id);
        agents.push({
          agentId: id,
          owner,
          wallet,
          uri,
          feedbackCount: count,
          avgScore: count > 0n ? Number(sum) / Number(count) : 0,
        });
      } catch {
        // Agent ID doesn't exist (burned or skipped)
      }
    }
    return agents;
  }
}
