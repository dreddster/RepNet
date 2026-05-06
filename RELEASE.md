# RepNet release checklist

RepNet is a workspace monorepo. Publish packages in dependency order so adapters never point at an SDK version that lacks the canonical action registry.

## Publish order

1. `@repnet/sdk@0.1.2`
2. `@repnet/mcp-server@0.1.2`
3. `@repnet/vercel-ai@0.1.1`
4. `@repnet/cli@0.1.2`
5. `@repnet/agentkit-plugin@0.1.1`
6. `@repnet/plugin-eliza@0.1.1`

## Required pre-publish checks

```bash
npm ci
npm run test:eliza
npm run build:eliza
npm run test:agentkit
npm run build:agentkit
npm run build:core
npm run smoke:gateway
npm run pack:check
npm run audit:prod
npm run release:check
npm run release:smoke
```

`release:check` validates package metadata, public scoped-package publish config, README presence in tarballs, required dist files, and binary shebangs.

`release:smoke` performs an end-to-end dry run from local tarballs: builds publishable packages, packs them, installs them into a fresh app under the home directory, imports package entrypoints with peer dependencies resolved, verifies CLI/MCP bin executability, and scans installed adapter surfaces. Do not run this smoke under `/tmp`; some environments mount `/tmp` with `noexec`, which breaks binary execution checks. The smoke intentionally installs adapter framework peers, so npm may report audit/deprecation noise from `@coinbase/agentkit`, `@elizaos/core`, WalletConnect, MetaMask, or related framework trees; use `npm run audit:prod` in this repo as the release-blocking production dependency gate.

## Dependency boundary notes

- `@repnet/sdk` is `0.1.2`; publishable adapters depend on the canonical action registry in the SDK.
- Publishable SDK consumers depend on `@repnet/sdk: ^0.1.2`.
- DKG access uses the configured DKG node HTTP API.
- `assertion-tools` is not a runtime dependency; private-content Merkle verification is implemented locally with compatibility fixtures.

## Do not publish if

- `npm audit --omit=dev` is not clean.
- `pack:check` reports adapter package artifacts that do not match source.
- `release:check` reports missing package docs/metadata/bin shebangs.
- SDK tarball lacks `dist/actions.js` or `dist/actions.d.ts`.
