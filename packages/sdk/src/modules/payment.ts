import { ethers } from "ethers";
import type { RepNet } from "../client";

export interface PaymentPreview {
  jobAmount: bigint;
  contractorPays: bigint;
  workerReceives: bigint;
  feePerSide: bigint;
  totalFee: bigint;
}

export class PaymentModule {
  constructor(private repnet: RepNet) {}

  /**
   * Preview a payment — shows exact amounts before committing.
   * @param jobAmount Job value in USDC (6 decimals)
   */
  async preview(jobAmount: bigint): Promise<PaymentPreview> {
    const [contractorPays, workerReceives, feePerSide, totalFee] =
      await this.repnet.contracts.feeRouter.previewPayment(jobAmount);
    return { jobAmount, contractorPays, workerReceives, feePerSide, totalFee };
  }

  /**
   * Route a direct payment (no escrow). Contractor pays worker through FeeRouter.
   * Automatically handles USDC approval.
   * @param worker Worker wallet address
   * @param jobAmount Job value in USDC (6 decimals)
   */
  async pay(worker: string, jobAmount: bigint) {
    const { contractorPays } = await this.preview(jobAmount);

    // Approve FeeRouter to spend USDC
    const approveTx = await this.repnet.contracts.usdc.approve(
      this.repnet.addresses.RepNetFeeRouter,
      contractorPays
    );
    const approveReceipt = await approveTx.wait();

    // Wait for state to settle (Base Sepolia read-after-write quirk)
    if (this.repnet.chainId === 84532) {
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Route payment
    const tx = await this.repnet.contracts.feeRouter.routePayment(worker, jobAmount);
    return tx.wait();
  }

  /**
   * Get USDC balance for an address.
   */
  async getBalance(address?: string): Promise<bigint> {
    const addr = address || (await this.repnet.getAddress());
    return this.repnet.contracts.usdc.balanceOf(addr);
  }

  /**
   * Get protocol stats from FeeRouter.
   */
  async getProtocolStats() {
    const [totalJobs, totalFeesCollected] = await Promise.all([
      this.repnet.contracts.feeRouter.totalJobs(),
      this.repnet.contracts.feeRouter.totalFeesCollected(),
    ]);
    return { totalJobs, totalFeesCollected };
  }
}
