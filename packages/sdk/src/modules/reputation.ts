import type { RepNet } from "../client";
import type { FeedbackSummary } from "./feedback";

export interface AgentReputation {
  agentId: bigint;
  wallet: string;
  agentURI: string;
  feedback: FeedbackSummary;
  isRegistered: boolean;
}

export class ReputationModule {
  constructor(private repnet: RepNet) {}

  /**
   * Get full reputation profile for an agent by wallet address.
   * Combines identity + feedback data. No scoring — raw data only.
   */
  async getByWallet(wallet: string): Promise<AgentReputation | null> {
    const agentId = await this.repnet.contracts.identity.walletToAgent(wallet);
    if (agentId === 0n) return null;
    return this._buildProfile(agentId, wallet);
  }

  /**
   * Get full reputation profile by agent ID.
   */
  async getById(agentId: bigint): Promise<AgentReputation | null> {
    try {
      const wallet = await this.repnet.contracts.identity.agentWallet(agentId);
      return this._buildProfile(agentId, wallet);
    } catch {
      return null;
    }
  }

  /**
   * Check if a wallet meets a minimum interaction threshold.
   * Based on factual data: review count and satisfaction rate.
   * Consuming agents define their own thresholds.
   */
  async meetsThreshold(
    wallet: string,
    minReviews: number = 1,
    minSatisfactionRate: number = 0.5
  ): Promise<boolean> {
    const [totalReviews, satisfied] =
      await this.repnet.contracts.reputation.getSummaryByWallet(wallet);

    if (totalReviews < BigInt(minReviews)) return false;
    const rate = Number(satisfied) / Number(totalReviews);
    return rate >= minSatisfactionRate;
  }

  /**
   * Compare two agents' reputations side by side.
   * Returns raw data — consumer decides what matters.
   */
  async compare(agentIdA: bigint, agentIdB: bigint) {
    const [a, b] = await Promise.all([
      this.getById(agentIdA),
      this.getById(agentIdB),
    ]);
    return { a, b };
  }

  private async _buildProfile(
    agentId: bigint,
    wallet: string
  ): Promise<AgentReputation> {
    const [agentURI, [totalReviews, satisfied]] = await Promise.all([
      this.repnet.contracts.identity.tokenURI(agentId),
      this.repnet.contracts.reputation.getSummaryByWallet(wallet),
    ]);

    return {
      agentId,
      wallet,
      agentURI,
      feedback: {
        wallet,
        totalReviews,
        satisfiedCount: satisfied,
        satisfactionRate: totalReviews > 0n
          ? Number(satisfied) / Number(totalReviews)
          : 0,
      },
      isRegistered: true,
    };
  }
}
