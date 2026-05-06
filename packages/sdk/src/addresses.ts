export interface DeploymentAddresses {
  MockUSDC: string;
  IdentityRegistry: string;
  ReputationRegistry: string;
  RepNetFeeRouter: string;
  EscrowVault: string;
  RepNetEscrow: string;
}

export const ADDRESSES: Record<number, DeploymentAddresses> = {
  // Base Sepolia (testnet) — deployed 2026-04-30T16:43:13Z
  84532: {
    MockUSDC: "0x1644d762753431a04d1D8a92F581398961b58C97",
    IdentityRegistry: "0xB6f13878a4d8063bc84d26CdDBaDa3C7BaBC628F",
    ReputationRegistry: "0xd816c3920a6f55da131A609D63C0dEA0359cFec4",
    RepNetFeeRouter: "0xA347B67e0592886Cc42dD095D7E9C1629d7c892a",
    EscrowVault: "0xBd568ea3ec6564e18d3119591237810A1d86c89b",
    RepNetEscrow: "0xb8F6Ef08e856fB57616d2D4878ca43897B89CE08",
  },
  // Base Mainnet (future)
  // 8453: { ... }
};

export const RPC_URLS: Record<number, string> = {
  84532: "https://sepolia.base.org",
  8453: "https://mainnet.base.org",
};

export function getAddresses(chainId: number): DeploymentAddresses {
  const addrs = ADDRESSES[chainId];
  if (!addrs) throw new Error(`RepNet not deployed on chain ${chainId}`);
  return addrs;
}
