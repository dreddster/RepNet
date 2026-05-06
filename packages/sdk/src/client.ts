import { ethers } from "ethers";
import { getAddresses, RPC_URLS, DeploymentAddresses } from "./addresses";
import {
  IdentityRegistryABI,
  ReputationRegistryABI,
  RepNetFeeRouterABI,
  RepNetEscrowABI,
  MockUSDCABI,
} from "./abi";
import { IdentityModule } from "./modules/identity";
import { PaymentModule } from "./modules/payment";
import { ReputationModule } from "./modules/reputation";
import { EscrowModule } from "./modules/escrow";
import { FeedbackModule } from "./modules/feedback";
import { DiscoveryModule } from "./modules/discovery";
import { AgreementModule } from "./modules/agreement";
import { DKGModule, DKGConfig } from "./modules/dkg";

export interface RepNetConfig {
  /** Chain ID (84532 = Base Sepolia, 8453 = Base Mainnet) */
  chainId: number;
  /** Ethers signer (wallet, AgentKit, any standard signer) */
  signer: ethers.Signer;
  /** Optional: custom RPC provider (defaults to public RPC) */
  provider?: ethers.Provider;
  /** Optional: custom contract addresses (overrides built-in) */
  addresses?: Partial<DeploymentAddresses>;
  /** Optional: DKG edge node config */
  dkg?: Partial<DKGConfig>;
  /** Optional: RepNet Gateway URL for private evidence submission */
  gatewayUrl?: string;
}

/**
 * RepNet SDK Client — main entry point.
 *
 * Usage:
 *   const repnet = new RepNet({ chainId: 84532, signer: wallet });
 *   await repnet.identity.register("https://my-agent/.well-known/agent-card.json");
 *   await repnet.payment.routePayment(workerAddress, parseUSDC(100));
 */
export class RepNet {
  public readonly provider: ethers.Provider;
  public readonly signer: ethers.Signer;
  public readonly chainId: number;
  public readonly addresses: DeploymentAddresses;
  public readonly gatewayUrl?: string;

  // Contract instances
  public readonly contracts: {
    identity: ethers.Contract;
    reputation: ethers.Contract;
    registration: ethers.Contract;
    feeRouter: ethers.Contract;
    escrow: ethers.Contract;
    usdc: ethers.Contract;
  };

  // Modules
  public readonly identity: IdentityModule;
  public readonly payment: PaymentModule;
  public readonly reputation: ReputationModule;
  public readonly escrow: EscrowModule;
  public readonly feedback: FeedbackModule;
  public readonly discovery: DiscoveryModule;
  public readonly agreement: AgreementModule;
  public readonly dkg: DKGModule;

  constructor(config: RepNetConfig) {
    this.chainId = config.chainId;
    this.signer = config.signer;

    // Provider: use custom, signer's provider, or default RPC
    if (config.provider) {
      this.provider = config.provider;
    } else if (config.signer.provider) {
      this.provider = config.signer.provider;
    } else {
      const rpc = RPC_URLS[config.chainId];
      if (!rpc) throw new Error(`No default RPC for chain ${config.chainId}`);
      this.provider = new ethers.JsonRpcProvider(rpc);
    }

    // Addresses: merge custom overrides with built-in
    const builtIn = getAddresses(config.chainId);
    this.addresses = { ...builtIn, ...(config.addresses || {}) };

    // Initialize contract instances
    this.contracts = {
      identity: new ethers.Contract(this.addresses.IdentityRegistry, IdentityRegistryABI, this.signer),
      reputation: new ethers.Contract(this.addresses.ReputationRegistry, ReputationRegistryABI, this.signer),
      registration: new ethers.Contract(this.addresses.IdentityRegistry, IdentityRegistryABI, this.signer),
      feeRouter: new ethers.Contract(this.addresses.RepNetFeeRouter, RepNetFeeRouterABI, this.signer),
      escrow: new ethers.Contract(this.addresses.RepNetEscrow, RepNetEscrowABI, this.signer),
      usdc: new ethers.Contract(this.addresses.MockUSDC, MockUSDCABI, this.signer),
    };

    // Initialize modules
    this.identity = new IdentityModule(this);
    this.payment = new PaymentModule(this);
    this.reputation = new ReputationModule(this);
    this.escrow = new EscrowModule(this);
    this.feedback = new FeedbackModule(this);
    this.discovery = new DiscoveryModule(this);
    this.agreement = new AgreementModule(this);
    this.dkg = new DKGModule(this, config.dkg);
    this.gatewayUrl = config.gatewayUrl;
  }

  /** Get the connected wallet address */
  async getAddress(): Promise<string> {
    return this.signer.getAddress();
  }

  /** Get the signer (for signing messages, etc.) */
  getSigner(): ethers.Signer {
    return this.signer;
  }

  /** Check if the connected wallet is registered */
  async isRegistered(): Promise<boolean> {
    const addr = await this.getAddress();
    return this.contracts.identity.isRegisteredWallet(addr);
  }

  /** Get agent ID for the connected wallet */
  async getAgentId(): Promise<bigint> {
    const addr = await this.getAddress();
    return this.contracts.identity.walletToAgent(addr);
  }

  /**
   * Get the universal agent identity for a wallet address.
   * Returns registry address + agentId, supporting both native and external agents.
   * Returns null if wallet is not registered.
   */
  async getAgentIdentity(wallet?: string): Promise<{ registry: string; agentId: bigint } | null> {
    const addr = wallet || await this.getAddress();
    return this.identity.getAgentIdentity(addr);
  }
}
