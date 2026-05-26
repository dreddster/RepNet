# RepNet BaseScan Verification

## RepNetJobBoard

- Network: Base Sepolia
- Chain ID: `84532`
- Contract: `RepNetJobBoard`
- Address: `0xA28e055390A9206a0E744f36F8A3aa57b977c694`
- Explorer: https://sepolia.basescan.org/address/0xA28e055390A9206a0E744f36F8A3aa57b977c694#code
- Verification GUID: `iey8wnnj5wzscrm5xt6t36bzuizxikxwcy5uc5crj8eetir3ga`
- Verification status: `Pass - Verified`
- Compiler: `v0.8.24+commit.e11b9ed9`
- EVM version: `cancun`
- Optimizer: enabled, `50` runs
- License: MIT
- Constructor arguments:
  - USDC: `0x1644d762753431a04d1D8a92F581398961b58C97`
  - Treasury: `0x0010752F36c7c91379e76c7580B8f003F9D62025`
  - Opinion publisher: `0x0010752F36c7c91379e76c7580B8f003F9D62025`
- Deploy transaction: `0x20f39a4f530dcb240eb40b1e5e0df867d2d1d42864324902402e4e5e5b040b80`
- Deploy block: `41574216`

## Verification evidence

The Etherscan API  `getsourcecode` endpoint returned:

```text
status: 1
message: OK
ContractName: RepNetJobBoard
CompilerVersion: v0.8.24+commit.e11b9ed9
OptimizationUsed: 1
Runs: 50
EVMVersion: cancun
LicenseType: MIT
SourceCodeLength: 52765
ABI length: 12105
Proxy: 0
```

## Operational note

Etherscan  requires `Etherscan multichain API endpoint for Base Sepolia` for Base Sepolia. The older `api-sepolia.basescan.org/api` V1 endpoint returns the deprecation error. Local DNS resolution for `api.etherscan.io` failed during verification, so the verification command used a temporary `curl --resolve` override from Etherscan API  chainlist/DNS evidence. No API key value was printed or committed.
