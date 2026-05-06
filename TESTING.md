# Testing

Use this checklist for changes in the public RepNet repository.

## Global checks

```bash
npm install --package-lock-only --ignore-scripts
npm ci --ignore-scripts
npm run release:check
npm run build:core
```

## Contracts

Any change to `contracts/`:

```bash
npm run test:contracts
```

## SDK

Any change to `packages/sdk/`:

```bash
npm run test:sdk
npm run build -w @repnet/sdk
```

## CLI, MCP, Vercel AI, signer

Any change to public integration packages:

```bash
npm run build -w @repnet/cli
npm run build -w @repnet/mcp-server
npm run build -w @repnet/vercel-ai
npm run build -w @repnet/signer
```

## Agent adapters

Any change to adapter packages:

```bash
npm run test:agentkit
npm run build:agentkit
npm run test:eliza
npm run build:eliza
```

## Release surface

Before publishing packages:

```bash
npm run pack:check
npm run release:smoke
npm run audit:prod
```

## Secret/runtime check

Before pushing a generated public cut, verify that no private operated-infrastructure files were exported:

```bash
find . \
  -path './publisher*' -o \
  -path './services*' -o \
  -path './audit*' -o \
  -path './contracts/.openzeppelin*' -o \
  -path './contracts/scripts*'
```

The command should print nothing.
